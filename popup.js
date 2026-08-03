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
  scanning: "读取文件",
  waiting_worker: "准备工作区",
  awaiting_confirmation: "等待确认",
  downloading: "下载中",
  paused: "已暂停",
  complete: "已完成",
  cancelled: "已取消",
  scan_complete: "清单完成"
};

const phaseLabels = {
  idle: "等待操作",
  waiting_worker: "准备隐藏工作区",
  resolving_selection: "定位文件夹",
  scanning: "读取文件清单",
  ready: "等待用户确认",
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

async function call(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "扩展后台未响应");
  return response;
}

function showError(error) {
  $("errorBox").hidden = false;
  $("errorBox").textContent = String(error?.message || error).replace(/^Error:\s*/, "");
}

function clearError() {
  $("errorBox").hidden = true;
  $("errorBox").textContent = "";
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
  const items = state.items || [];
  const selected = items.filter((item) => item.selected);
  const success = selected.filter((item) => item.status === "success").length;
  const failed = selected.filter((item) => item.status === "failed").length;
  const cancelled = selected.filter((item) => item.status === "cancelled").length;
  const finished = success + failed + cancelled;
  const progress = selected.length ? Math.round((finished / selected.length) * 100) : 0;
  const hasTask = state.triggerMode === "folder_button" && state.mode !== "idle";

  $("idleCard").hidden = hasTask;
  $("taskCard").hidden = !hasTask;
  $("modeBadge").textContent = modeLabels[state.mode] || state.mode;
  $("folderName").textContent = state.selectedFolderName || "—";
  $("phaseLabel").textContent = phaseLabels[state.phase] || state.phase;
  $("progressLabel").textContent = `${finished} / ${selected.length}`;
  $("progressBar").style.width = `${progress}%`;
  $("lastMessage").textContent = state.lastMessage || "—";
  $("metricFiles").textContent = selected.length;
  $("metricSuccess").textContent = success;
  $("metricFailed").textContent = failed + (state.scanFailures?.length || 0);

  if (!gopeedInputsInitialized && settings) {
    $("gopeedEndpoint").value = settings.gopeedEndpoint || "http://127.0.0.1:9999";
    $("gopeedToken").value = settings.gopeedToken || "";
    setSelectedDownloadDirectory(settings.gopeedDownloadDirOverride);
    gopeedInputsInitialized = true;
  }

  const failures = selected.filter((item) => item.status === "failed");
  $("failureList").hidden = failures.length === 0;
  $("failureItems").replaceChildren(...failures.slice(0, 6).map((item) => {
    const entry = document.createElement("li");
    entry.textContent = `${item.name}｜${item.failureStage || "失败"}｜${String(item.error || "").replace(/^Error:\s*/, "")}`;
    return entry;
  }));

  $("pauseButton").disabled = state.mode !== "downloading";
  $("resumeButton").disabled = state.mode !== "paused";
  $("cancelButton").disabled = !["waiting_worker", "scanning", "awaiting_confirmation", "downloading", "paused"].includes(state.mode);
  $("retryButton").disabled = !items.some((item) => item.status === "failed") ||
    ["waiting_worker", "scanning", "awaiting_confirmation", "downloading", "paused"].includes(state.mode);
}

async function refresh() {
  try {
    const { state, settings } = await call({ type: "GET_STATE" });
    render(state, settings);
    void refreshGopeed();
  } catch (error) {
    showError(error);
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
bindAction("retryButton", () => call({ type: "RETRY_FAILED" }));
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
