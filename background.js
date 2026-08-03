importScripts("core.js", "gopeed.js");

"use strict";

const {
  FAILURE,
  buildDownloadFilename,
  findFirstHttpUrl,
  isSystemMetadataFile,
  looksLikeFileTitle,
  matchesFilters,
  previewTitleMatchesFile
} = PopoCore;
const {
  classifyTaskStatus: classifyGopeedTaskStatus,
  continueTask: continueGopeedTask,
  createTask: createGopeedTask,
  deleteTask: deleteGopeedTask,
  getConfig: getGopeedConfig,
  getTask: getGopeedTask,
  normalizeDownloadDirectory: normalizeGopeedDownloadDirectory,
  normalizeEndpoint: normalizeGopeedEndpoint,
  patchTask: patchGopeedTask,
  pauseTask: pauseGopeedTask,
  splitDownloadTarget
} = PopoGopeed;
const PUMP_ALARM = "popo-stable-downloader-pump";
const WATCHDOG_ALARM = "popo-stable-downloader-watchdog";
const FOLDER_PICKER_HOST = "com.popo.stable_downloader.folder_picker";
const TERMINAL_STATUSES = new Set(["success", "failed", "cancelled", "skipped"]);
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
    version: 3,
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
    teamSpaceId: "",
    workTabId: null,
    scanQueue: [],
    resolveQueue: [],
    scanFailures: [],
    scannedFolderCount: 0,
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

async function getStored() {
  const data = await chrome.storage.local.get(["popoState", "popoSettings"]);
  const settings = mergeSettings(data.popoSettings || {});
  const state = data.popoState?.version === 3
    ? { ...newState(), ...data.popoState, settings }
    : newState();
  state.settings = settings;
  state.activeTransfers = Array.isArray(state.activeTransfers) ? state.activeTransfers : [];
  return { state, settings };
}

function mergeSettings(input) {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...input,
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

async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ popoState: state });
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

function waitForWorkerFrame(tabId, frameId, targetUrl, timeoutMs) {
  const key = workerFrameKey(tabId, frameId);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      workerFrameWaiters.delete(key);
      reject(new Error(`隐藏工作区加载超时：${targetUrl}`));
    }, timeoutMs);
    workerFrameWaiters.set(key, {
      targetUrl,
      resolve: (url) => {
        clearTimeout(timeout);
        workerFrameWaiters.delete(key);
        resolve(url);
      }
    });
  });
}

