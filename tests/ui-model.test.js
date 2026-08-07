"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { uiModel } = require("../runtime/popo-runtime.cjs");

test("共享 React 界面模型统一任务摘要、详情和进度", () => {
  const running = {
    id: "job-running",
    status: "downloading",
    folderName: "素材",
    counts: { files: 10, success: 4, failed: 1, cancelled: 0 }
  };
  const queued = {
    id: "job-queued",
    status: "queued",
    folderName: "视频",
    queuePosition: 2
  };

  assert.equal(uiModel.summarizeLiveJobs([running, queued]), "1 个进行中 · 1 个排队");
  assert.equal(uiModel.jobDetail(running), "已完成 4 / 10");
  assert.equal(uiModel.jobProgress(running), 50);
  assert.equal(uiModel.jobDetail(queued), "排队第 2");
  assert.equal(uiModel.jobProgress(queued), null);
});

test("网页行按钮用真实数量区分查找、空结果、遗漏和失败", () => {
  assert.deepEqual(
    uiModel.folderButtonDisplay({
      id: "scan",
      status: "scanning",
      counts: { discoveredFiles: 383 }
    }),
    {
      visualState: "scanning",
      primary: "查找中",
      secondary: "已找到 383 个",
      progress: null,
      indeterminate: true,
      warningSegment: false
    }
  );

  assert.deepEqual(
    uiModel.folderButtonDisplay({
      id: "partial",
      status: "complete",
      counts: {
        files: 380,
        discoveredFiles: 380,
        success: 380,
        failed: 0,
        scanFailures: 3
      }
    }),
    {
      visualState: "warning",
      primary: "找到 380 个",
      secondary: "遗漏 3 处",
      progress: 100,
      indeterminate: false,
      warningSegment: true
    }
  );

  assert.equal(uiModel.folderButtonDisplay({
    id: "empty",
    status: "complete",
    counts: { files: 0, discoveredFiles: 0 }
  }).primary, "未找到文件");

  assert.deepEqual(
    uiModel.folderButtonDisplay({
      id: "failed",
      status: "failed",
      counts: { files: 3, success: 2, failed: 1 }
    }),
    {
      visualState: "failed",
      primary: "未完成 1 个",
      secondary: "重试",
      progress: 67,
      indeterminate: false,
      warningSegment: false
    }
  );
});

test("页面通知只在任务转为完成或失败时产生且初始历史保持静默", () => {
  const complete = {
    id: "job-complete",
    status: "complete",
    folderName: "通用物料",
    completedAt: "2026-08-06T08:00:00.000Z",
    counts: { files: 17, success: 17, failed: 0, cancelled: 0 }
  };
  const failed = {
    id: "job-failed",
    status: "failed",
    folderName: "视频",
    completedAt: "2026-08-06T08:01:00.000Z",
    counts: { files: 3, success: 2, failed: 1, cancelled: 0 }
  };

  assert.equal(uiModel.notificationForTransition(null, complete), null);
  assert.equal(uiModel.notificationForTransition("downloading", {
    ...complete,
    status: "downloading"
  }), null);
  assert.deepEqual(
    uiModel.notificationForTransition("downloading", complete),
    {
      id: "job-complete:complete:2026-08-06T08:00:00.000Z",
      jobId: "job-complete",
      kind: "success",
      title: "通用物料",
      message: "已完成 17 个文件",
      timeoutMs: 3000
    }
  );
  assert.equal(
    uiModel.notificationForTransition("downloading", failed).timeoutMs,
    null
  );
});

test("下载服务每次断开只提醒一次且恢复后允许再次提醒", () => {
  let tracker = { connected: null, outageSequence: 0, outageNotified: false };

  let result = uiModel.nextServiceNotice(tracker, true);
  tracker = result.tracker;
  assert.equal(result.notification, null);

  result = uiModel.nextServiceNotice(tracker, false);
  tracker = result.tracker;
  assert.equal(result.notification.id, "download-service-disconnected:1");
  assert.equal(result.notification.timeoutMs, null);

  result = uiModel.nextServiceNotice(tracker, false);
  tracker = result.tracker;
  assert.equal(result.notification, null);

  result = uiModel.nextServiceNotice(tracker, true);
  tracker = result.tracker;
  result = uiModel.nextServiceNotice(tracker, false);
  assert.equal(result.notification.id, "download-service-disconnected:2");
});

test("弹窗打开期间确认到的服务断开不会延后重复弹出", () => {
  let tracker = { connected: true, outageSequence: 0, outageNotified: false };
  let result = uiModel.nextServiceNotice(tracker, false, true);
  tracker = result.tracker;
  assert.equal(result.notification, null);
  result = uiModel.nextServiceNotice(tracker, false, false);
  assert.equal(result.notification, null);
});

test("虚拟列表项目数与行按钮使用相同稳定页面标识", () => {
  assert.equal(uiModel.inferVirtualListItemCount({
    indices: ["0", "1", "2"],
    knownSizes: ["48", "48", "48"],
    paddingBottom: "672px"
  }), 17);

  const parentUrl = "https://docs.popo.netease.com/team/pc/team/pageDetail/folder";
  const key = uiModel.makeFolderJobKey({
    parentUrl,
    folderItemIndex: "3",
    folderName: "通用物料"
  });
  const state = {
    jobs: [{
      id: "job-folder",
      key,
      status: "queued",
      folderName: "通用物料",
      folderItemIndex: "3",
      parentUrl
    }]
  };
  assert.equal(
    uiModel.findMatchingFolderJob(state, {
      parentUrl,
      itemIndex: "3",
      name: "通用物料"
    }).id,
    "job-folder"
  );
});
