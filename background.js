importScripts("core.js", "gopeed.js", "queue.js");

"use strict";

const {
  FAILURE,
  buildDownloadFilename,
  extractTeamSpaceId,
  findFirstHttpUrl,
  isSystemMetadataFile,
  looksLikeFileTitle,
  previewTitleMatchesFile
} = PopoCore;
const {
  classifyTaskStatus: classifyGopeedTaskStatus,
  continueTask: continueGopeedTask,
  deleteTask: deleteGopeedTask,
  getConfig: getGopeedConfig,
  getTask: getGopeedTask,
  normalizeDownloadDirectory: normalizeGopeedDownloadDirectory,
  normalizeEndpoint: normalizeGopeedEndpoint,
  pauseTask: pauseGopeedTask,
  startOrReplaceTask: startOrReplaceGopeedTask,
  splitDownloadTarget
} = PopoGopeed;
const {
  applyCancelPolicy,
  clientVisibleJobs,
  findDuplicateJob,
  isJobTerminal,
  makeFolderJobKey,
  queuePosition,
  summarizeItems
} = PopoQueue;
const PUMP_ALARM = "popo-stable-downloader-pump";
const WATCHDOG_ALARM = "popo-stable-downloader-watchdog";
const FOLDER_PICKER_HOST = "com.popo.stable_downloader.folder_picker";
const TERMINAL_STATUSES = new Set(["success", "failed", "cancelled", "skipped"]);
const ITEM_CHUNK_SIZE = 200;
const ITEM_STORAGE_PREFIX = "popoItems";
const MAX_RETAINED_TERMINAL_JOBS = 20;
const WORKER_UNAVAILABLE_CODE = "POPO_WORKER_UNAVAILABLE";
const workerFrameWaiters = new Map();

const DEFAULT_SETTINGS = Object.freeze({
  recursive: true,
  formats: "",
  includeKeywords: "",
  excludeKeywords: "",
  downloadRoot: "POPO稳定下载",
  preserveStructure: true,
  concurrency: 5,
  gopeedEndpoint: "http://127.0.0.1:9999",
  gopeedToken: "",
  gopeedDownloadDirOverride: "",
  gopeedConnections: 1,
  maxRetries: 2,
  timeouts: {
    directoryLoad: 45000,
    scanList: 180000,
    itemLookup: 90000,
    fileOpen: 20000,
    previewLoad: 45000,
    downloadStart: 20000,
    transfer: 1800000
  }
});

function newState() {
  return {
    version: 4,
    runToken: createId("run"),
    jobs: [],
    activeJobId: null,
    mode: "idle",
    phase: "idle",
    settings: structuredClone(DEFAULT_SETTINGS),
    triggerMode: "popup",
    sourceTabId: null,
    selectedFolderName: "",
    workerFrameId: null,
    workerReadyUrl: "",
    workerDeadline: 0,
    rootUrl: "",
    teamSpaceKey: "",
    teamSpaceId: "",
    workTabId: null,
    scanQueue: [],
    resolveQueue: [],
    scanFailures: [],
    scannedFolderCount: 0,
    rootProjectCount: null,
    items: [],
    preparingItemId: null,
    activeTransfers: [],
    activeItemId: null,
    gopeedDownloadDir: "",
    gopeedConnected: false,
    gopeedLastError: "",
    startedAt: "",
    completedAt: "",
    updatedAt: new Date().toISOString(),
    lastMessage: "请在 POPO 文件夹页面开始扫描",
    logs: []
  };
}

function createId(prefix) {
  const random = globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

function rotateRunToken(state) {
  state.runToken = createId("run");
  return state.runToken;
}

function itemChunkKey(jobId, index) {
  return `${ITEM_STORAGE_PREFIX}:${jobId}:${index}`;
}

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function migrateStoredState(storedState, settings) {
  if (storedState?.version === 4) {
    const teamSpaceKey = storedState.teamSpaceKey || storedState.teamSpaceId || "";
    return {
      ...newState(),
      ...storedState,
      settings,
      teamSpaceKey,
      teamSpaceId: storedState.teamSpaceKey ? storedState.teamSpaceId || "" : "",
      jobs: Array.isArray(storedState.jobs) ? storedState.jobs : []
    };
  }
  if (storedState?.version !== 3) return newState();

  const state = {
    ...newState(),
    ...storedState,
    version: 4,
    runToken: createId("run"),
    settings,
    jobs: [],
    activeJobId: null
  };
  state.teamSpaceKey = storedState.teamSpaceKey || storedState.teamSpaceId || "";
  state.teamSpaceId = storedState.teamSpaceKey ? storedState.teamSpaceId || "" : "";
  if (storedState.mode !== "idle") {
    const id = createId("job");
    state.activeJobId = id;
    state.jobs = [{
      id,
      key: makeFolderJobKey({
        parentUrl: storedState.rootUrl,
        folderItemIndex: "legacy",
        folderName: storedState.selectedFolderName || "升级前任务"
      }),
      sourceTabId: storedState.sourceTabId ?? null,
      folderName: storedState.selectedFolderName || "升级前任务",
      folderItemIndex: "legacy",
      parentUrl: storedState.rootUrl || "",
      status: storedState.mode,
      cancelRequested: false,
      createdAt: storedState.startedAt || new Date().toISOString(),
      startedAt: storedState.startedAt || "",
      completedAt: storedState.completedAt || "",
      counts: summarizeItems(
        storedState.items || [],
        storedState.scannedFolderCount,
        storedState.scanFailures?.length
      ),
      projectCount: null,
      lastMessage: storedState.lastMessage || "升级前任务已恢复"
    }];
  }
  return state;
}

async function getStored({ loadItems = true } = {}) {
  const data = await chrome.storage.local.get(["popoState", "popoSettings"]);
  const settings = mergeSettings(data.popoSettings || {});
  const state = migrateStoredState(data.popoState, settings);
  state.settings = settings;
  state.activeTransfers = Array.isArray(state.activeTransfers) ? state.activeTransfers : [];
  state.items = Array.isArray(state.items) ? state.items : [];
  state._itemsLoaded = loadItems;
  if (loadItems && data.popoState?.version === 4 && state.itemStorageJobId && state.itemChunkCount > 0) {
    const keys = Array.from(
      { length: state.itemChunkCount },
      (_, index) => itemChunkKey(state.itemStorageJobId, index)
    );
    const chunks = await chrome.storage.local.get(keys);
    state.items = keys.flatMap((key) => Array.isArray(chunks[key]) ? chunks[key] : []);
  }
  return { state, settings };
}

function mergeSettings(input) {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...input,
    // 文件夹按钮始终下载完整目录。覆盖旧版本遗留的筛选和目录选项，
    // 避免升级后继续只下载曾经选中过的格式或关键词。
    recursive: true,
    formats: "",
    includeKeywords: "",
    excludeKeywords: "",
    preserveStructure: true,
    // 并发数是扩展的固定稳定策略；覆盖旧版本保存在 storage 中的值。
    concurrency: 5,
    gopeedConnections: 1,
    timeouts: {
      ...DEFAULT_SETTINGS.timeouts,
      ...(input.timeouts || {})
    }
  };
}

function pushLog(state, level, message, details) {
  state.logs = [
    ...(state.logs || []),
    { at: new Date().toISOString(), level, message, details: details || "" }
  ].slice(-300);
  state.lastMessage = message;
}

function activeJob(state) {
  return (state.jobs || []).find((job) => job.id === state.activeJobId) || null;
}

function syncActiveJobSummary(state) {
  const job = activeJob(state);
  if (!job) return;
  job.status = state.mode;
  job.startedAt ||= state.startedAt || new Date().toISOString();
  job.completedAt = state.completedAt || "";
  job.lastMessage = state.lastMessage || job.lastMessage || "";
  job.cancelRequested = Boolean(job.cancelRequested);
  if (state._itemsLoaded !== false) {
    job.counts = summarizeItems(
      state.items,
      state.scannedFolderCount,
      state.scanFailures?.length
    );
    job.failurePreview = (state.items || [])
      .filter((item) => item.status === "failed")
      .slice(0, 6)
      .map((item) => ({ name: item.name, stage: item.failureStage, error: item.error }));
    job.failureRetryKeys = [...new Set((state.items || [])
      .filter((item) => item.status === "failed")
      .map((item) => `${item.parentUrl}\u0000${item.name}`))];
  }
  if (Number.isInteger(state.rootProjectCount) && state.rootProjectCount >= 0) {
    job.projectCount = state.rootProjectCount;
  }
}

function pruneTerminalJobs(state) {
  const activeJobs = (state.jobs || []).filter((job) => !isJobTerminal(job.status));
  const terminalJobs = (state.jobs || [])
    .filter((job) => isJobTerminal(job.status))
    .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)))
    .slice(0, MAX_RETAINED_TERMINAL_JOBS);
  state.jobs = [...activeJobs, ...terminalJobs].sort(
    (left, right) => String(left.createdAt).localeCompare(String(right.createdAt))
  );
}

function publicState(state) {
  const snapshot = structuredClone(state);
  delete snapshot.items;
  delete snapshot.itemChunkHashes;
  delete snapshot._itemsLoaded;
  snapshot.jobs = clientVisibleJobs(snapshot.jobs || []).map((job) => ({
    ...job,
    queuePosition: queuePosition(state.jobs, job.id)
  }));
  return snapshot;
}

function processedJobCount(job) {
  const counts = job?.counts || {};
  return (counts.success || 0) + (counts.failed || 0) + (counts.cancelled || 0);
}

function jobProgressPercent(job) {
  const total = Number(job?.counts?.files) || 0;
  if (!total) return null;
  return Math.max(0, Math.min(100, Math.round(processedJobCount(job) * 100 / total)));
}

