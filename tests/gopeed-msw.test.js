"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const runtime = require("../runtime/popo-runtime.cjs");
const endpoint = "http://127.0.0.1:9999";
let http;
let HttpResponse;
let server;

test.before(async () => {
  ({ http, HttpResponse } = await import("msw"));
  const { setupServer } = await import("msw/node");
  server = setupServer();
  server.listen({ onUnhandledRequest: "error" });
});

test.afterEach(() => server.resetHandlers());
test.after(() => server.close());

test("MSW simulates Gopeed network loss and retry recovery", async () => {
  server.use(http.get(`${endpoint}/api/v1/tasks`, () => HttpResponse.error()));

  await assert.rejects(
    runtime.gopeed.listTasks({ gopeedEndpoint: endpoint }, { timeoutMs: 1000 }),
    /Failed to fetch|Gopeed|network|fetch/i
  );

  server.use(http.get(`${endpoint}/api/v1/tasks`, () => HttpResponse.json({
    code: 0,
    msg: "",
    data: [{ id: "task-restored", status: "running" }]
  })));

  const tasks = await runtime.gopeed.listTasks({ gopeedEndpoint: endpoint });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, "task-restored");
});

test("MSW malformed Gopeed data is rejected by Zod", async () => {
  server.use(http.get(`${endpoint}/api/v1/tasks`, () => HttpResponse.json({
    code: 0,
    msg: "",
    data: [{ id: "task-invalid", status: "future-status" }]
  })));

  await assert.rejects(
    runtime.gopeed.listTasks({ gopeedEndpoint: endpoint }),
    /SDK|Invalid option|contract/i
  );
});
