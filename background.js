importScripts("runtime/popo-runtime.js", "core.js", "gopeed.js", "queue.js");

"use strict";

const {
  FAILURE,
  buildDownloadFilename,
  extractTeamSpaceId,
  findFirstHttpUrl,
  isSystemMetadataFile,
  looksLikeFileTitle,
  previewTitleMatchesFile,
  validateRuntimeMessage,
  verifyDirectoryItemCount
} = PopoCore;
const {
  buildTaskIdentityLabels: buildGopeedTaskIdentityLabels,
  classifyTaskStatus: classifyGopeedTaskStatus,
  continueTask: continueGopeedTask,
  deleteTask: deleteGopeedTask,
  getConfig: getGopeedConfig,
  getTask: getGopeedTask,
  listTasks: listGopeedTasks,
  normalizeDownloadDirectory: normalizeGopeedDownloadDirectory,
  normalizeEndpoint: normalizeGopeedEndpoint,
  normalizeTargetKey: normalizeGopeedTargetKey,
  pauseTask: pauseGopeedTask,
  reusableTaskTargetKeys,
  selectTaskByIdentity: selectGopeedTaskByIdentity,
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
  summarizeItems,
  transitionJobStatus
} = PopoQueue;
const PUMP_ALARM = "popo-stable-downloader-pump";
const WATCHDOG_ALARM = "popo-stable-downloader-watchdog";
const UPDATE_ALARM = "popo-stable-downloader-update";
const FOLDER_PICKER_HOST = "com.popo.stable_downloader.folder_picker";
const TERMINAL_STATUSES = new Set(["success", "failed", "cancelled", "skipped"]);
const ITEM_CHUNK_SIZE = 200;
const ITEM_STORAGE_PREFIX = "popoItems";
const MAX_RETAINED_TERMINAL_JOBS = 20;
const WORKER_UNAVAILABLE_CODE = "POPO_WORKER_UNAVAILABLE";
const POPUP_UI_PORT_NAME = "popo-popup-ui";
const MIN_DOWNLOAD_CONCURRENCY = 1;
const MAX_DOWNLOAD_CONCURRENCY = 5;
const workerFrameWaiters = new Map();
const popupUiPorts = new Set();
const SERVICE_WORKER_STARTED_AT = new Date().toISOString();
const UPDATE_CHECK_PERIOD_MINUTES = 6 * 60;
const runtimeContracts = globalThis.PopoRuntime?.contracts || null;
const runtimeNetworkMonitor = globalThis.PopoRuntime?.networkMonitor || null;
const runtimeTaskStore = globalThis.PopoRuntime?.taskStore || null;
const runtimeWorkflow = globalThis.PopoRuntime?.workflow || null;
let automaticUpdateLocked = false;

function enforceRuntimeCommandContract(command) {
  if (typeof runtimeContracts?.parseRuntimeCommand !== "function") return command;
  try {
    return runtimeContracts.parseRuntimeCommand(command);
  } catch (error) {
    const detail = typeof runtimeContracts.contractErrorMessage === "function"
      ? runtimeContracts.contractErrorMessage(error)
      : String(error);
    throw new Error(`后台命令未通过运行时契约检查：${detail}`);
  }
}

function sanitizeStoredJobs(jobs) {
  if (typeof runtimeContracts?.sanitizeStoredJobs !== "function") {
    return { jobs: Array.isArray(jobs) ? jobs : [], rejected: 0 };
  }
  return runtimeContracts.sanitizeStoredJobs(jobs);
}

function indexedDbTaskStoreAvailable() {
  return typeof runtimeTaskStore?.isAvailable === "function" && runtimeTaskStore.isAvailable();
}

function newPersistentWorkflow() {
  if (typeof runtimeWorkflow?.createPersistentWorkflow === "function") {
    return runtimeWorkflow.createPersistentWorkflow();
  }
  return {
    version: 1,
    sequence: 0,
    value: { scan: "idle", handoff: "idle", transfer: "idle" },
    nextAction: "scan",
    reservedItemId: "",
    counts: {
      discovered: 0,
      selected: 0,
      skipped: 0,
      pending: 0,
      preparing: 0,
      transferring: 0,
      success: 0,
      failed: 0,
      cancelled: 0,
      handedOff: 0,
      verifiedDirectories: 0,
      unverifiedDirectories: 0,
      scanRetries: 0
    },
    updatedAt: new Date().toISOString()
  };
}

function newNetworkHealth() {
  if (typeof runtimeNetworkMonitor?.createNetworkHealth === "function") {
    return runtimeNetworkMonitor.createNetworkHealth();
  }
  return {
    version: 1,
    jobId: "",
    status: "idle",
    activeTasks: 0,
    medianSpeed: 0,
    baselineSpeed: 20 * 1024 * 1024,
    observedAt: new Date().toISOString(),
    highProbabilityWindow: false,
    peakNoticeSequence: 0,
    noticeSequence: 0,
    suppressed: false
  };
}

function normalizeNetworkHealth(value) {
  if (typeof runtimeNetworkMonitor?.normalizeNetworkHealth === "function") {
    return runtimeNetworkMonitor.normalizeNetworkHealth(value);
  }
  return { ...newNetworkHealth(), ...(value && typeof value === "object" ? value : {}) };
}

function refreshNetworkHealth(state) {
  const previous = normalizeNetworkHealth(state.networkHealth);
  const speeds = (state.activeTransfers || []).flatMap((transfer) => {
    const item = state.items.find((candidate) => candidate.id === transfer.itemId);
    if (item?.status !== "transferring") return [];
    const speed = Number(item.gopeedProgress?.speed);
    return Number.isFinite(speed) && speed >= 0 ? [speed] : [];
  });
  state.networkHealth = typeof runtimeNetworkMonitor?.updateNetworkHealth === "function"
    ? runtimeNetworkMonitor.updateNetworkHealth(previous, {
      jobId: activeJob(state)?.id || "",
      speeds
    })
    : { ...previous, activeTasks: speeds.length };

  if (state.networkHealth.peakNoticeSequence > previous.peakNoticeSequence) {
    pushRuntimeEvent(
      state,
      "NETWORK_CONGESTION_WINDOW",
      "info",
      "已进入本地网络慢速高发时段",
      "16:30–18:30 仅为概率提示，实际速度会继续监测",
      { jobId: activeJob(state)?.id || "" }
    );
  }
  if (state.networkHealth.noticeSequence > previous.noticeSequence) {
    pushRuntimeEvent(
      state,
      state.networkHealth.status === "severe" ? "NETWORK_SPEED_SEVERE" : "NETWORK_SPEED_SLOW",
      "warn",
      state.networkHealth.status === "severe"
        ? "多个下载任务速度接近停滞"
        : "多个下载任务速度明显低于近期常态",
      `medianSpeed=${Math.round(state.networkHealth.medianSpeed)}; activeTasks=${state.networkHealth.activeTasks}`,
      { jobId: activeJob(state)?.id || "" }
    );
  }
  return state.networkHealth;
}

function normalizePersistentWorkflow(value) {
  if (typeof runtimeWorkflow?.normalizePersistentWorkflow === "function") {
    return runtimeWorkflow.normalizePersistentWorkflow(value);
  }
  return { ...newPersistentWorkflow(), ...(value && typeof value === "object" ? value : {}) };
}

function updatePersistentWorkflow(state, patch = {}) {
  if (typeof runtimeWorkflow?.updatePersistentWorkflow === "function") {
    state.workflow = runtimeWorkflow.updatePersistentWorkflow(state.workflow, patch);
    return state.workflow;
  }
  const current = normalizePersistentWorkflow(state.workflow);
  state.workflow = {
    ...current,
    ...patch,
    value: { ...current.value, ...(patch.value || {}) },
    counts: { ...current.counts, ...(patch.counts || {}) },
    sequence: current.sequence + 1,
    updatedAt: new Date().toISOString()
  };
  return state.workflow;
}

function transitionPersistentWorkflow(state, event, patch = {}) {
  if (typeof runtimeWorkflow?.transitionPersistentWorkflow === "function") {
    state.workflow = runtimeWorkflow.transitionPersistentWorkflow(state.workflow, event, patch);
    return state.workflow;
  }
  return updatePersistentWorkflow(state, patch);
}

function refreshPersistentWorkflowCounts(state) {
  state.workflow = normalizePersistentWorkflow(state.workflow);
  const items = Array.isArray(state.items) ? state.items : [];
  const selected = items.filter((item) => item.selected);
  const count = (status) => selected.filter((item) => item.status === status).length;
  const transferring = selected.filter((item) => ["transferring", "paused"].includes(item.status)).length;
  const previous = state.workflow.counts;
  const handedOffNow = selected.filter((item) => item.gopeedTaskId || item.status === "success").length;
  updatePersistentWorkflow(state, {
    counts: {
      discovered: items.length,
      selected: selected.length,
      skipped: items.length - selected.length,
      pending: count("pending"),
      preparing: count("preparing"),
      transferring,
      success: count("success"),
      failed: count("failed"),
      cancelled: count("cancelled"),
      handedOff: Math.max(previous.handedOff || 0, handedOffNow)
    }
  });
  return state.workflow.counts;
}

function quantityReconciliation(state) {
  const counts = refreshPersistentWorkflowCounts(state);
  const discoveredBalanced = counts.discovered === counts.selected + counts.skipped;
  const selectedBalanced = counts.selected === counts.pending + counts.preparing +
    counts.transferring + counts.success + counts.failed + counts.cancelled;
  return { ok: discoveredBalanced && selectedBalanced, counts };
}

async function restrictLocalStorageAccess() {
  const localStorage = chrome.storage?.local;
  if (typeof localStorage?.setAccessLevel !== "function") return false;
  try {
    await localStorage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    return true;
  } catch (error) {
    console.warn("无法限制扩展本地状态访问", error);
    return false;
  }
}

void restrictLocalStorageAccess();

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

function newRuntimeHealth() {
  return {
    schemaVersion: 2,
    serviceWorkerStartedAt: SERVICE_WORKER_STARTED_AT,
    lastEventAt: "",
    lastEventCode: "",
    eventCounts: {},
    reconciliation: {
      lastCheckedAt: "",
      lastOutcome: "never",
      recoveredCount: 0,
      missCount: 0,
      errorCount: 0,
      ambiguousCount: 0,
      consecutiveErrors: 0,
      lastError: ""
    },
    storage: {
      backend: "unknown",
      lastMigrationAt: "",
      readFailureCount: 0,
      writeFallbackCount: 0,
      lastError: ""
    }
  };
}