async function updateActionIndicator(state) {
  if (!chrome.action?.setBadgeText) return;
  const jobs = state.jobs || [];
  const liveJobs = jobs.filter((job) => !isJobTerminal(job.status));
  const job = activeJob(state) || liveJobs[0] || null;
  let text = "";
  let color = "#1268e8";
  let title = "POPO 稳定下载助手";

  if (job) {
    const percent = jobProgressPercent(job);
    const total = Number(job.counts?.files) || 0;
    const processed = processedJobCount(job);
    const queued = liveJobs.filter((candidate) => candidate.status === "queued").length;
    text = percent == null ? (liveJobs.length > 9 ? "9+" : String(liveJobs.length)) : `${percent}%`;
    title = percent == null
      ? `${job.folderName || "下载任务"}：${job.lastMessage || "正在准备"}；${queued} 个排队`
      : `${job.folderName || "下载任务"}：${processed}/${total}（${percent}%）；失败 ${job.counts?.failed || 0}；排队 ${queued}`;
  } else {
    const latest = [...jobs].reverse().find((candidate) => isJobTerminal(candidate.status));
    if ((latest?.counts?.failed || 0) > 0) {
      text = "!";
      color = "#c73838";
      title = `${latest.folderName || "下载任务"}已结束：成功 ${latest.counts?.success || 0}，失败 ${latest.counts?.failed || 0}`;
    }
  }

  await Promise.allSettled([
    chrome.action.setBadgeText({ text }),
    chrome.action.setBadgeBackgroundColor?.({ color }),
    chrome.action.setTitle?.({ title })
  ].filter(Boolean));
}

let storageWriteChain = Promise.resolve();
let controlMutationChain = Promise.resolve();

function withControlMutation(action) {
  const operation = controlMutationChain.then(action);
  controlMutationChain = operation.catch(() => {});
  return operation;
}

function saveState(state, force = false) {
  const write = storageWriteChain.then(() => saveStateUnlocked(state, force));
  storageWriteChain = write.catch(() => {});
  return write;
}

async function saveStateUnlocked(state, force = false) {
  syncActiveJobSummary(state);
  pruneTerminalJobs(state);
  state.updatedAt = new Date().toISOString();
  const existing = await chrome.storage.local.get(["popoState"]);
  const storedState = existing.popoState;
  if (!force && storedState?.version === 4 && storedState.runToken &&
      storedState.runToken !== state.runToken) {
    return false;
  }

  if (state._itemsLoaded !== false) {
    const chunks = [];
    for (let index = 0; index < state.items.length; index += ITEM_CHUNK_SIZE) {
      chunks.push(state.items.slice(index, index + ITEM_CHUNK_SIZE));
    }
    const hashes = chunks.map((chunk) => hashText(JSON.stringify(chunk)));
    const updates = {};
    for (let index = 0; index < chunks.length; index += 1) {
      if (state.itemStorageJobId !== state.activeJobId || state.itemChunkHashes?.[index] !== hashes[index]) {
        updates[itemChunkKey(state.activeJobId || "idle", index)] = chunks[index];
      }
    }
    if (Object.keys(updates).length) await chrome.storage.local.set(updates);

    const staleKeys = [];
    if (state.itemStorageJobId && state.itemStorageJobId !== state.activeJobId) {
      for (let index = 0; index < (state.itemChunkCount || 0); index += 1) {
        staleKeys.push(itemChunkKey(state.itemStorageJobId, index));
      }
    } else if (state.itemStorageJobId === state.activeJobId && (state.itemChunkCount || 0) > chunks.length) {
      for (let index = chunks.length; index < state.itemChunkCount; index += 1) {
        staleKeys.push(itemChunkKey(state.itemStorageJobId, index));
      }
    }
    if (staleKeys.length && chrome.storage.local.remove) await chrome.storage.local.remove(staleKeys);
    state.itemStorageJobId = state.activeJobId || "";
    state.itemChunkCount = chunks.length;
    state.itemChunkHashes = hashes;
  }

  const metadata = structuredClone(state);
  delete metadata.items;
  delete metadata._itemsLoaded;
  await chrome.storage.local.set({ popoState: metadata });
  await updateActionIndicator(state);
  return true;
}

async function notifySource(state, message) {
  if (state.sourceTabId == null) return;
  try {
    await chrome.tabs.sendMessage(state.sourceTabId, {
      folderName: state.selectedFolderName,
      ...message
    }, { frameId: 0 });
  } catch {
    // The originating page may have been closed or reloaded.
  }
}

async function saveSettings(settings) {
  const merged = mergeSettings(settings);
  await chrome.storage.local.set({ popoSettings: merged });
  const { state } = await getStored();
  state.settings = merged;
  await saveState(state);
  return merged;
}

async function saveGopeedSettings(message) {
  const { settings } = await getStored();
  const merged = mergeSettings({
    ...settings,
    gopeedEndpoint: normalizeGopeedEndpoint(message.gopeedEndpoint),
    gopeedToken: String(message.gopeedToken || "").trim(),
    gopeedDownloadDirOverride: normalizeGopeedDownloadDirectory(
      message.gopeedDownloadDirOverride
    )
  });
  await chrome.storage.local.set({ popoSettings: merged });
  const { state } = await getStored();
  state.settings = merged;
  state.gopeedConnected = false;
  state.gopeedDownloadDir = "";
  state.gopeedLastError = "";
  await saveState(state);
  return merged;
}

async function chooseDownloadDirectory(message) {
  let nativeResult;
  try {
    nativeResult = await chrome.runtime.sendNativeMessage(FOLDER_PICKER_HOST, {
      action: "choose_folder",
      initialPath: normalizeGopeedDownloadDirectory(message.initialPath)
    });
  } catch (error) {
    const detail = String(error?.message || error).replace(/^Error:\s*/, "");
    throw new Error(`无法打开系统文件夹选择窗口：${detail}。请重新运行本机选择助手安装脚本`);
  }
  if (!nativeResult?.ok) {
    throw new Error(nativeResult?.error || "本机文件夹选择助手没有返回有效结果");
  }
  const { settings: currentSettings } = await getStored();
  if (nativeResult.cancelled) {
    const state = (await getStored()).state;
    const connection = await checkGopeedConnection(currentSettings, state);
    await saveState(state);
    return {
      cancelled: true,
      settings: connection.settings || currentSettings,
      connection
    };
  }
  const settings = await saveGopeedSettings({
    gopeedEndpoint: currentSettings.gopeedEndpoint,
    gopeedToken: currentSettings.gopeedToken,
    gopeedDownloadDirOverride: nativeResult.path
  });
  const { state } = await getStored();
  const connection = await checkGopeedConnection(settings, state);
  await saveState(state);
  return {
    cancelled: false,
    settings: connection.settings || settings,
    connection
  };
}

async function checkGopeedConnection(settings, stateToUpdate = null) {
  let effectiveSettings = mergeSettings(settings);
  let config;
  let firstError = "";
  try {
    config = await getGopeedConfig(effectiveSettings, { timeoutMs: 5000 });
  } catch (error) {
    firstError = String(error?.message || error).replace(/^Error:\s*/, "");
    try {
      const nativeResult = await chrome.runtime.sendNativeMessage(FOLDER_PICKER_HOST, {
        action: "ensure_gopeed"
      });
      if (!nativeResult?.ok || !nativeResult.endpoint) {
        throw new Error(nativeResult?.error || "本机助手没有返回 Gopeed 地址");
      }
      effectiveSettings = mergeSettings({
        ...effectiveSettings,
        gopeedEndpoint: normalizeGopeedEndpoint(nativeResult.endpoint),
        gopeedToken: ""
      });
      await chrome.storage.local.set({ popoSettings: effectiveSettings });
      config = await getGopeedConfig(effectiveSettings, { timeoutMs: 5000 });
    } catch (nativeError) {
      const nativeDetail = String(nativeError?.message || nativeError).replace(/^Error:\s*/, "");
      const detail = `${firstError}；内置 Gopeed 启动失败：${nativeDetail}`;
      if (stateToUpdate) {
        stateToUpdate.settings = effectiveSettings;
        stateToUpdate.gopeedConnected = false;
        stateToUpdate.gopeedDownloadDir = "";
        stateToUpdate.gopeedLastError = detail;
      }
      return {
        connected: false,
        endpoint: normalizeGopeedEndpoint(effectiveSettings.gopeedEndpoint),
        downloadDir: "",
        error: detail,
        settings: effectiveSettings
      };
    }
  }

  try {
    if (!config?.downloadDir) throw new Error("Gopeed 没有配置默认下载目录");
    const customDownloadDir = normalizeGopeedDownloadDirectory(
      effectiveSettings.gopeedDownloadDirOverride
    );
    const effectiveDownloadDir = customDownloadDir || config.downloadDir;
    if (stateToUpdate) {
      stateToUpdate.settings = effectiveSettings;
      stateToUpdate.gopeedConnected = true;
      stateToUpdate.gopeedDownloadDir = effectiveDownloadDir;
      stateToUpdate.gopeedLastError = "";
    }
    return {
      connected: true,
      endpoint: normalizeGopeedEndpoint(effectiveSettings.gopeedEndpoint),
      downloadDir: effectiveDownloadDir,
      defaultDownloadDir: config.downloadDir,
      customDownloadDir: customDownloadDir || "",
      settings: effectiveSettings
    };
  } catch (error) {
    const detail = String(error?.message || error).replace(/^Error:\s*/, "");
    if (stateToUpdate) {
      stateToUpdate.settings = effectiveSettings;
      stateToUpdate.gopeedConnected = false;
      stateToUpdate.gopeedDownloadDir = "";
      stateToUpdate.gopeedLastError = detail;
    }
    return {
      connected: false,
      endpoint: normalizeGopeedEndpoint(effectiveSettings.gopeedEndpoint),
      downloadDir: "",
      error: detail,
      settings: effectiveSettings
    };
  }
}

function gopeedTaskDefinition(state, item, url) {
  const relativeFilename = buildDownloadFilename(item, state.settings);
  const target = splitDownloadTarget(state.gopeedDownloadDir, relativeFilename);
  return {
    url,
    name: target.name,
    path: target.path,
    connections: state.settings.gopeedConnections
  };
}

