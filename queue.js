(function initPopoQueue(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PopoQueue = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createPopoQueue(root) {
  "use strict";

  const workflow = root?.PopoRuntime?.workflow || null;

  const TERMINAL_JOB_STATUSES = new Set(["complete", "cancelled", "failed"]);
  const RUNNABLE_JOB_STATUSES = new Set([
    "waiting_worker",
    "scanning",
    "scan_complete",
    "awaiting_confirmation",
    "starting",
    "downloading",
    "paused",
    "draining",
    "draining_paused"
  ]);
  const JOB_STATUS_TRANSITIONS = Object.freeze({
    queued: new Set(["waiting_worker", "scanning", "cancelled", "failed"]),
    waiting_worker: new Set(["scanning", "cancelled", "failed"]),
    scanning: new Set([
      "scan_complete",
      "awaiting_confirmation",
      "starting",
      "complete",
      "cancelled",
      "failed"
    ]),
    scan_complete: new Set(["starting", "downloading", "complete", "cancelled", "failed"]),
    awaiting_confirmation: new Set([
      "scanning",
      "scan_complete",
      "starting",
      "complete",
      "cancelled",
      "failed"
    ]),
    starting: new Set(["scan_complete", "downloading", "cancelled", "failed"]),
    downloading: new Set([
      "paused",
      "draining",
      "draining_paused",
      "complete",
      "cancelled",
      "failed"
    ]),
    paused: new Set(["downloading", "draining", "draining_paused", "cancelled", "failed"]),
    draining: new Set(["draining_paused", "complete", "cancelled", "failed"]),
    draining_paused: new Set(["draining", "downloading", "cancelled", "failed"]),
    complete: new Set(),
    cancelled: new Set(),
    failed: new Set()
  });
  const KNOWN_JOB_STATUSES = new Set(Object.keys(JOB_STATUS_TRANSITIONS));

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeParentUrl(value) {
    try {
      const url = new URL(String(value || ""));
      url.hash = "";
      return url.href;
    } catch {
      return String(value || "").trim();
    }
  }

  function makeFolderJobKey({ parentUrl, folderItemIndex, folderName }) {
    return [
      normalizeParentUrl(parentUrl),
      normalizeText(folderItemIndex),
      normalizeText(folderName).toLocaleLowerCase()
    ].join("\u0000");
  }

  function isJobTerminal(status) {
    return TERMINAL_JOB_STATUSES.has(String(status || ""));
  }

  function isJobActive(status) {
    return status === "queued" || RUNNABLE_JOB_STATUSES.has(String(status || ""));
  }

  function canTransitionJobStatus(currentStatus, nextStatus) {
    if (typeof workflow?.canTransition === "function") {
      return workflow.canTransition(currentStatus, nextStatus);
    }
    const current = String(currentStatus || "");
    const next = String(nextStatus || "");
    if (!KNOWN_JOB_STATUSES.has(next)) return false;
    if (!current || !KNOWN_JOB_STATUSES.has(current)) return true;
    if (current === next) return true;
    return JOB_STATUS_TRANSITIONS[current].has(next);
  }

  function transitionJobStatus(job, nextStatus, changes = {}) {
    if (!job || typeof job !== "object" || Array.isArray(job)) {
      throw new Error("任务状态转换缺少有效任务");
    }
    const currentStatus = String(job.status || "");
    const normalizedNextStatus = String(nextStatus || "");
    if (!canTransitionJobStatus(currentStatus, normalizedNextStatus)) {
      throw new Error(`非法任务状态转换：${currentStatus || "未设置"} → ${normalizedNextStatus || "未设置"}`);
    }
    return {
      ...job,
      ...(changes && typeof changes === "object" && !Array.isArray(changes) ? changes : {}),
      status: normalizedNextStatus
    };
  }

  function jobHasFailures(job) {
    return job?.status === "failed" ||
      Number(job?.counts?.failed || 0) > 0 ||
      Number(job?.counts?.scanFailures || 0) > 0 ||
      (job?.failureRetryKeys?.length || 0) > 0 ||
      (job?.failurePreview?.length || 0) > 0;
  }

  function jobHasRecoverableCancellations(job) {
    return job?.status === "cancelled" && (
      (job?.cancelledRetryKeys?.length || 0) > 0 ||
      Number(job?.counts?.cancelled || 0) > 0
    );
  }

  function clientVisibleJobs(jobs) {
    const list = Array.isArray(jobs) ? jobs : [];
    return list.filter((job, index) => {
      if (isJobActive(job.status)) return true;
      if (jobHasRecoverableCancellations(job)) {
        return !list.some((candidate) => {
          if (candidate.restoreOfJobId !== job.id) return false;
          if (isJobActive(candidate.status)) return true;
          if (jobHasRecoverableCancellations(candidate)) return true;
          return candidate.status === "complete" && !jobHasFailures(candidate);
        });
      }
      if (job.status === "cancelled" || !jobHasFailures(job)) return false;

      return !list.some((candidate, candidateIndex) => {
        if (candidate === job) return false;
        if (candidate.retryOfJobId === job.id) return true;
        if (!job.key || candidate.key !== job.key) return false;
        const jobTime = Date.parse(job.createdAt || "");
        const candidateTime = Date.parse(candidate.createdAt || "");
        if (Number.isFinite(jobTime) && Number.isFinite(candidateTime) && candidateTime !== jobTime) {
          return candidateTime > jobTime;
        }
        return candidateIndex > index;
      });
    });
  }

  function findDuplicateJob(jobs, key) {
    return (jobs || []).find((job) => job.key === key && isJobActive(job.status)) || null;
  }

  function summarizeItems(items, scannedFolderCount = 0, scanFailureCount = 0) {
    const selected = (items || []).filter((item) => item.selected);
    const count = (status) => selected.filter((item) => item.status === status).length;
    const activeStatuses = new Set(["preparing", "transferring", "paused"]);
    const terminalStatuses = new Set(["success", "failed", "cancelled"]);
    return {
      files: selected.length,
      discoveredFiles: (items || []).length,
      folders: Number(scannedFolderCount) || 0,
      projects: (items || []).length + (Number(scannedFolderCount) || 0),
      success: count("success"),
      failed: count("failed"),
      cancelled: count("cancelled"),
      active: selected.filter((item) => activeStatuses.has(item.status)).length,
      pending: selected.filter((item) => !terminalStatuses.has(item.status) && !activeStatuses.has(item.status)).length,
      scanFailures: Number(scanFailureCount) || 0
    };
  }

  function applyCancelPolicy(items, activeTransfers, completedAt = new Date().toISOString()) {
    const activeItemIds = new Set((activeTransfers || []).map((transfer) => transfer.itemId));
    let cancelledCount = 0;
    let preservedCount = 0;
    for (const item of items || []) {
      if (activeItemIds.has(item.id) || (item.gopeedTaskId && item.status !== "success" && item.status !== "failed")) {
        preservedCount += 1;
        continue;
      }
      if (["success", "failed", "cancelled", "skipped"].includes(item.status)) continue;
      item.status = "cancelled";
      item.stage = "已取消（未开始）";
      item.failureStage = "已取消";
      item.completedAt = completedAt;
      cancelledCount += 1;
    }
    return { cancelledCount, preservedCount };
  }

  function queuePosition(jobs, jobId) {
    const queued = (jobs || []).filter((job) => job.status === "queued");
    const index = queued.findIndex((job) => job.id === jobId);
    return index < 0 ? 0 : index + 1;
  }

  return {
    RUNNABLE_JOB_STATUSES,
    TERMINAL_JOB_STATUSES,
    applyCancelPolicy,
    canTransitionJobStatus,
    clientVisibleJobs,
    findDuplicateJob,
    isJobActive,
    isJobTerminal,
    makeFolderJobKey,
    queuePosition,
    summarizeItems,
    transitionJobStatus
  };
});