function normalizeRuntimeHealth(value) {
  const defaults = newRuntimeHealth();
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const sourceCounts = source.eventCounts && typeof source.eventCounts === "object"
    ? source.eventCounts
    : {};
  const eventCounts = Object.fromEntries(Object.entries(sourceCounts)
    .filter(([code, count]) => /^[A-Z0-9_]{1,64}$/.test(code) && Number.isFinite(Number(count)))
    .slice(0, 100)
    .map(([code, count]) => [code, Math.max(0, Number(count) || 0)]));
  const reconciliation = source.reconciliation &&
    typeof source.reconciliation === "object" &&
    !Array.isArray(source.reconciliation)
    ? source.reconciliation
    : {};
  const storage = source.storage && typeof source.storage === "object" && !Array.isArray(source.storage)
    ? source.storage
    : {};
  const count = (key) => Math.max(0, Number(reconciliation[key]) || 0);
  return {
    ...defaults,
    lastEventAt: String(source.lastEventAt || ""),
    lastEventCode: String(source.lastEventCode || ""),
    eventCounts,
    reconciliation: {
      ...defaults.reconciliation,
      lastCheckedAt: String(reconciliation.lastCheckedAt || ""),
      lastOutcome: String(reconciliation.lastOutcome || "never"),
      recoveredCount: count("recoveredCount"),
      missCount: count("missCount"),
      errorCount: count("errorCount"),
      ambiguousCount: count("ambiguousCount"),
      consecutiveErrors: count("consecutiveErrors"),
      lastError: String(reconciliation.lastError || "").slice(0, 500)
    },
    storage: {
      ...defaults.storage,
      backend: String(storage.backend || "unknown").slice(0, 32),
      lastMigrationAt: String(storage.lastMigrationAt || ""),
      readFailureCount: Math.max(0, Number(storage.readFailureCount) || 0),
      writeFallbackCount: Math.max(0, Number(storage.writeFallbackCount) || 0),
      lastError: String(storage.lastError || "").slice(0, 500)
    }
  };
}

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
    pauseOrigin: "",
    pauseResumeMode: "",
    gopeedDownloadDir: "",
    gopeedConnected: false,
    gopeedLastError: "",
    startedAt: "",
    completedAt: "",
    updatedAt: new Date().toISOString(),
    lastMessage: "请在 POPO 文件夹页面开始扫描",
    networkHealth: newNetworkHealth(),
    workflow: newPersistentWorkflow(),
    runtimeHealth: newRuntimeHealth(),
    itemStorageBackend: "",
    itemStorageGeneration: "",
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

function hashItemChunk(items) {
  if (typeof runtimeTaskStore?.hashItemChunk === "function") {
    return runtimeTaskStore.hashItemChunk(items);
  }
  return hashText(JSON.stringify(items));
}

function migrateStoredState(storedState, settings) {
  if (storedState?.version === 4) {
    const teamSpaceKey = storedState.teamSpaceKey || storedState.teamSpaceId || "";
    const checkedJobs = sanitizeStoredJobs(storedState.jobs);
    const migrated = {
      ...newState(),
      ...storedState,
      settings,
      teamSpaceKey,
      teamSpaceId: storedState.teamSpaceKey ? storedState.teamSpaceId || "" : "",
      jobs: checkedJobs.jobs,
      networkHealth: normalizeNetworkHealth(storedState.networkHealth),
      workflow: normalizePersistentWorkflow(storedState.workflow),
      runtimeHealth: normalizeRuntimeHealth(storedState.runtimeHealth)
    };
    if (checkedJobs.rejected > 0) {
      migrated.runtimeHealth.lastEventAt = new Date().toISOString();
      migrated.runtimeHealth.lastEventCode = "STORED_JOB_REJECTED";
      migrated.runtimeHealth.eventCounts.STORED_JOB_REJECTED =
        (migrated.runtimeHealth.eventCounts.STORED_JOB_REJECTED || 0) + checkedJobs.rejected;
    }
    return migrated;
  }
  if (storedState?.version !== 3) return newState();

  const state = {
    ...newState(),
    ...storedState,
    version: 4,
    runToken: createId("run"),
    settings,
    jobs: [],
    activeJobId: null,
    networkHealth: normalizeNetworkHealth(storedState.networkHealth),
    workflow: normalizePersistentWorkflow(storedState.workflow)
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
  state.networkHealth = normalizeNetworkHealth(state.networkHealth);
  state.workflow = normalizePersistentWorkflow(state.workflow);
  state._itemsLoaded = loadItems;
  if (loadItems && data.popoState?.version === 4 && state.itemStorageJobId && state.itemChunkCount > 0) {
    if (state.itemStorageBackend === "indexeddb") {
      if (!indexedDbTaskStoreAvailable() || !state.itemStorageGeneration) {
        recordItemStorageFailure(state, "read", "IndexedDB 任务存储当前不可用");
        throw new Error("无法读取大任务文件状态：IndexedDB 当前不可用");
      }
      try {
        state.items = await runtimeTaskStore.readItemChunks({
          jobId: state.itemStorageJobId,
          generation: state.itemStorageGeneration,
          chunkCount: state.itemChunkCount,
          hashes: state.itemChunkHashes
        });
        state.runtimeHealth.storage.backend = "indexeddb";
        state.runtimeHealth.storage.lastError = "";
      } catch (error) {
        recordItemStorageFailure(state, "read", error);
        throw new Error(`无法读取大任务文件状态：${String(error)}`);
      }
    } else {
      const legacy = await readLegacyItemChunks(state.itemStorageJobId, state.itemChunkCount);
      if (!legacy.complete) {
        recordItemStorageFailure(state, "read", "旧版任务分块缺失");
        throw new Error("无法读取旧版任务文件状态：本地分块缺失");
      }
      state.items = legacy.items;
      if (indexedDbTaskStoreAvailable()) {
        try {
          await migrateLegacyItemsToIndexedDb(state, legacy.keys);
        } catch (error) {
          recordItemStorageFailure(state, "write", error);
          state.runtimeHealth.storage.backend = "chrome-storage-fallback";
        }
      }
    }
  }
  if (state.activeJobId && indexedDbTaskStoreAvailable() &&
      typeof runtimeTaskStore?.readWorkflowCheckpoint === "function") {
    try {
      const checkpoint = await runtimeTaskStore.readWorkflowCheckpoint(state.activeJobId);
      const checkpointSequence = Number(checkpoint?.sequence) || 0;
      const storedSequence = Number(state.workflow?.sequence) || 0;
      if (checkpoint && checkpointSequence > storedSequence) {
        state.workflow = normalizePersistentWorkflow(checkpoint);
      }
    } catch (error) {
      recordItemStorageFailure(state, "read", `工作流检查点读取失败：${String(error)}`);
    }
  }
  return { state, settings };
}

function splitItemChunks(items) {
  const chunks = [];
  for (let index = 0; index < items.length; index += ITEM_CHUNK_SIZE) {
    chunks.push(items.slice(index, index + ITEM_CHUNK_SIZE));
  }
  return chunks;
}

async function readLegacyItemChunks(jobId, chunkCount) {
  const keys = Array.from({ length: chunkCount }, (_, index) => itemChunkKey(jobId, index));
  const stored = await chrome.storage.local.get(keys);
  const complete = keys.every((key) => Array.isArray(stored[key]));
  return {
    keys,
    complete,
    items: complete ? keys.flatMap((key) => stored[key]) : []
  };
}

function recordItemStorageFailure(state, operation, error) {
  state.runtimeHealth = normalizeRuntimeHealth(state.runtimeHealth);
  const detail = String(error?.message || error || "未知存储错误").slice(0, 500);
  state.runtimeHealth.storage.lastError = detail;
  if (operation === "read") state.runtimeHealth.storage.readFailureCount += 1;
  else state.runtimeHealth.storage.writeFallbackCount += 1;
  pushRuntimeEvent(
    state,
    operation === "read" ? "INDEXEDDB_READ_FAILED" : "INDEXEDDB_WRITE_FALLBACK",
    "warn",
    operation === "read" ? "IndexedDB 任务状态读取失败" : "IndexedDB 写入失败，已准备回退",
    detail,
    { operation }
  );
}

async function writeItemsToIndexedDb(state, chunks, hashes, { migration = false } = {}) {
  const jobId = String(state.activeJobId || state.itemStorageJobId || "");
  if (!jobId) throw new Error("IndexedDB 写入缺少活动任务 ID");
  const generation = runtimeTaskStore.createGeneration(jobId, hashes);
  await runtimeTaskStore.writeItemChunks({ jobId, generation, chunks, hashes });
  state.itemStorageBackend = "indexeddb";
  state.itemStorageGeneration = generation;
  state.itemStorageJobId = jobId;
  state.itemChunkCount = chunks.length;
  state.itemChunkHashes = hashes;
  state.runtimeHealth = normalizeRuntimeHealth(state.runtimeHealth);
  state.runtimeHealth.storage.backend = "indexeddb";
  state.runtimeHealth.storage.lastError = "";
  if (migration) {
    state.runtimeHealth.storage.lastMigrationAt = new Date().toISOString();
    pushRuntimeEvent(
      state,
      "INDEXEDDB_ITEMS_MIGRATED",
      "info",
      "旧版任务文件状态已迁移到 IndexedDB",
      "",
      { jobId, chunkCount: chunks.length }
    );
  }
  return generation;
}

async function migrateLegacyItemsToIndexedDb(state, legacyKeys = []) {
  const chunks = splitItemChunks(state.items || []);
  const hashes = chunks.map(hashItemChunk);
  await writeItemsToIndexedDb(state, chunks, hashes, { migration: true });
  const metadata = structuredClone(state);
  delete metadata.items;
  delete metadata._itemsLoaded;
  await chrome.storage.local.set({ popoState: metadata });
  if (legacyKeys.length && chrome.storage.local.remove) {
    try {
      await chrome.storage.local.remove(legacyKeys);
    } catch (error) {
      console.warn("IndexedDB 迁移已提交，但旧版任务分块暂未清理", error);
    }
  }
}

function mergeSettings(input) {
  const requestedConcurrency = Number(input?.concurrency);
  const concurrency = Number.isInteger(requestedConcurrency)
    ? Math.min(MAX_DOWNLOAD_CONCURRENCY, Math.max(MIN_DOWNLOAD_CONCURRENCY, requestedConcurrency))
    : DEFAULT_SETTINGS.concurrency;
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
    concurrency,
    gopeedConnections: 1,
    timeouts: {
      ...DEFAULT_SETTINGS.timeouts,
      ...(input.timeouts || {})
    }
  };
}

