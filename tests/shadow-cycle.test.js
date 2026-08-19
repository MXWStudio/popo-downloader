"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const verifier = path.join(root, "scripts", "verify-shadow-cycle.mjs");

function entry(index, outcome = "matched", target = "0.7.3") {
  const checkedAt = new Date(Date.UTC(2026, 7, 14, 1, index)).toISOString();
  return {
    schemaVersion: 1,
    outcome,
    comparable: ["matched", "mismatch", "matched_failure", "failure_mismatch"].includes(outcome),
    matches: ["matched", "matched_failure"].includes(outcome),
    shadowTarget: target,
    legacyTarget: outcome === "mismatch" ? "0.7.2" : target,
    shadowState: "available",
    shadowErrorCode: "",
    legacyErrorCode: "",
    shadowFailureKind: "",
    legacyFailureKind: "",
    shadowTransactionId: `shadow-cycle-${index}`,
    shadowUpdatedAt: checkedAt,
    checkedAt
  };
}

function summary(history) {
  const failures = new Set(["shadow_failed", "legacy_failed", "matched_failure", "failure_mismatch"]);
  return {
    total: history.length,
    comparable: history.filter((item) => item.comparable).length,
    matched: history.filter((item) => ["matched", "matched_failure"].includes(item.outcome)).length,
    mismatched: history.filter((item) => ["mismatch", "failure_mismatch"].includes(item.outcome)).length,
    unavailable: history.filter((item) => item.outcome === "shadow_unavailable").length,
    failures: history.filter((item) => failures.has(item.outcome)).length
  };
}

function snapshot(generatedAt, history, productVersion = "0.7.3") {
  return {
    schemaVersion: 1,
    phase: "shadow",
    productVersion,
    generatedAt,
    legacyUpdate: { state: "up_to_date", currentVersion: productVersion, targetVersion: productVersion },
    agent: {
      available: true,
      state: "available",
      currentVersion: productVersion,
      targetVersion: productVersion,
      transactionId: "shadow-current",
      errorCode: "",
      protocol: 2,
      minimumProtocol: 1,
      updatedAt: generatedAt
    },
    latestComparison: history.at(-1) || null,
    history,
    summary: summary(history)
  };
}

function runVerifier(before, after, options = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-shadow-cycle-"));
  const beforePath = path.join(sandbox, "before.json");
  const afterPath = path.join(sandbox, "after.json");
  fs.writeFileSync(beforePath, JSON.stringify(before), "utf8");
  fs.writeFileSync(afterPath, JSON.stringify(after), "utf8");
  try {
    return spawnSync(process.execPath, [
      verifier,
      "--before", beforePath,
      "--after", afterPath,
      "--expected-version", options.expectedVersion || "0.7.3",
      "--minimum-comparisons", String(options.minimumComparisons || 2)
    ], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000
    });
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

test("shadow cycle verifier accepts only new matching release comparisons", () => {
  const before = snapshot("2026-08-14T00:30:00.000Z", [], "0.7.2");
  const history = [entry(0), entry(15), entry(30)];
  const after = snapshot("2026-08-14T02:00:00.000Z", history);
  const result = runVerifier(before, after);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.Ok, true);
  assert.equal(output.NewComparisonCount, 3);
  assert.equal(output.MatchedComparisonCount, 3);
  assert.equal(output.NetworkUsed, false);
  assert.equal(output.StateChanged, false);
  assert.match(output.BeforeEvidenceSha256, /^[a-f0-9]{64}$/);
  assert.match(output.AfterEvidenceSha256, /^[a-f0-9]{64}$/);
});

test("shadow cycle verifier rejects a mismatch during the release cycle", () => {
  const before = snapshot("2026-08-14T00:30:00.000Z", [], "0.7.2");
  const history = [entry(0), entry(15, "mismatch")];
  const after = snapshot("2026-08-14T02:00:00.000Z", history);
  const result = runVerifier(before, after);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stderr.trim());
  assert.equal(output.ErrorCode, "cycle_not_consistent");
  assert.doesNotMatch(result.stderr, /before\.json|after\.json|popo-shadow-cycle-/);
});

test("shadow cycle verifier rejects stale and poisoned evidence", () => {
  const before = snapshot("2026-08-14T01:30:00.000Z", [], "0.7.2");
  const stale = snapshot("2026-08-14T02:00:00.000Z", [entry(0)]);
  const staleResult = runVerifier(before, stale, { minimumComparisons: 1 });
  assert.notEqual(staleResult.status, 0);
  assert.equal(JSON.parse(staleResult.stderr.trim()).ErrorCode, "insufficient_comparisons");

  const poisonedEntry = { ...entry(15), token: "must-not-be-accepted" };
  const poisoned = snapshot("2026-08-14T02:00:00.000Z", [poisonedEntry]);
  const poisonedResult = runVerifier(
    snapshot("2026-08-14T00:30:00.000Z", [], "0.7.2"),
    poisoned,
    { minimumComparisons: 1 }
  );
  assert.notEqual(poisonedResult.status, 0);
  assert.equal(JSON.parse(poisonedResult.stderr.trim()).ErrorCode, "evidence_schema_invalid");
  assert.doesNotMatch(poisonedResult.stderr, /must-not-be-accepted/);
});
