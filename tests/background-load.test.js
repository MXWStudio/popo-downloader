"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function eventStub() {
  return {
    listeners: [],
    addListener(listener) { this.listeners.push(listener); },
    removeListener(listener) {
      this.listeners = this.listeners.filter((candidate) => candidate !== listener);
    }
  };
}

test("后台状态机可在 Manifest V3 服务工作线程中完成初始化", () => {
  const backgroundPath = require.resolve(path.join(__dirname, "..", "background.js"));
  delete require.cache[backgroundPath];
  global.importScripts = (...files) => {
    if (files.includes("core.js")) global.PopoCore = require("../core.js");
    if (files.includes("gopeed.js")) global.PopoGopeed = require("../gopeed.js");
    if (files.includes("queue.js")) global.PopoQueue = require("../queue.js");
  };
  global.chrome = {
    alarms: {
      create() {},
      onAlarm: eventStub()
    },
    runtime: {
      onInstalled: eventStub(),
      onMessage: eventStub(),
      onStartup: eventStub()
    },
    storage: { local: {} },
    tabs: {
      onRemoved: eventStub(),
      onUpdated: eventStub()
    }
  };

  assert.doesNotThrow(() => require(backgroundPath));
  assert.equal(global.chrome.runtime.onMessage.listeners.length, 1);
  assert.equal(global.chrome.tabs.onRemoved.listeners.length, 1);

  delete global.chrome;
  delete global.importScripts;
  delete global.PopoCore;
  delete global.PopoGopeed;
  delete global.PopoQueue;
  delete require.cache[backgroundPath];
});

test("固定端口不可用时自动启动内置 Gopeed 并保存发现的端口", async () => {
  const backgroundPath = require.resolve(path.join(__dirname, "..", "background.js"));
  delete require.cache[backgroundPath];
  const stored = {};
  const requestedEndpoints = [];
  let nativeRequest = null;
  const actualGopeed = require("../gopeed.js");

  global.importScripts = (...files) => {
    if (files.includes("core.js")) global.PopoCore = require("../core.js");
    if (files.includes("gopeed.js")) {
      global.PopoGopeed = {
        ...actualGopeed,
        async getConfig(settings) {
          requestedEndpoints.push(settings.gopeedEndpoint);
          if (settings.gopeedEndpoint === "http://127.0.0.1:32123") {
            return { downloadDir: "D:\\Downloads", maxRunning: 5 };
          }
          throw new Error("connection refused");
        }
      };
    }
    if (files.includes("queue.js")) global.PopoQueue = require("../queue.js");
  };
  global.chrome = {
    alarms: { create() {}, onAlarm: eventStub() },
    runtime: {
      onInstalled: eventStub(),
      onMessage: eventStub(),
      onStartup: eventStub(),
      async sendNativeMessage(_host, request) {
        nativeRequest = request;
        return {
          ok: true,
          endpoint: "http://127.0.0.1:32123",
          bundled: true,
          started: true
        };
      }
    },
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]]));
        },
        async set(values) { Object.assign(stored, values); }
      }
    },
    tabs: { onRemoved: eventStub(), onUpdated: eventStub() }
  };

  require(backgroundPath);
  const listener = global.chrome.runtime.onMessage.listeners[0];
  const response = await new Promise((resolve) => {
    assert.equal(listener({ type: "CHECK_GOPEED" }, {}, resolve), true);
  });

  assert.equal(response.ok, true);
  assert.equal(response.connection.connected, true);
  assert.equal(response.connection.endpoint, "http://127.0.0.1:32123");
  assert.deepEqual(nativeRequest, { action: "ensure_gopeed" });
  assert.deepEqual(requestedEndpoints, ["http://127.0.0.1:9999", "http://127.0.0.1:32123"]);
  assert.equal(stored.popoSettings.gopeedEndpoint, "http://127.0.0.1:32123");
  assert.equal(stored.popoState, undefined);

  delete global.chrome;
  delete global.importScripts;
  delete global.PopoCore;
  delete global.PopoGopeed;
  delete global.PopoQueue;
  delete require.cache[backgroundPath];
});