function timeoutPromise(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
  });
}

async function withTimeout(promise, ms, label) {
  return Promise.race([promise, timeoutPromise(ms, label)]);
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function ensureWorkTab(state, initialUrl = "about:blank") {
  if (state.workTabId != null) {
    const existing = await getTab(state.workTabId);
    if (existing) return existing;
  }
  const tab = await chrome.tabs.create({ url: initialUrl, active: false });
  state.workTabId = tab.id;
  await saveState(state);
  return tab;
}

async function closeWorkTab(state) {
  if (state.triggerMode === "folder_button" && state.sourceTabId != null) {
    try {
      await chrome.tabs.sendMessage(
        state.sourceTabId,
        { type: "REMOVE_WORKER_FRAME" },
        { frameId: 0 }
      );
    } catch {}
    state.workerFrameId = null;
    state.workerReadyUrl = "";
    state.workerSourceTabId = null;
    state.workTabId = null;
    return;
  }
  if (state.workTabId != null) {
    try {
      await chrome.tabs.remove(state.workTabId);
    } catch {
      // The tab may already have been closed by the user.
    }
  }
  state.workTabId = null;
}

function workerFrameKey(tabId, frameId) {
  return `${tabId}:${frameId}`;
}

function workerUnavailableError(message, cause = null) {
  const error = new Error(message || "POPO 页面正在刷新，等待后台工作区恢复");
  error.code = WORKER_UNAVAILABLE_CODE;
  if (cause) error.cause = cause;
  return error;
}

function isWorkerUnavailableError(error) {
  return error?.code === WORKER_UNAVAILABLE_CODE;
}

function rejectWorkerFrameWaitersForTab(tabId, message) {
  for (const [key, waiter] of workerFrameWaiters) {
    if (!key.startsWith(`${tabId}:`)) continue;
    waiter.reject(workerUnavailableError(message));
  }
}

function waitForWorkerFrame(tabId, frameId, targetUrl, timeoutMs) {
  const key = workerFrameKey(tabId, frameId);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      workerFrameWaiters.delete(key);
      reject(workerUnavailableError(`隐藏工作区加载超时，等待页面恢复：${targetUrl}`));
    }, timeoutMs);
    workerFrameWaiters.set(key, {
      targetUrl,
      resolve: (url) => {
        clearTimeout(timeout);
        workerFrameWaiters.delete(key);
        resolve(url);
      },
      reject: (error) => {
        clearTimeout(timeout);
        workerFrameWaiters.delete(key);
        reject(error);
      }
    });
  });
}

async function registerWorkerFrame(sender, url) {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;
  if (tabId == null || frameId == null || frameId === 0) return null;
  const { state } = await getStored();
  const job = activeJob(state);
  if (!job || state.triggerMode !== "folder_button" || job.sourceTabId !== tabId) return null;
  state.workerFrameId = frameId;
  state.workerReadyUrl = url;
  state.workerSourceTabId = tabId;
  state.workerDeadline = 0;
  if (state.mode === "waiting_worker") {
    state.mode = "scanning";
    state.phase = "resolving_selection";
    pushLog(state, "info", "隐藏工作区已就绪");
  }
  await saveState(state);

  const waiter = workerFrameWaiters.get(workerFrameKey(tabId, frameId));
  if (waiter && (!waiter.targetUrl || waiter.targetUrl === url)) waiter.resolve(url);
  if (["scanning", "downloading", "draining"].includes(state.mode)) schedulePump(500);
  return state;
}

async function registerSourcePage(sender, url) {
  const tabId = sender.tab?.id;
  if (tabId == null || sender.frameId !== 0) return { needsWorker: false };
  const { state } = await getStored();
  await repairQueueState(state);
  const job = activeJob(state);
  if (!job || state.triggerMode !== "folder_button") {
    return { needsWorker: false, state: publicState(state) };
  }
  if (job.sourceTabId !== tabId) {
    const previousTab = job.sourceTabId == null ? null : await getTab(job.sourceTabId);
    const previousStillHostsPopo = Boolean(previousTab &&
      /^https:\/\/docs\.popo\.netease\.com\/team\/pc\/[^/]+\/pageDetail\/[a-z0-9]+/i.test(previousTab.url || ""));
    const candidateMatch = String(url || "").match(
      /^https:\/\/docs\.popo\.netease\.com\/team\/pc\/([^/]+)\/pageDetail\/[a-z0-9]+/i
    );
    const expectedTeamSpaceKey = state.teamSpaceKey ||
      String(job.parentUrl || "").match(/\/team\/pc\/([^/]+)\/pageDetail\//i)?.[1] || "";
    if (previousStillHostsPopo || !candidateMatch || candidateMatch[1] !== expectedTeamSpaceKey) {
      return { needsWorker: false, state: publicState(state) };
    }
    job.sourceTabId = tabId;
    state.sourceTabId = tabId;
    state.workerSourceTabId = tabId;
    pushLog(state, "warn", "原 POPO 页面已关闭，已在重新打开的同一团队空间页面恢复任务");
  }

  const hadWorker = state.workerFrameId != null;
  rejectWorkerFrameWaitersForTab(tabId, "POPO 页面已刷新，正在重建隐藏工作区");
  state.workerFrameId = null;
  state.workerReadyUrl = "";
  state.workerSourceTabId = tabId;
  state.workerDeadline = Date.now() + state.settings.timeouts.directoryLoad;

  if (state.preparingItemId) {
    const item = state.items.find((candidate) => candidate.id === state.preparingItemId);
    if (item && !TERMINAL_STATUSES.has(item.status)) {
      item.status = "pending";
      item.stage = "页面刷新，等待自动接续";
      item.failureStage = "";
      item.error = "";
      item.attempts = Math.max(0, (item.attempts || 0) - 1);
    }
    state.preparingItemId = null;
    state.activeItemId = state.activeTransfers?.[0]?.itemId ?? null;
  }

  if (hadWorker) {
    pushLog(
      state,
      "warn",
      "检测到 POPO 页面刷新；已开始的 Gopeed 下载继续，未开始文件将在工作区恢复后接续"
    );
  }
  rotateRunToken(state);
  await saveState(state, true);
  if (state.mode === "awaiting_confirmation") {
    await startScannedDownload(state, { automatic: true });
  }

  return {
    needsWorker: [
      "waiting_worker",
      "scanning",
      "awaiting_confirmation",
      "starting",
      "downloading",
      "paused",
      "draining",
      "draining_paused"
    ].includes(state.mode),
    workerUrl: state.rootUrl || job.parentUrl || url,
    state: publicState(state)
  };
}

function waitForTabComplete(tabId, timeoutMs) {
  return withTimeout(new Promise((resolve, reject) => {
    const onUpdated = (updatedId, changeInfo, tab) => {
      if (updatedId === tabId && changeInfo.status === "complete") {
        cleanup();
        resolve(tab);
      }
    };
    const onRemoved = (removedId) => {
      if (removedId === tabId) {
        cleanup();
        reject(new Error("后台工作标签页已关闭"));
      }
    };
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        cleanup();
        resolve(tab);
      }
    }).catch(() => {});
  }), timeoutMs, "目录加载");
}

async function waitForContent(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "PING" });
      if (response?.ok) return response;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(lastError || "内容脚本未就绪");
}

async function loadWorkUrl(state, url, timeoutMs, forceReload = true) {
  if (state.triggerMode === "folder_button") {
    if (state.sourceTabId == null || state.workerFrameId == null) {
      throw workerUnavailableError("POPO 页面后台工作区尚未恢复");
    }
    const ready = waitForWorkerFrame(state.sourceTabId, state.workerFrameId, url, timeoutMs);
    try {
      await chrome.tabs.sendMessage(
        state.sourceTabId,
        { type: "NAVIGATE_WORKER", url, forceReload },
        { frameId: state.workerFrameId }
      );
    } catch {
      // Navigation can close the message port before the response is delivered.
    }
    try {
      await ready;
    } catch (error) {
      throw isWorkerUnavailableError(error)
        ? error
        : workerUnavailableError("POPO 页面后台工作区加载中断", error);
    }
    state.workerReadyUrl = url;
    return { id: state.sourceTabId, url, status: "complete" };
  }
  const tab = await ensureWorkTab(state, "about:blank");
  const current = await getTab(tab.id);
  if (forceReload && current?.url === url) {
    await chrome.tabs.reload(tab.id);
  } else {
    await chrome.tabs.update(tab.id, { url, active: false });
  }
  await waitForTabComplete(tab.id, timeoutMs);
  await waitForContent(tab.id, timeoutMs);
  return getTab(tab.id);
}

async function sendToWork(state, message, timeoutMs, label) {
  if (state.triggerMode === "folder_button") {
    if (state.sourceTabId == null || state.workerFrameId == null) {
      throw workerUnavailableError("POPO 页面后台工作区尚未恢复");
    }
    let response;
    try {
      response = await withTimeout(
        chrome.tabs.sendMessage(
          state.sourceTabId,
          message,
          { frameId: state.workerFrameId }
        ),
        timeoutMs,
        label
      );
    } catch (error) {
      throw workerUnavailableError(`POPO 页面刷新导致“${label}”暂时中断`, error);
    }
    if (!response?.ok) throw new Error(response?.error || `${label}失败`);
    return response.result;
  }
  if (state.workTabId == null) throw new Error("后台工作标签页不存在");
  const response = await withTimeout(
    chrome.tabs.sendMessage(state.workTabId, message),
    timeoutMs,
    label
  );
  if (!response?.ok) throw new Error(response?.error || `${label}失败`);
  return response.result;
}

async function getWorkUrl(state) {
  if (state.triggerMode === "folder_button") {
    const response = await sendToWork(state, { type: "PING" }, 5000, "读取隐藏工作区地址");
    return response?.url || state.workerReadyUrl;
  }
  return (await getTab(state.workTabId))?.url || "";
}

