(function initPopoQueue(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PopoQueue = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createPopoQueue() {
  "use strict";

  const TERMINAL_JOB_STATUSES = new Set(["complete", "cancelled", "failed"]);
  const RUNNABLE_JOB_STATUSES = new Set([
    "waiting_worker",
    "scanning",
    "awaiting_confirmation",
    "starting",
    "downloading",
    "paused",
    "draining",
    "draining_paused"
  ]);

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

  function jobHasFailures(job) {
    return job?.status === "failed" ||
      Number(job?.counts?.failed || 0) > 0 ||
      Number(job?.counts?.scanFailures || 0) > 0 ||
      (job?.failureRetryKeys?.length || 0) > 0 ||
      (job?.failurePreview?.length || 0) > 0;
  }

  function clientVisibleJobs(jobs) {
    const list = Array.isArray(jobs) ? jobs : [];
    return list.filter((job, index) => {
      if (isJobActive(job.status)) return true;
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
    clientVisibleJobs,
    findDuplicateJob,
    isJobActive,
    isJobTerminal,
    makeFolderJobKey,
    queuePosition,
    summarizeItems
  };
});
