(function installPopoContentWorker() {
  "use strict";

  const SELECTORS = {
    scroller: '[data-test-id="virtuoso-scroller"], [data-virtuoso-scroller="true"]',
    row: "[data-item-index]",
    name: '[class*="topName"]',
    folderIcon: '[class*="drive-icon-folder"]',
    downloadButton: "button"
  };
  const API_REQUEST_SOURCE = "popo-stable-downloader-isolated";
  const API_RESPONSE_SOURCE = "popo-stable-downloader-page";
  const BUTTON_CLASS = "popo-stable-download-button";
  const STYLE_ID = "popo-stable-download-style";
  const PROJECT_COUNT_ID = "popo-stable-project-count";
  const STATUS_ID = "popo-stable-download-status";
  const QUEUE_PANEL_ID = "popo-stable-download-queue";
  const WORKER_FRAME_ID = "popo-stable-download-worker-frame";
  const ENSURE_WORKER_EVENT = "popo-stable-download:ensure-worker";
  const EXTENSION_NODE_SELECTOR = [
    `#${STYLE_ID}`,
    `#${PROJECT_COUNT_ID}`,
    `#${STATUS_ID}`,
    `#${QUEUE_PANEL_ID}`,
    `#${WORKER_FRAME_ID}`,
    `.${BUTTON_CLASS}`
  ].join(",");
  const IS_TOP_FRAME = window.top === window;
  const { inferVirtualListItemCount, selectVirtualListMatch } = globalThis.PopoCore;
  const { isJobActive, makeFolderJobKey } = globalThis.PopoQueue;
  let latestQueueState = null;
  let queueRefreshTimer = null;
  let projectCountUrl = "";
  let projectCountCandidate = null;
  let projectCountCandidateRounds = 0;
  let projectCountCandidateSince = 0;
  let workerRecoveryRequestedAt = 0;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitUntil(predicate, timeoutMs, intervalMs = 150) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const value = predicate();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await delay(intervalMs);
    }
    throw lastError || new Error(`等待超时（${timeoutMs}ms）`);
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function parseRow(row) {
    const nameElement = row.querySelector(SELECTORS.name);
    const name = normalizeText(nameElement?.textContent);
    if (!name) return null;
    const type = row.querySelector(SELECTORS.folderIcon) ? "folder" : "file";
    return {
      name,
      type,
      itemIndex: String(row.getAttribute("data-item-index") || row.getAttribute("data-index") || "")
    };
  }

  function directoryScrollers() {
    return Array.from(document.querySelectorAll(SELECTORS.scroller))
      .filter((scroller) => scroller.isConnected)
      .sort((left, right) => {
        const leftRows = left.querySelectorAll(SELECTORS.row).length;
        const rightRows = right.querySelectorAll(SELECTORS.row).length;
        if (leftRows !== rightRows) return rightRows - leftRows;
        const leftRange = Math.max(0, left.scrollHeight - left.clientHeight);
        const rightRange = Math.max(0, right.scrollHeight - right.clientHeight);
        return rightRange - leftRange;
      });
  }

  function currentDirectoryScroller() {
    return directoryScrollers()[0] || null;
  }

  function renderedEntries(scroller) {
    return Array.from(scroller?.querySelectorAll(SELECTORS.row) || [])
      .map((row) => ({ row, item: parseRow(row) }))
      .filter(({ item }) => item);
  }

  function moveScroller(scroller, requestedTop) {
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const top = Math.max(0, Math.min(maxTop, Number(requestedTop) || 0));
    try {
      scroller.scrollTo({ top, left: 0, behavior: "auto" });
    } catch {
      scroller.scrollTop = top;
    }
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    return top;
  }

  function setTextIfChanged(element, value) {
    const nextValue = String(value ?? "");
    if (element.textContent !== nextValue) element.textContent = nextValue;
  }

  function extensionElementForNode(node) {
    if (!node) return null;
    if (node.nodeType === 1) return node;
    return node.parentElement || null;
  }

  function isExtensionOwnedNode(node) {
    const element = extensionElementForNode(node);
    if (!element) return false;
    return element.matches?.(EXTENSION_NODE_SELECTOR) ||
      Boolean(element.closest?.(EXTENSION_NODE_SELECTOR));
  }

  function mutationNeedsFolderButtonInstall(mutation) {
    if (isExtensionOwnedNode(mutation.target)) return false;
    const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
    return changedNodes.length === 0 || !changedNodes.every(isExtensionOwnedNode);
  }

  function ensureInjectedStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    const popoLogoUrl = chrome.runtime.getURL("assets/popo-logo.svg");
    style.textContent = `
      .${BUTTON_CLASS} {
        box-sizing: border-box !important;
        position: relative !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        flex: 0 0 28px !important;
        width: 28px !important;
        height: 28px !important;
        overflow: visible !important;
        margin: 0 3px !important;
        padding: 0 !important;
        border: 1px solid #b9cce5 !important;
        border-radius: 6px !important;
        color: #1268e8 !important;
        background-color: #fff !important;
        background-position: center !important;
        background-repeat: no-repeat !important;
        background-size: 24px 24px !important;
        font: 700 17px/1 "Segoe UI", sans-serif !important;
        cursor: pointer !important;
        box-shadow: 0 1px 3px rgba(24, 61, 106, .1) !important;
        color-scheme: light;
      }
      .${BUTTON_CLASS}[data-state="idle"] {
        background-image: url("${popoLogoUrl}") !important;
      }
      .${BUTTON_CLASS}[data-state="idle"]::after {
        box-sizing: border-box !important;
        position: absolute !important;
        right: -2px !important;
        bottom: -2px !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 12px !important;
        height: 12px !important;
        border: 1.5px solid #fff !important;
        border-radius: 999px !important;
        color: #fff !important;
        background: #1268e8 !important;
        content: "↓" !important;
        font: 700 9px/1 "Segoe UI", sans-serif !important;
      }
      .${BUTTON_CLASS}:not([data-state="idle"]) {
        background-image: none !important;
      }
      .${BUTTON_CLASS}:hover {
        border-color: #1268e8 !important;
        background-color: #eaf3ff !important;
        box-shadow: 0 2px 7px rgba(18, 104, 232, .22) !important;
      }
      .${BUTTON_CLASS}[data-state="scanning"],
      .${BUTTON_CLASS}:disabled {
        cursor: wait !important;
        opacity: .65 !important;
      }
      @media (prefers-color-scheme: dark) {
        .${BUTTON_CLASS} {
          color: #89bdff !important;
          border-color: #4d5a6b !important;
          background-color: #222a35 !important;
          box-shadow: 0 1px 4px rgba(0, 0, 0, .28) !important;
          color-scheme: dark;
        }
        .${BUTTON_CLASS}[data-state="idle"]::after {
          border-color: #222a35 !important;
          background: #4d9aff !important;
        }
        .${BUTTON_CLASS}:hover {
          border-color: #67aaff !important;
          background-color: #29384c !important;
          box-shadow: 0 2px 8px rgba(0, 0, 0, .38) !important;
        }
      }
      :is(html, body).dark .${BUTTON_CLASS},
      :is(html, body)[data-theme="dark"] .${BUTTON_CLASS},
      :is(html, body)[data-color-mode="dark"] .${BUTTON_CLASS} {
        color: #89bdff !important;
        border-color: #4d5a6b !important;
        background-color: #222a35 !important;
        box-shadow: 0 1px 4px rgba(0, 0, 0, .28) !important;
        color-scheme: dark;
      }
      :is(html, body).dark .${BUTTON_CLASS}[data-state="idle"]::after,
      :is(html, body)[data-theme="dark"] .${BUTTON_CLASS}[data-state="idle"]::after,
      :is(html, body)[data-color-mode="dark"] .${BUTTON_CLASS}[data-state="idle"]::after {
        border-color: #222a35 !important;
        background: #4d9aff !important;
      }
      #${PROJECT_COUNT_ID} {
        all: initial;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        min-width: 72px;
        height: 32px;
        margin-left: 10px;
        margin-right: auto;
        padding: 0 10px;
        border: 1px solid #e0e6ee;
        border-radius: 6px;
        color: #59697a;
        background: #fff;
        font: 500 13px/1 "Segoe UI", "Microsoft YaHei", sans-serif;
        white-space: nowrap;
      }
      #${PROJECT_COUNT_ID}[data-state="loading"] {
        color: #7b8795;
      }
      :is(html, body).dark #${PROJECT_COUNT_ID},
      :is(html, body)[data-theme="dark"] #${PROJECT_COUNT_ID},
      :is(html, body)[data-color-mode="dark"] #${PROJECT_COUNT_ID} {
        color: #b6c2d0;
        border-color: #3b4655;
        background: #202832;
      }
      #${STATUS_ID} {
        all: initial;
        position: fixed;
        right: 24px;
        bottom: 24px;
        z-index: 2147483646;
        width: min(340px, calc(100vw - 48px));
        padding: 13px 15px;
        border: 1px solid #cfe0f7;
        border-radius: 10px;
        color: #223247;
        background: rgba(255, 255, 255, .97);
        box-shadow: 0 10px 35px rgba(24, 61, 106, .18);
        font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      #${STATUS_ID} strong {
        display: block;
        overflow: hidden;
        margin-bottom: 4px;
        font-size: 13px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${STATUS_ID} span {
        color: #607086;
        font-size: 12px;
        line-height: 1.45;
      }
      #${QUEUE_PANEL_ID} {
        all: initial;
        position: fixed;
        left: 20px;
        bottom: 20px;
        z-index: 2147483645;
        width: min(380px, calc(100vw - 40px));
        max-height: min(62vh, 560px);
        overflow: hidden;
        border: 1px solid #cfe0f7;
        border-radius: 12px;
        color: #223247;
        background: rgba(255, 255, 255, .98);
        box-shadow: 0 12px 38px rgba(24, 61, 106, .2);
        font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      #${QUEUE_PANEL_ID}[hidden] { display: none !important; }
      #${QUEUE_PANEL_ID} * { box-sizing: border-box; }
      #${QUEUE_PANEL_ID} .popo-queue-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 11px 13px;
        border-bottom: 1px solid #e1e9f2;
        background: #f5f9ff;
      }
      #${QUEUE_PANEL_ID} .popo-queue-header strong { font-size: 13px; }
      #${QUEUE_PANEL_ID} .popo-queue-header-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #${QUEUE_PANEL_ID} .popo-queue-header span { color: #607086; font-size: 12px; }
      #${QUEUE_PANEL_ID} .popo-queue-toggle {
        min-width: 0;
        height: 26px;
        padding: 0 8px;
        border: 1px solid #b9cce4;
        border-radius: 6px;
        color: #1268e8;
        background: #fff;
        font: 600 11px/1 "Segoe UI", "Microsoft YaHei", sans-serif;
        cursor: pointer;
      }
      #${QUEUE_PANEL_ID}[data-collapsed="true"] {
        width: min(320px, calc(100vw - 40px));
      }
      #${QUEUE_PANEL_ID}[data-collapsed="true"] .popo-queue-header {
        border-bottom: 0;
      }
      #${QUEUE_PANEL_ID}[data-collapsed="true"] .popo-queue-list {
        display: none;
      }
      #${QUEUE_PANEL_ID} .popo-queue-list {
        max-height: min(52vh, 470px);
        overflow: auto;
        padding: 6px 10px 9px;
      }
      #${QUEUE_PANEL_ID} .popo-queue-job {
        padding: 9px 3px;
        border-bottom: 1px solid #edf1f6;
      }
      #${QUEUE_PANEL_ID} .popo-queue-job:last-child { border-bottom: 0; }
      #${QUEUE_PANEL_ID} .popo-queue-title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      #${QUEUE_PANEL_ID} .popo-queue-name {
        overflow: hidden;
        color: #1d2d42;
        font-size: 13px;
        font-weight: 650;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${QUEUE_PANEL_ID} .popo-queue-state {
        flex: none;
        color: #1268e8;
        font-size: 11px;
        font-weight: 650;
      }
      #${QUEUE_PANEL_ID} .popo-queue-detail {
        margin-top: 5px;
        color: #607086;
        font-size: 11px;
        line-height: 1.45;
      }
      #${QUEUE_PANEL_ID} .popo-queue-progress {
        overflow: hidden;
        height: 6px;
        margin-top: 7px;
        border-radius: 999px;
        background: #dfe8f3;
      }
      #${QUEUE_PANEL_ID} .popo-queue-progress i {
        display: block;
        width: 0;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, #1268e8, #0aa17a);
        transition: width .2s ease;
      }
      #${QUEUE_PANEL_ID} .popo-queue-progress[data-indeterminate="true"] i {
        width: 38%;
        animation: popo-queue-progress-slide 1.2s ease-in-out infinite alternate;
      }
      @keyframes popo-queue-progress-slide {
        from { transform: translateX(-25%); }
        to { transform: translateX(190%); }
      }
      #${QUEUE_PANEL_ID} .popo-queue-actions {
        display: flex;
        justify-content: flex-end;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 7px;
      }
      #${QUEUE_PANEL_ID} .popo-remove-confirmation {
        margin-top: 7px;
        padding: 8px;
        border: 1px solid #dfe5ec;
        border-radius: 7px;
        background: #f7f9fc;
      }
      #${QUEUE_PANEL_ID} .popo-remove-note {
        margin: 0;
        color: #59697a;
        font: 500 11px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      #${QUEUE_PANEL_ID} .popo-remove-confirmation .popo-queue-actions {
        margin-top: 6px;
      }
      #${QUEUE_PANEL_ID} .popo-queue-action {
        min-width: 0;
        height: 26px;
        padding: 0 9px;
        border: 1px solid #d7dee7;
        border-radius: 6px;
        color: #4e5c6d;
        background: #fff;
        font: 600 11px/1 "Segoe UI", "Microsoft YaHei", sans-serif;
        cursor: pointer;
      }
      #${QUEUE_PANEL_ID} .popo-queue-action[data-kind="primary"] {
        color: #0a4fae;
        border-color: #b8d2f5;
        background: #f5f9ff;
      }
      #${QUEUE_PANEL_ID} .popo-queue-action[data-kind="danger"] {
        color: #a32626;
        border-color: #e3a5a5;
        background: #fff7f7;
      }
      #${QUEUE_PANEL_ID} .popo-queue-action:disabled {
        cursor: wait;
        opacity: .6;
      }
      @media (prefers-color-scheme: dark) {
        #${PROJECT_COUNT_ID} {
          color: #b6c2d0;
          border-color: #3b4655;
          background: #202832;
        }
        #${STATUS_ID},
        #${QUEUE_PANEL_ID} {
          color: #e9eff8;
          border-color: #38485b;
          background: rgba(25, 32, 42, .98);
          box-shadow: 0 12px 38px rgba(0, 0, 0, .42);
        }
        #${STATUS_ID} span,
        #${QUEUE_PANEL_ID} .popo-queue-header span,
        #${QUEUE_PANEL_ID} .popo-queue-detail,
        #${QUEUE_PANEL_ID} .popo-remove-note { color: #a4b0c0; }
        #${QUEUE_PANEL_ID} .popo-queue-header {
          border-bottom-color: #33404f;
          background: #202a38;
        }
        #${QUEUE_PANEL_ID} .popo-queue-job { border-bottom-color: #2c3642; }
        #${QUEUE_PANEL_ID} .popo-queue-name { color: #edf3fb; }
        #${QUEUE_PANEL_ID} .popo-queue-state { color: #67aaff; }
        #${QUEUE_PANEL_ID} .popo-remove-confirmation {
          border-color: #38485b;
          background: #202832;
        }
        #${QUEUE_PANEL_ID} .popo-queue-action {
          color: #b6c2d0;
          border-color: #465365;
          background: #202832;
        }
        #${QUEUE_PANEL_ID} .popo-queue-action[data-kind="primary"] {
          color: #a8cdff;
          border-color: #3d5f84;
          background: #1c3048;
        }
        #${QUEUE_PANEL_ID} .popo-queue-action[data-kind="danger"] {
          color: #ffaaaa;
          border-color: #7c4a50;
          background: #382328;
        }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function resetFolderButtons(folderName) {
    for (const button of document.querySelectorAll(`.${BUTTON_CLASS}`)) {
      if (!folderName || button.dataset.folderName === folderName) {
        button.disabled = false;
        button.dataset.state = "idle";
        setTextIfChanged(button, "");
      }
    }
  }

  function matchingQueueJob(item) {
    if (!latestQueueState || !item) return null;
    const key = makeFolderJobKey({
      parentUrl: location.href,
      folderItemIndex: item.itemIndex,
      folderName: item.name
    });
    return (latestQueueState.jobs || []).find((job) => job.key === key && isJobActive(job.status)) || null;
  }

  function applyQueueStateToButton(button, item) {
    const job = matchingQueueJob(item);
    if (!job) {
      button.disabled = false;
      button.dataset.state = "idle";
      setTextIfChanged(button, "");
      button.title = "稳定下载此文件夹";
      delete button.dataset.jobId;
      return;
    }
    button.disabled = false;
    button.dataset.state = job.status;
    button.dataset.jobId = job.id;
    setTextIfChanged(button, job.status === "queued" ? "✓" : "…");
    button.title = job.status === "queued"
      ? "已添加下载，点击可查看排队状态"
      : "该文件夹正在处理中，点击可查看状态";
  }

  function syncFolderButtonsWithQueue() {
    for (const button of document.querySelectorAll(`.${BUTTON_CLASS}`)) {
      const row = button.closest(SELECTORS.row);
      const item = row ? parseRow(row) : null;
      if (item?.type === "folder") applyQueueStateToButton(button, item);
    }
  }

  function projectCountPlacement() {
    const label = Array.from(document.querySelectorAll("span"))
      .find((element) => normalizeText(element.textContent) === "所有类型");
    const leftControl = label?.parentElement;
    const host = leftControl?.parentElement;
    if (!host || !leftControl || !host.contains(leftControl)) return null;
    return { host, leftControl };
  }

  function currentVirtualListItemCount() {
    if (hasExplicitEmptyState()) return 0;
    const scroller = currentDirectoryScroller();
    if (!scroller) return null;
    const rows = Array.from(scroller.querySelectorAll(SELECTORS.row));
    const itemList = scroller.querySelector('[data-test-id="virtuoso-item-list"]');
    if (!rows.length || !itemList) return null;
    return inferVirtualListItemCount({
      indices: rows.map((row) => row.getAttribute("data-item-index") || row.getAttribute("data-index")),
      knownSizes: rows.map((row) => row.getAttribute("data-known-size")),
      paddingBottom: getComputedStyle(itemList).paddingBottom,
      explicitEmpty: false
    });
  }

  function installProjectCount() {
    if (!IS_TOP_FRAME) return;
    if (!/\/pageDetail\/[a-z0-9]+/i.test(location.href)) {
      document.getElementById(PROJECT_COUNT_ID)?.remove();
      projectCountUrl = "";
      projectCountCandidate = null;
      projectCountCandidateRounds = 0;
      projectCountCandidateSince = 0;
      return;
    }
    const placement = projectCountPlacement();
    if (!placement) return;
    ensureInjectedStyles();
    let output = document.getElementById(PROJECT_COUNT_ID);
    if (!output) {
      output = document.createElement("span");
      output.id = PROJECT_COUNT_ID;
      output.setAttribute("aria-live", "polite");
    }
    if (output.parentElement !== placement.host || output.previousSibling !== placement.leftControl) {
      placement.host.insertBefore(output, placement.leftControl.nextSibling);
    }

    if (projectCountUrl !== location.href) {
      projectCountUrl = location.href;
      projectCountCandidate = null;
      projectCountCandidateRounds = 0;
      projectCountCandidateSince = 0;
      output.dataset.state = "loading";
      setTextIfChanged(output, "正在统计…");
      output.title = "正在统计当前目录第一层项目数";
      return;
    }

    const count = currentVirtualListItemCount();
    if (!Number.isInteger(count) || count < 0) {
      output.dataset.state = "loading";
      setTextIfChanged(output, "正在统计…");
      output.title = "正在统计当前目录第一层项目数";
      return;
    }
    if (projectCountCandidate === count) projectCountCandidateRounds += 1;
    else {
      projectCountCandidate = count;
      projectCountCandidateRounds = 1;
      projectCountCandidateSince = Date.now();
    }
    if (projectCountCandidateRounds < 2 || Date.now() - projectCountCandidateSince < 250) {
      output.dataset.state = "loading";
      setTextIfChanged(output, "正在统计…");
      output.title = "正在确认当前目录项目数";
      return;
    }
    output.dataset.state = "ready";
    setTextIfChanged(output, `${count} 个项目`);
    output.title = `当前目录第一层：${count} 个项目（文件 + 文件夹）`;
  }

  function showStatus(folderName, message) {
    ensureInjectedStyles();
    let status = document.getElementById(STATUS_ID);
    if (!status) {
      status = document.createElement("aside");
      status.id = STATUS_ID;
      status.innerHTML = "<strong></strong><span></span>";
      document.documentElement.appendChild(status);
    }
    status.querySelector("strong").textContent = folderName || "POPO 稳定下载";
    const detail = String(message || "正在准备…");
    status.querySelector("span").textContent =
      /隐藏工作区|后台工作区|Gopeed|\bAPI\b|IndexedDB|运行时契约|TCP/i.test(detail)
        ? "正在准备，请保持 POPO 页面打开。"
        : detail;
  }

  function hideStatus() {
    document.getElementById(STATUS_ID)?.remove();
  }

  const queueStatusLabels = {
    queued: "等待",
    waiting_worker: "准备中",
    scanning: "查找文件",
    awaiting_confirmation: "准备中",
    starting: "准备中",
    downloading: "下载中",
    paused: "已暂停",
    draining: "正在停止",
    draining_paused: "已暂停",
    complete: "已完成",
    cancelled: "已停止",
    failed: "未完成"
  };

  function queueJobDetail(job) {
    const counts = job.counts || {};
    if (job.status === "queued") {
      return job.queuePosition > 1 ? `前面还有 ${job.queuePosition - 1} 个任务` : "等待开始";
    }
    if (["waiting_worker", "scanning"].includes(job.status)) {
      return `已找到 ${counts.discoveredFiles || 0} 个文件`;
    }
    const success = Number(counts.success) || 0;
    const failed = Number(counts.failed) || 0;
    const cancelled = Number(counts.cancelled) || 0;
    const total = Number(counts.files) || 0;
    if (job.status === "cancelled") {
      return cancelled ? `已完成 ${success} 个 · ${cancelled} 个可继续` : `已完成 ${success} 个`;
    }
    if (job.status === "failed") {
      return failed ? `已完成 ${success} 个 · ${failed} 个未完成` : "未能开始，请稍后重试";
    }
    if (!total) return "正在准备文件";
    const paused = ["paused", "draining_paused"].includes(job.status) ? "已暂停 · " : "";
    return `${paused}已完成 ${success} / ${total}`;
  }

  function queueUserFacingError(error) {
    const detail = String(error?.message || error || "").replace(/^Error:\s*/, "");
    if (/请先打开|POPO 页面|页面已关闭/.test(detail)) return "请先打开 POPO 页面，再试一次。";
    if (/已经不在列表|没有可恢复|任务.*进行/.test(detail)) return detail;
    console.warn("下载任务操作失败", error);
    return "操作没有完成，请稍后重试。";
  }

  function queueJobProgress(job) {
    if (["queued", "waiting_worker", "scanning"].includes(job.status)) return null;
    const counts = job.counts || {};
    const total = Number(counts.files) || 0;
    if (!total) return ["complete", "cancelled", "failed"].includes(job.status) ? 0 : null;
    const finished = (counts.success || 0) + (counts.failed || 0) + (counts.cancelled || 0);
    return Math.max(0, Math.min(100, Math.round(finished * 100 / total)));
  }

  function ensureQueuePanel() {
    let panel = document.getElementById(QUEUE_PANEL_ID);
    if (panel) return panel;
    panel = document.createElement("aside");
    panel.id = QUEUE_PANEL_ID;
    const header = document.createElement("div");
    header.className = "popo-queue-header";
    const heading = document.createElement("strong");
    heading.textContent = "下载任务";
    const headerActions = document.createElement("div");
    headerActions.className = "popo-queue-header-actions";
    const summary = document.createElement("span");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "popo-queue-toggle";
    toggle.textContent = "展开";
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", () => {
      const collapsed = panel.dataset.collapsed !== "false";
      panel.dataset.collapsed = collapsed ? "false" : "true";
      toggle.textContent = collapsed ? "收起" : "展开";
      toggle.setAttribute("aria-expanded", String(collapsed));
    });
    headerActions.append(summary, toggle);
    header.append(heading, headerActions);
    const list = document.createElement("div");
    list.className = "popo-queue-list";
    panel.append(header, list);
    panel.dataset.collapsed = "true";
    document.documentElement.appendChild(panel);
    return panel;
  }

  function renderQueuePanel(state) {
    if (!IS_TOP_FRAME) return;
    latestQueueState = state;
    ensureInjectedStyles();
    const panel = ensureQueuePanel();
    const jobs = state.jobs || [];
    const liveJobs = jobs.filter((job) => isJobActive(job.status));
    const recoverableJobs = jobs.filter((job) => job.status === "cancelled" &&
      ((job.cancelledRetryKeys?.length || 0) > 0 || (job.counts?.cancelled || 0) > 0));
    const visibleJobs = [...liveJobs, ...recoverableJobs];
    panel.hidden = visibleJobs.length === 0;
    if (!visibleJobs.length) return;

    const queuedCount = liveJobs.filter((job) => job.status === "queued").length;
    const runningCount = liveJobs.length - queuedCount;
    panel.querySelector(".popo-queue-header span").textContent = recoverableJobs.length && liveJobs.length
      ? `${liveJobs.length} 个进行中 · ${recoverableJobs.length} 个可继续`
      : recoverableJobs.length
        ? `${recoverableJobs.length} 个可继续`
        : runningCount && queuedCount
          ? `${runningCount} 个进行中 · ${queuedCount} 个等待`
          : runningCount
            ? `${runningCount} 个进行中`
            : `${queuedCount} 个等待`;
    const list = panel.querySelector(".popo-queue-list");
    list.replaceChildren(...visibleJobs.map((job) => {
      const card = document.createElement("section");
      card.className = "popo-queue-job";
      card.dataset.jobId = job.id;
      const titleRow = document.createElement("div");
      titleRow.className = "popo-queue-title-row";
      const name = document.createElement("span");
      name.className = "popo-queue-name";
      name.textContent = job.folderName || job.displayName || "未命名文件夹";
      name.title = name.textContent;
      const status = document.createElement("span");
      status.className = "popo-queue-state";
      status.textContent = queueStatusLabels[job.status] || job.status;
      titleRow.append(name, status);
      const detail = document.createElement("div");
      detail.className = "popo-queue-detail";
      detail.textContent = queueJobDetail(job);
      card.append(titleRow, detail);

      const percent = queueJobProgress(job);
      const progress = document.createElement("div");
      progress.className = "popo-queue-progress";
      progress.setAttribute("role", "progressbar");
      progress.setAttribute("aria-label", `${name.textContent} 下载进度`);
      const progressValue = document.createElement("i");
      if (percent == null) {
        progress.dataset.indeterminate = "true";
        progress.removeAttribute("aria-valuenow");
      } else {
        progress.setAttribute("aria-valuemin", "0");
        progress.setAttribute("aria-valuemax", "100");
        progress.setAttribute("aria-valuenow", String(percent));
        progressValue.style.width = `${percent}%`;
      }
      progress.appendChild(progressValue);
      card.appendChild(progress);

      const actions = document.createElement("div");
      actions.className = "popo-queue-actions";
      if (isJobActive(job.status) && !job.cancelRequested) {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "popo-queue-action";
        cancel.dataset.kind = "danger";
        cancel.textContent = "停止后续下载";
        cancel.addEventListener("click", async () => {
          cancel.disabled = true;
          try {
            const response = await chrome.runtime.sendMessage({ type: "CANCEL_JOB", jobId: job.id });
            if (!response?.ok) throw new Error(response?.error || "操作失败");
            showStatus(job.folderName, "后续下载已停止，已开始的文件不受影响");
            await refreshQueueState();
          } catch (error) {
            cancel.disabled = false;
            showStatus(job.folderName, queueUserFacingError(error));
          }
        });
        actions.appendChild(cancel);
      } else if (job.status === "cancelled" &&
        ((job.cancelledRetryKeys?.length || 0) > 0 || (job.counts?.cancelled || 0) > 0)) {
        const restore = document.createElement("button");
        restore.type = "button";
        restore.className = "popo-queue-action";
        restore.dataset.kind = "primary";
        const cancelledCount = job.cancelledRetryKeys?.length || job.counts?.cancelled || 0;
        restore.textContent = `继续（${cancelledCount}）`;
        restore.addEventListener("click", async () => {
          restore.disabled = true;
          try {
            const response = await chrome.runtime.sendMessage({
              type: "RESTORE_CANCELLED_JOB",
              jobId: job.id
            });
            if (!response?.ok) throw new Error(response?.error || "操作失败");
            showStatus(job.folderName, "正在继续，已完成文件不会重复下载");
            await refreshQueueState();
          } catch (error) {
            restore.disabled = false;
            showStatus(job.folderName, queueUserFacingError(error));
          }
        });
        actions.appendChild(restore);
      }
      if (!isJobActive(job.status)) {
        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = "popo-queue-action";
        dismiss.textContent = "移除";
        dismiss.addEventListener("click", () => {
          const confirmation = document.createElement("div");
          confirmation.className = "popo-remove-confirmation";
          confirmation.setAttribute("role", "group");
          confirmation.setAttribute("aria-label", "确认移除任务");

          const note = document.createElement("p");
          note.className = "popo-remove-note";
          note.textContent = "只从列表移除，不会删除已下载文件。";

          const confirmationActions = document.createElement("div");
          confirmationActions.className = "popo-queue-actions";
          const confirmDismiss = document.createElement("button");
          confirmDismiss.type = "button";
          confirmDismiss.className = "popo-queue-action";
          confirmDismiss.dataset.kind = "danger";
          confirmDismiss.textContent = "确认移除";
          const back = document.createElement("button");
          back.type = "button";
          back.className = "popo-queue-action";
          back.textContent = "返回";

          back.addEventListener("click", () => {
            confirmation.replaceWith(actions);
          });
          confirmDismiss.addEventListener("click", async () => {
            confirmDismiss.disabled = true;
            back.disabled = true;
            try {
              const response = await chrome.runtime.sendMessage({
                type: "DISMISS_JOB",
                jobId: job.id
              });
              if (!response?.ok) throw new Error(response?.error || "操作失败");
              showStatus(job.folderName, "任务已移除，已下载文件仍然保留");
              await refreshQueueState();
            } catch (error) {
              confirmDismiss.disabled = false;
              back.disabled = false;
              showStatus(job.folderName, queueUserFacingError(error));
            }
          });

          confirmationActions.append(confirmDismiss, back);
          confirmation.append(note, confirmationActions);
          actions.replaceWith(confirmation);
        });
        actions.appendChild(dismiss);
      }
      if (actions.childElementCount) card.appendChild(actions);
      return card;
    }));
    syncFolderButtonsWithQueue();
  }

  async function refreshQueueState() {
    if (!IS_TOP_FRAME) return;
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
      if (response?.ok) {
        const state = response.state || {};
        const job = (state.jobs || []).find((candidate) => candidate.id === state.activeJobId);
        const needsWorkerRecovery = job && state.triggerMode === "folder_button" &&
          state.workerFrameId == null &&
          ["waiting_worker", "scanning", "awaiting_confirmation", "starting", "downloading", "paused", "draining", "draining_paused"].includes(state.mode);
        if (needsWorkerRecovery && Date.now() - workerRecoveryRequestedAt > 5000) {
          void restoreSourcePageSession();
        }
      }
    } catch {
      // Extension reloads can briefly interrupt the content-script connection.
    }
  }

  function startQueueStatePolling() {
    if (!IS_TOP_FRAME || queueRefreshTimer) return;
    void refreshQueueState();
    queueRefreshTimer = setInterval(refreshQueueState, 1000);
  }

  async function restoreSourcePageSession() {
    if (!IS_TOP_FRAME) return;
    workerRecoveryRequestedAt = Date.now();
    try {
      const response = await chrome.runtime.sendMessage({
        type: "SOURCE_PAGE_READY",
        url: location.href
      });
      if (!response?.ok) return;
      if (response.needsWorker) {
        createHiddenWorkerFrame(response.workerUrl || location.href, true);
      }
    } catch {
      // Extension reloads can briefly interrupt the background connection.
    }
  }

  async function handleStableDownloadClick(button, folderItem) {
    const folderName = folderItem.name;
    button.disabled = true;
    button.dataset.state = "scanning";
    button.textContent = "…";
    showStatus(folderName, "正在添加下载…");
    try {
      const response = await chrome.runtime.sendMessage({
        type: "START_FOLDER_SCAN",
        folderName,
        folderItemIndex: folderItem.itemIndex,
        parentUrl: location.href
      });
      if (!response?.ok) throw new Error(response?.error || "无法开始扫描");
      button.disabled = false;
      button.dataset.state = response.job?.status || "queued";
      button.textContent = response.job?.status === "queued" ? "✓" : "…";
      if (response.needsWorker) createHiddenWorkerFrame(location.href);
      const position = response.queuePosition || 0;
      const message = response.duplicate
        ? position > 0
          ? `已添加下载，排队中（第 ${position} 位）`
          : "该文件夹已经在处理中"
        : position > 0
          ? `已添加下载，排队中（第 ${position} 位）`
          : "已添加下载，正在检查文件数量";
      showStatus(folderName, message);
      await refreshQueueState();
    } catch (error) {
      resetFolderButtons(folderName);
      showStatus(folderName, String(error).replace(/^Error:\s*/, ""));
    }
  }

  function createHiddenWorkerFrame(url, force = false) {
    if (!IS_TOP_FRAME) return;
    const existing = document.getElementById(WORKER_FRAME_ID);
    if (existing && !force) return existing;
    existing?.remove();
    const frame = document.createElement("iframe");
    frame.id = WORKER_FRAME_ID;
    frame.src = url;
    frame.title = "POPO 稳定下载后台工作区";
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = [
      "position:fixed",
      "left:-20000px",
      "top:0",
      "width:1280px",
      "height:900px",
      "border:0",
      "opacity:0",
      "pointer-events:none",
      "z-index:-1"
    ].join(";");
    document.documentElement.appendChild(frame);
    return frame;
  }

  function removeHiddenWorkerFrame() {
    if (!IS_TOP_FRAME) return;
    document.getElementById(WORKER_FRAME_ID)?.remove();
  }

  function installFolderButtons() {
    ensureInjectedStyles();
    for (const row of document.querySelectorAll(SELECTORS.row)) {
      const item = parseRow(row);
      if (!item || item.type !== "folder") {
        row.querySelector(`.${BUTTON_CLASS}`)?.remove();
        continue;
      }
      const actions = row.querySelector('[class*="listMore"]');
      if (!actions) continue;
      let button = actions.querySelector(`.${BUTTON_CLASS}`);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = BUTTON_CLASS;
        button.dataset.state = "idle";
        setTextIfChanged(button, "");
        button.title = "稳定下载此文件夹";
        button.setAttribute("aria-label", "稳定下载此文件夹");
        button.addEventListener("mousedown", (event) => event.stopPropagation());
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const currentRow = button.closest(SELECTORS.row);
          const currentItem = currentRow ? parseRow(currentRow) : null;
          if (!currentItem || currentItem.type !== "folder") {
            resetFolderButtons();
            showStatus("POPO 稳定下载", "这一行已经发生变化，请重新点击当前文件夹的下载按钮");
            return;
          }
          button.dataset.folderName = currentItem.name;
          void handleStableDownloadClick(button, currentItem);
        });
        actions.insertBefore(button, actions.lastElementChild);
      }
      button.dataset.folderName = item.name;
      applyQueueStateToButton(button, item);
    }
  }

  let buttonInstallQueued = false;
  function scheduleFolderButtonInstall() {
    if (buttonInstallQueued) return;
    buttonInstallQueued = true;
    queueMicrotask(() => {
      buttonInstallQueued = false;
      installFolderButtons();
      installProjectCount();
    });
  }

  function startFolderButtonObserver() {
    if (!document.documentElement) return;
    scheduleFolderButtonInstall();
    const observer = new MutationObserver((mutations) => {
      if (mutations.some(mutationNeedsFolderButtonInstall)) scheduleFolderButtonInstall();
    });
    observer.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  function currentDirectoryName() {
    const title = normalizeText(document.title);
    if (title && title !== "POPO") return title;
    const candidates = Array.from(document.querySelectorAll('[class*="titleInput"], [class*="breadcrumb"]'))
      .map((element) => normalizeText(element.textContent))
      .filter(Boolean);
    return candidates[candidates.length - 1] || "POPO目录";
  }

  async function waitForDirectory(timeoutMs) {
    return waitUntil(() => {
      if (!/\/pageDetail\/[a-z0-9]+/i.test(location.href)) return null;
      return currentDirectoryScroller();
    }, timeoutMs);
  }

  function hasExplicitEmptyState() {
    const candidates = Array.from(document.querySelectorAll(
      '[class*="empty"], [class*="Empty"], [data-testid*="empty"], [data-test-id*="empty"]'
    )).slice(0, 30);
    return candidates.some((element) => {
      const text = normalizeText(element.textContent);
      return element.offsetParent !== null && /暂无|空文件夹|没有文件|无内容|empty/i.test(text);
    });
  }

  async function waitForDirectoryItems(scroller, timeoutMs) {
    return waitUntil(() => {
      const activeScroller = currentDirectoryScroller() || scroller;
      const rows = activeScroller?.querySelectorAll(SELECTORS.row) || [];
      if (rows.length > 0) {
        return { empty: false, initialRowCount: rows.length, scroller: activeScroller };
      }
      if (hasExplicitEmptyState()) return { empty: true, initialRowCount: 0 };
      if (!activeScroller?.isConnected) return null;
      return null;
    }, timeoutMs, 200);
  }

  async function scanDirectory(timeoutMs) {
    let scroller = await waitForDirectory(timeoutMs);
    const ready = await waitForDirectoryItems(scroller, timeoutMs);
    if (ready.empty) {
      return {
        directoryName: currentDirectoryName(),
        url: location.href,
        diagnostics: {
          explicitEmpty: true,
          initialRowCount: 0,
          renderedItemCount: 0,
          expectedItemCount: 0,
          countVerified: true
        },
        items: []
      };
    }
    scroller = ready.scroller || scroller;
    moveScroller(scroller, 0);
    await delay(120);
    const expectedItemCountAtStart = currentVirtualListItemCount();

    const items = new Map();
    let stableBottomRounds = 0;
    let previousSignature = "";

    for (let round = 0; round < 300; round += 1) {
      const replacement = currentDirectoryScroller();
      if (replacement && (!scroller.isConnected || replacement !== scroller)) scroller = replacement;
      for (const { item } of renderedEntries(scroller)) {
        items.set(`${item.type}\u0000${item.itemIndex}\u0000${item.name}`, item);
      }

      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const atBottom = scroller.scrollTop >= maxTop - 2;
      const signature = `${items.size}:${scroller.scrollTop}:${scroller.scrollHeight}`;
      stableBottomRounds = atBottom && signature === previousSignature ? stableBottomRounds + 1 : 0;
      if (stableBottomRounds >= 2) break;
      previousSignature = signature;

      const step = Math.max(240, Math.floor(scroller.clientHeight * 0.78));
      moveScroller(scroller, Math.min(maxTop, scroller.scrollTop + step));
      await delay(180);
    }

    if (items.size === 0) {
      throw new Error(
        `目录已出现 ${ready.initialRowCount} 行，但扫描结果为 0；拒绝把页面误判为空文件夹`
      );
    }

    moveScroller(scroller, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
    await delay(350);
    for (const { item } of renderedEntries(scroller)) {
      items.set(`${item.type}\u0000${item.itemIndex}\u0000${item.name}`, item);
    }
    const expectedItemCountAtEnd = currentVirtualListItemCount();
    const expectedItemCount = Number.isInteger(expectedItemCountAtEnd)
      ? expectedItemCountAtEnd
      : Number.isInteger(expectedItemCountAtStart)
        ? expectedItemCountAtStart
        : null;

    return {
      directoryName: currentDirectoryName(),
      url: location.href,
      diagnostics: {
        explicitEmpty: false,
        initialRowCount: ready.initialRowCount,
        renderedItemCount: items.size,
        expectedItemCount,
        countVerified: expectedItemCount == null ? null : expectedItemCount === items.size,
        expectedItemCountAtStart,
        expectedItemCountAtEnd,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight
      },
      items: Array.from(items.values())
    };
  }

  async function findItem(name, expectedType, itemIndex, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let scroller = await waitForDirectory(timeoutMs);
    const ready = await waitForDirectoryItems(scroller, Math.max(1000, deadline - Date.now()));
    if (ready.empty) {
      return { entry: null, diagnostics: { explicitEmpty: true, seenItems: [] } };
    }
    scroller = ready.scroller || scroller;
    moveScroller(scroller, 0);
    await delay(180);
    const minimumSearchUntil = Date.now() + Math.min(1600, Math.max(800, timeoutMs * 0.2));
    let stableBottomRounds = 0;
    let previousSignature = "";
    let bottomNudged = false;
    const seenItems = new Map();

    while (Date.now() < deadline) {
      const replacement = currentDirectoryScroller();
      if (replacement && (!scroller.isConnected || replacement !== scroller)) scroller = replacement;
      const entries = renderedEntries(scroller);
      for (const { item } of entries) {
        seenItems.set(`${item.type}\u0000${item.itemIndex}\u0000${item.name}`, item);
      }
      const selected = selectVirtualListMatch(entries, name, expectedType, itemIndex);
      if (selected.entry) {
        return {
          entry: selected.entry,
          diagnostics: {
            matchedBy: selected.matchedBy,
            seenItems: Array.from(seenItems.values())
          }
        };
      }
      if (selected.ambiguous && (itemIndex == null || itemIndex === "")) {
        const sameNameCount = entries.filter(({ item }) => item.name === name).length;
        throw new Error(`同目录存在 ${sameNameCount} 个同名项目，且没有可用的行标识：${name}`);
      }

      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const atBottom = scroller.scrollTop >= maxTop - 2;
      const signature = [
        scroller.scrollTop,
        scroller.scrollHeight,
        scroller.clientHeight,
        entries.map(({ item }) => `${item.itemIndex}:${item.name}`).join("|")
      ].join(":");
      stableBottomRounds = atBottom && signature === previousSignature
        ? stableBottomRounds + 1
        : 0;
      previousSignature = signature;
      if (Date.now() >= minimumSearchUntil && stableBottomRounds >= 8) break;

      if (!atBottom) {
        moveScroller(scroller, Math.min(
          maxTop,
          scroller.scrollTop + Math.max(240, Math.floor(scroller.clientHeight * 0.8))
        ));
      } else if (!bottomNudged && stableBottomRounds === 2 && maxTop > 0) {
        // Virtuoso occasionally leaves its last overscan window stale after a
        // quick off-screen navigation. Nudge it once, then return to the real
        // bottom on the following round so the final rows are rendered again.
        bottomNudged = true;
        moveScroller(scroller, Math.max(0, maxTop - Math.min(24, maxTop)));
      } else {
        moveScroller(scroller, maxTop);
      }
      await delay(220);
    }
    moveScroller(scroller, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
    await delay(500);
    const finalEntries = renderedEntries(scroller);
    for (const { item } of finalEntries) {
      seenItems.set(`${item.type}\u0000${item.itemIndex}\u0000${item.name}`, item);
    }
    const finalMatch = selectVirtualListMatch(finalEntries, name, expectedType, itemIndex);
    return {
      entry: finalMatch.entry || null,
      diagnostics: {
        matchedBy: finalMatch.matchedBy || "",
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        seenItems: Array.from(seenItems.values())
      }
    };
  }

  async function prepareOpenItem(name, expectedType, itemIndex, timeoutMs) {
    const search = await findItem(name, expectedType, itemIndex, timeoutMs);
    const found = search.entry;
    if (!found) return { clicked: false, reason: "not_found", diagnostics: search.diagnostics };
    const nameElement = found.row.querySelector(SELECTORS.name);
    if (!nameElement || normalizeText(nameElement.textContent) !== name) {
      return { clicked: false, reason: "stale_row" };
    }

    const beforeUrl = location.href;
    setTimeout(() => {
      const freshName = normalizeText(nameElement.textContent);
      const freshType = found.row.querySelector(SELECTORS.folderIcon) ? "folder" : "file";
      if (freshName === name && freshType === expectedType && nameElement.isConnected) nameElement.click();
    }, 60);
    return { clicked: true, beforeUrl };
  }

  function previewInfo() {
    const titleCandidates = [
      normalizeText(document.title),
      ...Array.from(document.querySelectorAll(
        '[class*="titleInput"], [class*="titleText"], [class*="fileName"], [class*="name"]'
      )).flatMap((element) => [
        normalizeText(element.value),
        normalizeText(element.textContent),
        normalizeText(element.getAttribute("title")),
        normalizeText(element.getAttribute("aria-label"))
      ])
    ].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index);
    const media = Array.from(document.querySelectorAll(
      [
        "video",
        "audio",
        "source",
        'img[src*="s3v2-drive-"]',
        'img[src*="response-content-disposition"]',
        'img[class*="image___"]',
        'img[class*="viewer-"]',
        'img[class*="preview"]',
        '[class*="file-preview"] img',
        '[class*="imageViewer"] img'
      ].join(",")
    ))
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        src: element.currentSrc || element.src || element.getAttribute("src") || "",
        readyState: typeof element.readyState === "number" ? element.readyState : null
      }))
      .filter((entry) => /^https?:\/\//i.test(entry.src));
    const downloadButtons = Array.from(document.querySelectorAll(SELECTORS.downloadButton))
      .filter((button) => normalizeText(button.textContent) === "下载");
    const loadingCount = document.querySelectorAll(
      '[class*="loading"], [class*="spin"], [class*="skeleton"]'
    ).length;
    const previewElementCount = document.querySelectorAll(
      'video, audio, iframe, [class*="file-preview"], [class*="previewContainer"], [class*="imageViewer"]'
    ).length;
    return {
      url: location.href,
      pageId: location.pathname.match(/\/pageDetail\/([a-z0-9]+)/i)?.[1] || "",
      titleCandidates,
      media,
      downloadButtonCount: downloadButtons.length,
      loadingCount,
      previewElementCount
    };
  }

  function requestPageApi(path, queryParams, timeoutMs) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeout = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("POPO 接口请求超时"));
      }, timeoutMs);
      const onMessage = (event) => {
        if (event.source !== window || event.data?.source !== API_RESPONSE_SOURCE ||
            event.data?.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        resolve(event.data);
      };
      window.addEventListener("message", onMessage);
      const query = new URLSearchParams(queryParams);
      window.postMessage({
        source: API_REQUEST_SOURCE,
        requestId,
        path: `${path}?${query.toString()}`
      }, location.origin);
    });
  }

  function requestDirectDownload(teamSpaceId, pageId, timeoutMs) {
    return requestPageApi(
      "/api/bs-team-space/web/v1/page/download",
      { teamSpaceId, pageId },
      timeoutMs
    );
  }

  function resolveTeamSpaceId(teamSpaceKey, timeoutMs) {
    return requestPageApi(
      "/api/bs-team-space/web/v1/teamSpace/id",
      { teamSpaceKey },
      timeoutMs
    );
  }

  function cleanPageState() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const scroller = currentDirectoryScroller();
    if (scroller) moveScroller(scroller, 0);
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      switch (message.type) {
        case "PING":
          return { ok: true, url: location.href, result: { url: location.href } };
        case "SCAN_DIRECTORY":
          return { ok: true, result: await scanDirectory(message.timeoutMs) };
        case "OPEN_ITEM":
          return {
            ok: true,
            result: await prepareOpenItem(
              message.name,
              message.expectedType,
              message.itemIndex,
              message.timeoutMs
            )
          };
        case "GET_PREVIEW_INFO":
          return { ok: true, result: previewInfo() };
        case "REQUEST_DIRECT_DOWNLOAD":
          return {
            ok: true,
            result: await requestDirectDownload(message.teamSpaceId, message.pageId, message.timeoutMs)
          };
        case "RESOLVE_TEAM_SPACE_ID":
          return {
            ok: true,
            result: await resolveTeamSpaceId(message.teamSpaceKey, message.timeoutMs)
          };
        case "CLEAN_STATE":
          return { ok: true, result: cleanPageState() };
        case "NAVIGATE_WORKER":
          if (IS_TOP_FRAME) return { ok: false, error: "顶层页面不能作为隐藏工作框架" };
          setTimeout(() => {
            if (message.forceReload && location.href === message.url) location.reload();
            else location.href = message.url;
          }, 50);
          return { ok: true, navigating: true };
        case "REMOVE_WORKER_FRAME":
          removeHiddenWorkerFrame();
          return { ok: true };
        case "ENSURE_WORKER_FRAME":
          if (!IS_TOP_FRAME) return { ok: false, error: "只能在顶层页面创建隐藏工作区" };
          createHiddenWorkerFrame(message.url || location.href, Boolean(message.force));
          return { ok: true };
        case "FOLDER_TASK_STATUS":
          return { ok: true };
        case "FOLDER_TASK_FINISHED":
          return { ok: true };
        case "FOLDER_TASK_CANCELLED":
          return { ok: true };
        case "FOLDER_TASK_ERROR":
          return { ok: true };
        default:
          return { ok: false, error: `未知内容脚本命令：${message.type}` };
      }
    })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  });

  if (IS_TOP_FRAME) {
    document.addEventListener(ENSURE_WORKER_EVENT, (event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      createHiddenWorkerFrame(detail?.url || location.href);
    });
    startQueueStatePolling();
    void restoreSourcePageSession();
  } else {
    void chrome.runtime.sendMessage({
      type: "REGISTER_WORKER_FRAME",
      url: location.href
    }).catch(() => {});
  }
})();