async function waitForWorkUrlChange(state, beforeUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let workerInterruption = null;
  while (Date.now() < deadline) {
    try {
      const url = await getWorkUrl(state);
      if (url && url !== beforeUrl && /\/pageDetail\/[a-z0-9]+/i.test(url)) return url;
    } catch (error) {
      if (isWorkerUnavailableError(error)) workerInterruption = error;
      // The content script is briefly unavailable while the frame navigates.
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  if (workerInterruption) throw workerInterruption;
  throw new Error("点击后页面地址未变化");
}

function schedulePump(delayMs = 500) {
  chrome.alarms.create(PUMP_ALARM, { when: Date.now() + Math.max(100, delayMs) });
}

let pumpLocked = false;

function clearEngineFields(state) {
  state.scanQueue = [];
  state.resolveQueue = [];
  state.scanFailures = [];
  state.scannedFolderCount = 0;
  state.rootProjectCount = null;
  state.items = [];
  state.preparingItemId = null;
  state.activeTransfers = [];
  state.activeItemId = null;
  state.rootUrl = "";
  state.teamSpaceKey = "";
  state.teamSpaceId = "";
  state.startedAt = "";
  state.completedAt = "";
}

function prepareJobForExecution(state, job, reuseWorker) {
  clearEngineFields(state);
  state.activeJobId = job.id;
  state.triggerMode = "folder_button";
  state.sourceTabId = job.sourceTabId;
  state.selectedFolderName = job.folderName;
  job.projectCount = null;
  state.rootUrl = job.parentUrl;
  const url = new URL(job.parentUrl);
  const match = url.pathname.match(/\/team\/pc\/([^/]+)\/pageDetail\/([a-z0-9]+)/i);
  state.teamSpaceKey = match?.[1] || "";
  state.teamSpaceId = "";
  state.resolveQueue = [{
    key: job.key,
    parentUrl: job.parentUrl,
    parentPath: [],
    name: job.folderName,
    itemIndex: job.folderItemIndex
  }];
  state.startedAt = new Date().toISOString();
  state.completedAt = "";
  state.settings = mergeSettings({
    ...state.settings,
    recursive: true,
    formats: "",
    includeKeywords: "",
    excludeKeywords: "",
    preserveStructure: true
  });
  if (reuseWorker) {
    state.mode = "scanning";
    state.phase = "resolving_selection";
    state.workerDeadline = 0;
  } else {
    state.mode = "waiting_worker";
    state.phase = "waiting_worker";
    state.workerDeadline = Date.now() + state.settings.timeouts.directoryLoad;
  }
  job.status = state.mode;
  job.startedAt ||= state.startedAt;
  job.lastMessage = reuseWorker ? "开始读取文件夹" : "正在准备隐藏工作区";
  pushLog(state, "info", `任务开始：${job.folderName}`);
}

async function removeWorkerFrameFromTab(tabId) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "REMOVE_WORKER_FRAME" }, { frameId: 0 });
  } catch {}
}

async function requestWorkerFrameForActiveJob(state) {
  const job = activeJob(state);
  if (!job || state.triggerMode !== "folder_button" || job.sourceTabId == null) return;
  try {
    await chrome.tabs.sendMessage(job.sourceTabId, {
      type: "ENSURE_WORKER_FRAME",
      url: job.parentUrl,
      force: true
    }, { frameId: 0 });
  } catch {}
}

async function waitForWorkerReconnect(state, message) {
  state.workerFrameId = null;
  state.workerReadyUrl = "";
  state.workerDeadline = Date.now() + state.settings.timeouts.directoryLoad;
  state.phase = "waiting_worker";
  if (state.lastMessage !== message) pushLog(state, "warn", message);
  await saveState(state);
  await requestWorkerFrameForActiveJob(state);
  schedulePump(1500);
}

function transitionToNextQueuedJob(state) {
  const previousSourceTabId = state.workerSourceTabId ?? state.sourceTabId;
  const next = (state.jobs || []).find((job) => job.status === "queued");
  if (!next) {
    state.workerFrameId = null;
    state.workerReadyUrl = "";
    state.workerSourceTabId = null;
    state.workerDeadline = 0;
    state.activeJobId = null;
    state.mode = "idle";
    state.phase = "idle";
    state.triggerMode = "folder_button";
    state.sourceTabId = null;
    state.selectedFolderName = "";
    clearEngineFields(state);
    state.lastMessage = "下载队列已处理完成";
    return { next: null, removeTabId: previousSourceTabId, requestWorker: false, schedule: false };
  }

  const reuseWorker = state.workerFrameId != null && previousSourceTabId === next.sourceTabId;
  if (!reuseWorker) {
    state.workerFrameId = null;
    state.workerReadyUrl = "";
    state.workerSourceTabId = null;
  }
  prepareJobForExecution(state, next, reuseWorker);
  return {
    next,
    removeTabId: reuseWorker ? null : previousSourceTabId,
    requestWorker: !reuseWorker,
    schedule: reuseWorker
  };
}

async function runQueueTransitionEffects(state, effects) {
  if (effects.removeTabId != null) await removeWorkerFrameFromTab(effects.removeTabId);
  if (effects.requestWorker) await requestWorkerFrameForActiveJob(state);
  if (effects.schedule) schedulePump(100);
}

function queueStateNeedsRepair(state) {
  const job = activeJob(state);
  if (job?.cancelRequested) return true;
  if (job && isJobTerminal(job.status)) return true;
  if (!job && (state.activeJobId || state.mode !== "idle")) return true;
  return !job && (state.jobs || []).some((candidate) => candidate.status === "queued");
}

async function repairQueueState(state) {
  if (!queueStateNeedsRepair(state)) return false;
  const job = activeJob(state);
  if (job?.cancelRequested && !isJobTerminal(job.status)) {
    state.mode = "cancelled";
    state.phase = "cancelled";
    state.completedAt = new Date().toISOString();
    pushLog(state, "info", "已结束取消任务；已经交给 Gopeed 的文件保持不变");
    syncActiveJobSummary(state);
    job.status = "cancelled";
    job.completedAt = state.completedAt;
    job.lastMessage = "任务已取消；已经开始的下载保留在 Gopeed 中";
  }
  state.activeJobId = null;
  const effects = transitionToNextQueuedJob(state);
  rotateRunToken(state);
  await saveState(state, true);
  await runQueueTransitionEffects(state, effects);
  return true;
}

async function finalizeActiveJob(state, status, message, notification = null, force = false) {
  const job = activeJob(state);
  if (!job) return null;
  state.mode = status;
  state.phase = status;
  state.completedAt = new Date().toISOString();
  pushLog(state, status === "failed" ? "error" : "info", message);
  syncActiveJobSummary(state);
  job.status = status;
  job.completedAt = state.completedAt;
  job.lastMessage = message;
  const source = {
    sourceTabId: state.sourceTabId,
    folderName: state.selectedFolderName
  };
  state.activeJobId = null;
  const effects = transitionToNextQueuedJob(state);
  const saved = await saveState(state, force);
  if (!saved) return null;
  if (notification) await notifySource({ ...state, ...source }, notification);
  await runQueueTransitionEffects(state, effects);
  return effects.next;
}

