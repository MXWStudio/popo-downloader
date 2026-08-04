"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCreateTaskBody,
  classifyTaskStatus,
  createTask,
  normalizeDownloadDirectory,
  normalizeEndpoint,
  request,
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
