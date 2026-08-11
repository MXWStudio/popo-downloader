"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { networkMonitor } = require("../runtime/popo-runtime.cjs");

const MB = 1024 * 1024;
const speeds = (...values) => values.map((value) => value * MB);
const at = (value) => Date.parse(value);

test("16:30–18:30 只产生一次高发时段提示且不把时段当成慢速结论", () => {
  let health = networkMonitor.createNetworkHealth(at("2026-08-11T08:29:00.000Z"));
  health = networkMonitor.updateNetworkHealth(health, {
    jobId: "job-window",
    speeds: speeds(20),
    nowMs: at("2026-08-11T08:31:00.000Z")
  });
  assert.equal(health.highProbabilityWindow, true);
  assert.equal(health.peakNoticeSequence, 1);
  assert.equal(health.status, "idle");

  health = networkMonitor.updateNetworkHealth(health, {
    jobId: "job-window",
    speeds: speeds(21),
    nowMs: at("2026-08-11T09:00:00.000Z")
  });
  assert.equal(health.peakNoticeSequence, 1);

  health = networkMonitor.updateNetworkHealth(health, {
    jobId: "job-window",
    speeds: speeds(21),
    nowMs: at("2026-08-11T11:00:00.000Z")
  });
  assert.equal(health.highProbabilityWindow, false);
});

test("使用多任务中位速度避免个别慢文件误报本地网络", () => {
  const startedAt = at("2026-08-11T04:00:00.000Z");
  let health = networkMonitor.createNetworkHealth(startedAt);
  health = networkMonitor.updateNetworkHealth(health, {
    jobId: "job-normal",
    speeds: speeds(22.84, 25.82, 18.70, 2.32, 3.50),
    nowMs: startedAt
  });
  health = networkMonitor.updateNetworkHealth(health, {
    jobId: "job-normal",
    speeds: speeds(22.84, 25.82, 18.70, 2.32, 3.50),
    nowMs: startedAt + 61_000
  });
  assert.equal(Math.round(health.medianSpeed / MB * 100) / 100, 18.7);
  assert.equal(health.status, "normal");
  assert.equal(health.noticeSequence, 0);
});

test("任何时段多个任务持续低速都会提醒并区分严重低速", () => {
  const startedAt = at("2026-08-11T04:00:00.000Z");
  let health = networkMonitor.createNetworkHealth(startedAt);
  health = networkMonitor.updateNetworkHealth(health, {
    jobId: "job-slow",
    speeds: speeds(0.02, 0.03, 0.04, 0.02, 0.03),
    nowMs: startedAt
  });
  health = networkMonitor.updateNetworkHealth(health, {
    jobId: "job-slow",
    speeds: speeds(0.02, 0.03, 0.04, 0.02, 0.03),
    nowMs: startedAt + 61_000
  });
  assert.equal(health.status, "normal");
  health = networkMonitor.updateNetworkHealth(health, {
    jobId: "job-slow",
    speeds: speeds(0.02, 0.03, 0.04, 0.02, 0.03),
    nowMs: startedAt + 122_000
  });
  assert.equal(health.highProbabilityWindow, false);
  assert.equal(health.status, "severe");
  assert.equal(health.noticeSequence, 1);
});

test("普通低速持续 90 秒后提醒，恢复稳定 30 秒后自动解除", () => {
  const startedAt = at("2026-08-11T01:00:00.000Z");
  let health = networkMonitor.createNetworkHealth(startedAt);
  health = networkMonitor.updateNetworkHealth(health, {
    jobId: "job-recovery",
    speeds: speeds(2, 2.5, 3, 2, 3),
    nowMs: startedAt
  });
  health = networkMonitor.updateNetworkHealth(health, {
    jobId: "job-recovery",
    speeds: speeds(2, 2.5, 3, 2, 3),
    nowMs: startedAt + 61_000
  });
  health = networkMonitor.updateNetworkHealth(health, {
    jobId: "job-recovery",
    speeds: speeds(2, 2.5, 3, 2, 3),
    nowMs: startedAt + 152_000
  });
  assert.equal(health.status, "slow");

  health = networkMonitor.updateNetworkHealth(health, {
    jobId: "job-recovery",
    speeds: speeds(9, 10, 11, 9, 10),
    nowMs: startedAt + 160_000
  });
  assert.equal(health.status, "slow");
  health = networkMonitor.updateNetworkHealth(health, {
    jobId: "job-recovery",
    speeds: speeds(9, 10, 11, 9, 10),
    nowMs: startedAt + 191_000
  });
  assert.equal(health.status, "normal");
});

test("稍后提醒在 15 分钟后仍低速时重新通知，今日静默只影响当天", () => {
  const startedAt = at("2026-08-11T04:00:00.000Z");
  let health = networkMonitor.createNetworkHealth(startedAt);
  health = networkMonitor.updateNetworkHealth(health, {
    jobId: "job-snooze",
    speeds: speeds(0.02, 0.03, 0.04),
    nowMs: startedAt
  });
  health = networkMonitor.updateNetworkHealth(health, {
    jobId: "job-snooze",
    speeds: speeds(0.02, 0.03, 0.04),
    nowMs: startedAt + 61_000
  });
  health = networkMonitor.updateNetworkHealth(health, {
    jobId: "job-snooze",
    speeds: speeds(0.02, 0.03, 0.04),
    nowMs: startedAt + 122_000
  });
  assert.equal(health.noticeSequence, 1);

  health = networkMonitor.snoozeNetworkReminder(health, 15, startedAt + 123_000);
  assert.equal(health.suppressed, true);
  health = networkMonitor.updateNetworkHealth(health, {
    jobId: "job-snooze",
    speeds: speeds(0.02, 0.03, 0.04),
    nowMs: startedAt + 16 * 60_000 + 123_000
  });
  assert.equal(health.noticeSequence, 2);
  assert.equal(health.suppressed, false);

  health = networkMonitor.muteNetworkReminderToday(health, startedAt + 17 * 60_000);
  assert.equal(health.suppressed, true);
  health = networkMonitor.updateNetworkHealth(health, {
    jobId: "job-snooze",
    speeds: speeds(0.02, 0.03, 0.04),
    nowMs: at("2026-08-12T04:00:00.000Z")
  });
  assert.equal(health.suppressed, false);
});