async function processScanStep(state) {
  const settings = state.settings;
  state.phase = "scanning";
  if (state.triggerMode === "folder_button" && state.workerFrameId == null) {
    await waitForWorkerReconnect(
      state,
      "等待 POPO 页面恢复；已扫描结果和下载队列均已保留"
    );
    return;
  }

  if (state.scanQueue.length) {
    const entry = state.scanQueue[0];
    try {
      pushLog(state, "info", `读取目录：${entry.path.join("/") || "当前目录"}`);
      await saveState(state);
      await notifySource(state, {
        type: "FOLDER_TASK_STATUS",
        message: `正在读取：${entry.path.join("/") || state.selectedFolderName}`
      });
      await loadWorkUrl(state, entry.url, settings.timeouts.directoryLoad, true);
      const result = await sendToWork(state, {
        type: "SCAN_DIRECTORY",
        timeoutMs: settings.timeouts.scanList
      }, settings.timeouts.scanList + 5000, "扫描目录");

      const directoryPath = entry.path.length ? entry.path : [result.directoryName];
      if (
        state.triggerMode === "folder_button" &&
        directoryPath.length === 1 &&
        directoryPath[0] === state.selectedFolderName
      ) {
        state.rootProjectCount = result.items.length;
        const job = activeJob(state);
        if (job) job.projectCount = result.items.length;
      }
      for (const scanned of result.items) {
        if (scanned.type === "folder") {
          state.scannedFolderCount += 1;
          if (settings.recursive) {
            const resolveKey = `${entry.url}\u0000${scanned.itemIndex}\u0000${scanned.name}`;
            if (!state.resolveQueue.some((candidate) => candidate.key === resolveKey)) {
              state.resolveQueue.push({
                key: resolveKey,
                parentUrl: entry.url,
                parentPath: directoryPath,
                name: scanned.name,
                itemIndex: scanned.itemIndex
              });
            }
          }
          continue;
        }
        const key = `${entry.url}\u0000${scanned.itemIndex}\u0000${scanned.name}`;
        if (state.items.some((item) => item.id === key)) continue;
        const systemMetadata = isSystemMetadataFile(scanned.name);
        const retryKeys = activeJob(state)?.retryKeys;
        const retrySelected = !retryKeys?.length || retryKeys.includes(`${entry.url}\u0000${scanned.name}`);
        // 用户选择的是整个文件夹：除系统元数据外，不按扩展名或关键词跳过文件。
        const selected = !systemMetadata && retrySelected;
        state.items.push({
          id: key,
          name: scanned.name,
          itemIndex: scanned.itemIndex,
          parentUrl: entry.url,
          directoryPath,
          selected,
          status: selected ? "pending" : "skipped",
          stage: "已扫描",
          failureStage: "",
          error: selected
            ? ""
            : systemMetadata
              ? "系统元数据文件已自动忽略"
              : !retrySelected
                ? "不属于本次失败重试"
              : "未通过筛选条件",
          attempts: 0,
          gopeedTaskId: null,
          retryTaskId: null,
          startedAt: "",
          completedAt: "",
          history: []
        });
      }
      state.scanQueue.shift();
      pushLog(
        state,
        "info",
        `目录完成：${directoryPath.join("/")}（${result.items.length} 项）`,
        JSON.stringify(result.diagnostics || {})
      );
    } catch (error) {
      if (isWorkerUnavailableError(error)) {
        await waitForWorkerReconnect(
          state,
          "POPO 页面刷新中；当前目录稍后自动继续，不计为扫描失败"
        );
        return;
      }
      state.scanFailures.push({
        url: entry.url,
        path: entry.path,
        stage: FAILURE.DIRECTORY_LOAD_FAILED,
        error: String(error),
        at: new Date().toISOString()
      });
      state.scanQueue.shift();
      pushLog(state, "error", `${FAILURE.DIRECTORY_LOAD_FAILED}：${entry.path.join("/") || entry.url}`, String(error));
    }
    await saveState(state);
    await notifySource(state, {
      type: "FOLDER_TASK_STATUS",
      message: `已发现 ${state.items.filter((item) => item.selected).length} 个可下载文件，继续读取子文件夹…`
    });
    schedulePump();
    return;
  }

  if (state.resolveQueue.length) {
    const folder = state.resolveQueue[0];
    try {
      pushLog(state, "info", `定位子目录：${[...folder.parentPath, folder.name].join("/")}`);
      await saveState(state);
      await notifySource(state, {
        type: "FOLDER_TASK_STATUS",
        message: `正在进入：${[...folder.parentPath, folder.name].join("/")}`
      });
      await loadWorkUrl(state, folder.parentUrl, settings.timeouts.directoryLoad, true);
      await sendToWork(state, { type: "CLEAN_STATE" }, 5000, "清理页面状态");
      const beforeUrl = await getWorkUrl(state);
      const openResult = await sendToWork(state, {
        type: "OPEN_ITEM",
        name: folder.name,
        itemIndex: folder.itemIndex,
        expectedType: "folder",
        timeoutMs: settings.timeouts.itemLookup
      }, settings.timeouts.itemLookup + 3000, "定位子目录");
      if (!openResult.clicked) throw new Error(openResult.reason === "not_found" ? "未找到文件夹" : "文件夹行已失效");
      const childUrl = await waitForWorkUrlChange(state, beforeUrl, settings.timeouts.fileOpen);
      state.scanQueue.push({
        url: childUrl,
        path: [...folder.parentPath, folder.name]
      });
      state.resolveQueue.shift();
    } catch (error) {
      if (isWorkerUnavailableError(error)) {
        await waitForWorkerReconnect(
          state,
          "POPO 页面刷新中；当前子文件夹稍后自动继续，不计为扫描失败"
        );
        return;
      }
      state.scanFailures.push({
        url: folder.parentUrl,
        path: [...folder.parentPath, folder.name],
        stage: FAILURE.DIRECTORY_LOAD_FAILED,
        error: String(error),
        at: new Date().toISOString()
      });
      state.resolveQueue.shift();
      pushLog(state, "error", `${FAILURE.DIRECTORY_LOAD_FAILED}：${folder.name}`, String(error));
    }
    await saveState(state);
    schedulePump();
    return;
  }

  state.mode = "scan_complete";
  state.phase = "ready";
  state.completedAt = new Date().toISOString();
  if (!settings.recursive && state.items.length === 0 && state.scannedFolderCount > 0) {
    pushLog(
      state,
      "warn",
      `当前目录有 ${state.scannedFolderCount} 个子文件夹；递归扫描已关闭，因此没有进入子文件夹。请开启递归后重新扫描`
    );
  } else {
    pushLog(
      state,
      "info",
      `扫描完成：共 ${state.items.length} 个文件、${state.scannedFolderCount} 个文件夹，${state.items.filter((item) => item.selected).length} 个待下载`
    );
  }
  if (state.triggerMode !== "folder_button") await closeWorkTab(state);
  const saved = await saveState(state);
  if (!saved) return;
  if (state.triggerMode === "folder_button") {
    await startScannedDownload(state, { automatic: true });
  }
}

function selectedPendingItem(state) {
  return state.items.find((item) => item.selected && item.status === "pending");
}

function removeActiveTransfer(state, itemId) {
  state.activeTransfers = (state.activeTransfers || [])
    .filter((transfer) => transfer.itemId !== itemId);
  if (state.preparingItemId === itemId) state.preparingItemId = null;
  if (state.activeItemId === itemId) state.activeItemId = null;
  if (!state.preparingItemId) state.activeItemId = state.activeTransfers[0]?.itemId ?? null;
}

function markAttemptFailure(state, item, stage, error, retryTaskId = null) {
  const detail = String(error || stage);
  item.failureStage = stage;
  item.error = detail;
  item.history = [...(item.history || []), {
    at: new Date().toISOString(),
    attempt: item.attempts,
    stage,
    error: detail
  }];
  item.gopeedTaskId = null;
  if (retryTaskId) item.retryTaskId = retryTaskId;
  removeActiveTransfer(state, item.id);

  if (activeJob(state)?.cancelRequested) {
    item.status = "failed";
    item.stage = "已开始文件下载失败";
    item.completedAt = new Date().toISOString();
    item.retryTaskId = null;
    pushLog(state, "error", `${item.name}：${stage}（任务已取消剩余文件，不再重试）`, detail);
  } else if (item.attempts <= state.settings.maxRetries) {
    item.status = "pending";
    item.stage = `等待重试（${item.attempts}/${state.settings.maxRetries + 1}）`;
    pushLog(state, "warn", `${item.name}：${stage}，将重新加载父目录后重试`, detail);
  } else {
    item.status = "failed";
    item.stage = "明确失败";
    item.completedAt = new Date().toISOString();
    pushLog(state, "error", `${item.name}：${stage}`, detail);
  }
}

async function waitForPreview(state, item) {
  const deadline = Date.now() + state.settings.timeouts.previewLoad;
  let lastInfo;
  let previewReadySince = 0;
  let conflictingTitleSince = 0;
  while (Date.now() < deadline) {
    lastInfo = await sendToWork(state, { type: "GET_PREVIEW_INFO" }, 5000, "读取预览状态");
    const titleCandidates = lastInfo.titleCandidates || [];
    const exactTitle = titleCandidates.some((title) => previewTitleMatchesFile(title, item.name));
    const conflictingFileTitle = titleCandidates.find(
      (title) => looksLikeFileTitle(title) && !previewTitleMatchesFile(title, item.name)
    );
    if (!exactTitle && conflictingFileTitle) {
      conflictingTitleSince ||= Date.now();
      if (Date.now() - conflictingTitleSince > 1500) {
        throw Object.assign(new Error(`预览标题不匹配；期望“${item.name}”，实际“${conflictingFileTitle}”`), {
          failureStage: FAILURE.FILE_OPEN_FAILED
        });
      }
    } else {
      conflictingTitleSince = 0;
    }

    const mediaUrl = lastInfo.media.find((entry) => entry.src)?.src || "";
    const previewReady = Boolean(
      mediaUrl ||
      lastInfo.downloadButtonCount > 0 ||
      (!lastInfo.loadingCount && lastInfo.previewElementCount > 0)
    );
    if (previewReady) previewReadySince ||= Date.now();
    else previewReadySince = 0;

    // The breadcrumb always contains the parent folder name. It is not the
    // preview title and must not cause an immediate mismatch. OPEN_ITEM has
    // already revalidated the exact virtual-list row before clicking, so when
    // no conflicting filename is visible we can accept a settled preview.
    const settledFor = Date.now() - previewReadySince;
    if (previewReadySince && (exactTitle || settledFor > 1500)) {
      if (mediaUrl) return { ...lastInfo, mediaUrl };
      return { ...lastInfo, mediaUrl: "" };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw Object.assign(new Error("预览页未在限定时间内出现可下载资源"), {
    failureStage: FAILURE.PREVIEW_LOAD_TIMEOUT,
    lastInfo
  });
}

async function beginDownload(state, item, url) {
  const definition = gopeedTaskDefinition(state, item, url);
  item.stage = item.retryTaskId ? "更新下载地址" : "建立 Gopeed 任务";
  await saveState(state);
  const previousTaskId = item.retryTaskId;
  const started = await startOrReplaceGopeedTask(
    state.settings,
    previousTaskId,
    definition,
    { timeoutMs: state.settings.timeouts.downloadStart }
  );
  const taskId = started.taskId;
  if (started.replacedMissingTask) {
    item.retryTaskId = null;
    pushLog(
      state,
      "warn",
      `Gopeed 原任务已不存在，已重新建立：${item.name}`,
      `oldTaskId=${previousTaskId}; newTaskId=${taskId}`
    );
  }
  if (!taskId) throw new Error("Gopeed 没有返回任务 ID");

  const fresh = (await getStored()).state;
  const freshItem = fresh.items.find((candidate) => candidate.id === item.id);
  if (!freshItem || TERMINAL_STATUSES.has(freshItem.status)) {
    try { await deleteGopeedTask(state.settings, taskId, { timeoutMs: 8000 }); } catch {}
    return;
  }
  fresh.activeTransfers = (fresh.activeTransfers || [])
    .filter((transfer) => transfer.itemId !== item.id);
  fresh.activeTransfers.push({
    itemId: item.id,
    taskId,
    pollFailures: 0,
    startedAt: new Date().toISOString()
  });
  fresh.preparingItemId = null;
  fresh.activeItemId = fresh.activeTransfers[0]?.itemId ?? null;
  freshItem.gopeedTaskId = taskId;
  freshItem.retryTaskId = null;
  freshItem.status = fresh.mode === "paused" ? "paused" : "transferring";
  freshItem.stage = fresh.mode === "paused" ? "已暂停" : "Gopeed 传输中";
  freshItem.transferDeadline = Date.now() + fresh.settings.timeouts.transfer;
  if (fresh.mode === "paused") {
    try { await pauseGopeedTask(fresh.settings, taskId); } catch {}
  }
  pushLog(fresh, "info", `Gopeed 任务已建立：${item.name}`, `taskId=${taskId}`);
  await saveState(fresh);
  schedulePump(500);
}

function pageApiErrorDetail(response) {
  const body = response?.body;
  const status = Number(response?.status) || 0;
  const code = body && typeof body === "object" ? body.code ?? body.status : null;
  const message = body && typeof body === "object"
    ? body.msg || body.message || response?.error || ""
    : response?.error || "";
  return [
    status ? `HTTP ${status}` : "",
    code != null ? `code ${code}` : "",
    message ? String(message).slice(0, 180) : ""
  ].filter(Boolean).join("，") || "接口未返回可识别数据";
}

async function ensureTeamSpaceId(state) {
  if (state.teamSpaceId) return state.teamSpaceId;
  const teamSpaceKey = state.teamSpaceKey ||
    new URL(state.rootUrl).pathname.match(/\/team\/pc\/([^/]+)/i)?.[1] || "";
  if (!teamSpaceKey) throw new Error("没有识别到 POPO 团队空间标识");
  const response = await sendToWork(state, {
    type: "RESOLVE_TEAM_SPACE_ID",
    teamSpaceKey,
    timeoutMs: state.settings.timeouts.downloadStart
  }, state.settings.timeouts.downloadStart + 3000, "解析团队空间 ID");
  const teamSpaceId = response?.ok ? extractTeamSpaceId(response.body) : "";
  if (!teamSpaceId) {
    throw new Error(`无法把 POPO 团队空间短码解析为真实 ID：${pageApiErrorDetail(response)}`);
  }
  state.teamSpaceKey = teamSpaceKey;
  state.teamSpaceId = teamSpaceId;
  await saveState(state);
  return teamSpaceId;
}

async function requestDirectDownloadUrl(state, pageId) {
  const teamSpaceId = await ensureTeamSpaceId(state);
  let lastResponse = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    lastResponse = await sendToWork(state, {
      type: "REQUEST_DIRECT_DOWNLOAD",
      teamSpaceId,
      pageId,
      timeoutMs: state.settings.timeouts.downloadStart
    }, state.settings.timeouts.downloadStart + 3000, "请求单文件下载地址");
    const directUrl = lastResponse?.ok ? findFirstHttpUrl(lastResponse.body) : "";
    if (directUrl) return directUrl;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 400));
  }
  throw Object.assign(
    new Error(`POPO 单文件地址接口连续 3 次未返回下载地址：${pageApiErrorDetail(lastResponse)}`),
    { failureStage: FAILURE.DOWNLOAD_NOT_ESTABLISHED }
  );
}

