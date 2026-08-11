"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fakeIndexedDb = require("fake-indexeddb");
const { buildTaskIdentityLabels } = require("../gopeed.js");

function installFakeIndexedDb() {
  const names = [
    "indexedDB",
    "IDBCursor",
    "IDBCursorWithValue",
    "IDBDatabase",
    "IDBFactory",
    "IDBIndex",
    "IDBKeyRange",
    "IDBObjectStore",
    "IDBOpenDBRequest",
    "IDBRecord",
    "IDBRequest",
    "IDBTransaction",
    "IDBVersionChangeEvent"
  ];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(global, name)]));
  for (const name of names) {
    const value = name === "indexedDB" ? new fakeIndexedDb.IDBFactory() : fakeIndexedDb[name];
    Object.defineProperty(global, name, { configurable: true, writable: true, value });
  }
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(global, name, descriptor);
      else delete global[name];
    }
  };
}

function eventStub() {
  return {
    listeners: [],
    addListener(listener) { this.listeners.push(listener); },
    removeListener(listener) {
      this.listeners = this.listeners.filter((candidate) => candidate !== listener);
    }
  };
}

function createHarness(initial = {}, options = {}) {
  const backgroundPath = require.resolve("../background.js");
  delete require.cache[backgroundPath];
  const stored = structuredClone(initial);
  const deletedGopeedTasks = [];
  const pausedGopeedTasks = [];
  const continuedGopeedTasks = [];
  const sentTabMessages = [];
  const actionState = {};
  const storageAccessState = {};

  global.importScripts = (...files) => {
    if (files.includes("runtime/popo-runtime.js")) global.PopoRuntime = require("../runtime/popo-runtime.cjs");
    if (files.includes("core.js")) global.PopoCore = require("../core.js");
    if (files.includes("gopeed.js")) {
      global.PopoGopeed = {
        ...require("../gopeed.js"),
        ...(options.gopeedConfig ? {
          async getConfig() { return structuredClone(options.gopeedConfig); }
        } : {}),
        ...(options.gopeedTasks ? {
          async listTasks() { return structuredClone(options.gopeedTasks); }
        } : {}),
        ...(options.listGopeedTasks ? {
          listTasks: options.listGopeedTasks
        } : {}),
        ...(options.getGopeedTask ? {
          getTask: options.getGopeedTask
        } : {}),
        ...(options.pauseGopeedTask ? {
          pauseTask: options.pauseGopeedTask
        } : {
          async pauseTask(_settings, taskId) { pausedGopeedTasks.push(taskId); }
        }),
        ...(options.continueGopeedTask ? {
          continueTask: options.continueGopeedTask
        } : {
          async continueTask(_settings, taskId) { continuedGopeedTasks.push(taskId); }
        }),
        async deleteTask(_settings, taskId) { deletedGopeedTasks.push(taskId); }
      };
    }
    if (files.includes("queue.js")) global.PopoQueue = require("../queue.js");
  };
  global.chrome = {
    action: {
      async setBadgeText({ text }) { actionState.text = text; },
      async setBadgeBackgroundColor({ color }) { actionState.color = color; },
      async setTitle({ title }) { actionState.title = title; }
    },
    alarms: { create() {}, onAlarm: eventStub() },
    runtime: { onInstalled: eventStub(), onMessage: eventStub(), onStartup: eventStub() },
    storage: {
      local: {
        async setAccessLevel({ accessLevel }) {
          storageAccessState.accessLevel = accessLevel;
        },
        async get(keys) {
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested.filter((key) => key in stored).map((key) => [key, stored[key]]));
        },
        async set(values) { Object.assign(stored, structuredClone(values)); },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
        }
      }
    },
    tabs: {
      onRemoved: eventStub(),
      onUpdated: eventStub(),
      async sendMessage(tabId, message, options) {
        sentTabMessages.push({ tabId, message: structuredClone(message), options: structuredClone(options) });
        return { ok: true };
      },
      async get() { return null; },
      async remove() {}
    }
  };

  require(backgroundPath);
  const listener = global.chrome.runtime.onMessage.listeners[0];
  const send = (message, sender = { tab: { id: 7 }, frameId: 0 }) => new Promise((resolve) => {
    assert.equal(listener(message, sender, resolve), true);
  });
  const cleanup = () => {
    delete global.chrome;
    delete global.importScripts;
    delete global.PopoCore;
    delete global.PopoGopeed;
    delete global.PopoQueue;
    delete global.PopoRuntime;
    delete require.cache[backgroundPath];
  };
  const fireAlarm = (name) => {
    for (const alarmListener of global.chrome.alarms.onAlarm.listeners) alarmListener({ name });
  };
  return {
    actionState,
    cleanup,
    continuedGopeedTasks,
    deletedGopeedTasks,
    fireAlarm,
    pausedGopeedTasks,
    send,
    sentTabMessages,
    storageAccessState,
    stored
  };
}

