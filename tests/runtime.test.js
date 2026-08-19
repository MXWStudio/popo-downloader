"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const runtime = require("../runtime/popo-runtime.cjs");

function response(data, status = 200) {
  return {
    status,
    async json() { return { code: 0, msg: "", data }; },
    async text() { return JSON.stringify({ code: 0, msg: "", data }); }
  };
}

test("TypeScript + Zod 运行时契约拒绝未知命令和非法任务状态", () => {
  assert.throws(
    () => runtime.contracts.parseRuntimeCommand({ type: "MUTATE_EVERYTHING" }),
    /Invalid input/
  );
  assert.throws(
    () => runtime.contracts.parseGopeedTask({ id: "task-1", status: "future-status" }),
    /Invalid option/
  );
  assert.equal(
    runtime.contracts.parseGopeedTask({ id: "task-1", status: "running" }).id,
    "task-1"
  );
  assert.deepEqual(
    runtime.contracts.parseRuntimeCommand({ type: "DISMISS_JOB", jobId: "job-a" }),
    { type: "DISMISS_JOB", jobId: "job-a" }
  );
  assert.deepEqual(
    runtime.contracts.parseRuntimeCommand({ type: "GET_UPDATE_STATUS" }),
    { type: "GET_UPDATE_STATUS" }
  );
  assert.deepEqual(
    runtime.contracts.parseRuntimeCommand({ type: "GET_UPDATE_DIAGNOSTICS" }),
    { type: "GET_UPDATE_DIAGNOSTICS" }
  );
  assert.deepEqual(
    runtime.contracts.parseRuntimeCommand({ type: "GET_DIAGNOSTIC_STATUS" }),
    { type: "GET_DIAGNOSTIC_STATUS" }
  );
  assert.deepEqual(
    runtime.contracts.parseRuntimeCommand({ type: "SEND_DIAGNOSTICS" }),
    { type: "SEND_DIAGNOSTICS" }
  );
  assert.deepEqual(
    runtime.contracts.parseRuntimeCommand({
      type: "REMOVE_DOWNLOAD_BATCH",
      batchId: "batch-a"
    }),
    { type: "REMOVE_DOWNLOAD_BATCH", batchId: "batch-a" }
  );
  assert.throws(
    () => runtime.contracts.parseRuntimeCommand({
      type: "PAUSE_DOWNLOAD_BATCH",
      batchId: "",
      ignored: true
    }),
    /Invalid/
  );
  assert.deepEqual(
    runtime.contracts.parseRuntimeCommand({
      type: "START_PAGE_DOWNLOAD",
      pageName: "整页素材",
      parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1"
    }),
    {
      type: "START_PAGE_DOWNLOAD",
      pageName: "整页素材",
      parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1"
    }
  );
});

test("诊断事件只保留脱敏状态、数量和匿名标识", () => {
  const event = runtime.diagnostics.buildDiagnosticEvent({
    candidate: {
      code: "DOWNLOAD_STALLED",
      level: "warn",
      at: "2026-08-19T00:00:00.000Z",
      context: {
        jobId: "job-secret-123",
        taskId: "task-secret-456",
        failureStage: "访问 https://secret.example/file?token=abc",
        path: "C:\\Users\\Alice\\Private\\movie.mp4",
        token: "token=super-secret"
      }
    },
    installId: "install-user-machine",
    release: "0.7.2",
    state: {
      mode: "downloading",
      phase: "downloading",
      counts: { total: 12, success: 2, failed: 0 }
    }
  });
  const exported = JSON.stringify(event);
  assert.equal(event.message, "DOWNLOAD_STALLED");
  assert.equal(event.tags.install.startsWith("h:"), true);
  assert.equal(event.extra.counts.total, 12);
  assert.doesNotMatch(exported, /secret\.example|super-secret|Alice|movie\.mp4/);
  assert.match(exported, /\[url\]|\[path\]/);
});