async function syncGopeedTransfers(state) {
  let connectionProblem = false;
  for (const transfer of [...(state.activeTransfers || [])]) {
    const item = state.items.find((candidate) => candidate.id === transfer.itemId);
    if (!item) {
      removeActiveTransfer(state, transfer.itemId);
      continue;
    }
    try {
      const task = await getGopeedTask(state.settings, transfer.taskId, { timeoutMs: 5000 });
      transfer.pollFailures = 0;
      state.gopeedConnected = true;
      state.gopeedLastError = "";
      item.gopeedProgress = {
        downloaded: task?.progress?.downloaded || 0,
        speed: task?.progress?.speed || 0,
        status: task?.status || ""
      };
      const status = classifyGopeedTaskStatus(task?.status);
      if (status === "success") {
        item.status = "success";
        item.stage = "成功";
        item.failureStage = "";
        item.error = "";
        item.completedAt = new Date().toISOString();
        item.retryTaskId = null;
        removeActiveTransfer(state, item.id);
        pushLog(state, "info", `下载成功：${item.name}`, `taskId=${transfer.taskId}`);
      } else if (status === "failed") {
        markAttemptFailure(
          state,
          item,
          FAILURE.TRANSFER_INTERRUPTED,
          "Gopeed 报告传输失败；将刷新 POPO 临时地址后继续原任务",
          transfer.taskId
        );
      } else if (status === "paused") {
        item.status = "paused";
        item.stage = "已在 Gopeed 暂停";
        state.mode = activeJob(state)?.cancelRequested ? "draining_paused" : "paused";
        state.phase = state.mode;
        pushLog(state, "info", `Gopeed 任务已暂停：${item.name}`);
      } else if (status === "unknown") {
        transfer.pollFailures = (transfer.pollFailures || 0) + 1;
        if (transfer.pollFailures >= 5) {
          markAttemptFailure(
            state,
            item,
            FAILURE.TRANSFER_INTERRUPTED,
            `Gopeed 返回未知任务状态：${task?.status || "空"}`,
            transfer.taskId
          );
        }
      }
    } catch (error) {
      if (error?.code === 2001) {
        item.retryTaskId = null;
        markAttemptFailure(
          state,
          item,
          FAILURE.DOWNLOAD_NOT_ESTABLISHED,
          "Gopeed 中已找不到该任务，将重新建立下载"
        );
        continue;
      }
      connectionProblem = true;
      transfer.pollFailures = (transfer.pollFailures || 0) + 1;
      const detail = String(error?.message || error).replace(/^Error:\s*/, "");
      state.gopeedConnected = false;
      state.gopeedLastError = detail;
      item.stage = `等待 Gopeed 恢复（${transfer.pollFailures}/5）`;
      if (transfer.pollFailures >= 5) {
        markAttemptFailure(
          state,
          item,
          FAILURE.TRANSFER_INTERRUPTED,
          `${detail}；连续 5 次无法读取任务状态`,
          transfer.taskId
        );
      }
    }
  }
  if (connectionProblem) {
    pushLog(state, "warn", "Gopeed 连接暂时中断，正在重连", state.gopeedLastError);
  }
}

async function processDownloadStep(state) {
  state.activeTransfers = Array.isArray(state.activeTransfers) ? state.activeTransfers : [];
  await syncGopeedTransfers(state);
  if (!state.gopeedConnected) {
    const connection = await checkGopeedConnection(state.settings, state);
    if (!connection.connected) {
      state.phase = "waiting_gopeed";
      pushLog(state, "warn", "等待 Gopeed 恢复连接", connection.error);
      await saveState(state);
      schedulePump(2000);
      return;
    }
  }
  if (state.mode === "draining_paused") {
    await saveState(state);
    return;
  }
  if (state.mode === "draining") {
    if (state.activeTransfers.length) {
      state.phase = "draining";
      await saveState(state);
      schedulePump(1000);
      return;
    }
    await finalizeActiveJob(
      state,
      "cancelled",
      "未开始文件已取消；已开始文件已处理完成",
      { type: "FOLDER_TASK_CANCELLED", preservedTransfers: true }
    );
    return;
  }
  if (state.mode !== "downloading") {
    await saveState(state);
    return;
  }
  if (state.preparingItemId) {
    // A preparation promise only lives for the current pump invocation. If a
    // later pump sees the persisted marker, the previous invocation ended or
    // the service worker was interrupted before it could clear the marker.
    const interruptedItem = state.items.find((entry) => entry.id === state.preparingItemId);
    if (interruptedItem && !TERMINAL_STATUSES.has(interruptedItem.status)) {
      interruptedItem.status = "pending";
      interruptedItem.stage = "准备步骤曾中断，正在自动接续";
      interruptedItem.failureStage = "";
      interruptedItem.error = "";
      interruptedItem.attempts = Math.max(0, (interruptedItem.attempts || 0) - 1);
      pushLog(state, "warn", `检测到准备步骤中断，自动重新处理：${interruptedItem.name}`);
    }
    state.preparingItemId = null;
    state.activeItemId = state.activeTransfers[0]?.itemId ?? null;
    await saveState(state);
    schedulePump(100);
    return;
  }
  if (state.triggerMode === "folder_button" && state.workerFrameId == null && selectedPendingItem(state)) {
    await waitForWorkerReconnect(
      state,
      "等待 POPO 页面恢复；已开始的 Gopeed 下载继续，未开始文件保持排队"
    );
    return;
  }
  if (state.activeTransfers.length >= state.settings.concurrency) {
    await saveState(state);
    schedulePump(1000);
    return;
  }
  const item = selectedPendingItem(state);
  if (!item) {
    if (state.activeTransfers.length) {
      await saveState(state);
      schedulePump(1000);
      return;
    }
    const successCount = state.items.filter((entry) => entry.status === "success").length;
    const failedCount = state.items.filter((entry) => entry.status === "failed").length;
    await finalizeActiveJob(
      state,
      "complete",
      `下载结束：成功 ${successCount}，失败 ${failedCount}`,
      { type: "FOLDER_TASK_FINISHED", successCount, failedCount }
    );
    return;
  }

  state.preparingItemId = item.id;
  state.activeItemId = item.id;
  item.attempts += 1;
  item.status = "preparing";
  item.startedAt ||= new Date().toISOString();
  item.failureStage = "";
  item.error = "";

  try {
    item.stage = "加载父目录";
    state.phase = "directory_loading";
    pushLog(state, "info", `准备下载：${item.name}（第 ${item.attempts} 次）`);
    await saveState(state);
    await notifySource(state, {
      type: "FOLDER_TASK_STATUS",
      message: `正在准备 ${state.items.filter((entry) => entry.status === "success").length + 1} / ${state.items.filter((entry) => entry.selected).length}：${item.name}`
    });
    await loadWorkUrl(state, item.parentUrl, state.settings.timeouts.directoryLoad, true);
    await sendToWork(state, { type: "CLEAN_STATE" }, 5000, "清理上一次页面状态");

    item.stage = "定位文件";
    state.phase = "file_lookup";
    await saveState(state);
    const beforeUrl = await getWorkUrl(state);
    const openResult = await sendToWork(state, {
      type: "OPEN_ITEM",
      name: item.name,
      itemIndex: item.itemIndex,
      expectedType: "file",
      timeoutMs: state.settings.timeouts.itemLookup
    }, state.settings.timeouts.itemLookup + 3000, "定位文件");
    if (!openResult.clicked) {
      const diagnosticItems = (openResult.diagnostics?.seenItems || [])
        .map((entry) => `${entry.itemIndex}:${entry.name}`)
        .slice(-20)
        .join(" | ");
      const detail = diagnosticItems ? `；已检查：${diagnosticItems}` : "";
      throw Object.assign(new Error(
        (openResult.reason === "not_found" ? "父目录中未找到该文件" : "文件行在点击前失效") + detail
      ), {
        failureStage: openResult.reason === "not_found" ? FAILURE.FILE_NOT_FOUND : FAILURE.FILE_OPEN_FAILED
      });
    }

    item.stage = "打开文件";
    state.phase = "file_opening";
    await saveState(state);
    await waitForWorkUrlChange(state, beforeUrl, state.settings.timeouts.fileOpen);

    item.stage = "等待预览";
    state.phase = "preview_loading";
    await saveState(state);
    const preview = await waitForPreview(state, item);

    let directUrl = preview.mediaUrl;
    if (!directUrl && preview.pageId) {
      directUrl = await requestDirectDownloadUrl(state, preview.pageId);
    }

    if (directUrl) {
      await beginDownload(state, item, directUrl);
      return;
    }
    throw Object.assign(
      new Error("没有取得可由扩展管理的单文件下载地址；已停止该文件，未调用 POPO 网页打包下载"),
      { failureStage: FAILURE.DOWNLOAD_NOT_ESTABLISHED }
    );
  } catch (error) {
    if (isWorkerUnavailableError(error)) {
      item.status = "pending";
      item.stage = "页面刷新，等待自动接续";
      item.failureStage = "";
      item.error = "";
      item.attempts = Math.max(0, item.attempts - 1);
      item.workerInterruptions = (item.workerInterruptions || 0) + 1;
      removeActiveTransfer(state, item.id);
      await waitForWorkerReconnect(
        state,
        `POPO 页面刷新中：${item.name} 稍后自动继续，本次不计失败`
      );
      return;
    }
    const failureStage = error.failureStage ||
      (item.stage === "加载父目录" ? FAILURE.DIRECTORY_LOAD_FAILED :
        item.stage === "定位文件" ? FAILURE.FILE_NOT_FOUND :
          item.stage === "打开文件" ? FAILURE.FILE_OPEN_FAILED :
            item.stage === "等待预览" ? FAILURE.PREVIEW_LOAD_TIMEOUT :
              FAILURE.DOWNLOAD_NOT_ESTABLISHED);
    markAttemptFailure(state, item, failureStage, error);
    await saveState(state);
    schedulePump();
  }
}

