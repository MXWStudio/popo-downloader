"use strict";

import crypto from "node:crypto";
import fs from "node:fs";

const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_HISTORY = 64;
const allowedOutcomes = new Set([
  "matched",
  "mismatch",
  "shadow_unavailable",
  "shadow_failed",
  "legacy_failed",
  "matched_failure",
  "failure_mismatch",
  "not_comparable"
]);
const allowedStates = new Set(["idle", "checking", "available", "failed", "unavailable"]);
const allowedFailureKinds = new Set(["", "network", "transport", "signature", "manifest", "check"]);
const allowedErrorCodes = new Set([
  "",
  "AGENT_UNAVAILABLE",
  "INTERRUPTED_SHADOW_CHECK",
  "SHADOW_NETWORK_ERROR",
  "SHADOW_SIGNATURE_INVALID",
  "SHADOW_MANIFEST_INVALID",
  "SHADOW_CHECK_FAILED",
  "LEGACY_NETWORK_ERROR",
  "LEGACY_SIGNATURE_INVALID",
  "LEGACY_MANIFEST_INVALID",
  "LEGACY_CHECK_FAILED",
  "LEGACY_TRANSPORT_ERROR"
]);
const historyKeys = new Set([
  "schemaVersion",
  "outcome",
  "comparable",
  "matches",
  "shadowTarget",
  "legacyTarget",
  "shadowState",
  "shadowErrorCode",
  "legacyErrorCode",
  "shadowFailureKind",
  "legacyFailureKind",
  "shadowTransactionId",
  "shadowUpdatedAt",
  "checkedAt"
]);

class EvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseArguments(argv) {
  const options = { minimumComparisons: 2 };
  const allowed = new Set(["--before", "--after", "--expected-version", "--minimum-comparisons"]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || !value || value.startsWith("--")) {
      throw new EvidenceError("invalid_arguments", "Required evidence arguments are missing or invalid.");
    }
    if (flag === "--before") options.before = value;
    if (flag === "--after") options.after = value;
    if (flag === "--expected-version") options.expectedVersion = value;
    if (flag === "--minimum-comparisons") options.minimumComparisons = Number(value);
  }
  if (!options.before || !options.after || !/^\d{1,10}(?:\.\d{1,10}){1,3}$/.test(options.expectedVersion || "") ||
      !Number.isInteger(options.minimumComparisons) || options.minimumComparisons < 1 ||
      options.minimumComparisons > MAX_HISTORY) {
    throw new EvidenceError("invalid_arguments", "Required evidence arguments are missing or invalid.");
  }
  return options;
}

function readEvidence(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_EVIDENCE_BYTES) {
      throw new EvidenceError("evidence_size_invalid", "Evidence must be a non-empty JSON file under 1 MiB.");
    }
    const bytes = fs.readFileSync(file);
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new EvidenceError("evidence_json_invalid", "Evidence is not valid JSON.");
    }
    return {
      value,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex")
    };
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError("evidence_unreadable", "Evidence could not be read.");
  }
}

function validTimestamp(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/.test(value || "") &&
    Number.isFinite(Date.parse(value));
}

function validVersion(value, allowEmpty = true) {
  return (allowEmpty && value === "") || /^\d{1,10}(?:\.\d{1,10}){1,3}$/.test(value || "");
}

function validateHistoryEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      Object.keys(entry).some((key) => !historyKeys.has(key)) ||
      entry.schemaVersion !== 1 || !allowedOutcomes.has(entry.outcome) ||
      typeof entry.comparable !== "boolean" || typeof entry.matches !== "boolean" ||
      !validVersion(entry.shadowTarget) || !validVersion(entry.legacyTarget) ||
      !allowedStates.has(entry.shadowState) || !allowedErrorCodes.has(entry.shadowErrorCode) ||
      !allowedErrorCodes.has(entry.legacyErrorCode) || !allowedFailureKinds.has(entry.shadowFailureKind) ||
      !allowedFailureKinds.has(entry.legacyFailureKind) ||
      (entry.shadowTransactionId !== "" &&
        !/^shadow-[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(entry.shadowTransactionId || "")) ||
      (entry.shadowUpdatedAt !== "" && !validTimestamp(entry.shadowUpdatedAt)) ||
      !validTimestamp(entry.checkedAt)) {
    throw new EvidenceError("evidence_schema_invalid", "Shadow comparison evidence does not match schema version 1.");
  }
  const comparable = new Set(["matched", "mismatch", "matched_failure", "failure_mismatch"])
    .has(entry.outcome);
  const matches = entry.outcome === "matched" || entry.outcome === "matched_failure";
  if (entry.comparable !== comparable || entry.matches !== matches) {
    throw new EvidenceError("evidence_semantics_invalid", "Shadow comparison derived fields are inconsistent.");
  }
  return entry;
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
      snapshot.schemaVersion !== 1 || snapshot.phase !== "shadow" ||
      !validTimestamp(snapshot.generatedAt) || !validVersion(snapshot.productVersion, false) ||
      !Array.isArray(snapshot.history) || snapshot.history.length > MAX_HISTORY) {
    throw new EvidenceError("evidence_schema_invalid", "Update diagnostic evidence does not match schema version 1.");
  }
  return {
    ...snapshot,
    history: snapshot.history.map(validateHistoryEntry)
  };
}

