"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCreateTaskBody,
  buildTaskIdentityLabels,
  classifyTaskStatus,
  createTask,
  listTasks,
  normalizeDownloadDirectory,
  normalizeEndpoint,
  normalizeTargetKey,
  request,
  reusableTaskTargetKeys,
  selectTaskByIdentity,
  startOrReplaceTask,
  splitDownloadTarget
} = require("../gopeed.js");

test("Gopeed 只接受本机 HTTP API 地址", () => {
  assert.equal(normalizeEndpoint("http://127.0.0.1:9999/"), "http://127.0.0.1:9999");
  assert.equal(normalizeEndpoint("http://localhost:9999"), "http://localhost:9999");
  assert.throws(() => normalizeEndpoint("https://127.0.0.1:9999"), /本机 HTTP/);
  assert.throws(() => normalizeEndpoint("http://192.168.1.20:9999"), /必须绑定到本机/);
});

test("自定义保存目录只接受本机 Windows 绝对路径", () => {
  assert.equal(normalizeDownloadDirectory("D:/POPO素材/项目A/"), "D:\\POPO素材\\项目A");
  assert.equal(normalizeDownloadDirectory("E:\\"), "E:\\");
  assert.equal(normalizeDownloadDirectory("\\\\fileserver\\素材库\\POPO"), "\\\\fileserver\\素材库\\POPO");
  assert.equal(normalizeDownloadDirectory(""), "");
  assert.throws(() => normalizeDownloadDirectory("POPO素材"), /Windows 绝对路径/);
  assert.throws(() => normalizeDownloadDirectory("D:\\POPO素材\\..\\其他"), /不能包含/);
  assert.throws(() => normalizeDownloadDirectory("D:\\POPO?素材"), /不允许的字符/);
});

test("创建任务时固定文件名、目录和单连接", () => {
  assert.deepEqual(buildCreateTaskBody({
    url: "https://example.com/video.mp4",
    name: "视频.mp4",
    path: "D:\\Downloads\\POPO稳定下载\\素材包",
    connections: 1
  }), {
    req: {
      url: "https://example.com/video.mp4",
      labels: { source: "popo-stable-downloader" }
    },
    opts: {
      name: "视频.mp4",
      path: "D:\\Downloads\\POPO稳定下载\\素材包",
      extra: { connections: 1 }
    }
  });
});

test("Gopeed 任务携带可对账且不暴露文件信息的稳定标签", () => {
  const taskIdentity = "https://docs.popo.netease.com/team/pc/team1/pageDetail/folder1\u00007\u0000视频.mp4";
  const labels = buildTaskIdentityLabels({
    jobId: "job-20260805",
    taskIdentity
  });
  const repeated = buildTaskIdentityLabels({
    jobId: "job-20260805",
    taskIdentity
  });
  const different = buildTaskIdentityLabels({
    jobId: "job-20260805",
    taskIdentity: `${taskIdentity}-different`
  });

  assert.deepEqual(labels, repeated);
  assert.equal(labels.popoSchema, "1");
  assert.equal(labels.popoJobId, "job-20260805");
  assert.match(labels.popoTaskKey, /^[a-f0-9]{16}$/);
  assert.notEqual(labels.popoTaskKey, different.popoTaskKey);
  assert.doesNotMatch(JSON.stringify(labels), /pageDetail|视频\.mp4/);

  const body = buildCreateTaskBody({
    url: "https://example.com/video.mp4",
    name: "视频.mp4",
    path: "D:\\Downloads",
    labels: {
      ...labels,
      source: "untrusted-source",
      unrelated: "discard-me"
    }
  });
  assert.deepEqual(body.req.labels, {
    source: "popo-stable-downloader",
    popoSchema: "1",
    popoJobId: "job-20260805",
    popoTaskKey: labels.popoTaskKey
  });
});

test("任务对账按作业与任务键唯一匹配并优先采用已完成结果", () => {
  const labels = buildTaskIdentityLabels({
    jobId: "job-reconcile",
    taskIdentity: "folder\u00001\u0000video.mp4"
  });
  const makeTask = (id, status, overrides = {}) => ({
    id,
    status,
    meta: {
      req: {
        labels: {
          source: "popo-stable-downloader",
          ...labels,
          ...overrides
        }
      }
    }
  });

  const live = makeTask("task-live", "running");
  assert.deepEqual(selectTaskByIdentity([
    makeTask("foreign-job", "running", { popoJobId: "job-other" }),
    live
  ], labels), {
    task: live,
    matchCount: 1,
    resolution: "live"
  });

  const ambiguous = selectTaskByIdentity([
    makeTask("task-live-a", "running"),
    makeTask("task-live-b", "wait")
  ], labels);
  assert.equal(ambiguous.task, null);
  assert.equal(ambiguous.matchCount, 2);
  assert.equal(ambiguous.resolution, "ambiguous");

  const done = makeTask("task-done", "done");
  const completed = selectTaskByIdentity([
    makeTask("task-live-c", "running"),
    done
  ], labels);
  assert.equal(completed.task, done);
  assert.equal(completed.matchCount, 2);
  assert.equal(completed.resolution, "success");
});