async function pump() {
  if (pumpLocked) return;
  pumpLocked = true;
  try {
    const { state } = await getStored();
    if (await repairQueueState(state)) return;
    if (state.mode === "scanning") await processScanStep(state);
    else if (["downloading", "draining", "draining_paused"].includes(state.mode)) {
      await processDownloadStep(state);
    }
  } catch (error) {
    const { state } = await getStored();
    pushLog(state, "error", "后台任务发生未捕获错误", String(error));
    await saveState(state);
    if (["scanning", "downloading", "draining"].includes(state.mode)) schedulePump(1000);
  } finally {
    pumpLocked = false;
  }
}

async function startScan(message) {
  if (!/^https:\/\/docs\.popo\.netease\.com\/team\/pc\/[^/]+\/pageDetail\/[a-z0-9]+/i.test(message.url || "")) {
    throw new Error("请先打开一个 POPO 团队空间文件夹页面");
  }
  const previous = (await getStored()).state;
  if (["scanning", "downloading", "paused"].includes(previous.mode)) {
    throw new Error("已有任务正在运行，请先取消");
  }
  await closeWorkTab(previous);

  const settings = await saveSettings(message.settings || {});
  const url = new URL(message.url);
  const match = url.pathname.match(/\/team\/pc\/([^/]+)\/pageDetail\/([a-z0-9]+)/i);
  const state = newState();
  state.settings = settings;
  state.mode = "scanning";
  state.phase = "starting";
  state.rootUrl = url.href;
  state.teamSpaceKey = match[1];
  state.teamSpaceId = "";
  state.scanQueue = [{ url: url.href, path: [] }];
  state.startedAt = new Date().toISOString();
  pushLog(state, "info", "扫描任务已创建；用户当前标签页不会被切换");
  await saveState(state);
  schedulePump(100);
  return state;
}

async function startFolderScan(message, sourceTabId) {
  if (!/^https:\/\/docs\.popo\.netease\.com\/team\/pc\/[^/]+\/pageDetail\/[a-z0-9]+/i.test(message.parentUrl || "")) {
    throw new Error("当前页面不是可读取的 POPO 文件夹");
  }
  const folderName = String(message.folderName || "").trim();
  if (!folderName) throw new Error("没有识别到文件夹名称");
  const folderItemIndex = String(message.folderItemIndex ?? "").trim();
  if (!folderItemIndex) throw new Error("没有识别到被点击文件夹的行标识，请刷新 POPO 页面后重试");

  const state = (await getStored()).state;
  if (state.activeJobId == null && state.mode !== "idle" && state.triggerMode !== "folder_button") {
    throw new Error("另一个扫描任务正在运行，请稍后再试");
  }
  const key = makeFolderJobKey({
    parentUrl: message.parentUrl,
    folderItemIndex,
    folderName
  });
  const duplicate = findDuplicateJob(state.jobs, key);
  if (duplicate) {
    return {
      state,
      job: duplicate,
      duplicate: true,
      queuePosition: queuePosition(state.jobs, duplicate.id),
      needsWorker: false
    };
  }

  const job = {
    id: createId("job"),
    key,
    sourceTabId,
    folderName,
    folderItemIndex,
    parentUrl: new URL(message.parentUrl).href,
    status: "queued",
    cancelRequested: false,
    createdAt: new Date().toISOString(),
    startedAt: "",
    completedAt: "",
    counts: summarizeItems([], 0, 0),
    projectCount: null,
    lastMessage: "已添加下载，排队中"
  };
  state.jobs = [...(state.jobs || []), job];
  let needsWorker = false;
  if (!state.activeJobId) {
    prepareJobForExecution(state, job, false);
    needsWorker = true;
  }
  rotateRunToken(state);
  await saveState(state, true);
  return {
    state,
    job,
    duplicate: false,
    queuePosition: queuePosition(state.jobs, job.id),
    needsWorker
  };
}

async function startScannedDownload(state, { automatic = false } = {}) {
  if (!["scan_complete", "awaiting_confirmation", "complete"].includes(state.mode)) {
    throw new Error("请先完成文件数量检查");
  }
  const pending = state.items.filter((item) => item.selected && !["success", "cancelled"].includes(item.status));
  if (!pending.length) {
    const message = state.scanFailures.length
      ? `没有可下载文件；${state.scanFailures.length} 个目录读取失败`
      : `当前目录没有可下载文件（${state.rootProjectCount ?? 0} 个项目）`;
    if (!automatic || state.triggerMode !== "folder_button") throw new Error(message);
    await finalizeActiveJob(
      state,
      state.scanFailures.length ? "failed" : "complete",
      message,
      {
        type: state.scanFailures.length ? "FOLDER_TASK_ERROR" : "FOLDER_TASK_FINISHED",
        message,
        successCount: 0,
        failedCount: state.scanFailures.length
      }
    );
    return state;
  }
  if (activeJob(state)?.cancelRequested) throw new Error("该任务已经取消未开始文件");
  state.mode = "starting";
  state.phase = "waiting_gopeed";
  rotateRunToken(state);
  await saveState(state, true);
  const connection = await checkGopeedConnection(state.settings, state);
  if (!connection.connected) {
    const message = `Gopeed 未连接：${connection.error}。请重新运行测试包中的 START-HERE.cmd 后再试。`;
    if (automatic && state.triggerMode === "folder_button") {
      await finalizeActiveJob(state, "failed", message, { type: "FOLDER_TASK_ERROR", message });
      return state;
    }
    state.mode = "scan_complete";
    state.phase = "ready";
    await saveState(state);
    throw new Error(message);
  }
  for (const item of pending) {
    if (item.status === "failed") continue;
    if (item.status !== "success") item.status = "pending";
  }
  state.mode = "downloading";
  state.phase = "starting";
  state.completedAt = "";
  state.preparingItemId = null;
  state.activeTransfers = [];
  state.activeItemId = null;
  pushLog(
    state,
    "info",
    `开始下载 ${pending.filter((item) => item.status === "pending").length} 个文件；Gopeed 任务并发 ${state.settings.concurrency}`,
    `downloadDir=${connection.downloadDir}`
  );
  const saved = await saveState(state);
  if (!saved) throw new Error("任务状态已经变化，未启动新的下载");
  schedulePump(100);
  return state;
}

async function startDownload() {
  const { state } = await getStored();
  return startScannedDownload(state);
}

async function pauseTask() {
  const { state } = await getStored();
  if (state.mode !== "downloading") return state;
  state.mode = "paused";
  state.phase = "paused";
  rotateRunToken(state);
  await saveState(state, true);
  for (const transfer of state.activeTransfers || []) {
    const item = state.items.find((candidate) => candidate.id === transfer.itemId);
    try {
      await pauseGopeedTask(state.settings, transfer.taskId);
    } catch (error) {
      pushLog(state, "warn", `暂停 Gopeed 任务失败：${item?.name || transfer.taskId}`, String(error));
    }
    if (item) {
      item.status = "paused";
      item.stage = "已暂停";
    }
  }
  pushLog(state, "info", "任务已暂停");
  await saveState(state);
  await notifySource(state, { type: "FOLDER_TASK_STATUS", message: "下载已暂停" });
  return state;
}