function recomputeSummary(history) {
  const failureOutcomes = new Set(["shadow_failed", "legacy_failed", "matched_failure", "failure_mismatch"]);
  return {
    total: history.length,
    comparable: history.filter((entry) => entry.comparable).length,
    matched: history.filter((entry) => entry.outcome === "matched" || entry.outcome === "matched_failure").length,
    mismatched: history.filter((entry) => entry.outcome === "mismatch" || entry.outcome === "failure_mismatch").length,
    unavailable: history.filter((entry) => entry.outcome === "shadow_unavailable").length,
    failures: history.filter((entry) => failureOutcomes.has(entry.outcome)).length
  };
}

function validateSummary(snapshot) {
  const expected = recomputeSummary(snapshot.history);
  if (!snapshot.summary || Object.keys(expected).some((key) => snapshot.summary[key] !== expected[key])) {
    throw new EvidenceError("evidence_summary_invalid", "Update diagnostic summary does not match its history.");
  }
}

function verifyCycle(beforeEvidence, afterEvidence, expectedVersion, minimumComparisons) {
  const before = validateSnapshot(beforeEvidence.value);
  const after = validateSnapshot(afterEvidence.value);
  validateSummary(after);
  const cycleStart = Date.parse(before.generatedAt);
  const cycleEnd = Date.parse(after.generatedAt);
  if (cycleEnd <= cycleStart) {
    throw new EvidenceError("evidence_order_invalid", "After evidence must be newer than before evidence.");
  }
  if (after.productVersion !== expectedVersion || after.agent?.protocol !== 2 ||
      after.agent?.minimumProtocol !== 1) {
    throw new EvidenceError("cycle_contract_invalid", "After evidence does not report the expected product and Agent protocol.");
  }
  const cycleEntries = after.history.filter((entry) => {
    const checkedAt = Date.parse(entry.checkedAt);
    return checkedAt > cycleStart && checkedAt <= cycleEnd;
  });
  if (cycleEntries.length < minimumComparisons) {
    throw new EvidenceError("insufficient_comparisons", "The release cycle does not contain enough new comparisons.");
  }
  const inconsistent = cycleEntries.filter((entry) => entry.outcome !== "matched" ||
    entry.shadowTarget !== expectedVersion || entry.legacyTarget !== expectedVersion ||
    !entry.shadowTransactionId || !entry.shadowUpdatedAt);
  if (inconsistent.length > 0) {
    throw new EvidenceError("cycle_not_consistent", "The release cycle contains a mismatch, failure, unavailable result, or unexpected target.");
  }
  return {
    Ok: true,
    SchemaVersion: 1,
    ExpectedVersion: expectedVersion,
    MinimumComparisons: minimumComparisons,
    NewComparisonCount: cycleEntries.length,
    MatchedComparisonCount: cycleEntries.length,
    MismatchedComparisonCount: 0,
    UnavailableComparisonCount: 0,
    FailureComparisonCount: 0,
    BeforeEvidenceSha256: beforeEvidence.sha256,
    AfterEvidenceSha256: afterEvidence.sha256,
    ReadOnly: true,
    NetworkUsed: false,
    StateChanged: false
  };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const result = verifyCycle(
    readEvidence(options.before),
    readEvidence(options.after),
    options.expectedVersion,
    options.minimumComparisons
  );
  console.log(JSON.stringify(result));
} catch (error) {
  const code = error instanceof EvidenceError ? error.code : "verification_failed";
  const message = error instanceof EvidenceError ? error.message : "Shadow cycle verification failed.";
  console.error(JSON.stringify({ Ok: false, ErrorCode: code, Message: message }));
  process.exitCode = 1;
}