async function registerWorkerFrame(sender, url) {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;
  if (tabId == null || frameId == null || frameId === 0) return null;
  const { state } = await getStored();
  if (state.triggerMode !== "folder_button" || state.sourceTabId !== tabId) return null;
  state.workerFrameId = frameId;
  state.workerReadyUrl = url;
  state.workerDeadline = 0;
  if (state.mode === "waiting_worker") {
    state.mode = "scanning";
    state.phase = "resolving_selection";
    pushLog(state, "info", "隐藏工作区已就绪");
    schedulePump(100);
  }
  await saveState(state);

  const waiter = workerFrameWaiters.get(workerFrameKey(tabId, frameId));
  if (waiter && (!waiter.targetUrl || waiter.targetUrl === url)) waiter.resolve(url);
  return state;
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
  if (state.triggerMode === "folder_button" && state.sourceTabId != null && state.workerFrameId != null) {
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
    await ready;
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
  if (state.triggerMode === "folder_button" && state.sourceTabId != null && state.workerFrameId != null) {
    const response = await withTimeout(
      chrome.tabs.sendMessage(
        state.sourceTabId,
        message,
        { frameId: state.workerFrameId }
      ),
      timeoutMs,
      label
    );
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
  while (Date.now() < deadline) {
    try {
      const url = await getWorkUrl(state);
      if (url && url !== beforeUrl && /\/pageDetail\/[a-z0-9]+/i.test(url)) return url;
    } catch {
      // The content script is briefly unavailable while the frame navigates.
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw new Error("点击后页面地址未变化");
}

function schedulePump(delayMs = 500) {
  chrome.alarms.create(PUMP_ALARM, { when: Date.now() + Math.max(100, delayMs) });
}

let pumpLocked = false;

async function processScanStep(state) {
  const settings = state.settings;
  state.phase = "scanning";

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
        const selected = !systemMetadata && matchesFilters(scanned.name, settings);
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

  state.mode = state.triggerMode === "folder_button" ? "awaiting_confirmation" : "scan_complete";
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
  await saveState(state);
  if (state.triggerMode === "folder_button") {
    await notifySource(state, {
      type: "SHOW_FOLDER_CONFIRMATION",
      fileCount: state.items.filter((item) => item.selected).length,
      folderCount: state.scannedFolderCount,
      scanFailureCount: state.scanFailures.length,
      scanFailureDetail: state.scanFailures[0]?.error || ""
    });
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

  if (item.attempts <= state.settings.maxRetries) {
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
  let taskId = item.retryTaskId;
  if (taskId) {
    await patchGopeedTask(state.settings, taskId, definition, {
      timeoutMs: state.settings.timeouts.downloadStart
    });
    await continueGopeedTask(state.settings, taskId, {
      timeoutMs: state.settings.timeouts.downloadStart
    });
  } else {
    taskId = await createGopeedTask(state.settings, definition, {
      timeoutMs: state.settings.timeouts.downloadStart
    });
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
        state.mode = "paused";
        state.phase = "paused";
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
  if (state.mode !== "downloading") {
    await saveState(state);
    return;
  }
  if (state.preparingItemId) return;
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
    state.mode = "complete";
    state.phase = "complete";
    state.completedAt = new Date().toISOString();
    pushLog(state, "info", `下载结束：成功 ${state.items.filter((entry) => entry.status === "success").length}，失败 ${state.items.filter((entry) => entry.status === "failed").length}`);
    await closeWorkTab(state);
    await saveState(state);
    if (state.triggerMode === "folder_button") {
      await notifySource(state, {
        type: "FOLDER_TASK_FINISHED",
        successCount: state.items.filter((entry) => entry.status === "success").length,
        failedCount: state.items.filter((entry) => entry.status === "failed").length
      });
    }
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
      const apiResponse = await sendToWork(state, {
        type: "REQUEST_DIRECT_DOWNLOAD",
        teamSpaceId: state.teamSpaceId,
        pageId: preview.pageId,
        timeoutMs: state.settings.timeouts.downloadStart
      }, state.settings.timeouts.downloadStart + 3000, "请求单文件下载地址");
      if (apiResponse?.ok) directUrl = findFirstHttpUrl(apiResponse.body);
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
    if (state.mode === "scanning") await processScanStep(state);
    else if (state.mode === "downloading") await processDownloadStep(state);
  } catch (error) {
    const { state } = await getStored();
    pushLog(state, "error", "后台任务发生未捕获错误", String(error));
    await saveState(state);
    if (state.mode === "scanning" || state.mode === "downloading") schedulePump(1000);
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
  state.teamSpaceId = match[1];
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

  const previous = (await getStored()).state;
  if (["waiting_worker", "scanning", "downloading", "paused", "awaiting_confirmation"].includes(previous.mode)) {
    throw new Error(`已有任务正在处理“${previous.selectedFolderName || "其他文件夹"}”，请先取消`);
  }
  await closeWorkTab(previous);

  const url = new URL(message.parentUrl);
  const match = url.pathname.match(/\/team\/pc\/([^/]+)\/pageDetail\/([a-z0-9]+)/i);
  const state = newState();
  state.settings = mergeSettings({
    ...previous.settings,
    recursive: true,
    formats: "",
    includeKeywords: "",
    excludeKeywords: "",
    preserveStructure: true
  });
  state.triggerMode = "folder_button";
  state.sourceTabId = sourceTabId;
  state.selectedFolderName = folderName;
  state.mode = "waiting_worker";
  state.phase = "waiting_worker";
  state.workerDeadline = Date.now() + state.settings.timeouts.directoryLoad;
  state.rootUrl = url.href;
  state.teamSpaceId = match[1];
  state.resolveQueue = [{
    key: `${url.href}\u0000${folderItemIndex}\u0000${folderName}`,
    parentUrl: url.href,
    parentPath: [],
    name: folderName,
    itemIndex: folderItemIndex
  }];
  state.startedAt = new Date().toISOString();
  pushLog(state, "info", `用户选择稳定下载：${folderName}`);
  await saveState(state);
  return state;
}

async function startDownload() {
  const { state } = await getStored();
  if (!["scan_complete", "awaiting_confirmation", "complete"].includes(state.mode)) {
    throw new Error("请先完成文件数量检查");
  }
  const pending = state.items.filter((item) => item.selected && !["success", "cancelled"].includes(item.status));
  if (!pending.length) throw new Error("没有符合筛选条件的待下载文件");
  const connection = await checkGopeedConnection(state.settings, state);
  if (!connection.connected) {
    await saveState(state);
    throw new Error(
      `Gopeed 未连接：${connection.error}。请重新运行测试包中的 START-HERE.cmd 后再试。`
    );
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
  await saveState(state);
  schedulePump(100);
  return state;
}

async function pauseTask() {
  const { state } = await getStored();
  if (state.mode !== "downloading") return state;
  state.mode = "paused";
  state.phase = "paused";
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
  if (state.mode !== "paused") return state;
  state.mode = "downloading";
  state.phase = "resuming";
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
  for (const transfer of state.activeTransfers || []) {
    try {
      await deleteGopeedTask(state.settings, transfer.taskId, { timeoutMs: 8000 });
    } catch (error) {
      pushLog(state, "warn", `取消 Gopeed 任务失败：${transfer.taskId}`, String(error));
    }
  }
  for (const item of state.items) {
    if (!TERMINAL_STATUSES.has(item.status)) {
      item.status = "cancelled";
      item.stage = "已取消";
      item.failureStage = FAILURE.CANCELLED;
      item.completedAt = new Date().toISOString();
    }
  }
  state.mode = "cancelled";
  state.phase = "cancelled";
  state.preparingItemId = null;
  state.activeTransfers = [];
  state.activeItemId = null;
  state.scanQueue = [];
  state.resolveQueue = [];
  state.completedAt = new Date().toISOString();
  pushLog(state, "warn", "任务已取消");
  await closeWorkTab(state);
  await saveState(state);
  await notifySource(state, { type: "FOLDER_TASK_CANCELLED" });
  return state;
}

async function retryFailed() {
  const { state } = await getStored();
  const connection = await checkGopeedConnection(state.settings, state);
  if (!connection.connected) {
    await saveState(state);
    throw new Error(`Gopeed 未连接：${connection.error}`);
  }
  let count = 0;
  for (const item of state.items) {
    if (item.status === "failed") {
      item.status = "pending";
      item.stage = "等待人工重试";
      item.attempts = 0;
      count += 1;
    }
  }
  if (!count) throw new Error("没有失败文件可重试");
  state.mode = "downloading";
  state.phase = "retrying";
  state.preparingItemId = null;
  state.activeTransfers = [];
  state.activeItemId = null;
  pushLog(state, "info", `重新尝试 ${count} 个失败文件`);
  await saveState(state);
  schedulePump(100);
  return state;
}

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(["popoSettings", "popoState"]);
  if (!data.popoSettings) await chrome.storage.local.set({ popoSettings: structuredClone(DEFAULT_SETTINGS) });
  if (!data.popoState) await chrome.storage.local.set({ popoState: newState() });
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
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
  if (state.mode === "waiting_worker" && state.workerDeadline && Date.now() > state.workerDeadline) {
    state.mode = "cancelled";
    state.phase = "cancelled";
    pushLog(
      state,
      "error",
      "POPO 阻止了隐藏工作区加载；任务已停止，没有创建可见标签页"
    );
    await closeWorkTab(state);
    await saveState(state);
    await notifySource(state, {
      type: "FOLDER_TASK_ERROR",
      message: "隐藏工作区未能加载，任务已停止；没有创建可见标签页"
    });
    return;
  }
  if (state.mode !== "downloading") return;
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
  if (state.workTabId !== tabId) return;
  state.workTabId = null;
  if (state.mode === "scanning" || state.mode === "downloading") {
    pushLog(state, "warn", "后台工作标签页被关闭，将在下一步自动重建");
    await saveState(state);
    schedulePump(500);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "GET_STATE":
        return { ok: true, ...(await getStored()) };
      case "CHECK_GOPEED": {
        const { state, settings } = await getStored();
        const connection = await checkGopeedConnection(settings, state);
        await saveState(state);
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
        return { ok: true, state: await startFolderScan(message, sender.tab?.id ?? null) };
      case "REGISTER_WORKER_FRAME":
        return { ok: true, state: await registerWorkerFrame(sender, message.url) };
      case "CONFIRM_FOLDER_DOWNLOAD":
        return { ok: true, state: await startDownload() };
      case "CANCEL_FOLDER_TASK":
        return { ok: true, state: await cancelTask() };
      case "START_DOWNLOAD":
        return { ok: true, state: await startDownload() };
      case "PAUSE":
        return { ok: true, state: await pauseTask() };
      case "RESUME":
        return { ok: true, state: await resumeTask() };
      case "CANCEL":
        return { ok: true, state: await cancelTask() };
      case "RETRY_FAILED":
        return { ok: true, state: await retryFailed() };
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