async function waitUntil(predicate, message = "等待后台状态更新超时") {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function transferState({ mode = "downloading", jobStatus = mode, includePending = false } = {}) {
  const now = new Date().toISOString();
  const jobId = "job-gopeed-control";
  const rootUrl = "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1";
  const items = [{
    id: "active-file",
    parentUrl: rootUrl,
    name: "active.mp4",
    selected: true,
    status: "transferring",
    stage: "传输中",
    attempts: 1,
    gopeedTaskId: "task-active"
  }];
  if (includePending) {
    items.push({
      id: "pending-file",
      parentUrl: rootUrl,
      name: "pending.mp4",
      selected: true,
      status: "pending",
      attempts: 0
    });
  }
  return {
    version: 4,
    runToken: "run-gopeed-control",
    jobs: [{
      id: jobId,
      key: "key-gopeed-control",
      sourceTabId: 7,
      folderName: "Gopeed 控制测试",
      folderItemIndex: "1",
      parentUrl: rootUrl,
      status: jobStatus,
      cancelRequested: false,
      createdAt: now,
      counts: { files: items.length }
    }],
    activeJobId: jobId,
    mode,
    phase: mode,
    triggerMode: "popup",
    sourceTabId: 7,
    selectedFolderName: "Gopeed 控制测试",
    rootUrl,
    workerFrameId: 42,
    settings: { concurrency: 1, gopeedConnections: 1, maxRetries: 3 },
    items,
    preparingItemId: null,
    activeTransfers: [{ itemId: "active-file", taskId: "task-active" }],
    activeItemId: "active-file",
    scanQueue: [],
    resolveQueue: [],
    scanFailures: [],
    scannedFolderCount: 0,
    logs: [],
    startedAt: now,
    completedAt: ""
  };
}

test("后台启动时把本地状态限制在受信任扩展上下文", () => {
  const harness = createHarness();
  try {
    assert.equal(harness.storageAccessState.accessLevel, "TRUSTED_CONTEXTS");
  } finally {
    harness.cleanup();
  }
});

test("后台在状态读取前拒绝格式错误的控制命令", async () => {
  const harness = createHarness();
  try {
    const missingJob = await harness.send({ type: "CANCEL_JOB", jobId: "" });
    assert.equal(missingJob.ok, false);
    assert.match(missingJob.error, /jobId/);
    assert.deepEqual(harness.stored, {});
  } finally {
    harness.cleanup();
  }
});

test("文件数量检查完成后无需确认即可自动进入 Gopeed 下载", async () => {
  const now = new Date().toISOString();
  const state = {
    version: 4,
    runToken: "run-auto-start",
    jobs: [{
      id: "job-auto-start",
      key: "key-auto-start",
      sourceTabId: 7,
      folderName: "母文件 A",
      folderItemIndex: "1",
      parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1",
      status: "scanning",
      cancelRequested: false,
      createdAt: now,
      counts: {},
      projectCount: 1
    }],
    activeJobId: "job-auto-start",
    mode: "scanning",
    phase: "scanning",
    triggerMode: "folder_button",
    sourceTabId: 7,
    selectedFolderName: "母文件 A",
    rootProjectCount: 1,
    workerFrameId: 42,
    workerReadyUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/folder1",
    settings: { concurrency: 5, gopeedConnections: 1 },
    items: [{
      id: "file-1",
      name: "a.mp4",
      selected: true,
      status: "pending",
      parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/folder1"
    }],
    activeTransfers: [],
    scanQueue: [],
    resolveQueue: [],
    scanFailures: [],
    scannedFolderCount: 0,
    logs: [],
    startedAt: now,
    completedAt: ""
  };
  const harness = createHarness(
    { popoSettings: state.settings, popoState: state },
    { gopeedConfig: { downloadDir: "D:\\Downloads" } }
  );
  try {
    harness.fireAlarm("popo-stable-downloader-pump");
    for (let attempt = 0; attempt < 30 && harness.stored.popoState.mode !== "downloading"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(harness.stored.popoState.mode, "downloading");
    assert.equal(harness.stored.popoState.phase, "starting");
    assert.equal(harness.stored.popoState.jobs[0].status, "downloading");
    assert.equal(harness.stored.popoState.jobs[0].projectCount, 1);
  } finally {
    harness.cleanup();
  }
});

test("三个母文件夹可按点击顺序入队且重复点击不会新增任务", async () => {
  const harness = createHarness();
  try {
    const base = "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1";
    const first = await harness.send({
      type: "START_FOLDER_SCAN",
      parentUrl: base,
      folderName: "母文件 A",
      folderItemIndex: "1"
    });
    const second = await harness.send({
      type: "START_FOLDER_SCAN",
      parentUrl: base,
      folderName: "母文件 B",
      folderItemIndex: "2"
    });
    const third = await harness.send({
      type: "START_FOLDER_SCAN",
      parentUrl: base,
      folderName: "母文件 C",
      folderItemIndex: "3"
    });
    const duplicate = await harness.send({
      type: "START_FOLDER_SCAN",
      parentUrl: `${base}#ignored`,
      folderName: "母文件 B",
      folderItemIndex: "2"
    });
    const rapidDuplicates = await Promise.all(Array.from({ length: 8 }, () => harness.send({
      type: "START_FOLDER_SCAN",
      parentUrl: base,
      folderName: "母文件 B",
      folderItemIndex: "2"
    })));

    assert.equal(first.ok, true);
    assert.equal(first.needsWorker, true);
    assert.equal(second.queuePosition, 1);
    assert.equal(third.queuePosition, 2);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.job.id, second.job.id);
    assert.ok(rapidDuplicates.every((response) => response.duplicate && response.job.id === second.job.id));

    const snapshot = await harness.send({ type: "GET_STATE" });
    assert.equal(snapshot.state.jobs.length, 3);
    assert.equal(snapshot.state.jobs[0].status, "waiting_worker");
    assert.deepEqual(snapshot.state.jobs.slice(1).map((job) => job.status), ["queued", "queued"]);

    await harness.send({ type: "CANCEL_JOB", jobId: second.job.id });
    await harness.send({ type: "CANCEL_JOB", jobId: first.job.id });
    const advanced = await harness.send({ type: "GET_STATE" });
    assert.equal(advanced.state.activeJobId, third.job.id);
    assert.equal(advanced.state.jobs.some((job) => job.id === second.job.id), false);
    assert.equal(harness.stored.popoState.jobs.find((job) => job.id === second.job.id).status, "cancelled");
    assert.equal(advanced.state.jobs.find((job) => job.id === third.job.id).status, "waiting_worker");
  } finally {
    harness.cleanup();
  }
});

test("旧版本保存过的筛选不会跳过文件夹中的其他格式", async () => {
  const harness = createHarness({
    popoSettings: {
      recursive: false,
      formats: ".mp4",
      includeKeywords: "成片",
      excludeKeywords: "源文件",
      preserveStructure: false,
      concurrency: 2
    }
  });
  try {
    const response = await harness.send({
      type: "START_FOLDER_SCAN",
      parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1",
      folderName: "混合格式素材",
      folderItemIndex: "1"
    });

    assert.equal(response.ok, true);
    assert.equal(harness.stored.popoState.settings.recursive, true);
    assert.equal(harness.stored.popoState.settings.formats, "");
    assert.equal(harness.stored.popoState.settings.includeKeywords, "");
    assert.equal(harness.stored.popoState.settings.excludeKeywords, "");
    assert.equal(harness.stored.popoState.settings.preserveStructure, true);
    assert.equal(harness.stored.popoState.settings.concurrency, 2);

    const snapshot = await harness.send({ type: "GET_STATE" });
    assert.equal(snapshot.settings.formats, "");
    assert.equal(snapshot.settings.includeKeywords, "");
    assert.equal(snapshot.settings.excludeKeywords, "");
  } finally {
    harness.cleanup();
  }
});

test("并行下载数可在 1 到 5 之间持久化并立即更新运行状态", async () => {
  const harness = createHarness({ popoSettings: { concurrency: 5 } });
  try {
    const response = await harness.send({
      type: "SET_DOWNLOAD_CONCURRENCY",
      concurrency: 2
    });

    assert.equal(response.ok, true);
    assert.equal(response.settings.concurrency, 2);
    assert.equal(response.state.settings.concurrency, 2);
    assert.equal(harness.stored.popoSettings.concurrency, 2);
    assert.equal(harness.stored.popoState.settings.concurrency, 2);
    assert.equal(
      harness.stored.popoState.logs.at(-1).code,
      "DOWNLOAD_CONCURRENCY_CHANGED"
    );

    const snapshot = await harness.send({ type: "GET_STATE" });
    assert.equal(snapshot.settings.concurrency, 2);
  } finally {
    harness.cleanup();
  }
});

test("弹窗检查 Gopeed 连接不会覆盖正在变化的下载状态", async () => {
  const now = new Date().toISOString();
  const state = {
    version: 4,
    runToken: "run-readonly-check",
    jobs: [],
    activeJobId: null,
    mode: "idle",
    phase: "idle",
    settings: { concurrency: 5, gopeedConnections: 1 },
    items: [],
    activeTransfers: [],
    logs: [],
    updatedAt: now
  };
  const harness = createHarness(
    { popoSettings: state.settings, popoState: state },
    { gopeedConfig: { downloadDir: "D:\\Downloads" } }
  );
  try {
    const before = structuredClone(harness.stored.popoState);
    const response = await harness.send({ type: "CHECK_GOPEED" });
    assert.equal(response.ok, true);
    assert.equal(response.connection.connected, true);
    assert.deepEqual(harness.stored.popoState, before);
  } finally {
    harness.cleanup();
  }
});

test("后台再次运行时自动恢复遗留在准备中的文件", async () => {
  const now = new Date().toISOString();
  const state = {
    version: 4,
    runToken: "run-interrupted-preparation",
    jobs: [{
      id: "job-interrupted-preparation",
      key: "key-interrupted-preparation",
      sourceTabId: 7,
      folderName: "混合格式素材",
      folderItemIndex: "1",
      parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1",
      status: "downloading",
      cancelRequested: false,
      createdAt: now,
      counts: {}
    }],
    activeJobId: "job-interrupted-preparation",
    mode: "downloading",
    phase: "preview_loading",
    triggerMode: "folder_button",
    sourceTabId: 7,
    selectedFolderName: "混合格式素材",
    workerFrameId: 42,
    workerReadyUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/folder1",
    settings: { concurrency: 5, gopeedConnections: 1 },
    items: [{
      id: "orphan-preparing-file",
      name: "动画.gif",
      selected: true,
      status: "preparing",
      stage: "建立 Gopeed 任务",
      attempts: 1,
      failureStage: "",
      error: ""
    }],
    preparingItemId: "orphan-preparing-file",
    activeItemId: "orphan-preparing-file",
    activeTransfers: [],
    scanQueue: [],
    resolveQueue: [],
    scanFailures: [],
    scannedFolderCount: 0,
    gopeedConnected: true,
    logs: [],
    startedAt: now,
    completedAt: ""
  };
  const harness = createHarness(
    { popoSettings: state.settings, popoState: state },
    { gopeedTasks: [] }
  );
  try {
    harness.fireAlarm("popo-stable-downloader-pump");
    for (let attempt = 0; attempt < 30 && harness.stored.popoState.preparingItemId; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(harness.stored.popoState.preparingItemId, null);
    assert.equal(harness.stored.popoState.activeItemId, null);
    const recovered = harness.stored["popoItems:job-interrupted-preparation:0"][0];
    assert.equal(recovered.status, "pending");
    assert.equal(recovered.attempts, 0);
    assert.match(recovered.stage, /自动接续/);
  } finally {
    harness.cleanup();
  }
});

test("服务工作线程中断后按稳定标签重新挂接已创建的 Gopeed 任务", async () => {
  const now = new Date().toISOString();
  const itemId = "orphan-after-gopeed-create";
  const jobId = "job-reconcile-created-task";
  const labels = buildTaskIdentityLabels({ jobId, taskIdentity: itemId });
  const state = {
    version: 4,
    runToken: "run-reconcile-created-task",
    jobs: [{
      id: jobId,
      key: "key-reconcile-created-task",
      sourceTabId: 7,
      folderName: "母文件 A",
      folderItemIndex: "1",
      parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1",
      status: "downloading",
      cancelRequested: false,
      createdAt: now,
      counts: {}
    }],
    activeJobId: jobId,
    mode: "downloading",
    phase: "download_start",
    triggerMode: "folder_button",
    sourceTabId: 7,
    selectedFolderName: "母文件 A",
    workerFrameId: 42,
    workerReadyUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/folder1",
    settings: { concurrency: 5, gopeedConnections: 1 },
    items: [{
      id: itemId,
      parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/folder1",
      itemIndex: "7",
      name: "动画.gif",
      selected: true,
      status: "preparing",
      stage: "建立 Gopeed 任务",
      attempts: 1,
      startedAt: now,
      failureStage: "",
      error: ""
    }],
    preparingItemId: itemId,
    activeItemId: itemId,
    activeTransfers: [],
    scanQueue: [],
    resolveQueue: [],
    scanFailures: [],
    scannedFolderCount: 0,
    gopeedConnected: true,
    logs: [],
    startedAt: now,
    completedAt: ""
  };
  const gopeedTasks = [{
    id: "task-reconciled",
    status: "running",
    progress: { downloaded: 1024, speed: 128 },
    meta: {
      req: { labels: { source: "popo-stable-downloader", ...labels } }
    }
  }];
  const harness = createHarness(
    { popoSettings: state.settings, popoState: state },
    { gopeedTasks }
  );
  try {
    harness.fireAlarm("popo-stable-downloader-pump");
    for (let attempt = 0; attempt < 30 && !harness.stored.popoState?.activeTransfers?.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(harness.stored.popoState.preparingItemId, null);
    assert.deepEqual(harness.stored.popoState.activeTransfers, [{
      itemId,
      taskId: "task-reconciled",
      pollFailures: 0,
      startedAt: now,
      reconciledAt: harness.stored.popoState.activeTransfers[0].reconciledAt
    }]);
    const recovered = harness.stored[`popoItems:${jobId}:0`][0];
    assert.equal(recovered.status, "transferring");
    assert.equal(recovered.gopeedTaskId, "task-reconciled");
    assert.match(recovered.stage, /已恢复关联/);
    assert.equal(harness.stored.popoState.runtimeHealth.reconciliation.recoveredCount, 1);
    assert.equal(harness.stored.popoState.runtimeHealth.lastEventCode, "GOPEED_TASK_RECONCILED");
    assert.ok(harness.stored.popoState.logs.some(
      (entry) => entry.code === "GOPEED_TASK_RECONCILED" && entry.context.taskKey === labels.popoTaskKey
    ));
    const snapshot = await harness.send({ type: "GET_STATE" });
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.state.runtimeHealth.reconciliation.lastOutcome, "recovered");
    assert.equal(snapshot.state.runtimeHealth.eventCounts.GOPEED_TASK_RECONCILED, 1);
  } finally {
    harness.cleanup();
  }
});

test("Gopeed 对账接口失败时保留准备状态并等待重试", async () => {
  const now = new Date().toISOString();
  const itemId = "orphan-waiting-reconciliation";
  const jobId = "job-reconciliation-error";
  const state = {
    version: 4,
    runToken: "run-reconciliation-error",
    jobs: [{
      id: jobId,
      key: "key-reconciliation-error",
      sourceTabId: 7,
      folderName: "母文件 B",
      folderItemIndex: "2",
      parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1",
      status: "downloading",
      cancelRequested: false,
      createdAt: now,
      counts: {}
    }],
    activeJobId: jobId,
    mode: "downloading",
    phase: "download_start",
    triggerMode: "folder_button",
    sourceTabId: 7,
    selectedFolderName: "母文件 B",
    workerFrameId: 42,
    settings: { concurrency: 5, gopeedConnections: 1 },
    items: [{
      id: itemId,
      name: "设计源文件.psd",
      selected: true,
      status: "preparing",
      stage: "建立 Gopeed 任务",
      attempts: 1
    }],
    preparingItemId: itemId,
    activeItemId: itemId,
    activeTransfers: [],
    scanQueue: [],
    resolveQueue: [],
    scanFailures: [],
    scannedFolderCount: 0,
    gopeedConnected: true,
    logs: [],
    startedAt: now,
    completedAt: ""
  };
  const harness = createHarness(
    { popoSettings: state.settings, popoState: state },
    { listGopeedTasks: async () => { throw new Error("temporary list failure"); } }
  );
  try {
    harness.fireAlarm("popo-stable-downloader-pump");
    for (let attempt = 0; attempt < 30 && !harness.stored.popoState?.runtimeHealth; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(harness.stored.popoState.preparingItemId, itemId);
    assert.deepEqual(harness.stored.popoState.activeTransfers, []);
    assert.equal(harness.stored.popoState.phase, "reconciling_gopeed");
    assert.equal(harness.stored.popoState.runtimeHealth.reconciliation.lastOutcome, "error");
    assert.equal(harness.stored.popoState.runtimeHealth.reconciliation.errorCount, 1);
    assert.equal(harness.stored.popoState.runtimeHealth.lastEventCode, "GOPEED_RECONCILIATION_ERROR");
  } finally {
    harness.cleanup();
  }
});

test("扫描未结束时可恢复已交付的 Gopeed 任务并继续保持扫描态", async () => {
  const now = new Date().toISOString();
  const jobId = "job-persistent-pipeline";
  const itemId = "https://docs.popo.netease.com/folder\u00007\u0000动画.gif";
  const labels = buildTaskIdentityLabels({ jobId, taskIdentity: itemId });
  const state = {
    version: 4,
    runToken: "run-persistent-pipeline",
    jobs: [{
      id: jobId,
      key: "key-persistent-pipeline",
      sourceTabId: 7,
      folderName: "大型母文件",
      folderItemIndex: "2",
      parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1",
      status: "scanning",
      cancelRequested: false,
      createdAt: now,
      counts: {}
    }],
    activeJobId: jobId,
    mode: "scanning",
    phase: "scanning_and_downloading",
    triggerMode: "folder_button",
    sourceTabId: 7,
    selectedFolderName: "大型母文件",
    workerFrameId: 42,
    workerReadyUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/folder1",
    settings: { concurrency: 5, gopeedConnections: 1 },
    items: [{
      id: itemId,
      parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/folder1",
      itemIndex: "7",
      name: "动画.gif",
      selected: true,
      status: "preparing",
      stage: "建立 Gopeed 任务",
      attempts: 1,
      startedAt: now,
      failureStage: "",
      error: ""
    }],
    preparingItemId: itemId,
    activeItemId: itemId,
    activeTransfers: [],
    scanQueue: [{
      url: "https://docs.popo.netease.com/team/pc/team1/pageDetail/folder-next",
      path: ["大型母文件", "下一层"]
    }],
    resolveQueue: [],
    scanFailures: [],
    scannedFolderCount: 0,
    gopeedConnected: true,
    workflow: {
      version: 1,
      sequence: 3,
      value: { scan: "running", handoff: "preparing", transfer: "idle" },
      nextAction: "handoff",
      reservedItemId: itemId,
      counts: { discovered: 1, selected: 1, preparing: 1 },
      updatedAt: now
    },
    logs: [],
    startedAt: now,
    completedAt: ""
  };
  const gopeedTasks = [{
    id: "task-pipeline-recovered",
    status: "running",
    progress: { downloaded: 2048, speed: 256 },
    meta: { req: { labels: { source: "popo-stable-downloader", ...labels } } }
  }];
  const harness = createHarness(
    { popoSettings: state.settings, popoState: state },
    { gopeedTasks }
  );
  try {
    harness.fireAlarm("popo-stable-downloader-pump");
    for (let attempt = 0; attempt < 30 && !harness.stored.popoState?.activeTransfers?.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(harness.stored.popoState.mode, "scanning");
    assert.equal(harness.stored.popoState.scanQueue.length, 1);
    assert.equal(harness.stored.popoState.preparingItemId, null);
    assert.equal(harness.stored.popoState.activeTransfers[0].taskId, "task-pipeline-recovered");
    assert.deepEqual(harness.stored.popoState.workflow.value, {
      scan: "running",
      handoff: "idle",
      transfer: "active"
    });
    assert.equal(harness.stored.popoState.workflow.nextAction, "scan");
    assert.equal(harness.stored.popoState.jobs[0].counts.handedOff, 1);
  } finally {
    harness.cleanup();
  }
});

test("opening the extension finalizes a cancelled job with a paused Gopeed transfer", async () => {
  const now = new Date().toISOString();
  const state = {
    version: 4,
    runToken: "run-stuck-cancel",
    jobs: [{
      id: "job-stuck-cancel",
      key: "key-stuck-cancel",
      sourceTabId: 7,
      folderName: "cancelled folder",
      folderItemIndex: "1",
      parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1",
      status: "draining_paused",
      cancelRequested: true,
      createdAt: now,
      counts: {}
    }],
    activeJobId: "job-stuck-cancel",
    mode: "draining_paused",
    phase: "draining_paused",
    triggerMode: "folder_button",
    sourceTabId: 7,
    selectedFolderName: "cancelled folder",
    settings: { concurrency: 5, gopeedConnections: 1 },
    items: [{
      id: "started-file",
      name: "started.mp4",
      selected: true,
      status: "paused",
      gopeedTaskId: "gopeed-task-1"
    }],
    activeTransfers: [{ itemId: "started-file", taskId: "gopeed-task-1" }],
    scanQueue: [],
    resolveQueue: [],
    scanFailures: [],
    scannedFolderCount: 0,
    logs: [],
    startedAt: now,
    completedAt: ""
  };
  const harness = createHarness({ popoSettings: state.settings, popoState: state });
  try {
    const response = await harness.send({ type: "GET_STATE" });
    assert.equal(response.ok, true);
    assert.equal(response.state.activeJobId, null);
    assert.equal(response.state.mode, "idle");
    assert.deepEqual(response.state.jobs, []);
    assert.equal(harness.stored.popoState.jobs[0].status, "cancelled");
    assert.deepEqual(harness.deletedGopeedTasks, []);
  } finally {
    harness.cleanup();
  }
});

test("取消活动任务仅取消未开始文件并保留 Gopeed 传输", async () => {
  const now = new Date().toISOString();
  const settings = { concurrency: 5, gopeedConnections: 1 };
  const state = {
    version: 4,
    runToken: "run-seeded",
    jobs: [{
      id: "job-a",
      key: "key-a",
      sourceTabId: 7,
      folderName: "母文件 A",
      folderItemIndex: "1",
      parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1",
      status: "downloading",
      cancelRequested: false,
      createdAt: now,
      counts: {}
    }],
    activeJobId: "job-a",
    mode: "downloading",
    phase: "preview_loading",
    triggerMode: "folder_button",
    sourceTabId: 7,
    selectedFolderName: "母文件 A",
    settings,
    items: [
      { id: "active", parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/folder1", name: "active.mp4", selected: true, status: "transferring", gopeedTaskId: "task-1" },
      { id: "pending", parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/folder1", name: "pending.mp4", selected: true, status: "pending", gopeedTaskId: null }
    ],
    activeTransfers: [{ itemId: "active", taskId: "task-1" }],
    scanQueue: [],
    resolveQueue: [],
    scanFailures: [],
    scannedFolderCount: 0,
    logs: [],
    startedAt: now,
    completedAt: ""
  };
  const harness = createHarness({ popoSettings: settings, popoState: state });
  try {
    const response = await harness.send({ type: "CANCEL_JOB", jobId: "job-a" });
    assert.equal(response.ok, true);
    assert.equal(response.state.mode, "idle");
    assert.equal(response.state.jobs.length, 1);
    assert.equal(response.state.jobs[0].status, "cancelled");
    assert.deepEqual(response.state.jobs[0].cancelledRetryKeys, [
      "https://docs.popo.netease.com/team/pc/team1/pageDetail/folder1\u0000pending.mp4"
    ]);
    assert.deepEqual(harness.deletedGopeedTasks, []);
    assert.equal(harness.stored.popoState.jobs[0].status, "cancelled");
    assert.equal(harness.stored.popoState.jobs[0].cancelRequested, true);
    assert.deepEqual(harness.stored.popoState.activeTransfers, []);
  } finally {
    harness.cleanup();
  }
});

test("移除终止任务只清理扩展记录且不删除下载任务或文件", async () => {
  const now = new Date().toISOString();
  const settings = { concurrency: 5, gopeedConnections: 1 };
  const state = {
    version: 4,
    runToken: "run-dismiss-terminal",
    jobs: [{
      id: "job-cancelled",
      key: "folder-a",
      folderName: "母文件 A",
      status: "cancelled",
      createdAt: now,
      completedAt: now,
      counts: { files: 3, success: 1, failed: 0, cancelled: 2 },
      cancelledRetryKeys: ["folder\u0000a.psd", "folder\u0000b.psd"]
    }, {
      id: "job-cancelled-retry",
      key: "folder-a",
      restoreOfJobId: "job-cancelled",
      folderName: "母文件 A",
      status: "failed",
      createdAt: now,
      completedAt: now,
      counts: { files: 0, success: 0, failed: 0, cancelled: 0 }
    }, {
      id: "job-unrelated-failure",
      key: "folder-b",
      folderName: "母文件 B",
      status: "failed",
      createdAt: now,
      completedAt: now,
      counts: { files: 1, success: 0, failed: 1, cancelled: 0 },
      failureRetryKeys: ["folder\u0000broken.psd"]
    }],
    activeJobId: null,
    mode: "idle",
    phase: "idle",
    settings,
    activeTransfers: [],
    scanQueue: [],
    resolveQueue: [],
    scanFailures: [],
    logs: []
  };
  const harness = createHarness({ popoSettings: settings, popoState: state });
  try {
    const response = await harness.send({ type: "DISMISS_JOB", jobId: "job-cancelled" });
    assert.equal(response.ok, true);
    assert.deepEqual(harness.stored.popoState.jobs.map((job) => job.id), ["job-unrelated-failure"]);
    assert.deepEqual(response.state.jobs.map((job) => job.id), ["job-unrelated-failure"]);
    assert.deepEqual(harness.deletedGopeedTasks, []);
  } finally {
    harness.cleanup();
  }
});

test("进行中的显式重试任务不能被移除", async () => {
  const now = new Date().toISOString();
  const settings = { concurrency: 5, gopeedConnections: 1 };
  const state = {
    version: 4,
    runToken: "run-dismiss-active",
    jobs: [{
      id: "job-old-failure",
      key: "folder-a",
      folderName: "母文件 A",
      status: "failed",
      createdAt: now,
      completedAt: now,
      counts: { files: 1, success: 0, failed: 1, cancelled: 0 }
    }, {
      id: "job-active-retry",
      key: "folder-a",
      retryOfJobId: "job-old-failure",
      folderName: "母文件 A",
      status: "paused",
      createdAt: now,
      counts: { files: 1, success: 0, failed: 0, cancelled: 0 }
    }],
    activeJobId: "job-active-retry",
    mode: "paused",
    phase: "paused",
    settings,
    items: [],
    activeTransfers: [],
    scanQueue: [],
    resolveQueue: [],
    scanFailures: [],
    logs: []
  };
  const harness = createHarness({ popoSettings: settings, popoState: state });
  try {
    const response = await harness.send({ type: "DISMISS_JOB", jobId: "job-old-failure" });
    assert.equal(response.ok, false);
    assert.match(response.error, /仍在进行/);
    assert.equal(harness.stored.popoState.jobs.length, 2);
  } finally {
    harness.cleanup();
  }
});

test("同一文件夹后来创建的独立任务不会阻止移除旧记录", async () => {
  const now = new Date().toISOString();
  const settings = { concurrency: 5, gopeedConnections: 1 };
  const state = {
    version: 4,
    runToken: "run-dismiss-independent-same-folder",
    jobs: [{
      id: "job-old-cancelled",
      key: "folder-a",
      folderName: "母文件 A",
      status: "cancelled",
      createdAt: now,
      completedAt: now,
      counts: { files: 1, success: 0, failed: 0, cancelled: 1 },
      cancelledRetryKeys: ["folder\u0000old.psd"]
    }, {
      id: "job-new-independent",
      key: "folder-a",
      folderName: "母文件 A",
      status: "paused",
      createdAt: now,
      counts: { files: 2, success: 0, failed: 0, cancelled: 0 }
    }],
    activeJobId: "job-new-independent",
    mode: "paused",
    phase: "paused",
    settings,
    items: [],
    activeTransfers: [],
    scanQueue: [],
    resolveQueue: [],
    scanFailures: [],
    logs: []
  };
  const harness = createHarness({ popoSettings: settings, popoState: state });
  try {
    const response = await harness.send({ type: "DISMISS_JOB", jobId: "job-old-cancelled" });
    assert.equal(response.ok, true);
    assert.deepEqual(response.state.jobs.map((job) => job.id), ["job-new-independent"]);
    assert.deepEqual(harness.stored.popoState.jobs.map((job) => job.id), ["job-new-independent"]);
  } finally {
    harness.cleanup();
  }
});

test("升级后可从旧版取消状态中只恢复未开始文件", async () => {
  const now = new Date().toISOString();
  const parentUrl = "https://docs.popo.netease.com/team/pc/team1/pageDetail/folder1";
  const state = {
    version: 4,
    runToken: "run-legacy-cancelled",
    jobs: [{
      id: "job-legacy-cancelled",
      key: "key-legacy-cancelled",
      sourceTabId: 7,
      folderName: "母文件 A",
      folderItemIndex: "1",
      parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1",
      status: "cancelled",
      cancelRequested: true,
      createdAt: now,
      completedAt: now,
      counts: { files: 3, success: 1, failed: 0, cancelled: 2 }
    }],
    activeJobId: null,
    mode: "idle",
    phase: "idle",
    itemStorageJobId: "idle",
    itemChunkCount: 1,
    itemChunkHashes: [],
    activeTransfers: [],
    scanQueue: [],
    resolveQueue: [],
    scanFailures: [],
    settings: { concurrency: 5, gopeedConnections: 1 },
    logs: []
  };
  const items = [
    { id: "done", parentUrl, name: "done.psd", selected: true, status: "success" },
    { id: "cancelled-1", parentUrl, name: "remaining.gif", selected: true, status: "cancelled" },
    { id: "cancelled-2", parentUrl, name: "remaining.bin", selected: true, status: "cancelled" }
  ];
  const harness = createHarness({
    popoSettings: state.settings,
    popoState: state,
    "popoItems:idle:0": items
  });
  try {
    const response = await harness.send({
      type: "RESTORE_CANCELLED_JOB",
      jobId: "job-legacy-cancelled"
    });
    assert.equal(response.ok, true);
    assert.equal(response.state.mode, "waiting_worker");
    assert.equal(response.state.jobs.length, 1);
    assert.match(response.state.jobs[0].displayName, /恢复未开始文件/);
    const storedJobs = harness.stored.popoState.jobs;
    const source = storedJobs.find((job) => job.id === "job-legacy-cancelled");
    const restored = storedJobs.find((job) => job.restoreOfJobId === source.id);
    assert.deepEqual(source.cancelledRetryKeys, [
      `${parentUrl}\u0000remaining.gif`,
      `${parentUrl}\u0000remaining.bin`
    ]);
    assert.deepEqual(restored.retryKeys, source.cancelledRetryKeys);
    assert.equal(restored.status, "waiting_worker");
    assert.equal(harness.deletedGopeedTasks.length, 0);
    assert.ok(harness.sentTabMessages.some(({ message }) => message.type === "ENSURE_WORKER_FRAME"));
  } finally {
    harness.cleanup();
  }
});

test("从弹窗恢复时改用当前打开的 POPO 页面承载隐藏工作区", async () => {
  const now = new Date().toISOString();
  const state = {
    version: 4,
    runToken: "run-popup-restore",
    jobs: [{
      id: "job-popup-restore",
      key: "key-popup-restore",
      sourceTabId: 99,
      folderName: "母文件 A",
      folderItemIndex: "1",
      parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1",
      status: "cancelled",
      cancelRequested: true,
      createdAt: now,
      completedAt: now,
      counts: { files: 2, success: 1, failed: 0, cancelled: 1 },
      cancelledRetryKeys: [
        "https://docs.popo.netease.com/team/pc/team1/pageDetail/folder1\u0000remaining.psd"
      ]
    }],
    activeJobId: null,
    mode: "idle",
    phase: "idle",
    itemStorageJobId: "idle",
    itemChunkCount: 0,
    activeTransfers: [],
    scanQueue: [],
    resolveQueue: [],
    scanFailures: [],
    settings: { concurrency: 5, gopeedConnections: 1 },
    logs: []
  };
  const harness = createHarness({ popoSettings: state.settings, popoState: state });
  try {
    const response = await harness.send(
      { type: "RESTORE_CANCELLED_JOB", jobId: "job-popup-restore", sourceTabId: 7 },
      { url: "chrome-extension://coocdgkmbpkacapjlmnmemebmmdahjaa/popup.html", frameId: 0 }
    );
    assert.equal(response.ok, true);
    const source = harness.stored.popoState.jobs.find((job) => job.id === "job-popup-restore");
    const restored = harness.stored.popoState.jobs.find(
      (job) => job.restoreOfJobId === "job-popup-restore"
    );
    assert.equal(source.sourceTabId, 7);
    assert.equal(restored.sourceTabId, 7);
    assert.ok(harness.sentTabMessages.some(({ tabId, message }) =>
      tabId === 7 && message.type === "ENSURE_WORKER_FRAME"
    ));
  } finally {
    harness.cleanup();
  }
});

test("旧版取消任务丢失明细时按 Gopeed 已有保存路径恢复缺失文件", async () => {
  const now = new Date().toISOString();
  const state = {
    version: 4,
    runToken: "run-legacy-no-items",
    jobs: [{
      id: "job-legacy-no-items",
      key: "key-legacy-no-items",
      sourceTabId: 7,
      folderName: "母文件 A",
      folderItemIndex: "1",
      parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1",
      status: "cancelled",
      cancelRequested: true,
      createdAt: now,
      completedAt: now,
      counts: { files: 3, success: 1, failed: 0, cancelled: 2 }
    }],
    activeJobId: null,
    mode: "idle",
    phase: "idle",
    itemStorageJobId: "",
    itemChunkCount: 0,
    activeTransfers: [],
    scanQueue: [],
    resolveQueue: [],
    scanFailures: [],
    settings: { downloadRoot: "POPO稳定下载", concurrency: 5, gopeedConnections: 1 },
    logs: []
  };
  const gopeedTasks = [{
    status: "done",
    name: "done.psd",
    meta: {
      req: { labels: { source: "popo-stable-downloader" } },
      opts: {
        path: "D:\\Downloads\\POPO稳定下载\\母文件 A",
        name: "done.psd"
      }
    }
  }];
  const harness = createHarness(
    { popoSettings: state.settings, popoState: state },
    {
      gopeedConfig: { downloadDir: "D:\\Downloads" },
      gopeedTasks
    }
  );
  try {
    const response = await harness.send({
      type: "RESTORE_CANCELLED_JOB",
      jobId: "job-legacy-no-items"
    });
    assert.equal(response.ok, true);
    assert.equal(response.state.mode, "waiting_worker");
    const source = harness.stored.popoState.jobs.find((job) => job.id === "job-legacy-no-items");
    const restored = harness.stored.popoState.jobs.find((job) => job.restoreOfJobId === source.id);
    assert.deepEqual(restored.retryKeys, []);
    assert.equal(restored.restoreStrategy, "missing_from_gopeed");
    assert.equal(restored.restoreExpectedCount, 2);
    assert.deepEqual(restored.existingGopeedTargetKeys, [
      "popo稳定下载/母文件 a/done.psd"
    ]);
    assert.equal(response.state.jobs[0].existingGopeedTargetCount, 1);
    assert.equal(response.state.jobs[0].existingGopeedTargetKeys, undefined);
    assert.ok(harness.sentTabMessages.some(({ message }) => message.type === "ENSURE_WORKER_FRAME"));
  } finally {
    harness.cleanup();
  }
});

test("刷新 POPO 页面会恢复准备中的文件且保留已开始的 Gopeed 下载", async () => {
  const now = new Date().toISOString();
  const settings = { concurrency: 5, gopeedConnections: 1 };
  const state = {
    version: 4,
    runToken: "run-refresh",
    jobs: [{
      id: "job-refresh",
      key: "key-refresh",
      sourceTabId: 7,
      folderName: "母文件 A",
      folderItemIndex: "1",
      parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1",
      status: "downloading",
      cancelRequested: false,
      createdAt: now,
      counts: {}
    }],
    activeJobId: "job-refresh",
    mode: "downloading",
    phase: "preview_loading",
    triggerMode: "folder_button",
    sourceTabId: 7,
    selectedFolderName: "母文件 A",
    rootUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1",
    workerFrameId: 42,
    workerReadyUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/folder1",
    settings,
    items: [
      { id: "active", name: "active.mp4", selected: true, status: "transferring", gopeedTaskId: "task-1" },
      { id: "preparing", name: "preparing.mp4", selected: true, status: "preparing", attempts: 2 }
    ],
    preparingItemId: "preparing",
    activeTransfers: [{ itemId: "active", taskId: "task-1" }],
    scanQueue: [],
    resolveQueue: [],
    scanFailures: [],
    scannedFolderCount: 0,
    logs: [],
    startedAt: now,
    completedAt: ""
  };
  const harness = createHarness({ popoSettings: settings, popoState: state });
  try {
    const response = await harness.send({
      type: "SOURCE_PAGE_READY",
      url: state.rootUrl
    });
    assert.equal(response.ok, true);
    assert.equal(response.needsWorker, true);
    assert.equal(response.workerUrl, state.rootUrl);
    assert.equal(harness.stored.popoState.mode, "downloading");
    assert.equal(harness.stored.popoState.workerFrameId, null);
    assert.equal(harness.stored.popoState.preparingItemId, null);
    assert.deepEqual(harness.stored.popoState.activeTransfers, [{ itemId: "active", taskId: "task-1" }]);
    const items = harness.stored["popoItems:job-refresh:0"];
    assert.equal(items.find((item) => item.id === "active").status, "transferring");
    assert.equal(items.find((item) => item.id === "preparing").status, "pending");
    assert.equal(items.find((item) => item.id === "preparing").attempts, 1);
    assert.equal(items.find((item) => item.id === "preparing").failureStage, "");
    assert.equal(harness.actionState.text, "0%");
    assert.match(harness.actionState.title, /0\/2（0%）/);
  } finally {
    harness.cleanup();
  }
});

test("原 POPO 标签页关闭后可在其他团队空间的 POPO 标签页恢复任务", async () => {
  const now = new Date().toISOString();
  const rootUrl = "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1";
  const state = {
    version: 4,
    runToken: "run-reopen",
    jobs: [{
      id: "job-reopen",
      key: "key-reopen",
      sourceTabId: 7,
      folderName: "母文件 A",
      folderItemIndex: "1",
      parentUrl: rootUrl,
      status: "downloading",
      cancelRequested: false,
      createdAt: now,
      counts: { files: 1 }
    }],
    activeJobId: "job-reopen",
    mode: "downloading",
    phase: "waiting_worker",
    triggerMode: "folder_button",
    sourceTabId: 7,
    selectedFolderName: "母文件 A",
    rootUrl,
    teamSpaceKey: "team1",
    workerFrameId: null,
    settings: { concurrency: 5, gopeedConnections: 1 },
    items: [{ id: "pending", name: "pending.mp4", selected: true, status: "pending", attempts: 0 }],
    activeTransfers: [],
    scanQueue: [],
    resolveQueue: [],
    scanFailures: [],
    scannedFolderCount: 0,
    logs: [],
    startedAt: now,
    completedAt: ""
  };
  const harness = createHarness({ popoSettings: state.settings, popoState: state });
  try {
    const response = await harness.send(
      { type: "SOURCE_PAGE_READY", url: "https://docs.popo.netease.com/team/pc/team2/pageDetail/another1" },
      { tab: { id: 9 }, frameId: 0 }
    );
    assert.equal(response.ok, true);
    assert.equal(response.needsWorker, true);
    assert.equal(harness.stored.popoState.sourceTabId, 9);
    assert.equal(harness.stored.popoState.jobs[0].sourceTabId, 9);
    assert.match(harness.stored.popoState.lastMessage, /恢复任务/);
  } finally {
    harness.cleanup();
  }
});

test("继续下载时会主动重建失联的页面工作区", async () => {
  const now = new Date().toISOString();
  const rootUrl = "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1";
  const state = {
    version: 4,
    runToken: "run-paused-worker-missing",
    jobs: [{
      id: "job-paused-worker-missing",
      key: "key-paused-worker-missing",
      sourceTabId: 7,
      folderName: "母文件 A",
      folderItemIndex: "1",
      parentUrl: rootUrl,
      status: "paused",
      cancelRequested: false,
      createdAt: now,
      counts: { files: 1, success: 0, failed: 0, cancelled: 0 }
    }],
    activeJobId: "job-paused-worker-missing",
    mode: "paused",
    phase: "paused",
    triggerMode: "folder_button",
    sourceTabId: 7,
    selectedFolderName: "母文件 A",
    rootUrl,
    teamSpaceKey: "team1",
    workerFrameId: null,
    settings: { concurrency: 5, gopeedConnections: 1 },
    items: [{
      id: "pending",
      parentUrl: rootUrl,
      name: "pending.psd",
      selected: true,
      status: "pending",
      attempts: 0
    }],
    activeTransfers: [],
    scanQueue: [],
    resolveQueue: [],
    scanFailures: [],
    scannedFolderCount: 0,
    logs: [],
    startedAt: now,
    completedAt: ""
  };
  const harness = createHarness({ popoSettings: state.settings, popoState: state });
  try {
    const response = await harness.send({ type: "RESUME" });
    assert.equal(response.ok, true);
    assert.equal(response.state.mode, "downloading");
    assert.ok(harness.sentTabMessages.some(({ tabId, message }) =>
      tabId === 7 && message.type === "ENSURE_WORKER_FRAME" && message.url === rootUrl
    ));
  } finally {
    harness.cleanup();
  }
});

test("旧版 chrome.storage 文件分块首次读取后迁移到 IndexedDB", async () => {
  const restoreIndexedDb = installFakeIndexedDb();
  const runtime = require("../runtime/popo-runtime.cjs");
  await runtime.taskStore.resetDatabaseForTests();
  const now = new Date().toISOString();
  const jobId = "job-legacy-storage";
  const legacyKey = "popoItems:" + jobId + ":0";
  const items = [{
    id: "legacy-item",
    parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1",
    name: "legacy.psd",
    selected: true,
    status: "pending",
    attempts: 0
  }];
  const state = {
    version: 4,
    runToken: "run-legacy-storage",
    jobs: [{
      id: jobId,
      key: "legacy-storage-key",
      sourceTabId: null,
      folderName: "旧版大任务",
      folderItemIndex: "1",
      parentUrl: items[0].parentUrl,
      status: "downloading",
      cancelRequested: false,
      createdAt: now,
      counts: { files: 1 }
    }],
    activeJobId: jobId,
    mode: "downloading",
    phase: "starting",
    triggerMode: "folder_button",
    sourceTabId: null,
    settings: { concurrency: 5, gopeedConnections: 1 },
    itemStorageBackend: "chrome-storage-fallback",
    itemStorageGeneration: "",
    itemStorageJobId: jobId,
    itemChunkCount: 1,
    itemChunkHashes: [],
    activeTransfers: [],
    scanQueue: [],
    resolveQueue: [],
    scanFailures: [],
    scannedFolderCount: 0,
    logs: [],
    startedAt: now,
    completedAt: ""
  };
  const harness = createHarness({
    popoSettings: state.settings,
    popoState: state,
    [legacyKey]: items
  });
  try {
    const response = await harness.send({ type: "PAUSE" });
    assert.equal(response.ok, true);
    assert.equal(harness.stored.popoState.itemStorageBackend, "indexeddb");
    assert.match(harness.stored.popoState.itemStorageGeneration, /^v1-/);
    assert.equal(legacyKey in harness.stored, false);
    assert.ok(harness.stored.popoState.runtimeHealth.storage.lastMigrationAt);
    const restored = await runtime.taskStore.readItemChunks({
      jobId,
      generation: harness.stored.popoState.itemStorageGeneration,
      chunkCount: 1,
      hashes: harness.stored.popoState.itemChunkHashes
    });
    assert.deepEqual(restored, items);
  } finally {
    harness.cleanup();
    await runtime.taskStore.resetDatabaseForTests();
    restoreIndexedDb();
  }
});

test("万级文件状态按块持久化且公开状态不传输完整文件数组", async () => {
  const restoreIndexedDb = installFakeIndexedDb();
  const runtime = require("../runtime/popo-runtime.cjs");
  await runtime.taskStore.resetDatabaseForTests();
  const now = new Date().toISOString();
  const items = Array.from({ length: 10000 }, (_, index) => ({
    id: `item-${index}`,
    name: `video-${index}.mp4`,
    parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/folder1",
    selected: true,
    status: "pending"
  }));
  const state = {
    version: 4,
    runToken: "run-large",
    jobs: [{
      id: "job-large",
      key: "key-large",
      sourceTabId: 7,
      folderName: "超大母文件",
      folderItemIndex: "8",
      parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1",
      status: "downloading",
      cancelRequested: false,
      createdAt: now,
      counts: {}
    }],
    activeJobId: "job-large",
    mode: "downloading",
    phase: "starting",
    triggerMode: "folder_button",
    sourceTabId: 7,
    selectedFolderName: "超大母文件",
    settings: { concurrency: 5, gopeedConnections: 1 },
    items,
    activeTransfers: [],
    scanQueue: [],
    resolveQueue: [],
    scanFailures: [],
    scannedFolderCount: 50,
    logs: [],
    startedAt: now,
    completedAt: ""
  };
  const harness = createHarness({ popoState: state, popoSettings: state.settings });
  try {
    const paused = await harness.send({ type: "PAUSE" });
    assert.equal(paused.ok, true);
    assert.equal(harness.stored.popoState.itemChunkCount, 50);
    assert.equal(harness.stored.popoState.itemStorageBackend, "indexeddb");
    assert.match(harness.stored.popoState.itemStorageGeneration, /^v1-/);
    assert.equal("items" in harness.stored.popoState, false);
    assert.equal("popoItems:job-large:0" in harness.stored, false);
    const restoredItems = await runtime.taskStore.readItemChunks({
      jobId: "job-large",
      generation: harness.stored.popoState.itemStorageGeneration,
      chunkCount: 50,
      hashes: harness.stored.popoState.itemChunkHashes
    });
    assert.equal(restoredItems.length, 10000);
    assert.equal(restoredItems[9999].id, "item-9999");
    const snapshot = await harness.send({ type: "GET_STATE" });
    assert.equal("items" in snapshot.state, false);
    assert.equal(snapshot.state.jobs[0].counts.files, 10000);
    assert.equal(snapshot.state.jobs[0].counts.projects, 10050);
  } finally {
    harness.cleanup();
    await runtime.taskStore.resetDatabaseForTests();
    restoreIndexedDb();
  }
});

test("手动暂停和继续 Gopeed 任务时项目保持运行并持续对账", async () => {
  const state = transferState();
  let gopeedStatus = "pause";
  const harness = createHarness(
    { popoSettings: state.settings, popoState: state },
    {
      async getGopeedTask() {
        return { status: gopeedStatus, progress: { downloaded: 1024, speed: 0 } };
      }
    }
  );
  try {
    harness.fireAlarm("popo-stable-downloader-pump");
    await waitUntil(() => harness.stored.popoState?.activeTransfers?.[0]?.externalPaused === true);
    assert.equal(harness.stored.popoState.mode, "downloading");
    assert.equal(harness.stored["popoItems:job-gopeed-control:0"][0].status, "paused");

    gopeedStatus = "running";
    harness.fireAlarm("popo-stable-downloader-pump");
    await waitUntil(() => harness.stored.popoState?.activeTransfers?.[0]?.externalPaused === false);
    assert.equal(harness.stored.popoState.mode, "downloading");
    assert.equal(harness.stored["popoItems:job-gopeed-control:0"][0].status, "transferring");
    assert.ok(harness.stored.popoState.logs.some((entry) =>
      entry.code === "GOPEED_TASK_RESUMED_EXTERNALLY"
    ));
  } finally {
    harness.cleanup();
  }
});

test("旧版项目因 Gopeed 手动暂停卡住后会在任务完成时自动接续", async () => {
  const state = transferState({ mode: "paused", jobStatus: "paused", includePending: true });
  state.items[0].status = "paused";
  const harness = createHarness(
    { popoSettings: state.settings, popoState: state },
    {
      async getGopeedTask() {
        return { status: "done", progress: { downloaded: 2048, speed: 0 } };
      }
    }
  );
  try {
    harness.fireAlarm("popo-stable-downloader-watchdog");
    await waitUntil(() => harness.stored.popoState?.mode === "downloading");
    assert.equal(harness.stored.popoState.activeTransfers.length, 0);
    assert.equal(harness.stored["popoItems:job-gopeed-control:0"][0].status, "success");
    assert.ok(harness.stored.popoState.logs.some((entry) =>
      entry.code === "GOPEED_PROJECT_RECONCILED"
    ));
  } finally {
    harness.cleanup();
  }
});

test("POPO 页面暂停具有明确归属且扫描阶段也能暂停后继续", async () => {
  const state = transferState({ mode: "scanning", jobStatus: "scanning" });
  let queriedGopeed = 0;
  const harness = createHarness(
    { popoSettings: state.settings, popoState: state },
    {
      async getGopeedTask() {
        queriedGopeed += 1;
        return { status: "pause", progress: { downloaded: 1024, speed: 0 } };
      }
    }
  );
  try {
    const paused = await harness.send({ type: "PAUSE" });
    assert.equal(paused.ok, true);
    assert.equal(paused.state.mode, "paused");
    assert.equal(paused.state.pauseOrigin, "popo");
    assert.equal(paused.state.pauseResumeMode, "scanning");
    assert.deepEqual(harness.pausedGopeedTasks, ["task-active"]);

    harness.fireAlarm("popo-stable-downloader-watchdog");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(harness.stored.popoState.mode, "paused");
    assert.equal(queriedGopeed, 0);

    const resumed = await harness.send({ type: "RESUME" });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.state.mode, "scanning");
    assert.equal(resumed.state.pauseOrigin, "");
    assert.deepEqual(harness.continuedGopeedTasks, ["task-active"]);
  } finally {
    harness.cleanup();
  }
});

test("网页暂停后若 Gopeed 已手动完成，继续前先对账且不重复恢复", async () => {
  const state = transferState({ mode: "paused", jobStatus: "paused", includePending: true });
  state.pauseOrigin = "popo";
  state.pauseResumeMode = "downloading";
  state.items[0].status = "paused";
  state.items[0].stage = "已暂停";
  const harness = createHarness(
    { popoSettings: state.settings, popoState: state },
    {
      async getGopeedTask() {
        return { status: "done", progress: { downloaded: 2048, speed: 0 } };
      }
    }
  );
  try {
    const response = await harness.send({ type: "RESUME" });
    assert.equal(response.ok, true);
    assert.equal(response.state.mode, "downloading");
    assert.deepEqual(harness.continuedGopeedTasks, []);
    assert.equal(harness.stored.popoState.activeTransfers.length, 0);
    assert.equal(harness.stored["popoItems:job-gopeed-control:0"][0].status, "success");
    assert.equal(harness.stored.popoState.jobs[0].counts.success, 1);
    assert.equal(harness.stored.popoState.jobs[0].counts.failed, 0);
  } finally {
    harness.cleanup();
  }
});

test("停止卡住项目时先核对 Gopeed 完成状态再取消未开始文件", async () => {
  const state = transferState({ mode: "paused", jobStatus: "paused", includePending: true });
  state.items[0].status = "paused";
  const harness = createHarness(
    { popoSettings: state.settings, popoState: state },
    {
      async getGopeedTask() {
        return { status: "done", progress: { downloaded: 2048, speed: 0 } };
      }
    }
  );
  try {
    const response = await harness.send({ type: "CANCEL" });
    assert.equal(response.ok, true);
    const job = harness.stored.popoState.jobs.find((candidate) => candidate.id === "job-gopeed-control");
    assert.equal(job.status, "cancelled");
    assert.equal(job.counts.success, 1);
    assert.equal(job.counts.cancelled, 1);
    assert.equal(harness.stored.popoState.activeJobId, null);
  } finally {
    harness.cleanup();
  }
});