test("保存位置使用选择的根目录并保留 POPO 文件夹结构", () => {
  assert.deepEqual(
    splitDownloadTarget(
      "D:\\Downloads",
      "POPO稳定下载/素材包/子目录/视频.mp4"
    ),
    {
      name: "视频.mp4",
      path: "D:\\Downloads\\POPO稳定下载\\素材包\\子目录"
    }
  );
});

test("Gopeed 状态映射区分完成、失败、暂停和进行中", () => {
  assert.equal(classifyTaskStatus("done"), "success");
  assert.equal(classifyTaskStatus("error"), "failed");
  assert.equal(classifyTaskStatus("pause"), "paused");
  assert.equal(classifyTaskStatus("ready"), "active");
  assert.equal(classifyTaskStatus("running"), "active");
  assert.equal(classifyTaskStatus("wait"), "active");
});

test("旧任务恢复只把 POPO 已完成或进行中的保存路径作为去重依据", () => {
  const makeTask = (status, path, name, source = "popo-stable-downloader") => ({
    status,
    name,
    meta: {
      req: { labels: { source } },
      opts: { path, name }
    }
  });
  const tasks = [
    makeTask("done", "C:\\Users\\EDY\\Downloads\\POPO稳定下载\\母文件 A", "DONE.PSD"),
    makeTask("running", "C:\\Users\\EDY\\Downloads\\POPO稳定下载\\母文件 A\\gif", "a.gif"),
    makeTask("error", "C:\\Users\\EDY\\Downloads\\POPO稳定下载\\母文件 A", "retry.bin"),
    makeTask("done", "C:\\Users\\EDY\\Downloads\\其他工具", "outside.psd"),
    makeTask("done", "C:\\Users\\EDY\\Downloads\\POPO稳定下载\\母文件 A", "foreign.psd", "other")
  ];
  assert.deepEqual(reusableTaskTargetKeys(tasks, "POPO稳定下载"), [
    "popo稳定下载/母文件 a/done.psd",
    "popo稳定下载/母文件 a/gif/a.gif"
  ]);
  assert.equal(normalizeTargetKey("POPO稳定下载\\母文件 A\\DONE.PSD"),
    "popo稳定下载/母文件 a/done.psd");
});

test("读取 Gopeed 全部任务调用 tasks 列表接口", async () => {
  let captured;
  const tasks = await listTasks({
    gopeedEndpoint: "http://127.0.0.1:9999",
    gopeedToken: ""
  }, {
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        status: 200,
        async json() { return { code: 0, data: [{ id: "task-1", status: "done" }] }; }
      };
    }
  });
  assert.equal(captured.url, "http://127.0.0.1:9999/api/v1/tasks");
  assert.equal(captured.options.method, "GET");
  assert.deepEqual(tasks, [{ id: "task-1", status: "done" }]);
});

test("REST 请求携带 Token 并解析 Gopeed 响应信封", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      status: 200,
      async json() {
        return { code: 0, data: { downloadDir: "D:\\Downloads" } };
      }
    };
  };
  const data = await request({
    gopeedEndpoint: "http://127.0.0.1:9999",
    gopeedToken: "secret"
  }, "/api/v1/config", { fetchImpl });
  assert.equal(captured.url, "http://127.0.0.1:9999/api/v1/config");
  assert.equal(captured.options.headers["X-Api-Token"], "secret");
  assert.deepEqual(data, { downloadDir: "D:\\Downloads" });
});

test("创建下载调用 Gopeed tasks 接口并返回任务 ID", async () => {
  let captured;
  const taskId = await createTask({
    gopeedEndpoint: "http://127.0.0.1:9999",
    gopeedToken: ""
  }, {
    url: "https://example.com/video.mp4",
    name: "video.mp4",
    path: "D:\\Downloads",
    connections: 1
  }, {
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        status: 200,
        async json() {
          return { code: 0, data: "task-123" };
        }
      };
    }
  });
  assert.equal(taskId, "task-123");
  assert.equal(captured.url, "http://127.0.0.1:9999/api/v1/tasks");
  assert.equal(captured.options.method, "POST");
  assert.equal(JSON.parse(captured.options.body).opts.extra.connections, 1);
});

test("刷新地址时 Gopeed 原任务不存在会自动新建任务", async () => {
  const calls = [];
  const result = await startOrReplaceTask({
    gopeedEndpoint: "http://127.0.0.1:9999",
    gopeedToken: ""
  }, "missing-task", {
    url: "https://example.com/refreshed.mp4",
    name: "video.mp4",
    path: "D:\\Downloads",
    connections: 1
  }, {
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      if (options.method === "PATCH") {
        return {
          ok: true,
          status: 200,
          async json() { return { code: 2001, msg: "task not found", data: null }; }
        };
      }
      return {
        ok: true,
        status: 200,
        async json() { return { code: 0, data: "replacement-task" }; }
      };
    }
  });
  assert.deepEqual(result, { taskId: "replacement-task", replacedMissingTask: true });
  assert.deepEqual(calls.map((entry) => entry.method), ["PATCH", "POST"]);
});