test("Sentry DSN 只接受官方 HTTPS 接收域名并生成 envelope 地址", () => {
  const target = runtime.diagnostics.parseSentryDsn(
    "https://12345678abcdef@o123.ingest.sentry.io/456"
  );
  assert.equal(target.projectId, "456");
  assert.match(target.envelopeUrl, /\/api\/456\/envelope\//);
  assert.equal(runtime.diagnostics.parseSentryDsn("http://o123.ingest.sentry.io/456"), null);
  assert.equal(runtime.diagnostics.parseSentryDsn("https://key@example.com/456"), null);
});

test("传输连续 90 秒无新增字节只报告一次，恢复进度后可重新计时", () => {
  const first = runtime.diagnostics.inspectTransferProgress({
    previousDownloaded: 1024,
    downloaded: 1024,
    lastProgressAt: 10_000,
    status: "active",
    now: 100_000,
    thresholdMs: 90_000
  });
  assert.equal(first.stalled, true);
  const duplicate = runtime.diagnostics.inspectTransferProgress({
    previousDownloaded: first.downloaded,
    downloaded: first.downloaded,
    lastProgressAt: first.lastProgressAt,
    stallReportedAt: first.stallReportedAt,
    status: "active",
    now: 110_000,
    thresholdMs: 90_000
  });
  assert.equal(duplicate.stalled, false);
  const resumed = runtime.diagnostics.inspectTransferProgress({
    previousDownloaded: duplicate.downloaded,
    downloaded: 2048,
    lastProgressAt: duplicate.lastProgressAt,
    stallReportedAt: duplicate.stallReportedAt,
    status: "active",
    now: 120_000,
    thresholdMs: 90_000
  });
  assert.equal(resumed.progressed, true);
  assert.equal(resumed.lastProgressAt, 120_000);
  assert.equal(resumed.stallReportedAt, 0);
});

test("XState 作业状态机只允许声明过的迁移", () => {
  assert.equal(runtime.workflow.canTransition("queued", "scanning"), true);
  assert.equal(runtime.workflow.canTransition("downloading", "paused"), true);
  assert.equal(runtime.workflow.canTransition("scanning", "paused"), true);
  assert.equal(runtime.workflow.canTransition("paused", "scanning"), true);
  assert.equal(runtime.workflow.canTransition("complete", "downloading"), false);
  assert.equal(runtime.workflow.canTransition("queued", "made_up"), false);
});

test("XState 持久化工作流可独立恢复扫描、交付和传输区域", () => {
  let snapshot = runtime.workflow.createPersistentWorkflow("2026-08-10T00:00:00.000Z");
  snapshot = runtime.workflow.transitionPersistentWorkflow(snapshot, "SCAN_START", {
    nextAction: "handoff",
    counts: { discovered: 12, selected: 11, skipped: 1 }
  });
  snapshot = runtime.workflow.transitionPersistentWorkflow(snapshot, "HANDOFF_RESERVE", {
    reservedItemId: "parent\u0000file.mp4"
  });
  snapshot = runtime.workflow.transitionPersistentWorkflow(snapshot, "HANDOFF_PREPARE");
  snapshot = runtime.workflow.transitionPersistentWorkflow(snapshot, "TRANSFER_START");

  const restored = runtime.workflow.normalizePersistentWorkflow(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(restored.value, {
    scan: "running",
    handoff: "preparing",
    transfer: "active"
  });
  assert.equal(restored.reservedItemId, "parent\u0000file.mp4");
  assert.equal(restored.counts.discovered, 12);
  assert.equal(restored.sequence, 4);

  const completed = runtime.workflow.transitionPersistentWorkflow(restored, "SCAN_COMPLETE");
  assert.equal(completed.value.scan, "complete");
  assert.equal(completed.value.transfer, "active");
  assert.equal(runtime.workflow.choosePersistentWorkflowAction({
    workflow: restored,
    hasPending: true,
    hasPreparing: false,
    activeTransfers: 2,
    concurrency: 5
  }), "handoff");
  assert.equal(runtime.workflow.choosePersistentWorkflowAction({
    workflow: restored,
    hasPending: true,
    hasPreparing: false,
    activeTransfers: 5,
    concurrency: 5
  }), "scan");
});

test("Gopeed 官方 SDK 创建任务并由 Zod 校验返回数据", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/api/v1/tasks") && options.method === "POST") {
      return response("sdk-task-1");
    }
    if (String(url).endsWith("/api/v1/tasks")) {
      return response([{ id: "sdk-task-1", status: "not-a-gopeed-status" }]);
    }
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    const settings = { gopeedEndpoint: "http://127.0.0.1:9999", gopeedToken: "secret" };
    const taskId = await runtime.gopeed.createTask(settings, {
      req: { url: "https://example.com/a.zip" },
      opts: { name: "a.zip", path: "D:\\Downloads" }
    });
    assert.equal(taskId, "sdk-task-1");
    assert.equal(calls[0].options.headers["X-Api-Token"], "secret");
    await assert.rejects(
      runtime.gopeed.listTasks(settings),
      /Gopeed SDK 返回数据不符合约定/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("生产 Gopeed 适配层优先使用官方 SDK", async () => {
  const originalFetch = global.fetch;
  const originalRuntime = global.PopoRuntime;
  const gopeedPath = require.resolve("../gopeed.js");
  delete require.cache[gopeedPath];
  global.PopoRuntime = runtime;
  let calledUrl = "";
  global.fetch = async (url) => {
    calledUrl = String(url);
    return response("sdk-task-2");
  };

  try {
    const gopeed = require(gopeedPath);
    const taskId = await gopeed.createTask(
      { gopeedEndpoint: "http://127.0.0.1:9999", gopeedToken: "" },
      { url: "https://example.com/b.zip", name: "b.zip", path: "D:\\Downloads" }
    );
    assert.equal(taskId, "sdk-task-2");
    assert.equal(calledUrl, "http://127.0.0.1:9999/api/v1/tasks");
  } finally {
    global.fetch = originalFetch;
    global.PopoRuntime = originalRuntime;
    delete require.cache[gopeedPath];
  }
});
