"use strict";

const $ = (id) => document.getElementById(id);
let refreshTimer = null;
let gopeedCheckAt = 0;
let gopeedChecking = false;
let gopeedInputsInitialized = false;

function setSelectedDownloadDirectory(path) {
  const value = String(path || "").trim();
  const output = $("gopeedDownloadDirOverride");
  output.dataset.path = value;
  output.textContent = value || "使用 Gopeed 默认下载目录";
  output.title = value;
}

const modeLabels = {
  idle: "等待操作",
  queued: "排队中",
  scanning: "读取文件",
  waiting_worker: "准备工作区",
  awaiting_confirmation: "准备自动下载",
  starting: "连接下载引擎",
  downloading: "下载中",
  paused: "已暂停",
  draining: "取消剩余",
  draining_paused: "取消剩余，已暂停",
  complete: "已完成",
  cancelled: "已取消",
  failed: "失败",
  scan_complete: "清单完成"
};

const phaseLabels = {
  idle: "等待操作",
  waiting_worker: "准备隐藏工作区",
  resolving_selection: "定位文件夹",
  scanning: "读取文件清单",
  ready: "清单已就绪",
  starting: "开始下载",
  directory_loading: "加载父目录",
  file_lookup: "定位文件",
  file_opening: "打开文件",
  preview_loading: "获取下载地址",
  waiting_gopeed: "等待 Gopeed",
  paused: "下载暂停",
  resuming: "继续下载",
  retrying: "重试失败项",
  complete: "全部结束",
  cancelled: "任务取消"
};

const terminalJobStatuses = new Set(["complete", "cancelled", "failed"]);

function jobIsActive(job) {
  return !terminalJobStatuses.has(job.status);
}

function jobDetail(job) {
  const counts = job.counts || {};
  const currentLevel = Number.isInteger(job.projectCount)
    ? `当前层 ${job.projectCount} 项 · `
    : "";
  if (job.status === "queued") {
    return job.queuePosition ? `排队第 ${job.queuePosition} 位 · 等待统计` : "等待统计";
  }
  if (["waiting_worker", "scanning"].includes(job.status)) {
    return `${currentLevel}递归已发现 ${counts.discoveredFiles || 0} 文件 · ${counts.folders || 0} 文件夹`;
  }
  const finished = (counts.success || 0) + (counts.failed || 0) + (counts.cancelled || 0);
  const total = Number(counts.files) || 0;
  const percent = total ? Math.max(0, Math.min(100, Math.round(finished * 100 / total))) : 0;
  return `${currentLevel}${finished} / ${total} 已处理（${percent}%）· 成功 ${counts.success || 0} · 失败 ${counts.failed || 0}`;
}

function jobProgress(job) {
  if (["queued", "waiting_worker", "scanning"].includes(job.status)) return null;
  const counts = job.counts || {};
  const total = Number(counts.files) || 0;
  if (!total) return null;
  const finished = (counts.success || 0) + (counts.failed || 0) + (counts.cancelled || 0);
  return Math.max(0, Math.min(100, Math.round(finished * 100 / total)));
}

async function call(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "扩展后台未响应");
  return response;
}

function showError(error) {
  $("errorBox").hidden = false;
  $("errorBox").dataset.transient = "false";
  $("errorBox").textContent = String(error?.message || error).replace(/^Error:\s*/, "");
}

function showRefreshError(error) {
  $("errorBox").hidden = false;
  $("errorBox").dataset.transient = "true";
  $("errorBox").textContent = String(error?.message || error).replace(/^Error:\s*/, "");
}

function clearError() {
  $("errorBox").hidden = true;
  delete $("errorBox").dataset.transient;
  $("errorBox").textContent = "";
}

function clearRecoveredRefreshError() {
  if ($("errorBox").dataset.transient === "true") clearError();
}

