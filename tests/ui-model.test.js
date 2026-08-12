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
  assert.equal(uiModel.jobProgress(running), 40);
  assert.equal(uiModel.folderButtonDisplay(running).secondary, "4 / 10");
  assert.equal(uiModel.jobDetail(queued), "排队第 2");
  assert.equal(uiModel.jobProgress(queued), null);
});

test("网页行内和任务详情只把成功下载计入完成数量", () => {
  const paused = {
    id: "job-paused",
    status: "paused",
    counts: { files: 11, success: 1, failed: 3, cancelled: 4 }
  };

  assert.equal(uiModel.jobDetail(paused), "已暂停 · 已完成 1 / 11");
  assert.equal(uiModel.folderButtonDisplay(paused).secondary, "1 / 11");
  assert.equal(uiModel.jobProgress(paused), 9);

  const finishedWithFailure = {
    id: "job-finished-with-failure",
    status: "complete",
    counts: { files: 3, success: 2, failed: 1, cancelled: 0 }
  };
  assert.equal(uiModel.jobDetail(finishedWithFailure), "已完成 2 个文件");
  assert.equal(uiModel.folderButtonDisplay(finishedWithFailure).progress, 67);
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

  assert.equal(
    uiModel.folderButtonDisplay({
      id: "unverified",
      status: "complete",
      counts: {
        files: 12,
        discoveredFiles: 12,
        success: 12,
        unverifiedDirectories: 1
      }
    }).secondary,
    "1 处未核对"
  );

  assert.deepEqual(
    uiModel.folderButtonDisplay({
      id: "pipeline",
      status: "scanning",
      counts: { discoveredFiles: 383, handedOff: 27 }
    }),
    {
      visualState: "scanning",
      primary: "边找边下",
      secondary: "找到 383 · 已交付 27",
      progress: null,
      indeterminate: true,
      warningSegment: false
    }
  );
  assert.equal(
    uiModel.jobDetail({
      id: "pipeline",
      status: "scanning",
      counts: { discoveredFiles: 383, handedOff: 27 }
    }),
    "边查找边下载 · 已找到 383 个 · 已交付 27 个"
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

test("一键下载批次在页面顶部和文件夹行共享暂停状态", () => {
  const parentUrl = "https://docs.popo.netease.com/team/pc/team/pageDetail/folder";
  const state = {
    jobs: [{
      id: "job-batch-a",
      batchId: "batch-a",
      batchParentUrl: parentUrl,
      batchPaused: true,
      status: "queued",
      queuePosition: 0,
      createdAt: "2026-08-11T10:00:00.000Z"
    }, {
      id: "job-batch-b",
      batchId: "batch-a",
      batchParentUrl: parentUrl,
      batchPaused: true,
      status: "queued",
      queuePosition: 0,
      createdAt: "2026-08-11T10:00:01.000Z"
    }, {
      id: "job-independent",
      status: "waiting_worker",
      parentUrl
    }]
  };

  const batch = uiModel.findPageDownloadBatch(state, parentUrl + "#preview");
  assert.equal(batch.id, "batch-a");
  assert.equal(batch.paused, true);
  assert.equal(batch.activeCount, 2);
  assert.equal(batch.queuedCount, 2);
  assert.deepEqual(uiModel.folderButtonDisplay(state.jobs[0]), {
    visualState: "paused",
    primary: "批次已暂停",
    secondary: "",
    progress: null,
    indeterminate: false,
    warningSegment: false
  });
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

test("网络提醒区分高发时段和实际持续低速并支持去重", () => {
  let tracker = { peakNoticeSequence: 0, noticeSequence: 0 };
  const health = {
    version: 1,
    jobId: "job-network",
    status: "normal",
    activeTasks: 5,
    medianSpeed: 18.7 * 1024 * 1024,
    baselineSpeed: 20 * 1024 * 1024,
    observedAt: "2026-08-11T08:31:00.000Z",
    sessionStartedAt: "2026-08-11T08:30:00.000Z",
    lowSince: "",
    severeSince: "",
    recoverySince: "",
    statusChangedAt: "2026-08-11T08:30:00.000Z",
    highProbabilityWindow: true,
    peakNoticeSequence: 1,
    peakNotifiedDate: "2026-08-11",
    noticeSequence: 0,
    lastNoticeAt: "",
    snoozedUntil: "",
    snoozeReminderPending: false,
    mutedDate: "",
    suppressed: false
  };
  let result = uiModel.nextNetworkNotice(tracker, health);
  tracker = result.tracker;
  assert.equal(result.notification.kind, "warning");
  assert.match(result.notification.message, /16:30–18:30/);

  result = uiModel.nextNetworkNotice(tracker, health);
  assert.equal(result.notification, null);

  result = uiModel.nextNetworkNotice(tracker, {
    ...health,
    status: "slow",
    medianSpeed: 2.5 * 1024 * 1024,
    noticeSequence: 1
  });
  assert.equal(result.notification.source, "network");
  assert.match(result.notification.message, /本地网络拥堵/);
  assert.equal(uiModel.networkReminderVisible({
    ...health,
    status: "slow",
    noticeSequence: 1
  }), true);
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

test("数量闭环凭证可让单项和一键任务持续显示绿色无遗漏反馈", () => {
  const parentUrl = "https://docs.popo.netease.com/team/pc/team/pageDetail/folder";
  const key = uiModel.makeFolderJobKey({
    parentUrl,
    folderItemIndex: "8",
    folderName: "完整素材"
  });
  const receipt = {
    key,
    parentUrl,
    folderItemIndex: "8",
    folderName: "完整素材",
    completedAt: "2026-08-11T10:00:00.000Z",
    counts: { files: 12, discoveredFiles: 12, success: 12 }
  };

  assert.equal(uiModel.findMatchingFolderReceipt({ folderReceipts: [receipt] }, {
    parentUrl,
    itemIndex: "8",
    name: "完整素材"
  }), receipt);
  assert.deepEqual(uiModel.folderButtonDisplay({
    id: `receipt:${key}`,
    status: "complete",
    counts: receipt.counts,
    verifiedCompletion: true
  }), {
    visualState: "success",
    primary: "已下载 12 个",
    secondary: "无遗漏",
    progress: 100,
    indeterminate: false,
    warningSegment: false
  });
});