async function resumeTask() {
  const { state } = await getStored();
  if (!["paused", "draining_paused"].includes(state.mode)) return state;
  const cancelRequested = Boolean(activeJob(state)?.cancelRequested);
  state.mode = cancelRequested ? "draining" : "downloading";
  state.phase = "resuming";
  rotateRunToken(state);
  await saveState(state, true);
  for (const transfer of [...(state.activeTransfers || [])]) {
    const item = state.items.find((candidate) => candidate.id === transfer.itemId);
    try { await continueGopeedTask(state.settings, transfer.taskId); } catch (error) {
      if (item) markAttemptFailure(state, item, FAILURE.TRANSFER_INTERRUPTED, error, transfer.taskId);
    }
    if (item && state.activeTransfers.some((candidate) => candidate.itemId === item.id)) {
      item.status = "transferring";
      item.stage = "传输中";
    }
  }
  pushLog(state, "info", "任务已继续");
  await saveState(state);
  await notifySource(state, { type: "FOLDER_TASK_STATUS", message: "继续下载…" });
  schedulePump(100);
  return state;
}

async function cancelTask() {
  const { state } = await getStored();
  return cancelJob(state.activeJobId);
}

async function cancelJob(jobId) {
  const { state } = await getStored();
  const job = (state.jobs || []).find((candidate) => candidate.id === jobId);
  if (!job) throw new Error("没有找到要取消的下载任务");
  if (isJobTerminal(job.status)) return state;

  if (state.activeJobId !== job.id) {
    job.status = "cancelled";
    job.cancelRequested = true;
    job.completedAt = new Date().toISOString();
    job.lastMessage = "排队任务已取消，未创建任何下载";
    rotateRunToken(state);
    await saveState(state, true);
    return state;
  }

  job.cancelRequested = true;
  rotateRunToken(state);
  const cancellation = applyCancelPolicy(state.items, state.activeTransfers);
  state.preparingItemId = null;
  state.scanQueue = [];
  state.resolveQueue = [];
  pushLog(
    state,
    "warn",
    `已取消 ${cancellation.cancelledCount} 个未开始文件；保留 ${cancellation.preservedCount} 个已开始文件`
  );
  await finalizeActiveJob(
    state,
    "cancelled",
    cancellation.preservedCount
      ? `任务已取消；${cancellation.preservedCount} 个已经开始的下载保留在 Gopeed 中`
      : "任务已取消，没有停止任何已开始下载",
    { type: "FOLDER_TASK_CANCELLED", preservedTransfers: cancellation.preservedCount > 0 },
    true
  );
  return state;
}

async function retryFailed() {
  const { state } = await getStored({ loadItems: false });
  const job = [...(state.jobs || [])]
    .reverse()
    .find((candidate) => (candidate.counts?.failed || 0) > 0 && candidate.failureRetryKeys?.length);
  if (!job) throw new Error("没有失败文件可重试");
  return retryJob(job.id);
}

async function retryJob(jobId) {
  const { state } = await getStored();
  const source = (state.jobs || []).find((candidate) => candidate.id === jobId);
  if (!source?.failureRetryKeys?.length) throw new Error("这个任务没有可重试的失败文件");
  const existing = (state.jobs || []).find(
    (candidate) => candidate.retryOfJobId === source.id && !isJobTerminal(candidate.status)
  );
  if (existing) return state;
  const job = {
    id: createId("job"),
    key: source.key,
    sourceTabId: source.sourceTabId,
    folderName: source.folderName,
    displayName: `${source.folderName}（重试失败项）`,
    folderItemIndex: source.folderItemIndex,
    parentUrl: source.parentUrl,
    retryOfJobId: source.id,
    retryKeys: source.failureRetryKeys,
    status: "queued",
    cancelRequested: false,
    createdAt: new Date().toISOString(),
    startedAt: "",
    completedAt: "",
    counts: summarizeItems([], 0, 0),
    lastMessage: `等待重新扫描并重试 ${source.failureRetryKeys.length} 个失败文件`
  };
  state.jobs.push(job);
  if (!state.activeJobId) prepareJobForExecution(state, job, false);
  rotateRunToken(state);
  await saveState(state, true);
  if (state.activeJobId === job.id) await requestWorkerFrameForActiveJob(state);
  return state;
}

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(["popoSettings", "popoState"]);
  // 更新时一并清除旧版本保存过的文件格式和关键词筛选。
  await chrome.storage.local.set({ popoSettings: mergeSettings(data.popoSettings || {}) });
  if (!data.popoState) await chrome.storage.local.set({ popoState: newState() });
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  schedulePump(1000);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  schedulePump(1000);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PUMP_ALARM) void pump();
  if (alarm.name === WATCHDOG_ALARM) void runWatchdog();
});

async function runWatchdog() {
  const { state } = await getStored();
  if (await repairQueueState(state)) return;
  if (state.mode === "waiting_worker" && state.workerDeadline && Date.now() > state.workerDeadline) {
    await finalizeActiveJob(
      state,
      "failed",
      "POPO 阻止了隐藏工作区加载；任务已停止，没有创建可见标签页",
      {
        type: "FOLDER_TASK_ERROR",
        message: "隐藏工作区未能加载，任务已停止；没有创建可见标签页"
      }
    );
    return;
  }
  if (!["downloading", "draining"].includes(state.mode)) return;
  let changed = false;
  for (const transfer of [...(state.activeTransfers || [])]) {
    const item = state.items.find((candidate) => candidate.id === transfer.itemId);
    if (item?.transferDeadline && Date.now() > item.transferDeadline) {
      try { await pauseGopeedTask(state.settings, transfer.taskId); } catch {}
      markAttemptFailure(
        state,
        item,
        FAILURE.TRANSFER_INTERRUPTED,
        "单文件传输超过设定时限；刷新临时地址后将继续原 Gopeed 任务",
        transfer.taskId
      );
      changed = true;
    }
  }
  if (changed) {
    await saveState(state);
    schedulePump(100);
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { state } = await getStored();
  let changed = false;
  if (state.workTabId === tabId) {
    state.workTabId = null;
    changed = true;
    pushLog(state, "warn", "后台工作标签页被关闭，将在下一步自动重建");
  }
  if (state.triggerMode === "folder_button" && state.sourceTabId === tabId && activeJob(state)) {
    rejectWorkerFrameWaitersForTab(tabId, "POPO 页面已关闭");
    const job = activeJob(state);
    if (job) job.sourceTabId = null;
    state.sourceTabId = null;
    state.workerSourceTabId = null;
    state.workerFrameId = null;
    state.workerReadyUrl = "";
    state.workerDeadline = 0;
    changed = true;
    pushLog(state, "warn", "POPO 页面已关闭；已开始的 Gopeed 下载继续，未开始文件等待重新打开原页面");
  }
  if (!changed) return;
  rotateRunToken(state);
  await saveState(state, true);
  if (["scanning", "downloading", "draining"].includes(state.mode)) schedulePump(500);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "GET_STATE":
      {
        let { state, settings } = await getStored({ loadItems: false });
        if (queueStateNeedsRepair(state)) {
          ({ state, settings } = await getStored());
          await repairQueueState(state);
        }
        return { ok: true, state: publicState(state), settings };
      }
      case "CHECK_GOPEED": {
        const { settings } = await getStored({ loadItems: false });
        // 弹窗会定时检查连接；这里必须保持只读，不能用稍早读到的状态
        // 覆盖正在建立或完成的下载任务。
        const connection = await checkGopeedConnection(settings);
        return { ok: true, connection, settings: connection.settings || settings };
      }
      case "SAVE_GOPEED_SETTINGS": {
        const settings = await saveGopeedSettings(message);
        const { state } = await getStored();
        const connection = await checkGopeedConnection(settings, state);
        await saveState(state);
        return { ok: true, connection, settings: connection.settings || settings };
      }
      case "CHOOSE_DOWNLOAD_DIRECTORY": {
        const result = await chooseDownloadDirectory(message);
        return { ok: true, ...result };
      }
      case "SAVE_SETTINGS":
        return { ok: true, settings: await saveSettings(message.settings) };
      case "START_SCAN":
        return { ok: true, state: await startScan(message) };
      case "START_FOLDER_SCAN":
      {
        const result = await withControlMutation(
          () => startFolderScan(message, sender.tab?.id ?? null)
        );
        return {
          ok: true,
          state: publicState(result.state),
          job: result.job,
          duplicate: result.duplicate,
          queuePosition: result.queuePosition,
          needsWorker: result.needsWorker
        };
      }
      case "SOURCE_PAGE_READY": {
        const result = await withControlMutation(
          () => registerSourcePage(sender, message.url)
        );
        return { ok: true, ...result };
      }
      case "REGISTER_WORKER_FRAME":
        return { ok: true, state: await registerWorkerFrame(sender, message.url) };
      case "CANCEL_FOLDER_TASK": {
        const state = await withControlMutation(() => cancelTask());
        return { ok: true, state: publicState(state) };
      }
      case "CANCEL_JOB": {
        const state = await withControlMutation(() => cancelJob(message.jobId));
        return { ok: true, state: publicState(state) };
      }
      case "START_DOWNLOAD": {
        const state = await startDownload();
        return { ok: true, state: publicState(state) };
      }
      case "PAUSE": {
        const state = await pauseTask();
        return { ok: true, state: publicState(state) };
      }
      case "RESUME": {
        const state = await resumeTask();
        return { ok: true, state: publicState(state) };
      }
      case "CANCEL": {
        const state = await withControlMutation(() => cancelTask());
        return { ok: true, state: publicState(state) };
      }
      case "RETRY_FAILED": {
        const state = await withControlMutation(() => retryFailed());
        return { ok: true, state: publicState(state) };
      }
      case "RETRY_JOB": {
        const state = await withControlMutation(() => retryJob(message.jobId));
        return { ok: true, state: publicState(state) };
      }
      case "RESET": {
        const previous = (await getStored()).state;
        await closeWorkTab(previous);
        const state = newState();
        state.settings = (await getStored()).settings;
        await saveState(state);
        return { ok: true, state };
      }
      default:
        return { ok: false, error: `未知命令：${message.type}` };
    }
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});