function renderGopeed(connection, settings) {
  const status = $("gopeedStatus");
  if (connection.connected) {
    status.textContent = "已连接";
    status.dataset.state = "connected";
    $("gopeedDetail").textContent = `保存目录：${connection.downloadDir}${connection.customDownloadDir ? "（自定义）" : ""}`;
  } else {
    status.textContent = "未连接";
    status.dataset.state = "disconnected";
    $("gopeedDetail").textContent = connection.error ||
      "请启动 Gopeed，并在设置 → 高级中开启 TCP API。";
  }
  if (!gopeedInputsInitialized && settings) {
    $("gopeedEndpoint").value = settings.gopeedEndpoint || "http://127.0.0.1:9999";
    $("gopeedToken").value = settings.gopeedToken || "";
    setSelectedDownloadDirectory(settings.gopeedDownloadDirOverride);
    gopeedInputsInitialized = true;
  }
}

async function refreshGopeed(force = false) {
  if (gopeedChecking || (!force && Date.now() - gopeedCheckAt < 5000)) return;
  gopeedChecking = true;
  gopeedCheckAt = Date.now();
  try {
    const response = await call({ type: "CHECK_GOPEED" });
    renderGopeed(response.connection, response.settings);
  } catch (error) {
    renderGopeed({ connected: false, error: String(error?.message || error) });
  } finally {
    gopeedChecking = false;
  }
}

function render(state, settings) {
  const jobs = state.jobs || [];
  const liveJobs = jobs.filter(jobIsActive);
  const unresolvedFailures = jobs.filter((job) => !jobIsActive(job));
  const visibleJobs = [...liveJobs, ...unresolvedFailures.slice(-3)];
  const hasTask = visibleJobs.length > 0;

  $("idleCard").hidden = hasTask;
  $("taskCard").hidden = !hasTask;
  $("modeBadge").textContent = liveJobs.length
    ? `${liveJobs.length} 个任务`
    : modeLabels[state.mode] || "已完成";
  $("queueSummary").textContent = `${liveJobs.length} 个进行中 · ${liveJobs.filter((job) => job.status === "queued").length} 个排队`;
  $("popupQueueList").replaceChildren(...visibleJobs.map((job) => {
    const card = document.createElement("article");
    card.className = "popup-queue-item";
    const title = document.createElement("div");
    title.className = "popup-queue-title";
    const name = document.createElement("strong");
    name.className = "popup-queue-name";
    name.textContent = job.displayName || job.folderName || "未命名文件夹";
    name.title = name.textContent;
    const status = document.createElement("span");
    status.className = "popup-queue-status";
    status.textContent = modeLabels[job.status] || job.status;
    title.append(name, status);
    const meta = document.createElement("div");
    meta.className = "popup-queue-meta";
    meta.textContent = jobDetail(job);
    card.append(title, meta);
    const percent = jobProgress(job);
    const progress = document.createElement("div");
    progress.className = "popup-job-progress";
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", `${name.textContent} 下载进度`);
    const progressValue = document.createElement("i");
    if (percent == null) {
      progress.dataset.indeterminate = "true";
    } else {
      progress.setAttribute("aria-valuemin", "0");
      progress.setAttribute("aria-valuemax", "100");
      progress.setAttribute("aria-valuenow", String(percent));
      progressValue.style.width = `${percent}%`;
    }
    progress.appendChild(progressValue);
    card.appendChild(progress);
    if (jobIsActive(job) && !job.cancelRequested) {
      const actions = document.createElement("div");
      actions.className = "popup-queue-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "取消未开始文件";
      cancel.addEventListener("click", async () => {
        clearError();
        cancel.disabled = true;
        try {
          await call({ type: "CANCEL_JOB", jobId: job.id });
          await refresh();
        } catch (error) {
          cancel.disabled = false;
          showError(error);
        }
      });
      actions.appendChild(cancel);
      card.appendChild(actions);
    } else if (!jobIsActive(job) && job.failureRetryKeys?.length) {
      const actions = document.createElement("div");
      actions.className = "popup-queue-actions";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = `重试失败项（${job.failureRetryKeys.length}）`;
      retry.addEventListener("click", async () => {
        clearError();
        retry.disabled = true;
        try {
          await call({ type: "RETRY_JOB", jobId: job.id });
          await refresh();
        } catch (error) {
          retry.disabled = false;
          showError(error);
        }
      });
      actions.appendChild(retry);
      card.appendChild(actions);
    }
    return card;
  }));

  if (!gopeedInputsInitialized && settings) {
    $("gopeedEndpoint").value = settings.gopeedEndpoint || "http://127.0.0.1:9999";
    $("gopeedToken").value = settings.gopeedToken || "";
    setSelectedDownloadDirectory(settings.gopeedDownloadDirOverride);
    gopeedInputsInitialized = true;
  }

  const failures = [...liveJobs, ...unresolvedFailures]
    .flatMap((job) => job.failurePreview || [])
    .slice(0, 6);
  $("failureList").hidden = failures.length === 0;
  $("failureItems").replaceChildren(...failures.map((item) => {
    const entry = document.createElement("li");
    entry.textContent = `${item.name}｜${item.stage || "失败"}｜${String(item.error || "").replace(/^Error:\s*/, "")}`;
    return entry;
  }));

  $("pauseButton").disabled = state.mode !== "downloading";
  $("resumeButton").disabled = !["paused", "draining_paused"].includes(state.mode);
  $("cancelButton").disabled = !state.activeJobId ||
    Boolean(jobs.find((job) => job.id === state.activeJobId)?.cancelRequested);
}

