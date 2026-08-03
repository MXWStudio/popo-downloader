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
  const MODAL_ID = "popo-stable-download-modal";
  const STATUS_ID = "popo-stable-download-status";
  const WORKER_FRAME_ID = "popo-stable-download-worker-frame";
  const IS_TOP_FRAME = window.top === window;
  const { selectVirtualListMatch } = globalThis.PopoCore;

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

  function ensureInjectedStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${BUTTON_CLASS} {
        box-sizing: border-box !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        flex: 0 0 28px !important;
        width: 28px !important;
        height: 28px !important;
        margin: 0 3px !important;
        padding: 0 !important;
        border: 1px solid #76aaf4 !important;
        border-radius: 6px !important;
        color: #1268e8 !important;
        background: #f4f8ff !important;
        font: 700 17px/1 "Segoe UI", sans-serif !important;
        cursor: pointer !important;
        box-shadow: none !important;
      }
      .${BUTTON_CLASS}:hover {
        color: #fff !important;
        border-color: #1268e8 !important;
        background: #1268e8 !important;
      }
      .${BUTTON_CLASS}[data-state="scanning"],
      .${BUTTON_CLASS}:disabled {
        cursor: wait !important;
        opacity: .65 !important;
      }
      #${MODAL_ID} {
        all: initial;
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(14, 25, 39, .42);
        font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      #${MODAL_ID} * { box-sizing: border-box; }
      #${MODAL_ID} .popo-stable-dialog {
        width: min(420px, calc(100vw - 40px));
        padding: 24px;
        border: 1px solid #dbe4ef;
        border-radius: 14px;
        color: #17212b;
        background: #fff;
        box-shadow: 0 18px 60px rgba(16, 40, 72, .24);
      }
      #${MODAL_ID} h2 {
        margin: 0 0 10px;
        font-size: 20px;
        line-height: 1.35;
      }
      #${MODAL_ID} p {
        margin: 7px 0;
        color: #526170;
        font-size: 14px;
        line-height: 1.55;
      }
      #${MODAL_ID} .popo-stable-folder {
        overflow: hidden;
        margin: 14px 0;
        padding: 10px 12px;
        border-radius: 8px;
        color: #263444;
        background: #f3f7fc;
        font-weight: 650;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${MODAL_ID} .popo-stable-permission-warning {
        margin: 12px 0;
        padding: 10px 12px;
        border: 1px solid #f0c36c;
        border-radius: 8px;
        color: #6d4700;
        background: #fff8e7;
        font-weight: 650;
      }
      #${MODAL_ID} .popo-stable-actions {
        display: flex;
        justify-content: flex-end;
        gap: 9px;
        margin-top: 18px;
      }
      #${MODAL_ID} button {
        min-width: 88px;
        height: 38px;
        padding: 0 16px;
        border: 1px solid #d6dee8;
        border-radius: 8px;
        color: #354152;
        background: #fff;
        font: 650 14px/1 "Segoe UI", "Microsoft YaHei", sans-serif;
        cursor: pointer;
      }
      #${MODAL_ID} button[data-primary="true"] {
        color: #fff;
        border-color: #1268e8;
        background: #1268e8;
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
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function resetFolderButtons(folderName) {
    for (const button of document.querySelectorAll(`.${BUTTON_CLASS}`)) {
      if (!folderName || button.dataset.folderName === folderName) {
        button.disabled = false;
        button.dataset.state = "idle";
        button.textContent = "⇩";
      }
    }
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
    status.querySelector("span").textContent = message || "正在准备…";
  }

  function hideStatus() {
    document.getElementById(STATUS_ID)?.remove();
  }

  function removeConfirmation() {
    document.getElementById(MODAL_ID)?.remove();
  }

  function showFolderConfirmation({
    folderName,
    fileCount,
    folderCount,
    scanFailureCount,
    scanFailureDetail
  }) {
    ensureInjectedStyles();
    removeConfirmation();
    const overlay = document.createElement("div");
    overlay.id = MODAL_ID;
    const dialog = document.createElement("section");
    dialog.className = "popo-stable-dialog";
    const heading = document.createElement("h2");
    heading.textContent = fileCount > 0 ? `发现 ${fileCount} 个文件，确认下载？` : "没有发现可下载文件";
    const description = document.createElement("p");
    description.textContent = fileCount > 0
      ? `将逐个下载全部文件，不使用 POPO 服务器打包。包含 ${folderCount || 0} 个子文件夹。`
      : "该文件夹可能为空，或目录读取失败。";
    const folder = document.createElement("div");
    folder.className = "popo-stable-folder";
    folder.textContent = folderName;
    dialog.append(heading, description, folder);

    const engineNote = document.createElement("p");
    engineNote.className = "popo-stable-permission-warning";
    engineNote.textContent = "文件将交给本机 Gopeed 下载；下载期间请保持 Gopeed 运行。";
    dialog.appendChild(engineNote);

    if (scanFailureCount > 0) {
      const warning = document.createElement("p");
      warning.textContent = `注意：有 ${scanFailureCount} 个目录读取失败，确认后只下载已经成功读取的文件。`;
      dialog.appendChild(warning);
      if (scanFailureDetail) {
        const detail = document.createElement("p");
        detail.textContent = `失败详情：${String(scanFailureDetail).replace(/^Error:\s*/, "")}`;
        dialog.appendChild(detail);
      }
    }

    const actions = document.createElement("div");
    actions.className = "popo-stable-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = fileCount > 0 ? "取消" : "关闭";
    cancel.addEventListener("click", async () => {
      removeConfirmation();
      hideStatus();
      resetFolderButtons(folderName);
      try {
        await chrome.runtime.sendMessage({ type: "CANCEL_FOLDER_TASK" });
      } catch {
        // The background may already have reset after an empty scan.
      }
    });
    actions.appendChild(cancel);

    if (fileCount > 0) {
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.dataset.primary = "true";
      confirm.textContent = "确认下载";
      confirm.addEventListener("click", async () => {
        confirm.disabled = true;
        cancel.disabled = true;
        try {
          const response = await chrome.runtime.sendMessage({ type: "CONFIRM_FOLDER_DOWNLOAD" });
          if (!response?.ok) throw new Error(response?.error || "无法启动下载");
          removeConfirmation();
          showStatus(folderName, `开始下载 0 / ${fileCount}`);
        } catch (error) {
          confirm.disabled = false;
          cancel.disabled = false;
          showStatus(folderName, String(error).replace(/^Error:\s*/, ""));
        }
      });
      actions.appendChild(confirm);
    }
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.documentElement.appendChild(overlay);
  }

  async function handleStableDownloadClick(button, folderItem) {
    const folderName = folderItem.name;
    button.disabled = true;
    button.dataset.state = "scanning";
    button.textContent = "…";
    showStatus(folderName, "正在读取这个文件夹的全部文件…");
    try {
      const response = await chrome.runtime.sendMessage({
        type: "START_FOLDER_SCAN",
        folderName,
        folderItemIndex: folderItem.itemIndex,
        parentUrl: location.href
      });
      if (!response?.ok) throw new Error(response?.error || "无法开始扫描");
      createHiddenWorkerFrame(location.href);
    } catch (error) {
      resetFolderButtons(folderName);
      showStatus(folderName, String(error).replace(/^Error:\s*/, ""));
    }
  }

  function createHiddenWorkerFrame(url) {
    if (!IS_TOP_FRAME) return;
    document.getElementById(WORKER_FRAME_ID)?.remove();
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
        button.textContent = "⇩";
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
    }
  }

  let buttonInstallQueued = false;
  function scheduleFolderButtonInstall() {
    if (buttonInstallQueued) return;
    buttonInstallQueued = true;
    queueMicrotask(() => {
      buttonInstallQueued = false;
      installFolderButtons();
    });
  }

  function startFolderButtonObserver() {
    if (!document.documentElement) return;
    scheduleFolderButtonInstall();
    const observer = new MutationObserver(scheduleFolderButtonInstall);
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
          renderedItemCount: 0
        },
        items: []
      };
    }
    scroller = ready.scroller || scroller;
    moveScroller(scroller, 0);
    await delay(120);

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

    return {
      directoryName: currentDirectoryName(),
      url: location.href,
      diagnostics: {
        explicitEmpty: false,
        initialRowCount: ready.initialRowCount,
        renderedItemCount: items.size,
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

  function requestDirectDownload(teamSpaceId, pageId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeout = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("单文件下载接口超时"));
      }, timeoutMs);
      const onMessage = (event) => {
        if (event.source !== window || event.data?.source !== API_RESPONSE_SOURCE ||
            event.data?.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        resolve(event.data);
      };
      window.addEventListener("message", onMessage);
      const query = new URLSearchParams({ teamSpaceId, pageId });
      window.postMessage({
        source: API_REQUEST_SOURCE,
        requestId,
        path: `/api/bs-team-space/web/v1/page/download?${query.toString()}`
      }, location.origin);
    });
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
        case "SHOW_FOLDER_CONFIRMATION":
          showFolderConfirmation(message);
          return { ok: true };
        case "FOLDER_TASK_STATUS":
          showStatus(message.folderName, message.message);
          return { ok: true };
        case "FOLDER_TASK_FINISHED":
          showStatus(
            message.folderName,
            `下载结束：成功 ${message.successCount || 0}，失败 ${message.failedCount || 0}`
          );
          resetFolderButtons(message.folderName);
          return { ok: true };
        case "FOLDER_TASK_CANCELLED":
          removeConfirmation();
          hideStatus();
          resetFolderButtons(message.folderName);
          return { ok: true };
        case "FOLDER_TASK_ERROR":
          removeConfirmation();
          showStatus(message.folderName, message.message || "任务失败");
          resetFolderButtons(message.folderName);
          return { ok: true };
        default:
          return { ok: false, error: `未知内容脚本命令：${message.type}` };
      }
    })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  });

  if (IS_TOP_FRAME) {
    startFolderButtonObserver();
  } else {
    void chrome.runtime.sendMessage({
      type: "REGISTER_WORKER_FRAME",
      url: location.href
    }).catch(() => {});
  }
})();