function sanitizeRuntimeContext(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) return undefined;
  const entries = Object.entries(context).slice(0, 12).flatMap(([key, value]) => {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) return [];
    if (typeof value === "string") return [[key, value.slice(0, 200)]];
    if (typeof value === "number" && Number.isFinite(value)) return [[key, value]];
    if (typeof value === "boolean") return [[key, value]];
    return [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function pushLog(state, level, message, details, event = null) {
  const at = new Date().toISOString();
  const code = /^[A-Z0-9_]{1,64}$/.test(String(event?.code || ""))
    ? String(event.code)
    : "";
  const context = sanitizeRuntimeContext(event?.context);
  const entry = { at, level, message, details: details || "" };
  if (code) entry.code = code;
  if (context) entry.context = context;
  state.logs = [
    ...(state.logs || []),
    entry
  ].slice(-300);
  state.lastMessage = message;
  if (code) {
    state.runtimeHealth = normalizeRuntimeHealth(state.runtimeHealth);
    state.runtimeHealth.lastEventAt = at;
    state.runtimeHealth.lastEventCode = code;
    state.runtimeHealth.eventCounts[code] =
      (state.runtimeHealth.eventCounts[code] || 0) + 1;
  }
}

function pushRuntimeEvent(state, code, level, message, details = "", context = {}) {
  pushLog(state, level, message, details, { code, context });
}

function activeJob(state) {
  return (state.jobs || []).find((job) => job.id === state.activeJobId) || null;
}

function setJobStatus(job, nextStatus, changes = {}) {
  Object.assign(job, transitionJobStatus(job, nextStatus, changes));
  return job;
}

function syncActiveJobSummary(state) {
  const job = activeJob(state);
  if (!job) return;
  setJobStatus(job, state.mode);
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
    const workflowCounts = refreshPersistentWorkflowCounts(state);
    job.counts.handedOff = workflowCounts.handedOff;
    job.counts.verifiedDirectories = workflowCounts.verifiedDirectories;
    job.counts.unverifiedDirectories = workflowCounts.unverifiedDirectories;
    job.counts.scanRetries = workflowCounts.scanRetries;
    job.failurePreview = (state.items || [])
      .filter((item) => item.status === "failed")
      .slice(0, 6)
      .map((item) => ({ name: item.name, stage: item.failureStage, error: item.error }));
    job.failureRetryKeys = [...new Set((state.items || [])
      .filter((item) => item.status === "failed")
      .map((item) => `${item.parentUrl}\u0000${item.name}`))];
    job.cancelledRetryKeys = [...new Set((state.items || [])
      .filter((item) => item.status === "cancelled")
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
  snapshot.jobs = clientVisibleJobs(snapshot.jobs || []).map((job) => {
    const publicJob = {
      ...job,
      existingGopeedTargetCount: job.existingGopeedTargetKeys?.length || 0,
      queuePosition: queuePosition(state.jobs, job.id)
    };
    delete publicJob.existingGopeedTargetKeys;
    return publicJob;
  });
  snapshot.popupOpen = popupUiPorts.size > 0;
  return snapshot;
}

function completedJobCount(job) {
  const counts = job?.counts || {};
  return counts.success || 0;
}

function jobProgressPercent(job) {
  const total = Number(job?.counts?.files) || 0;
  if (!total) return null;
  return Math.max(0, Math.min(100, Math.round(completedJobCount(job) * 100 / total)));
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
    const completed = completedJobCount(job);
    const queued = liveJobs.filter((candidate) => candidate.status === "queued").length;
    text = percent == null ? (liveJobs.length > 9 ? "9+" : String(liveJobs.length)) : `${percent}%`;
    title = percent == null
      ? `${job.folderName || "下载任务"}：${job.lastMessage || "正在准备"}；${queued} 个排队`
      : `${job.folderName || "下载任务"}：${completed}/${total}（${percent}%）；失败 ${job.counts?.failed || 0}；排队 ${queued}`;
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

async function writeLegacyItemChunks(state, chunks, hashes, previousStorage) {
  const jobId = String(state.activeJobId || "");
  const updates = {};
  for (let index = 0; index < chunks.length; index += 1) {
    if (previousStorage.backend !== "chrome-storage-fallback" ||
        previousStorage.jobId !== jobId || previousStorage.hashes?.[index] !== hashes[index]) {
      updates[itemChunkKey(jobId || "idle", index)] = chunks[index];
    }
  }
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);

  const staleKeys = [];
  if (previousStorage.jobId && previousStorage.jobId !== jobId) {
    for (let index = 0; index < previousStorage.chunkCount; index += 1) {
      staleKeys.push(itemChunkKey(previousStorage.jobId, index));
    }
  } else if (previousStorage.jobId === jobId && previousStorage.chunkCount > chunks.length) {
    for (let index = chunks.length; index < previousStorage.chunkCount; index += 1) {
      staleKeys.push(itemChunkKey(previousStorage.jobId, index));
    }
  }
  if (staleKeys.length && chrome.storage.local.remove) await chrome.storage.local.remove(staleKeys);
  state.itemStorageBackend = "chrome-storage-fallback";
  state.itemStorageGeneration = "";
  state.itemStorageJobId = jobId;
  state.itemChunkCount = chunks.length;
  state.itemChunkHashes = hashes;
  state.runtimeHealth = normalizeRuntimeHealth(state.runtimeHealth);
  state.runtimeHealth.storage.backend = "chrome-storage-fallback";
}

async function cleanupCommittedItemStorage(previousStorage, state) {
  if (!indexedDbTaskStoreAvailable()) return;
  try {
    if (state.itemStorageBackend === "indexeddb" && state.itemStorageJobId && state.itemStorageGeneration) {
      await runtimeTaskStore.pruneJobGenerations(
        state.itemStorageJobId,
        state.itemStorageGeneration
      );
    }
    if (previousStorage.jobId && previousStorage.jobId !== state.itemStorageJobId) {
      await runtimeTaskStore.deleteJobItems(previousStorage.jobId);
      if (typeof runtimeTaskStore.deleteJobWorkflow === "function") {
        await runtimeTaskStore.deleteJobWorkflow(previousStorage.jobId);
      }
      if (chrome.storage.local.remove) {
        const legacyKeys = Array.from(
          { length: previousStorage.chunkCount },
          (_, index) => itemChunkKey(previousStorage.jobId, index)
        );
        if (legacyKeys.length) await chrome.storage.local.remove(legacyKeys);
      }
    }
  } catch (error) {
    console.warn("清理旧版任务存储失败，将在后续保存时重试", error);
  }
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

  const previousStorage = {
    backend: String(state.itemStorageBackend || ""),
    generation: String(state.itemStorageGeneration || ""),
    jobId: String(state.itemStorageJobId || ""),
    chunkCount: Math.max(0, Number(state.itemChunkCount) || 0),
    hashes: Array.isArray(state.itemChunkHashes) ? [...state.itemChunkHashes] : []
  };

  if (state._itemsLoaded !== false) {
    const chunks = splitItemChunks(state.items || []);
    const hashes = chunks.map(hashItemChunk);
    if (state.activeJobId && indexedDbTaskStoreAvailable()) {
      try {
        await writeItemsToIndexedDb(state, chunks, hashes);
      } catch (error) {
        recordItemStorageFailure(state, "write", error);
        await writeLegacyItemChunks(state, chunks, hashes, previousStorage);
      }
    } else if (state.activeJobId) {
      await writeLegacyItemChunks(state, chunks, hashes, previousStorage);
    } else {
      state.itemStorageBackend = indexedDbTaskStoreAvailable() ? "indexeddb" : "chrome-storage-fallback";
      state.itemStorageGeneration = "";
      state.itemStorageJobId = "";
      state.itemChunkCount = 0;
      state.itemChunkHashes = [];
      state.runtimeHealth = normalizeRuntimeHealth(state.runtimeHealth);
      state.runtimeHealth.storage.backend = state.itemStorageBackend;
    }
  }

  const metadata = structuredClone(state);
  delete metadata.items;
  delete metadata._itemsLoaded;
  await chrome.storage.local.set({ popoState: metadata });
  if (state.activeJobId && indexedDbTaskStoreAvailable() &&
      typeof runtimeTaskStore?.writeWorkflowCheckpoint === "function") {
    try {
      await runtimeTaskStore.writeWorkflowCheckpoint({
        jobId: state.activeJobId,
        snapshot: state.workflow
      });
    } catch (error) {
      recordItemStorageFailure(state, "write", `工作流检查点写入失败：${String(error)}`);
    }
  }
  await cleanupCommittedItemStorage(previousStorage, state);
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

async function setDownloadConcurrency(value) {
  const concurrency = Math.min(
    MAX_DOWNLOAD_CONCURRENCY,
    Math.max(MIN_DOWNLOAD_CONCURRENCY, Number(value) || DEFAULT_SETTINGS.concurrency)
  );
  const { state, settings } = await getStored({ loadItems: false });
  const previous = settings.concurrency;
  const merged = mergeSettings({ ...settings, concurrency });
  await chrome.storage.local.set({ popoSettings: merged });
  state.settings = merged;
  if (previous !== concurrency) {
    pushRuntimeEvent(
      state,
      "DOWNLOAD_CONCURRENCY_CHANGED",
      "info",
      `并行下载数已调整为 ${concurrency}`,
      "已开始的下载保持不变，新任务按新的并行上限调度",
      { previous: Number(previous) || DEFAULT_SETTINGS.concurrency, concurrency }
    );
  }
  await saveState(state);
  if (["scanning", "downloading", "draining"].includes(state.mode)) schedulePump(100);
  return { state: publicState(state), settings: merged };
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

function gopeedTaskIdentityLabels(state, item) {
  const taskIdentity = item.id || [item.parentUrl, item.itemIndex, item.name].join("\u0000");
  return buildGopeedTaskIdentityLabels({
    jobId: activeJob(state)?.id,
    taskIdentity
  });
}

async function reserveDownloadOperation(state, item) {
  const jobId = activeJob(state)?.id || "";
  if (!jobId || !indexedDbTaskStoreAvailable() ||
      typeof runtimeTaskStore?.reserveOperation !== "function") return null;
  const labels = gopeedTaskIdentityLabels(state, item);
  return runtimeTaskStore.reserveOperation({
    jobId,
    itemId: item.id,
    taskKey: labels.popoTaskKey || item.id
  });
}

async function acceptDownloadOperation(state, item, taskId) {
  const jobId = activeJob(state)?.id || "";
  if (!jobId || !indexedDbTaskStoreAvailable() ||
      typeof runtimeTaskStore?.markOperationAccepted !== "function") return null;
  try {
    return await runtimeTaskStore.markOperationAccepted({ jobId, itemId: item.id, taskId });
  } catch (error) {
    if (/没有找到文件操作预约/.test(String(error))) {
      try {
        await reserveDownloadOperation(state, item);
        return await runtimeTaskStore.markOperationAccepted({ jobId, itemId: item.id, taskId });
      } catch (retryError) {
        recordItemStorageFailure(state, "write", `文件操作接管记录失败：${String(retryError)}`);
        return null;
      }
    }
    recordItemStorageFailure(state, "write", `文件操作接管记录失败：${String(error)}`);
    return null;
  }
}

async function reopenDownloadOperation(state, item) {
  const jobId = activeJob(state)?.id || "";
  if (!jobId || !indexedDbTaskStoreAvailable() ||
      typeof runtimeTaskStore?.reopenOperation !== "function") return null;
  try {
    return await runtimeTaskStore.reopenOperation({ jobId, itemId: item.id });
  } catch (error) {
    if (/没有找到文件操作预约/.test(String(error))) return null;
    recordItemStorageFailure(state, "write", `文件操作重试记录失败：${String(error)}`);
    return null;
  }
}

async function completeDownloadOperation(state, item, status) {
  const jobId = activeJob(state)?.id || "";
  if (!jobId || !indexedDbTaskStoreAvailable() ||
      typeof runtimeTaskStore?.completeOperation !== "function") return null;
  try {
    return await runtimeTaskStore.completeOperation({ jobId, itemId: item.id, status });
  } catch (error) {
    if (/没有找到文件操作预约/.test(String(error))) return null;
    recordItemStorageFailure(state, "write", `文件操作完成记录失败：${String(error)}`);
    return null;
  }
}

function gopeedTaskDefinition(state, item, url) {
  const relativeFilename = buildDownloadFilename(item, state.settings);
  const target = splitDownloadTarget(state.gopeedDownloadDir, relativeFilename);
  return {
    url,
    name: target.name,
    path: target.path,
    connections: state.settings.gopeedConnections,
    labels: gopeedTaskIdentityLabels(state, item)
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

function isPopoFolderPage(url) {
  return /^https:\/\/docs\.popo\.netease\.com\/team\/pc\/[^/]+\/pageDetail\/[a-z0-9]+/i.test(
    String(url || "")
  );
}

async function broadcastPopupVisibility() {
  if (typeof chrome.tabs?.query !== "function" || typeof chrome.tabs?.sendMessage !== "function") return;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: "https://docs.popo.netease.com/*" });
  } catch {
    return;
  }
  const message = {
    type: "POPUP_VISIBILITY_CHANGED",
    open: popupUiPorts.size > 0
  };
  await Promise.allSettled(tabs
    .filter((tab) => Number.isInteger(tab.id) && isPopoFolderPage(tab.url))
    .map((tab) => chrome.tabs.sendMessage(tab.id, message, { frameId: 0 })));
}

chrome.runtime.onConnect?.addListener((port) => {
  if (port?.name !== POPUP_UI_PORT_NAME) return;
  popupUiPorts.add(port);
  void broadcastPopupVisibility();
  port.onDisconnect.addListener(() => {
    popupUiPorts.delete(port);
    void broadcastPopupVisibility();
  });
});

async function resolveRestoreSourceTabId(preferredTabId, fallbackTabId) {
  const candidates = [...new Set([preferredTabId, fallbackTabId].filter(Number.isInteger))];
  for (const tabId of candidates) {
    const tab = await getTab(tabId);
    if (tab && isPopoFolderPage(tab.url)) return tabId;
  }

  if (typeof chrome.tabs.query === "function") {
    try {
      const tabs = await chrome.tabs.query({ url: "https://docs.popo.netease.com/*" });
      const candidate = tabs.find((tab) => tab.active && isPopoFolderPage(tab.url)) ||
        tabs.find((tab) => isPopoFolderPage(tab.url));
      if (Number.isInteger(candidate?.id)) return candidate.id;
    } catch {}
  }

  return candidates[0] ?? null;
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
    pushRuntimeEvent(state, "WORKER_FRAME_READY", "info", "隐藏工作区已就绪", "", {
      jobId: job.id,
      tabId,
      frameId
    });
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
    if (previousStillHostsPopo || !candidateMatch) {
      return { needsWorker: false, state: publicState(state) };
    }
    job.sourceTabId = tabId;
    state.sourceTabId = tabId;
    state.workerSourceTabId = tabId;
    pushLog(state, "warn", "原 POPO 页面已关闭，已在重新打开的 POPO 页面恢复任务");
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
  state.pauseOrigin = "";
  state.pauseResumeMode = "";
  state.rootUrl = "";
  state.teamSpaceKey = "";
  state.teamSpaceId = "";
  state.startedAt = "";
  state.completedAt = "";
  state.workflow = newPersistentWorkflow();
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
  transitionPersistentWorkflow(state, "SCAN_START", { nextAction: "scan" });
  setJobStatus(job, state.mode, {
    startedAt: job.startedAt || state.startedAt,
    lastMessage: reuseWorker ? "开始读取文件夹" : "正在准备隐藏工作区"
  });
  pushRuntimeEvent(state, "JOB_STARTED", "info", `任务开始：${job.folderName}`, "", {
    jobId: job.id,
    status: state.mode
  });
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
    setJobStatus(job, "cancelled", {
      completedAt: state.completedAt,
      lastMessage: "任务已取消；已经开始的下载保留在 Gopeed 中"
    });
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
  const eventCode = status === "failed"
    ? "JOB_FAILED"
    : status === "cancelled"
      ? "JOB_CANCELLED"
      : "JOB_COMPLETED";
  pushRuntimeEvent(state, eventCode, status === "failed" ? "error" : "info", message, "", {
    jobId: job.id,
    status
  });
  syncActiveJobSummary(state);
  setJobStatus(job, status, {
    completedAt: state.completedAt,
    lastMessage: message
  });
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
  state.workflow = normalizePersistentWorkflow(state.workflow);
  if (state.workflow.value.scan !== "running") {
    transitionPersistentWorkflow(state, "SCAN_START", { nextAction: "scan" });
  }
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

      const countCheck = verifyDirectoryItemCount(
        result.diagnostics?.expectedItemCount,
        result.items.length
      );
      const expectedItemCount = countCheck.expected;
      if (!countCheck.matches) {
        throw Object.assign(new Error(
          `目录数量核对不一致：页面预计 ${expectedItemCount} 项，实际稳定扫描到 ${result.items.length} 项`
        ), {
          scanCountMismatch: true,
          expectedItemCount,
          actualItemCount: result.items.length
        });
      }

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
        const currentJob = activeJob(state);
        const retryKeys = currentJob?.retryKeys;
        const retrySelected = !retryKeys?.length || retryKeys.includes(`${entry.url}\u0000${scanned.name}`);
        const relativeTargetKey = normalizeGopeedTargetKey(buildDownloadFilename({
          name: scanned.name,
          directoryPath
        }, settings));
        const alreadyInGopeed = currentJob?.restoreStrategy === "missing_from_gopeed" &&
          currentJob.existingGopeedTargetKeys?.includes(relativeTargetKey);
        // 用户选择的是整个文件夹：除系统元数据外，不按扩展名或关键词跳过文件。
        const selected = !systemMetadata && retrySelected && !alreadyInGopeed;
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
                ? "不属于本次恢复或失败重试"
                : alreadyInGopeed
                  ? "Gopeed 已有相同保存路径的完成或进行中任务，恢复时不重复下载"
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
      const workflowCounts = state.workflow.counts;
      updatePersistentWorkflow(state, {
        nextAction: selectedPendingItem(state) ? "handoff" : "scan",
        counts: countCheck.verified
          ? { verifiedDirectories: workflowCounts.verifiedDirectories + 1 }
          : { unverifiedDirectories: workflowCounts.unverifiedDirectories + 1 }
      });
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
      if (error?.scanCountMismatch) {
        entry.countRetries = Math.max(0, Number(entry.countRetries) || 0) + 1;
        const workflowCounts = state.workflow.counts;
        updatePersistentWorkflow(state, {
          nextAction: "scan",
          counts: { scanRetries: workflowCounts.scanRetries + 1 }
        });
        if (entry.countRetries <= 2) {
          pushRuntimeEvent(
            state,
            "DIRECTORY_COUNT_RETRY",
            "warn",
            `目录数量不一致，正在自动重扫（${entry.countRetries}/2）`,
            String(error),
            {
              expected: error.expectedItemCount,
              actual: error.actualItemCount,
              jobId: activeJob(state)?.id || ""
            }
          );
          await saveState(state);
          schedulePump(300);
          return;
        }
      }
      state.scanFailures.push({
        url: entry.url,
        path: entry.path,
        stage: FAILURE.DIRECTORY_LOAD_FAILED,
        error: String(error),
        at: new Date().toISOString()
      });
      state.scanQueue.shift();
      const workflowCounts = state.workflow.counts;
      updatePersistentWorkflow(state, {
        nextAction: selectedPendingItem(state) ? "handoff" : "scan",
        counts: { unverifiedDirectories: workflowCounts.unverifiedDirectories + 1 }
      });
      pushLog(state, "error", `${FAILURE.DIRECTORY_LOAD_FAILED}：${entry.path.join("/") || entry.url}`, String(error));
    }
    await saveState(state);
    await notifySource(state, {
      type: "FOLDER_TASK_STATUS",
      message: `已发现 ${state.items.filter((item) => item.selected).length} 个可下载文件，已交付 ${state.workflow.counts.handedOff} 个，继续读取子文件夹…`
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
      updatePersistentWorkflow(state, {
        nextAction: selectedPendingItem(state) ? "handoff" : "scan"
      });
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
      updatePersistentWorkflow(state, {
        nextAction: selectedPendingItem(state) ? "handoff" : "scan"
      });
      pushLog(state, "error", `${FAILURE.DIRECTORY_LOAD_FAILED}：${folder.name}`, String(error));
    }
    await saveState(state);
    schedulePump();
    return;
  }

  state.mode = "scan_complete";
  state.phase = "ready";
  state.completedAt = new Date().toISOString();
  transitionPersistentWorkflow(
    state,
    state.scanFailures.length || state.workflow.counts.unverifiedDirectories > 0
      ? "SCAN_INCOMPLETE"
      : "SCAN_COMPLETE",
    { nextAction: selectedPendingItem(state) ? "handoff" : "scan" }
  );
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
      `扫描完成：共 ${state.items.length} 个文件、${state.scannedFolderCount} 个文件夹，${state.items.filter((item) => item.selected).length} 个待下载；已核对 ${state.workflow.counts.verifiedDirectories} 个目录，未核对 ${state.workflow.counts.unverifiedDirectories} 个目录`
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

function recordGopeedReconciliation(state, outcome, options = {}) {
  const checkedAt = new Date().toISOString();
  state.runtimeHealth = normalizeRuntimeHealth(state.runtimeHealth);
  const reconciliation = state.runtimeHealth.reconciliation;
  const previousOutcome = reconciliation.lastOutcome;
  const previousCheckedAt = Date.parse(reconciliation.lastCheckedAt || "");
  reconciliation.lastCheckedAt = checkedAt;
  reconciliation.lastOutcome = outcome;

  if (outcome === "recovered" || outcome === "linked") {
    reconciliation.recoveredCount += 1;
    reconciliation.consecutiveErrors = 0;
    reconciliation.lastError = "";
  } else if (outcome === "missing") {
    reconciliation.missCount += 1;
    reconciliation.consecutiveErrors = 0;
    reconciliation.lastError = "";
  } else if (outcome === "ambiguous") {
    reconciliation.ambiguousCount += 1;
    reconciliation.consecutiveErrors = 0;
    reconciliation.lastError = String(options.details || "").slice(0, 500);
  } else if (outcome === "error") {
    reconciliation.errorCount += 1;
    reconciliation.consecutiveErrors += 1;
    reconciliation.lastError = String(options.details || "").slice(0, 500);
  }

  const repeatedRecently = previousOutcome === outcome &&
    Number.isFinite(previousCheckedAt) &&
    Date.now() - previousCheckedAt < 30000;
  if (!repeatedRecently || outcome === "recovered" || outcome === "linked" || outcome === "missing") {
    pushRuntimeEvent(
      state,
      options.code || "GOPEED_RECONCILIATION",
      options.level || "info",
      options.message || "Gopeed 任务对账完成",
      options.details || "",
      options.context || {}
    );
  }
}

async function reconcileInterruptedGopeedTask(state) {
  const item = state.items.find((candidate) => candidate.id === state.preparingItemId);
  if (!item || TERMINAL_STATUSES.has(item.status)) return { handled: false };
  if (!/Gopeed 任务|下载地址/.test(String(item.stage || ""))) return { handled: false };
  const labels = gopeedTaskIdentityLabels(state, item);
  const taskKey = labels.popoTaskKey || "";

  const existingTransfer = (state.activeTransfers || [])
    .find((transfer) => transfer.itemId === item.id);
  if (existingTransfer) {
    state.preparingItemId = null;
    state.activeItemId = state.activeTransfers[0]?.itemId ?? item.id;
    item.gopeedTaskId ||= existingTransfer.taskId;
    item.status = state.mode === "paused" ? "paused" : "transferring";
    item.stage = state.mode === "paused" ? "已暂停" : "Gopeed 传输中";
    await acceptDownloadOperation(state, item, existingTransfer.taskId);
    recordGopeedReconciliation(state, "linked", {
      code: "GOPEED_TASK_LINK_CONFIRMED",
      message: `已确认现有 Gopeed 任务关联：${item.name}`,
      context: { taskKey, taskId: existingTransfer.taskId }
    });
    transitionPersistentWorkflow(state, "HANDOFF_ACCEPT", {
      reservedItemId: "",
      nextAction: "scan"
    });
    transitionPersistentWorkflow(state, "TRANSFER_START");
    return { handled: true, delayMs: 100 };
  }

  let tasks;
  try {
    tasks = await listGopeedTasks(state.settings, { timeoutMs: 10000 });
    if (!Array.isArray(tasks)) throw new Error("Gopeed 任务列表格式不正确");
  } catch (error) {
    const detail = String(error?.message || error).replace(/^Error:\s*/, "");
    state.phase = "reconciling_gopeed";
    recordGopeedReconciliation(state, "error", {
      code: "GOPEED_RECONCILIATION_ERROR",
      level: "warn",
      message: "Gopeed 任务对账暂时失败，等待后重试",
      details: detail,
      context: { taskKey }
    });
    return { handled: true, delayMs: 2000 };
  }

  const selection = selectGopeedTaskByIdentity(tasks, labels);
  if (selection.resolution === "missing") {
    recordGopeedReconciliation(state, "missing", {
      code: "GOPEED_RECONCILIATION_MISS",
      level: "warn",
      message: `Gopeed 中未找到中断任务，按原流程重新处理：${item.name}`,
      context: { taskKey }
    });
    await reopenDownloadOperation(state, item);
    transitionPersistentWorkflow(state, "HANDOFF_RESET", {
      reservedItemId: "",
      nextAction: "scan"
    });
    return { handled: false };
  }
  if (!selection.task) {
    state.phase = "reconciling_gopeed";
    recordGopeedReconciliation(state, "ambiguous", {
      code: "GOPEED_RECONCILIATION_AMBIGUOUS",
      level: "error",
      message: `Gopeed 中存在多个同身份任务，已暂停自动重建：${item.name}`,
      details: `matchCount=${selection.matchCount}; resolution=${selection.resolution}`,
      context: { taskKey, matchCount: selection.matchCount }
    });
    return { handled: true, delayMs: 5000 };
  }

  const taskId = String(selection.task.id || "").trim();
  const conflictingTransfer = (state.activeTransfers || []).find(
    (transfer) => transfer.taskId === taskId && transfer.itemId !== item.id
  );
  if (!taskId || conflictingTransfer) {
    state.phase = "reconciling_gopeed";
    recordGopeedReconciliation(state, "ambiguous", {
      code: "GOPEED_RECONCILIATION_AMBIGUOUS",
      level: "error",
      message: `Gopeed 任务关联冲突，已暂停自动重建：${item.name}`,
      details: conflictingTransfer
        ? `taskId=${taskId}; conflictingItemId=${conflictingTransfer.itemId}`
        : "任务缺少 ID",
      context: { taskKey, matchCount: selection.matchCount }
    });
    return { handled: true, delayMs: 5000 };
  }

  const now = new Date().toISOString();
  const status = classifyGopeedTaskStatus(selection.task.status);
  await acceptDownloadOperation(state, item, taskId);
  state.preparingItemId = null;
  item.reconciledAt = now;
  item.gopeedTaskId = taskId;
  item.retryTaskId = null;
  item.gopeedProgress = {
    downloaded: selection.task?.progress?.downloaded || 0,
    speed: selection.task?.progress?.speed || 0,
    status: selection.task?.status || ""
  };

  if (status === "success") {
    item.status = "success";
    item.stage = "成功（已从 Gopeed 对账恢复）";
    item.failureStage = "";
    item.error = "";
    item.completedAt = now;
    removeActiveTransfer(state, item.id);
    await completeDownloadOperation(state, item, "success");
  } else if (status === "failed") {
    markAttemptFailure(
      state,
      item,
      FAILURE.TRANSFER_INTERRUPTED,
      "对账找到的 Gopeed 任务已失败；将刷新临时地址后继续原任务",
      taskId
    );
    if (item.status === "pending") await reopenDownloadOperation(state, item);
    else await completeDownloadOperation(state, item, "failed");
  } else {
    state.activeTransfers = (state.activeTransfers || [])
      .filter((transfer) => transfer.itemId !== item.id);
    state.activeTransfers.push({
      itemId: item.id,
      taskId,
      pollFailures: 0,
      startedAt: item.startedAt || now,
      reconciledAt: now
    });
    state.activeItemId = state.activeTransfers[0]?.itemId ?? item.id;
    item.status = status === "paused" ? "paused" : "transferring";
    item.stage = status === "paused" ? "已在 Gopeed 暂停" : "Gopeed 传输中（已恢复关联）";
    item.transferDeadline = Date.now() + state.settings.timeouts.transfer;
    if (status === "paused") {
      if (state.mode !== "scanning") {
        state.mode = activeJob(state)?.cancelRequested ? "draining_paused" : "paused";
        state.phase = state.mode;
      }
    } else {
      state.phase = state.mode === "scanning" ? "scanning_and_downloading" : "downloading";
    }
  }

  transitionPersistentWorkflow(state, "HANDOFF_ACCEPT", {
    reservedItemId: "",
    nextAction: "scan"
  });
  if (state.activeTransfers.length) transitionPersistentWorkflow(state, "TRANSFER_START");

  recordGopeedReconciliation(state, "recovered", {
    code: "GOPEED_TASK_RECONCILED",
    message: `已恢复中断的 Gopeed 任务关联：${item.name}`,
    details: `taskId=${taskId}; status=${selection.task.status || ""}`,
    context: {
      taskKey,
      taskId,
      taskStatus: status,
      matchCount: selection.matchCount
    }
  });
  return { handled: true, delayMs: 100 };
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
  const operation = await reserveDownloadOperation(state, item);
  if (operation?.status === "success") {
    item.status = "success";
    item.stage = "成功（已从持久化账本恢复）";
    item.completedAt ||= operation.completedAt || new Date().toISOString();
    state.preparingItemId = null;
    transitionPersistentWorkflow(state, "HANDOFF_ACCEPT", {
      reservedItemId: "",
      nextAction: "scan"
    });
    await saveState(state);
    schedulePump(100);
    return;
  }
  if (operation?.status === "accepted" && operation.taskId && !previousTaskId) {
    item.stage = "Gopeed 任务待对账";
    transitionPersistentWorkflow(state, "HANDOFF_RECONCILE", {
      reservedItemId: item.id,
      nextAction: "handoff"
    });
    await saveState(state);
    schedulePump(100);
    return;
  }
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
  await acceptDownloadOperation(state, item, taskId);

  const fresh = (await getStored()).state;
  const freshItem = fresh.items.find((candidate) => candidate.id === item.id);
  if (!freshItem || TERMINAL_STATUSES.has(freshItem.status)) {
    try { await deleteGopeedTask(state.settings, taskId, { timeoutMs: 8000 }); } catch {}
    if (freshItem) await completeDownloadOperation(fresh, freshItem, "cancelled");
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
  transitionPersistentWorkflow(fresh, "HANDOFF_ACCEPT", {
    reservedItemId: "",
    nextAction: "scan"
  });
  transitionPersistentWorkflow(fresh, "TRANSFER_START");
  if (fresh.mode === "paused") {
    try { await pauseGopeedTask(fresh.settings, taskId); } catch {}
  }
  pushRuntimeEvent(
    fresh,
    "GOPEED_TASK_CREATED",
    "info",
    `Gopeed 任务已建立：${item.name}`,
    `taskId=${taskId}`,
    { jobId: activeJob(fresh)?.id || "", taskId }
  );
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
  const observed = {
    active: 0,
    paused: 0,
    success: 0,
    failed: 0,
    unknown: 0,
    pausedItemIds: []
  };
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
      observed[status] += 1;
      if (status === "success") {
        item.status = "success";
        item.stage = "成功";
        item.failureStage = "";
        item.error = "";
        item.completedAt = new Date().toISOString();
        item.retryTaskId = null;
        removeActiveTransfer(state, item.id);
        await completeDownloadOperation(state, item, "success");
        pushRuntimeEvent(
          state,
          "GOPEED_TASK_COMPLETED",
          "info",
          `下载成功：${item.name}`,
          `taskId=${transfer.taskId}`,
          { jobId: activeJob(state)?.id || "", taskId: transfer.taskId }
        );
      } else if (status === "failed") {
        markAttemptFailure(
          state,
          item,
          FAILURE.TRANSFER_INTERRUPTED,
          "Gopeed 报告传输失败；将刷新 POPO 临时地址后继续原任务",
          transfer.taskId
        );
        if (item.status === "pending") await reopenDownloadOperation(state, item);
        else await completeDownloadOperation(state, item, "failed");
      } else if (status === "paused") {
        observed.pausedItemIds.push(item.id);
        const newlyPaused = item.status !== "paused" || !transfer.externalPaused;
        item.status = "paused";
        item.stage = "已在 Gopeed 暂停";
        transfer.externalPaused = state.pauseOrigin !== "popo";
        if (newlyPaused && transfer.externalPaused) {
          pushRuntimeEvent(
            state,
            "GOPEED_TASK_PAUSED_EXTERNALLY",
            "info",
            `检测到 Gopeed 任务被手动暂停：${item.name}`,
            `taskId=${transfer.taskId}`,
            { jobId: activeJob(state)?.id || "", taskId: transfer.taskId }
          );
        }
      } else if (status === "active") {
        const resumedExternally = item.status === "paused" || transfer.externalPaused;
        if (!TERMINAL_STATUSES.has(item.status)) {
          item.status = "transferring";
          item.stage = "Gopeed 传输中";
        }
        if (resumedExternally && transfer.externalPaused) {
          pushRuntimeEvent(
            state,
            "GOPEED_TASK_RESUMED_EXTERNALLY",
            "info",
            `检测到 Gopeed 任务已手动继续：${item.name}`,
            `taskId=${transfer.taskId}`,
            { jobId: activeJob(state)?.id || "", taskId: transfer.taskId }
          );
        }
        transfer.externalPaused = false;
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
          if (item.status === "pending") await reopenDownloadOperation(state, item);
          else await completeDownloadOperation(state, item, "failed");
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
        if (item.status === "pending") await reopenDownloadOperation(state, item);
        else await completeDownloadOperation(state, item, "failed");
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
        if (item.status === "pending") await reopenDownloadOperation(state, item);
        else await completeDownloadOperation(state, item, "failed");
      }
    }
  }
  if (connectionProblem) {
    pushRuntimeEvent(
      state,
      "GOPEED_CONNECTION_LOST",
      "warn",
      "Gopeed 连接暂时中断，正在重连",
      state.gopeedLastError,
      { jobId: activeJob(state)?.id || "" }
    );
  }
  refreshNetworkHealth(state);
  if (state.activeTransfers.length) transitionPersistentWorkflow(state, "TRANSFER_START");
  else transitionPersistentWorkflow(state, "TRANSFER_IDLE");
  return observed;
}

function isUnownedPausedState(state) {
  return ["paused", "draining_paused"].includes(state.mode) &&
    state.pauseOrigin !== "popo" &&
    Boolean(activeJob(state));
}

async function reconcileUnownedPausedState(state) {
  if (!isUnownedPausedState(state)) return false;
  const transferCountBefore = (state.activeTransfers || []).length;
  if (!transferCountBefore) return false;

  const observed = await syncGopeedTransfers(state);
  const gopeedMovedForward = observed.active > 0 || observed.success > 0 || observed.failed > 0 ||
    state.activeTransfers.length < transferCountBefore;
  if (!gopeedMovedForward) {
    await saveState(state);
    return false;
  }

  const cancelRequested = Boolean(activeJob(state)?.cancelRequested);
  const requestedMode = state.pauseResumeMode === "scanning" ? "scanning" : "downloading";
  state.mode = cancelRequested ? "draining" : requestedMode;
  state.phase = "reconciling_gopeed";
  state.pauseOrigin = "";
  state.pauseResumeMode = "";
  pushRuntimeEvent(
    state,
    "GOPEED_PROJECT_RECONCILED",
    "info",
    "检测到 Gopeed 任务已恢复或完成，POPO 项目已自动接续",
    `active=${observed.active}; success=${observed.success}; failed=${observed.failed}`,
    { jobId: activeJob(state)?.id || "" }
  );
  await saveState(state);
  schedulePump(100);
  return true;
}

async function processDownloadStep(state, { duringScan = false, skipTransferSync = false } = {}) {
  state.activeTransfers = Array.isArray(state.activeTransfers) ? state.activeTransfers : [];
  if (!skipTransferSync) await syncGopeedTransfers(state);
  if (!state.gopeedConnected) {
    const connection = await checkGopeedConnection(state.settings, state);
    if (!connection.connected) {
      if (duringScan && state.mode === "scanning") {
        state.phase = "scanning";
        updatePersistentWorkflow(state, { nextAction: "scan" });
        pushLog(state, "warn", "Gopeed 暂未连接，继续查找文件", connection.error);
        await processScanStep(state);
      } else {
        state.phase = "waiting_gopeed";
        pushLog(state, "warn", "等待 Gopeed 恢复连接", connection.error);
        await saveState(state);
        schedulePump(2000);
      }
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
  if ((!duringScan && state.mode !== "downloading") ||
      (duringScan && state.mode !== "scanning")) {
    await saveState(state);
    return;
  }
  if (state.preparingItemId) {
    transitionPersistentWorkflow(state, "HANDOFF_RECONCILE", {
      reservedItemId: state.preparingItemId,
      nextAction: "handoff"
    });
    const reconciliation = await reconcileInterruptedGopeedTask(state);
    if (reconciliation.handled) {
      await saveState(state);
      schedulePump(reconciliation.delayMs || 500);
      return;
    }
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
      pushRuntimeEvent(
        state,
        "PREPARATION_INTERRUPTED",
        "warn",
        `检测到准备步骤中断，自动重新处理：${interruptedItem.name}`,
        "",
        { jobId: activeJob(state)?.id || "" }
      );
    }
    state.preparingItemId = null;
    state.activeItemId = state.activeTransfers[0]?.itemId ?? null;
    transitionPersistentWorkflow(state, "HANDOFF_RESET", {
      reservedItemId: "",
      nextAction: "scan"
    });
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
    if (duringScan) {
      updatePersistentWorkflow(state, { nextAction: "scan" });
      await processScanStep(state);
    } else {
      await saveState(state);
      schedulePump(1000);
    }
    return;
  }
  const item = selectedPendingItem(state);
  if (!item) {
    if (duringScan) {
      updatePersistentWorkflow(state, { nextAction: "scan" });
      await processScanStep(state);
      return;
    }
    if (state.activeTransfers.length) {
      await saveState(state);
      schedulePump(1000);
      return;
    }
    const successCount = state.items.filter((entry) => entry.status === "success").length;
    const failedCount = state.items.filter((entry) => entry.status === "failed").length;
    const reconciliation = quantityReconciliation(state);
    if (!reconciliation.ok) {
      await finalizeActiveJob(
        state,
        "failed",
        "数量核对失败：文件状态合计与已发现数量不一致，已停止静默完成",
        { type: "FOLDER_TASK_ERROR", message: "数量核对失败，请重试任务" }
      );
      return;
    }
    pushRuntimeEvent(
      state,
      "QUANTITY_RECONCILED",
      "info",
      "文件数量核对通过",
      `discovered=${reconciliation.counts.discovered}; selected=${reconciliation.counts.selected}`,
      { jobId: activeJob(state)?.id || "" }
    );
    const scanWarning = state.scanFailures.length
      ? `；${state.scanFailures.length} 个目录读取失败`
      : state.workflow.counts.unverifiedDirectories
        ? `；${state.workflow.counts.unverifiedDirectories} 个目录未能独立核对数量`
        : "";
    await finalizeActiveJob(
      state,
      "complete",
      `下载结束：成功 ${successCount}，失败 ${failedCount}${scanWarning}`,
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
  transitionPersistentWorkflow(state, "HANDOFF_RESERVE", {
    reservedItemId: item.id,
    nextAction: "handoff"
  });
  transitionPersistentWorkflow(state, "HANDOFF_PREPARE");

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
      transitionPersistentWorkflow(state, "HANDOFF_RESET", {
        reservedItemId: "",
        nextAction: "scan"
      });
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
    if (item.status === "pending") await reopenDownloadOperation(state, item);
    else await completeDownloadOperation(state, item, "failed");
    transitionPersistentWorkflow(state, "HANDOFF_RESET", {
      reservedItemId: "",
      nextAction: "scan"
    });
    await saveState(state);
    schedulePump();
  }
}

async function processPersistentWorkflowStep(state) {
  state.workflow = normalizePersistentWorkflow(state.workflow);
  await syncGopeedTransfers(state);
  const action = typeof runtimeWorkflow?.choosePersistentWorkflowAction === "function"
    ? runtimeWorkflow.choosePersistentWorkflowAction({
      workflow: state.workflow,
      hasPending: Boolean(selectedPendingItem(state)),
      hasPreparing: Boolean(state.preparingItemId),
      activeTransfers: state.activeTransfers.length,
      concurrency: state.settings.concurrency
    })
    : (Boolean(state.preparingItemId) || (
      state.workflow.nextAction === "handoff" &&
      state.activeTransfers.length < state.settings.concurrency &&
      selectedPendingItem(state)
    ))
      ? "handoff"
      : "scan";
  if (action === "handoff") {
    await processDownloadStep(state, { duringScan: true, skipTransferSync: true });
    return;
  }
  await processScanStep(state);
}

async function pump() {
  if (pumpLocked) return;
  pumpLocked = true;
  try {
    const { state } = await getStored();
    if (await repairQueueState(state)) return;
    if (await reconcileUnownedPausedState(state)) return;
    if (state.mode === "scanning") await processPersistentWorkflowStep(state);
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
  transitionPersistentWorkflow(state, "SCAN_START", { nextAction: "scan" });
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
  const selected = state.items.filter((item) => item.selected);
  const pending = selected.filter((item) =>
    ["pending", "preparing", "transferring", "paused"].includes(item.status)
  );
  if (!pending.length) {
    const successCount = selected.filter((item) => item.status === "success").length;
    const failedCount = selected.filter((item) => item.status === "failed").length;
    if (selected.length && successCount + failedCount === selected.length) {
      const reconciliation = quantityReconciliation(state);
      const scanWarning = state.scanFailures.length
        ? `；${state.scanFailures.length} 个目录读取失败`
        : state.workflow.counts.unverifiedDirectories
          ? `；${state.workflow.counts.unverifiedDirectories} 个目录未能独立核对数量`
          : "";
      await finalizeActiveJob(
        state,
        reconciliation.ok ? "complete" : "failed",
        reconciliation.ok
          ? `下载结束：成功 ${successCount}，失败 ${failedCount}${scanWarning}`
          : "数量核对失败：文件状态合计与已发现数量不一致",
        {
          type: reconciliation.ok ? "FOLDER_TASK_FINISHED" : "FOLDER_TASK_ERROR",
          successCount,
          failedCount
        }
      );
      return state;
    }
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
    if ((state.activeTransfers || []).length || state.preparingItemId) {
      state.mode = "downloading";
      state.phase = "waiting_gopeed";
      pushLog(state, "warn", "扫描已结束；已开始任务继续等待 Gopeed 恢复", connection.error);
      await saveState(state);
      schedulePump(2000);
      return state;
    }
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
    if (!["preparing", "transferring", "paused"].includes(item.status)) item.status = "pending";
  }
  state.mode = "downloading";
  state.phase = "starting";
  state.completedAt = "";
  state.activeTransfers = Array.isArray(state.activeTransfers) ? state.activeTransfers : [];
  state.activeItemId = state.preparingItemId || state.activeTransfers[0]?.itemId || null;
  pushLog(
    state,
    "info",
    `扫描结束后继续下载：待处理 ${pending.filter((item) => item.status === "pending").length} 个，已交付 ${state.workflow?.counts?.handedOff || 0} 个；Gopeed 任务并发 ${state.settings.concurrency}`,
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
  if (!["scanning", "downloading", "draining"].includes(state.mode)) return state;
  const resumeMode = state.mode;
  state.pauseOrigin = "popo";
  state.pauseResumeMode = resumeMode;
  state.mode = resumeMode === "draining" ? "draining_paused" : "paused";
  state.phase = state.mode;
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

async function snoozeNetworkReminder() {
  const { state } = await getStored();
  state.networkHealth = typeof runtimeNetworkMonitor?.snoozeNetworkReminder === "function"
    ? runtimeNetworkMonitor.snoozeNetworkReminder(state.networkHealth, 15)
    : { ...normalizeNetworkHealth(state.networkHealth), suppressed: true };
  pushRuntimeEvent(state, "NETWORK_NOTICE_SNOOZED", "info", "网络慢速提醒已稍后 15 分钟");
  await saveState(state);
  await notifySource(state, { type: "FOLDER_TASK_STATUS", message: "网络提醒已稍后 15 分钟" });
  return state;
}

async function muteNetworkReminderToday() {
  const { state } = await getStored();
  state.networkHealth = typeof runtimeNetworkMonitor?.muteNetworkReminderToday === "function"
    ? runtimeNetworkMonitor.muteNetworkReminderToday(state.networkHealth)
    : { ...normalizeNetworkHealth(state.networkHealth), suppressed: true };
  pushRuntimeEvent(state, "NETWORK_NOTICE_MUTED_TODAY", "info", "今日不再提醒网络慢速");
  await saveState(state);
  await notifySource(state, { type: "FOLDER_TASK_STATUS", message: "今日不再提醒网络慢速" });
  return state;
}

async function resumeTask() {
  const { state } = await getStored();
  if (state.mode === "downloading") {
    if (state.triggerMode === "folder_button" && state.workerFrameId == null) {
      await requestWorkerFrameForActiveJob(state);
      schedulePump(100);
    }
    return state;
  }
  if (!["paused", "draining_paused"].includes(state.mode)) return state;
  const observed = await syncGopeedTransfers(state);
  const pausedItemIds = new Set(observed.pausedItemIds || []);
  const cancelRequested = Boolean(activeJob(state)?.cancelRequested);
  const resumeMode = state.pauseResumeMode === "scanning" ? "scanning" : "downloading";
  state.mode = cancelRequested ? "draining" : resumeMode;
  state.phase = "resuming";
  state.pauseOrigin = "";
  state.pauseResumeMode = "";
  rotateRunToken(state);
  await saveState(state, true);
  for (const transfer of [...(state.activeTransfers || [])]) {
    const item = state.items.find((candidate) => candidate.id === transfer.itemId);
    if (!item || !pausedItemIds.has(item.id)) continue;
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
  if (state.triggerMode === "folder_button" && state.workerFrameId == null) {
    await requestWorkerFrameForActiveJob(state);
  }
  await notifySource(state, { type: "FOLDER_TASK_STATUS", message: "继续下载…" });
  schedulePump(100);
  return state;
}

async function cancelTask() {
  const { state } = await getStored();
  return cancelJob(state.activeJobId, state);
}

async function cancelJob(jobId, currentState = null) {
  const state = currentState || (await getStored()).state;
  const job = (state.jobs || []).find((candidate) => candidate.id === jobId);
  if (!job) throw new Error("没有找到要取消的下载任务");
  if (isJobTerminal(job.status)) return state;

  if (state.activeJobId !== job.id) {
    setJobStatus(job, "cancelled", {
      cancelRequested: true,
      completedAt: new Date().toISOString(),
      lastMessage: "排队任务已取消，未创建任何下载"
    });
    rotateRunToken(state);
    await saveState(state, true);
    return state;
  }

  await syncGopeedTransfers(state);
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

function linkedJobIds(jobs, target) {
  const ids = new Set([target.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of jobs || []) {
      const linkedToKnownJob = ids.has(candidate.retryOfJobId) || ids.has(candidate.restoreOfJobId);
      const knownJobLinksToCandidate = [...ids].some((id) => {
        const known = (jobs || []).find((job) => job.id === id);
        return known?.retryOfJobId === candidate.id || known?.restoreOfJobId === candidate.id;
      });
      if ((linkedToKnownJob || knownJobLinksToCandidate) && !ids.has(candidate.id)) {
        ids.add(candidate.id);
        changed = true;
      }
    }
  }
  return ids;
}

async function dismissJob(jobId) {
  const { state } = await getStored({ loadItems: false });
  const target = (state.jobs || []).find((candidate) => candidate.id === jobId);
  if (!target) throw new Error("这个任务已经不在列表中");
  if (!isJobTerminal(target.status)) throw new Error("任务进行中，暂时不能移除");

  const relatedIds = linkedJobIds(state.jobs || [], target);
  const hasActiveRelatedJob = (state.jobs || []).some(
    (candidate) => relatedIds.has(candidate.id) && !isJobTerminal(candidate.status)
  );
  if (hasActiveRelatedJob) throw new Error("这个任务仍在进行，暂时不能移除");

  state.jobs = (state.jobs || []).filter((candidate) => !relatedIds.has(candidate.id));
  pushRuntimeEvent(
    state,
    "JOB_DISMISSED",
    "info",
    "任务记录已从扩展列表移除",
    "",
    { jobId: target.id, removedCount: relatedIds.size }
  );
  rotateRunToken(state);
  await saveState(state, true);
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

function cancelledRetryKeysForJob(state, source) {
  const storedKeys = Array.isArray(source?.cancelledRetryKeys)
    ? source.cancelledRetryKeys.filter(Boolean)
    : [];
  if (storedKeys.length) return [...new Set(storedKeys)];

  const latestCancelled = [...(state.jobs || [])]
    .reverse()
    .find((candidate) => candidate.status === "cancelled" && (candidate.counts?.cancelled || 0) > 0);
  if (latestCancelled?.id !== source?.id || state._itemsLoaded === false || state.activeJobId) return [];
  return [...new Set((state.items || [])
    .filter((item) => item.status === "cancelled")
    .map((item) => `${item.parentUrl}\u0000${item.name}`))];
}

async function restoreCancelledJob(jobId, preferredSourceTabId = null) {
  const { state } = await getStored();
  const source = (state.jobs || []).find((candidate) => candidate.id === jobId);
  if (!source || source.status !== "cancelled") throw new Error("没有找到可恢复的已取消任务");

  const restoreSourceTabId = await resolveRestoreSourceTabId(
    preferredSourceTabId,
    source.sourceTabId
  );
  if (restoreSourceTabId != null) source.sourceTabId = restoreSourceTabId;

  const retryKeys = cancelledRetryKeysForJob(state, source);
  const cancelledCount = Number(source.counts?.cancelled || 0);
  if (!retryKeys.length && !cancelledCount) throw new Error("这个任务没有可恢复的未开始文件");
  if (retryKeys.length) source.cancelledRetryKeys = retryKeys;

  const existing = (state.jobs || []).find(
    (candidate) => candidate.restoreOfJobId === source.id && !isJobTerminal(candidate.status)
  );
  if (existing) return state;
  if ((state.jobs || []).some(
    (candidate) => candidate.restoreOfJobId === source.id && candidate.status === "complete" &&
      (candidate.counts?.failed || 0) === 0
  )) {
    throw new Error("这个已取消任务已经恢复完成");
  }

  let restoreStrategy = "retry_keys";
  let existingGopeedTargetKeys = [];
  if (!retryKeys.length) {
    const connection = await checkGopeedConnection(state.settings, state);
    if (!connection.connected) {
      throw new Error(`无法安全恢复旧任务：读取 Gopeed 历史前连接失败（${connection.error}）`);
    }
    let gopeedTasks;
    try {
      gopeedTasks = await listGopeedTasks(state.settings, { timeoutMs: 10000 });
    } catch (error) {
      const detail = String(error?.message || error).replace(/^Error:\s*/, "");
      throw new Error(`无法安全恢复旧任务：读取 Gopeed 历史失败（${detail}）`);
    }
    const allExistingGopeedTargetKeys = reusableTaskTargetKeys(
      gopeedTasks,
      state.settings.downloadRoot
    );
    const markerName = "__popo_restore_marker__";
    const sourceTarget = normalizeGopeedTargetKey(buildDownloadFilename({
      name: markerName,
      directoryPath: [source.folderName]
    }, state.settings));
    const sourceTargetPrefix = sourceTarget.slice(0, -markerName.length);
    existingGopeedTargetKeys = allExistingGopeedTargetKeys
      .filter((targetKey) => targetKey.startsWith(sourceTargetPrefix));
    if (Number(source.counts?.success || 0) > 0 && !existingGopeedTargetKeys.length) {
      throw new Error("Gopeed 中没有找到已完成文件记录，暂不能安全恢复，避免重复下载");
    }
    restoreStrategy = "missing_from_gopeed";
  }

  const restoreCount = retryKeys.length || cancelledCount;

  const job = {
    id: createId("job"),
    key: source.key,
    sourceTabId: source.sourceTabId,
    folderName: source.folderName,
    displayName: `${source.folderName}（恢复未开始文件）`,
    folderItemIndex: source.folderItemIndex,
    parentUrl: source.parentUrl,
    restoreOfJobId: source.id,
    retryKeys,
    restoreStrategy,
    restoreExpectedCount: restoreCount,
    existingGopeedTargetKeys,
    status: "queued",
    cancelRequested: false,
    createdAt: new Date().toISOString(),
    startedAt: "",
    completedAt: "",
    counts: summarizeItems([], 0, 0),
    lastMessage: `等待重新扫描并恢复 ${restoreCount} 个未开始文件`
  };
  state.jobs.push(job);
  if (!state.activeJobId) prepareJobForExecution(state, job, false);
  rotateRunToken(state);
  await saveState(state, true);
  if (state.activeJobId === job.id) await requestWorkerFrameForActiveJob(state);
  return state;
}

async function saveAutomaticUpdateStatus(status) {
  const normalized = {
    state: String(status?.state || "idle"),
    currentVersion: String(status?.currentVersion || chrome.runtime.getManifest().version_name ||
      chrome.runtime.getManifest().version || ""),
    targetVersion: String(status?.targetVersion || status?.version || ""),
    message: String(status?.message || status?.error || ""),
    updatedAt: String(status?.updatedAt || new Date().toISOString())
  };
  await chrome.storage.local.set({ popoUpdateStatus: normalized });
  return normalized;
}

function updateBlockedByActiveJobs(state) {
  return (state?.jobs || []).some((job) => !isJobTerminal(job.status));
}

async function runAutomaticUpdateCheck() {
  if (automaticUpdateLocked) return;
  automaticUpdateLocked = true;
  const currentVersion = chrome.runtime.getManifest().version_name ||
    chrome.runtime.getManifest().version;
  try {
    const { state } = await getStored({ loadItems: false });
    if (updateBlockedByActiveJobs(state)) {
      await saveAutomaticUpdateStatus({
        state: "deferred",
        currentVersion,
        message: "有下载任务正在处理，已延后自动更新。"
      });
      return;
    }

    const check = await chrome.runtime.sendNativeMessage(FOLDER_PICKER_HOST, {
      action: "check_update",
      currentVersion
    });
    if (!check?.ok) throw new Error(check?.error || "无法读取签名更新清单");
    if (!check.available) {
      await saveAutomaticUpdateStatus({
        state: "up_to_date",
        currentVersion,
        targetVersion: check.version,
        message: "当前已是最新正式版。"
      });
      return;
    }

    await saveAutomaticUpdateStatus({
      state: "starting",
      currentVersion,
      targetVersion: check.version,
      message: "发现新正式版，正在启动安全更新。"
    });
    const started = await chrome.runtime.sendNativeMessage(FOLDER_PICKER_HOST, {
      action: "apply_update",
      currentVersion
    });
    if (!started?.ok) throw new Error(started?.error || "无法启动自动更新");
    if (!started.started) return;

    for (let attempt = 0; attempt < 90; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const updateStatus = await chrome.runtime.sendNativeMessage(FOLDER_PICKER_HOST, {
        action: "update_status"
      });
      if (!updateStatus?.ok) continue;
      await saveAutomaticUpdateStatus(updateStatus);
      if (updateStatus.state === "succeeded") {
        chrome.runtime.reload();
        return;
      }
      if (updateStatus.state === "failed") {
        throw new Error(updateStatus.message || "自动更新失败，已保留当前版本");
      }
    }
    throw new Error("自动更新等待超时，稍后会重新检查");
  } catch (error) {
    await saveAutomaticUpdateStatus({
      state: "failed",
      currentVersion,
      message: String(error?.message || error).replace(/^Error:\s*/, "")
    });
  } finally {
    automaticUpdateLocked = false;
  }
}

function scheduleAutomaticUpdates(delayInMinutes) {
  chrome.alarms.create(UPDATE_ALARM, {
    delayInMinutes,
    periodInMinutes: UPDATE_CHECK_PERIOD_MINUTES
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(["popoSettings", "popoState"]);
  // 更新时一并清除旧版本保存过的文件格式和关键词筛选。
  await chrome.storage.local.set({ popoSettings: mergeSettings(data.popoSettings || {}) });
  if (!data.popoState) await chrome.storage.local.set({ popoState: newState() });
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  scheduleAutomaticUpdates(5);
  schedulePump(1000);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  scheduleAutomaticUpdates(2);
  schedulePump(1000);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PUMP_ALARM) void pump();
  if (alarm.name === WATCHDOG_ALARM) void runWatchdog();
  if (alarm.name === UPDATE_ALARM) void runAutomaticUpdateCheck();
});

async function runWatchdog() {
  const { state } = await getStored();
  if (await repairQueueState(state)) return;
  if (await reconcileUnownedPausedState(state)) return;
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
    const command = enforceRuntimeCommandContract(validateRuntimeMessage(message));
    switch (command.type) {
      case "GET_STATE":
      {
        let { state, settings } = await getStored({ loadItems: false });
        if (queueStateNeedsRepair(state)) {
          ({ state, settings } = await getStored());
          await repairQueueState(state);
        }
        return { ok: true, state: publicState(state), settings };
      }
      case "GET_UPDATE_STATUS": {
        const data = await chrome.storage.local.get("popoUpdateStatus");
        return {
          ok: true,
          updateStatus: data.popoUpdateStatus || {
            state: "idle",
            currentVersion: chrome.runtime.getManifest().version_name ||
              chrome.runtime.getManifest().version,
            targetVersion: "",
            message: "",
            updatedAt: ""
          }
        };
      }
      case "CHECK_GOPEED": {
        const { settings } = await getStored({ loadItems: false });
        // 弹窗会定时检查连接；这里必须保持只读，不能用稍早读到的状态
        // 覆盖正在建立或完成的下载任务。
        const connection = await checkGopeedConnection(settings);
        return { ok: true, connection, settings: connection.settings || settings };
      }
      case "SAVE_GOPEED_SETTINGS": {
        const settings = await saveGopeedSettings(command);
        const { state } = await getStored();
        const connection = await checkGopeedConnection(settings, state);
        await saveState(state);
        return { ok: true, connection, settings: connection.settings || settings };
      }
      case "CHOOSE_DOWNLOAD_DIRECTORY": {
        const result = await chooseDownloadDirectory(command);
        return { ok: true, ...result };
      }
      case "SET_DOWNLOAD_CONCURRENCY": {
        const result = await withControlMutation(
          () => setDownloadConcurrency(command.concurrency)
        );
        return { ok: true, ...result };
      }
      case "SAVE_SETTINGS":
        return { ok: true, settings: await saveSettings(command.settings) };
      case "START_SCAN":
        return { ok: true, state: await startScan(command) };
      case "START_FOLDER_SCAN":
      {
        const result = await withControlMutation(
          () => startFolderScan(command, sender.tab?.id ?? null)
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
          () => registerSourcePage(sender, command.url)
        );
        return { ok: true, ...result };
      }
      case "REGISTER_WORKER_FRAME":
        return { ok: true, state: await registerWorkerFrame(sender, command.url) };
      case "CANCEL_FOLDER_TASK": {
        const state = await withControlMutation(() => cancelTask());
        return { ok: true, state: publicState(state) };
      }
      case "CANCEL_JOB": {
        const state = await withControlMutation(() => cancelJob(command.jobId));
        return { ok: true, state: publicState(state) };
      }
      case "START_DOWNLOAD": {
        const state = await startDownload();
        return { ok: true, state: publicState(state) };
      }
      case "SNOOZE_NETWORK_REMINDER": {
        const state = await withControlMutation(() => snoozeNetworkReminder());
        return { ok: true, state: publicState(state) };
      }
      case "MUTE_NETWORK_REMINDER_TODAY": {
        const state = await withControlMutation(() => muteNetworkReminderToday());
        return { ok: true, state: publicState(state) };
      }
      case "PAUSE": {
        const state = await withControlMutation(() => pauseTask());
        return { ok: true, state: publicState(state) };
      }
      case "RESUME": {
        const state = await withControlMutation(() => resumeTask());
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
        const state = await withControlMutation(() => retryJob(command.jobId));
        return { ok: true, state: publicState(state) };
      }
      case "DISMISS_JOB": {
        const state = await withControlMutation(() => dismissJob(command.jobId));
        return { ok: true, state: publicState(state) };
      }
      case "RESTORE_CANCELLED_JOB": {
        const preferredSourceTabId = Number.isInteger(command.sourceTabId)
          ? command.sourceTabId
          : sender.tab?.id;
        const state = await withControlMutation(
          () => restoreCancelledJob(command.jobId, preferredSourceTabId)
        );
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
        return { ok: false, error: `未知命令：${command.type}` };
    }
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});
