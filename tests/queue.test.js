"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

global.PopoRuntime = require("../runtime/popo-runtime.cjs");

const {
  applyCancelPolicy,
  canTransitionJobStatus,
  clientVisibleJobs,
  findDuplicateJob,
  isJobActive,
  makeFolderJobKey,
  queuePosition,
  summarizeItems,
  transitionJobStatus
} = require("../queue.js");

test.after(() => {
  delete global.PopoRuntime;
});

test("任务状态转换由纯函数统一约束且终态不能回流", () => {
  const original = { id: "job-a", status: "queued", lastMessage: "等待中" };
  const waiting = transitionJobStatus(original, "waiting_worker", { lastMessage: "准备工作区" });
  const scanning = transitionJobStatus(waiting, "scanning");
  const scanComplete = transitionJobStatus(scanning, "scan_complete");
  const starting = transitionJobStatus(scanComplete, "starting");
  const downloading = transitionJobStatus(starting, "downloading");
  const paused = transitionJobStatus(downloading, "paused");
  const resumed = transitionJobStatus(paused, "downloading");
  const complete = transitionJobStatus(resumed, "complete");

  assert.equal(original.status, "queued");
  assert.equal(original.lastMessage, "等待中");
  assert.notEqual(waiting, original);
  assert.equal(waiting.lastMessage, "准备工作区");
  assert.equal(complete.status, "complete");
  assert.equal(isJobActive("scan_complete"), true);
  assert.equal(canTransitionJobStatus("failed", "downloading"), false);
  assert.throws(
    () => transitionJobStatus(complete, "downloading"),
    /非法任务状态转换/
  );

  const legacy = transitionJobStatus({ id: "legacy", status: "legacy_running" }, "scanning");
  assert.equal(legacy.status, "scanning");
});

test("client view hides finished jobs and resolved failures", () => {
  const jobs = [
    { id: "active", key: "active", status: "downloading", createdAt: "2026-08-03T00:00:00Z" },
    { id: "cancelled", key: "cancelled", status: "cancelled", createdAt: "2026-08-03T00:01:00Z" },
    { id: "complete", key: "complete", status: "complete", createdAt: "2026-08-03T00:02:00Z" },
    {
      id: "old-error",
      key: "retried-folder",
      status: "failed",
      createdAt: "2026-08-03T00:03:00Z",
      failureRetryKeys: ["folder\u0000video.mp4"]
    },
    {
      id: "fixed-retry",
      key: "retried-folder",
      retryOfJobId: "old-error",
      status: "complete",
      createdAt: "2026-08-03T00:04:00Z",
      counts: { failed: 0 }
    },
    {
      id: "unresolved-error",
      key: "broken-folder",
      status: "complete",
      createdAt: "2026-08-03T00:05:00Z",
      counts: { failed: 1 },
      failureRetryKeys: ["folder\u0000broken.mp4"]
    }
  ];

  assert.deepEqual(
    clientVisibleJobs(jobs).map((job) => job.id),
    ["active", "unresolved-error"]
  );
});

test("误取消任务在恢复完成前保持可见", () => {
  const cancelled = {
    id: "cancelled-recoverable",
    key: "folder-a",
    status: "cancelled",
    createdAt: "2026-08-04T00:00:00Z",
    counts: { files: 3, success: 1, cancelled: 2 },
    cancelledRetryKeys: ["folder\u0000a.psd", "folder\u0000b.gif"]
  };
  assert.deepEqual(clientVisibleJobs([cancelled]).map((job) => job.id), [cancelled.id]);
  assert.deepEqual(clientVisibleJobs([
    cancelled,
    {
      id: "restored",
      key: "folder-a",
      restoreOfJobId: cancelled.id,
      status: "complete",
      createdAt: "2026-08-04T00:01:00Z",
      counts: { files: 2, success: 2, cancelled: 0, failed: 0 }
    }
  ]), []);

  const failedRestore = {
    id: "failed-restore",
    key: "folder-a",
    restoreOfJobId: cancelled.id,
    status: "failed",
    createdAt: "2026-08-04T00:02:00Z",
    counts: { files: 0, success: 0, cancelled: 0, failed: 0 },
    lastMessage: "POPO 页面工作区未能加载"
  };
  assert.deepEqual(
    clientVisibleJobs([cancelled, failedRestore]).map((job) => job.id),
    [cancelled.id, failedRestore.id]
  );
});

test("同一 POPO 文件夹重复点击只匹配一个活动任务", () => {
  const key = makeFolderJobKey({
    parentUrl: "https://docs.popo.netease.com/team/pc/t1/pageDetail/p1#preview",
    folderItemIndex: "42",
    folderName: " 母文件 A "
  });
  const secondKey = makeFolderJobKey({
    parentUrl: "https://docs.popo.netease.com/team/pc/t1/pageDetail/p1",
    folderItemIndex: 42,
    folderName: "母文件 A"
  });
  assert.equal(key, secondKey);
  assert.equal(findDuplicateJob([{ id: "a", key, status: "queued" }], secondKey)?.id, "a");
  assert.equal(findDuplicateJob([{ id: "a", key, status: "complete" }], secondKey), null);
});

test("取消只影响未开始文件并保留已交给 Gopeed 的文件", () => {
  const items = [
    { id: "pending", selected: true, status: "pending" },
    { id: "preparing", selected: true, status: "preparing" },
    { id: "active", selected: true, status: "transferring", gopeedTaskId: "task-1" },
    { id: "success", selected: true, status: "success" }
  ];
  const result = applyCancelPolicy(items, [{ itemId: "active", taskId: "task-1" }], "2026-08-03T00:00:00.000Z");
  assert.deepEqual(result, { cancelledCount: 2, preservedCount: 1 });
  assert.equal(items[0].status, "cancelled");
  assert.equal(items[1].status, "cancelled");
  assert.equal(items[2].status, "transferring");
  assert.equal(items[3].status, "success");
});

test("万级文件统计保持准确且排队位置只计算等待任务", () => {
  const items = Array.from({ length: 10000 }, (_, index) => ({
    id: String(index),
    selected: true,
    status: index < 125 ? "success" : index < 130 ? "failed" : "pending"
  }));
  assert.deepEqual(summarizeItems(items, 86, 2), {
    files: 10000,
    discoveredFiles: 10000,
    folders: 86,
    projects: 10086,
    success: 125,
    failed: 5,
    cancelled: 0,
    active: 0,
    pending: 9870,
    scanFailures: 2
  });
  const jobs = [
    { id: "active", status: "downloading" },
    { id: "b", status: "queued" },
    { id: "done", status: "complete" },
    { id: "c", status: "queued" }
  ];
  assert.equal(queuePosition(jobs, "b"), 1);
  assert.equal(queuePosition(jobs, "c"), 2);
});