async function refresh() {
  try {
    const { state, settings } = await call({ type: "GET_STATE" });
    clearRecoveredRefreshError();
    render(state, settings);
    void refreshGopeed();
  } catch (error) {
    showRefreshError(error);
  }
}

function bindAction(id, action) {
  $(id).addEventListener("click", async () => {
    clearError();
    try {
      await action();
      await refresh();
    } catch (error) {
      showError(error);
    }
  });
}

bindAction("pauseButton", () => call({ type: "PAUSE" }));
bindAction("resumeButton", () => call({ type: "RESUME" }));
bindAction("cancelButton", () => call({ type: "CANCEL_FOLDER_TASK" }));
bindAction("chooseDownloadDirectoryButton", async () => {
  $("gopeedStatus").textContent = "选择中";
  $("gopeedStatus").dataset.state = "checking";
  const response = await call({
    type: "CHOOSE_DOWNLOAD_DIRECTORY",
    initialPath: $("gopeedDownloadDirOverride").dataset.path || ""
  });
  if (!response.cancelled) {
    setSelectedDownloadDirectory(response.settings.gopeedDownloadDirOverride);
    renderGopeed(response.connection, response.settings);
  }
});
bindAction("clearDownloadDirectoryButton", async () => {
  const response = await call({
    type: "SAVE_GOPEED_SETTINGS",
    gopeedEndpoint: $("gopeedEndpoint").value,
    gopeedToken: $("gopeedToken").value,
    gopeedDownloadDirOverride: ""
  });
  setSelectedDownloadDirectory("");
  renderGopeed(response.connection, response.settings);
});
bindAction("saveGopeedButton", async () => {
  $("gopeedStatus").textContent = "检测中";
  $("gopeedStatus").dataset.state = "checking";
  const response = await call({
    type: "SAVE_GOPEED_SETTINGS",
    gopeedEndpoint: $("gopeedEndpoint").value,
    gopeedToken: $("gopeedToken").value,
    gopeedDownloadDirOverride: $("gopeedDownloadDirOverride").dataset.path || ""
  });
  gopeedInputsInitialized = true;
  gopeedCheckAt = Date.now();
  renderGopeed(response.connection, response.settings);
});

void refresh();
refreshTimer = setInterval(refresh, 1000);
window.addEventListener("unload", () => clearInterval(refreshTimer));
