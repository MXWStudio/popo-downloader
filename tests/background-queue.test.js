"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

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
  const actionState = {};

  global.importScripts = (...files) => {
    if (files.includes("core.js")) global.PopoCore = require("../core.js");
    if (files.includes("gopeed.js")) {
      global.PopoGopeed = {
        ...require("../gopeed.js"),
        ...(options.gopeedConfig ? {
          async getConfig() { return structuredClone(options.gopeedConfig); }
        } : {}),
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
      async sendMessage() { return { ok: true }; },
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
    delete require.cache[backgroundPath];
  };
  const fireAlarm = (name) => {
    for (const alarmListener of global.chrome.alarms.onAlarm.listeners) alarmListener({ name });
  };
  return { actionState, cleanup, deletedGopeedTasks, fireAlarm, send, stored };
}

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
    assert.equal(harness.stored.popoState.settings.concurrency, 5);

    const snapshot = await harness.send({ type: "GET_STATE" });
    assert.equal(snapshot.settings.formats, "");
    assert.equal(snapshot.settings.includeKeywords, "");
    assert.equal(snapshot.settings.excludeKeywords, "");
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
  const harness = createHarness({ popoSettings: state.settings, popoState: state });
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
      { id: "active", name: "active.mp4", selected: true, status: "transferring", gopeedTaskId: "task-1" },
      { id: "pending", name: "pending.mp4", selected: true, status: "pending", gopeedTaskId: null }
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
    assert.deepEqual(response.state.jobs, []);
    assert.deepEqual(harness.deletedGopeedTasks, []);
    assert.equal(harness.stored.popoState.jobs[0].status, "cancelled");
    assert.equal(harness.stored.popoState.jobs[0].cancelRequested, true);
    assert.deepEqual(harness.stored.popoState.activeTransfers, []);
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

test("原 POPO 标签页关闭后可在同一团队空间的新标签页恢复任务", async () => {
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
      { type: "SOURCE_PAGE_READY", url: rootUrl },
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

test("万级文件状态按块持久化且公开状态不传输完整文件数组", async () => {
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
    assert.equal("items" in harness.stored.popoState, false);
    assert.equal(harness.stored["popoItems:job-large:0"].length, 200);
    assert.equal(harness.stored["popoItems:job-large:49"].length, 200);
    const snapshot = await harness.send({ type: "GET_STATE" });
    assert.equal("items" in snapshot.state, false);
    assert.equal(snapshot.state.jobs[0].counts.files, 10000);
    assert.equal(snapshot.state.jobs[0].counts.projects, 10050);
  } finally {
    harness.cleanup();
  }
});
