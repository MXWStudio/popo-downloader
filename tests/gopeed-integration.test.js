"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  classifyTaskStatus,
  continueTask,
  createTask,
  deleteTask,
  getConfig,
  getTask,
  patchTask,
  pauseTask
} = require("../gopeed.js");

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : null);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function reply(response, data, code = 0, msg = "") {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ code, msg, data }));
}

test("五文件通过 Gopeed REST 建立任务并按任务 ID 管理", async (t) => {
  const tasks = new Map();
  let sequence = 0;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/v1/config") {
      reply(response, { downloadDir: "D:\\Downloads", maxRunning: 5 });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/tasks") {
      const body = await readJson(request);
      const id = `task-${++sequence}`;
      tasks.set(id, {
        id,
        status: "running",
        meta: body,
        progress: { downloaded: 0, speed: 0 }
      });
      reply(response, id);
      return;
    }
    const match = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)(?:\/(pause|continue))?$/);
    if (!match) {
      reply(response, null, 1002, "unknown route");
      return;
    }
    const [, id, action] = match;
    const task = tasks.get(id);
    if (!task) {
      reply(response, null, 2001, "task not found");
      return;
    }
    if (request.method === "GET") {
      reply(response, task);
    } else if (request.method === "PATCH") {
      task.meta = await readJson(request);
      reply(response, null);
    } else if (request.method === "PUT" && action === "pause") {
      task.status = "pause";
      reply(response, null);
    } else if (request.method === "PUT" && action === "continue") {
      task.status = "running";
      reply(response, null);
    } else if (request.method === "DELETE") {
      tasks.delete(id);
      reply(response, null);
    } else {
      reply(response, null, 1002, "invalid method");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const settings = {
    gopeedEndpoint: `http://127.0.0.1:${address.port}`,
    gopeedToken: ""
  };
  const config = await getConfig(settings);
  assert.equal(config.downloadDir, "D:\\Downloads");

  const ids = [];
  for (let index = 0; index < 5; index += 1) {
    ids.push(await createTask(settings, {
      url: `https://example.com/video-${index}.mp4`,
      name: `video-${index}.mp4`,
      path: `D:\\Downloads\\POPO稳定下载\\测试包`,
      connections: 1
    }));
  }
  assert.deepEqual(ids, ["task-1", "task-2", "task-3", "task-4", "task-5"]);
  assert.equal(tasks.size, 5);
  assert.ok([...tasks.values()].every((task) => task.meta.opts.extra.connections === 1));

  await pauseTask(settings, ids[0]);
  assert.equal(classifyTaskStatus((await getTask(settings, ids[0])).status), "paused");
  await patchTask(settings, ids[0], {
    url: "https://example.com/video-0-refreshed.mp4",
    name: "video-0.mp4",
    path: "D:\\Downloads\\POPO稳定下载\\测试包",
    connections: 1
  });
  await continueTask(settings, ids[0]);
  assert.equal(classifyTaskStatus((await getTask(settings, ids[0])).status), "active");
  assert.equal(tasks.get(ids[0]).meta.req.url, "https://example.com/video-0-refreshed.mp4");

  tasks.get(ids[1]).status = "done";
  tasks.get(ids[2]).status = "error";
  assert.equal(classifyTaskStatus((await getTask(settings, ids[1])).status), "success");
  assert.equal(classifyTaskStatus((await getTask(settings, ids[2])).status), "failed");

  await deleteTask(settings, ids[4]);
  assert.equal(tasks.has(ids[4]), false);
});
