import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import {
  attentionJobs,
  failedRetryCount,
  findMatchingFolderJob,
  inferVirtualListItemCount,
  jobDetail,
  jobIsActive,
  jobName,
  jobProgress,
  liveJobs,
  MODE_LABELS,
  nextServiceNotice,
  notificationForTransition,
  recoverableCount,
  summarizeLiveJobs,
  userFacingError,
  type QueueJob,
  type QueueState,
  type ServiceNoticeTracker,
  type GopeedConnection,
  type UiNotification
} from "./ui-model";

const SELECTORS = {
  scroller: '[data-test-id="virtuoso-scroller"], [data-virtuoso-scroller="true"]',
  row: "[data-item-index]",
  name: '[class*="topName"]',
  folderIcon: '[class*="drive-icon-folder"]',
  actions: '[class*="listMore"]'
} as const;

const ROOT_ID = "popo-react-page-root";
const GLOBAL_STYLE_ID = "popo-react-page-global-style";
const PROJECT_COUNT_ID = "popo-stable-project-count";
const DOWNLOAD_ANCHOR_CLASS = "popo-react-download-anchor";
const DOWNLOAD_BUTTON_CLASS = "popo-stable-download-button";
const OWNED_SELECTOR = [
  "#" + ROOT_ID,
  "#" + GLOBAL_STYLE_ID,
  "#" + PROJECT_COUNT_ID,
  "." + DOWNLOAD_ANCHOR_CLASS,
  "." + DOWNLOAD_BUTTON_CLASS
].join(",");
const ENSURE_WORKER_EVENT = "popo-stable-download:ensure-worker";
const PAGE_DETAIL_PATTERN = /\/pageDetail\/[a-z0-9]+/i;

interface FolderItem {
  name: string;
  itemIndex: string;
  parentUrl: string;
}

interface FolderPortalTarget {
  key: string;
  target: HTMLElement;
  item: FolderItem;
}

interface PageSnapshot {
  url: string;
  rawCount: number | null;
  countTarget: HTMLElement | null;
  folderTargets: FolderPortalTarget[];
}

interface ToastRecord extends UiNotification {
  receivedAt: number;
  mergedCount: number;
}

interface PageUiGlobal {
  __POPO_REACT_PAGE_CLEANUP__?: (() => void) | undefined;
}

function normalizeText(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseFolderRow(row: Element): FolderItem | null {
  const name = normalizeText(row.querySelector(SELECTORS.name)?.textContent);
  if (!name || !row.querySelector(SELECTORS.folderIcon)) return null;
  const itemIndex = String(
    row.getAttribute("data-item-index") ||
    row.getAttribute("data-index") ||
    ""
  );
  if (!itemIndex) return null;
  return { name, itemIndex, parentUrl: location.href };
}

function directoryScrollers(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(SELECTORS.scroller))
    .filter((scroller) => scroller.isConnected)
    .sort((left, right) => {
      const rowDifference =
        right.querySelectorAll(SELECTORS.row).length -
        left.querySelectorAll(SELECTORS.row).length;
      if (rowDifference) return rowDifference;
      return (right.scrollHeight - right.clientHeight) -
        (left.scrollHeight - left.clientHeight);
    });
}

function currentDirectoryScroller(): HTMLElement | null {
  return directoryScrollers()[0] || null;
}

function hasExplicitEmptyState(): boolean {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(
    '[class*="empty"], [class*="Empty"], [data-testid*="empty"], [data-test-id*="empty"]'
  )).slice(0, 30);
  return candidates.some((element) => {
    const text = normalizeText(element.textContent);
    return element.offsetParent !== null && /暂无|空文件夹|没有文件|无内容|empty/i.test(text);
  });
}

function currentVirtualListItemCount(): number | null {
  if (hasExplicitEmptyState()) return 0;
  const scroller = currentDirectoryScroller();
  if (!scroller) return null;
  const rows = Array.from(scroller.querySelectorAll(SELECTORS.row));
  const itemList = scroller.querySelector<HTMLElement>('[data-test-id="virtuoso-item-list"]');
  if (!rows.length || !itemList) return null;
  return inferVirtualListItemCount({
    indices: rows.map((row) =>
      row.getAttribute("data-item-index") || row.getAttribute("data-index")
    ),
    knownSizes: rows.map((row) => row.getAttribute("data-known-size")),
    paddingBottom: getComputedStyle(itemList).paddingBottom,
    explicitEmpty: false
  });
}

function projectCountPlacement(): { host: HTMLElement; leftControl: HTMLElement } | null {
  const label = Array.from(document.querySelectorAll<HTMLElement>("span"))
    .find((element) => normalizeText(element.textContent) === "所有类型");
  const leftControl = label?.parentElement;
  const host = leftControl?.parentElement;
  if (!host || !leftControl || !host.contains(leftControl)) return null;
  return { host, leftControl };
}

function ensureProjectCountTarget(): HTMLElement | null {
  if (!PAGE_DETAIL_PATTERN.test(location.href)) {
    document.getElementById(PROJECT_COUNT_ID)?.remove();
    return null;
  }
  const placement = projectCountPlacement();
  if (!placement) return null;
  let target = document.getElementById(PROJECT_COUNT_ID);
  if (!target) {
    target = document.createElement("span");
    target.id = PROJECT_COUNT_ID;
  }
  target.dataset.popoReactOwned = "true";
  target.setAttribute("aria-live", "polite");
  if (
    target.parentElement !== placement.host ||
    target.previousElementSibling !== placement.leftControl
  ) {
    placement.host.insertBefore(target, placement.leftControl.nextSibling);
  }
  return target;
}

function ensureFolderTargets(): FolderPortalTarget[] {
  const activeAnchors = new Set<HTMLElement>();
  const targets: FolderPortalTarget[] = [];
  for (const row of document.querySelectorAll<HTMLElement>(SELECTORS.row)) {
    const item = parseFolderRow(row);
    const existing = row.querySelector<HTMLElement>("." + DOWNLOAD_ANCHOR_CLASS);
    if (!item) {
      existing?.remove();
      continue;
    }
    const actions = row.querySelector<HTMLElement>(SELECTORS.actions);
    if (!actions) {
      existing?.remove();
      continue;
    }
    let anchor = existing;
    if (!anchor) {
      anchor = document.createElement("span");
      anchor.className = DOWNLOAD_ANCHOR_CLASS;
    }
    anchor.dataset.popoReactOwned = "true";
    const nativeChildren = Array.from(actions.children)
      .filter((child) => child !== anchor && !child.matches("[data-popo-react-owned]"));
    const reference = nativeChildren.at(-1) || null;
    if (anchor.parentElement !== actions || anchor.nextElementSibling !== reference) {
      actions.insertBefore(anchor, reference);
    }
    const key = [item.parentUrl, item.itemIndex, item.name].join("\u0000");
    anchor.dataset.popoKey = key;
    activeAnchors.add(anchor);
    targets.push({ key, target: anchor, item });
  }
  for (const anchor of document.querySelectorAll<HTMLElement>("." + DOWNLOAD_ANCHOR_CLASS)) {
    if (!activeAnchors.has(anchor)) anchor.remove();
  }
  return targets;
}

function elementForNode(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
}

function isOwnedNode(node: Node): boolean {
  const element = elementForNode(node);
  if (!element) return false;
  return element.matches(OWNED_SELECTOR) || Boolean(element.closest(OWNED_SELECTOR));
}

function mutationNeedsReconcile(mutation: MutationRecord): boolean {
  if (isOwnedNode(mutation.target)) return false;
  const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
  return nodes.length === 0 || !nodes.every(isOwnedNode);
}

function createPageDomAdapter(onSnapshot: (snapshot: PageSnapshot) => void): () => void {
  let frame = 0;
  let disposed = false;

  const reconcile = () => {
    frame = 0;
    if (disposed) return;
    onSnapshot({
      url: location.href,
      rawCount: PAGE_DETAIL_PATTERN.test(location.href)
        ? currentVirtualListItemCount()
        : null,
      countTarget: ensureProjectCountTarget(),
      folderTargets: PAGE_DETAIL_PATTERN.test(location.href) ? ensureFolderTargets() : []
    });
  };

  const schedule = () => {
    if (disposed || frame) return;
    frame = requestAnimationFrame(reconcile);
  };

  const observer = new MutationObserver((mutations) => {
    if (mutations.some(mutationNeedsReconcile)) schedule();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-index", "data-item-index"],
    childList: true,
    characterData: true,
    subtree: true
  });
  const timer = window.setInterval(schedule, 350);
  window.addEventListener("popstate", schedule);
  window.addEventListener("hashchange", schedule);
  schedule();

  return () => {
    disposed = true;
    observer.disconnect();
    window.clearInterval(timer);
    window.removeEventListener("popstate", schedule);
    window.removeEventListener("hashchange", schedule);
    if (frame) cancelAnimationFrame(frame);
    document.getElementById(PROJECT_COUNT_ID)?.remove();
    for (const anchor of document.querySelectorAll("." + DOWNLOAD_ANCHOR_CLASS)) anchor.remove();
  };
}

function globalStyles(): string {
  const logoUrl = chrome.runtime.getURL("assets/popo-logo.svg");
  return [
    "." + DOWNLOAD_ANCHOR_CLASS + "{display:inline-flex!important;align-items:center!important;}",
    "." + DOWNLOAD_BUTTON_CLASS + "{box-sizing:border-box!important;position:relative!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;flex:0 0 28px!important;width:28px!important;height:28px!important;overflow:visible!important;margin:0 3px!important;padding:0!important;border:1px solid #b9cce5!important;border-radius:6px!important;color:#1268e8!important;background-color:#fff!important;background-position:center!important;background-repeat:no-repeat!important;background-size:24px 24px!important;font:700 17px/1 'Segoe UI',sans-serif!important;cursor:pointer!important;box-shadow:0 1px 3px rgba(24,61,106,.1)!important;color-scheme:light;}",
    "." + DOWNLOAD_BUTTON_CLASS + "[data-state='idle']{background-image:url('" + logoUrl + "')!important;}",
    "." + DOWNLOAD_BUTTON_CLASS + "[data-state='idle']::after{box-sizing:border-box!important;position:absolute!important;right:-2px!important;bottom:-2px!important;display:flex!important;align-items:center!important;justify-content:center!important;width:12px!important;height:12px!important;border:1.5px solid #fff!important;border-radius:999px!important;color:#fff!important;background:#1268e8!important;content:'↓'!important;font:700 9px/1 'Segoe UI',sans-serif!important;}",
    "." + DOWNLOAD_BUTTON_CLASS + ":not([data-state='idle']){background-image:none!important;}",
    "." + DOWNLOAD_BUTTON_CLASS + ":hover{border-color:#1268e8!important;background-color:#eaf3ff!important;box-shadow:0 2px 7px rgba(18,104,232,.22)!important;}",
    "." + DOWNLOAD_BUTTON_CLASS + "[data-state='scanning'],." + DOWNLOAD_BUTTON_CLASS + ":disabled{cursor:wait!important;opacity:.65!important;}",
    "#" + PROJECT_COUNT_ID + "{display:contents!important;}",
    ".popo-react-project-count{all:initial;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;min-width:72px;height:32px;margin-left:10px;margin-right:auto;padding:0 10px;border:1px solid #e0e6ee;border-radius:6px;color:#59697a;background:#fff;font:500 13px/1 'Segoe UI','Microsoft YaHei',sans-serif;white-space:nowrap;}",
    ".popo-react-project-count[data-state='loading']{color:#7b8795;}",
    "@media(prefers-color-scheme:dark){." + DOWNLOAD_BUTTON_CLASS + "{color:#89bdff!important;border-color:#4d5a6b!important;background-color:#222a35!important;box-shadow:0 1px 4px rgba(0,0,0,.28)!important;color-scheme:dark;}." + DOWNLOAD_BUTTON_CLASS + "[data-state='idle']::after{border-color:#222a35!important;background:#4d9aff!important;}.popo-react-project-count{color:#b6c2d0;border-color:#3b4655;background:#202832;}}",
    ":is(html,body).dark ." + DOWNLOAD_BUTTON_CLASS + ",:is(html,body)[data-theme='dark'] ." + DOWNLOAD_BUTTON_CLASS + ",:is(html,body)[data-color-mode='dark'] ." + DOWNLOAD_BUTTON_CLASS + "{color:#89bdff!important;border-color:#4d5a6b!important;background-color:#222a35!important;box-shadow:0 1px 4px rgba(0,0,0,.28)!important;color-scheme:dark;}",
    ":is(html,body).dark .popo-react-project-count,:is(html,body)[data-theme='dark'] .popo-react-project-count,:is(html,body)[data-color-mode='dark'] .popo-react-project-count{color:#b6c2d0;border-color:#3b4655;background:#202832;}"
  ].join("\n");
}

const SHADOW_STYLES = [
  ":host{all:initial;color-scheme:light;}",
  "*{box-sizing:border-box;}",
  "button{font:600 11px/1 'Segoe UI','Microsoft YaHei',sans-serif;}",
  ".popo-page-queue{position:fixed;left:20px;bottom:20px;z-index:2147483645;width:min(380px,calc(100vw - 40px));max-height:min(62vh,560px);overflow:hidden;border:1px solid #cfe0f7;border-radius:12px;color:#223247;background:rgba(255,255,255,.98);box-shadow:0 12px 38px rgba(24,61,106,.2);font-family:'Segoe UI','Microsoft YaHei',sans-serif;}",
  ".popo-page-queue[data-collapsed='true']{width:min(330px,calc(100vw - 40px));}",
  ".popo-page-queue-header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 13px;background:#f5f9ff;}",
  ".popo-page-queue[data-collapsed='false'] .popo-page-queue-header{border-bottom:1px solid #e1e9f2;}",
  ".popo-page-queue-heading{min-width:0;overflow:hidden;color:#1d2d42;font-size:13px;font-weight:700;text-overflow:ellipsis;white-space:nowrap;}",
  ".popo-page-queue-summary{color:#607086;font-size:11px;font-weight:500;}",
  ".popo-page-queue-toggle,.popo-page-action,.popo-toast-action{min-width:0;height:27px;padding:0 9px;border:1px solid #b9cce4;border-radius:6px;color:#1268e8;background:#fff;cursor:pointer;}",
  ".popo-page-queue-toggle:disabled,.popo-page-action:disabled,.popo-toast-action:disabled{cursor:wait;opacity:.6;}",
  ".popo-page-queue-body{max-height:min(52vh,470px);overflow:auto;padding:11px 13px 13px;}",
  ".popo-page-title-row{display:flex;align-items:center;justify-content:space-between;gap:10px;}",
  ".popo-page-job-name{overflow:hidden;color:#1d2d42;font-size:13px;font-weight:650;text-overflow:ellipsis;white-space:nowrap;}",
  ".popo-page-job-state{flex:none;color:#1268e8;font-size:11px;font-weight:650;}",
  ".popo-page-job-detail{margin-top:5px;color:#607086;font-size:11px;line-height:1.45;}",
  ".popo-page-queue-more{margin-top:7px;color:#607086;font-size:11px;line-height:1.45;}",
  ".popo-page-progress{overflow:hidden;height:6px;margin-top:8px;border-radius:999px;background:#dfe8f3;}",
  ".popo-page-progress i{display:block;width:0;height:100%;border-radius:inherit;background:linear-gradient(90deg,#1268e8,#0aa17a);transition:width .2s ease;}",
  ".popo-page-progress[data-indeterminate='true'] i{width:38%;animation:popo-react-progress 1.2s ease-in-out infinite alternate;}",
  "@keyframes popo-react-progress{from{transform:translateX(-25%)}to{transform:translateX(190%)}}",
  ".popo-page-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:6px;margin-top:9px;}",
  ".popo-page-action[data-kind='danger']{color:#a32626;border-color:#e3a5a5;background:#fff7f7;}",
  ".popo-page-confirm{margin-top:9px;padding:8px;border:1px solid #dfe5ec;border-radius:7px;background:#f7f9fc;}",
  ".popo-page-confirm p{margin:0;color:#59697a;font-size:11px;line-height:1.5;}",
  ".popo-toast-viewport{position:fixed;right:24px;bottom:24px;z-index:2147483646;display:grid;width:min(340px,calc(100vw - 48px));gap:8px;font-family:'Segoe UI','Microsoft YaHei',sans-serif;}",
  ".popo-toast{padding:13px 15px;border:1px solid #cfe0f7;border-radius:10px;color:#223247;background:rgba(255,255,255,.98);box-shadow:0 10px 35px rgba(24,61,106,.18);}",
  ".popo-toast[data-kind='error']{border-color:#e7b0b0;background:#fff8f8;}",
  ".popo-toast strong{display:block;overflow:hidden;font-size:13px;text-overflow:ellipsis;white-space:nowrap;}",
  ".popo-toast p{margin:4px 0 0;color:#607086;font-size:12px;line-height:1.45;}",
  ".popo-toast-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:8px;}",
  ".popo-toast-action[data-kind='quiet']{color:#607086;border-color:#d7dee7;}",
  "@media(prefers-color-scheme:dark){:host{color-scheme:dark}.popo-page-queue,.popo-toast{color:#e9eff8;border-color:#38485b;background:rgba(25,32,42,.98);box-shadow:0 12px 38px rgba(0,0,0,.42)}.popo-page-queue-header{background:#202a38}.popo-page-queue[data-collapsed='false'] .popo-page-queue-header{border-bottom-color:#33404f}.popo-page-queue-heading,.popo-page-job-name{color:#edf3fb}.popo-page-queue-summary,.popo-page-job-detail,.popo-page-queue-more,.popo-toast p,.popo-page-confirm p{color:#a4b0c0}.popo-page-job-state{color:#67aaff}.popo-page-queue-toggle,.popo-page-action,.popo-toast-action{color:#a8cdff;border-color:#465365;background:#202832}.popo-page-action[data-kind='danger']{color:#ffaaaa;border-color:#7c4a50;background:#382328}.popo-page-confirm{border-color:#38485b;background:#202832}.popo-toast[data-kind='error']{border-color:#7c4a50;background:#382328}}",
  "@media(max-width:620px){.popo-page-queue{left:12px;bottom:12px;width:calc(100vw - 24px)}.popo-toast-viewport{right:12px;bottom:12px;width:calc(100vw - 24px)}}"
].join("\n");

function cleanupLegacyUi(): void {
  document.getElementById("popo-stable-download-style")?.remove();
  document.getElementById("popo-stable-download-status")?.remove();
  document.getElementById("popo-stable-download-queue")?.remove();
  document.getElementById(PROJECT_COUNT_ID)?.remove();
  for (const button of document.querySelectorAll("." + DOWNLOAD_BUTTON_CLASS)) button.remove();
  for (const anchor of document.querySelectorAll("." + DOWNLOAD_ANCHOR_CLASS)) anchor.remove();
}

function removeRecreatedLegacyUi(): void {
  document.getElementById("popo-stable-download-style")?.remove();
  document.getElementById("popo-stable-download-status")?.remove();
  document.getElementById("popo-stable-download-queue")?.remove();
  for (const button of document.querySelectorAll<HTMLElement>(
    "." + DOWNLOAD_BUTTON_CLASS + ":not([data-popo-react-owned='true'])"
  )) {
    button.remove();
  }
}

function observeLegacyUi(): () => void {
  removeRecreatedLegacyUi();
  const observer = new MutationObserver((mutations) => {
    const legacyAdded = mutations.some((mutation) => Array.from(mutation.addedNodes).some((node) => {
      if (!(node instanceof Element)) return false;
      return node.matches(
        "#popo-stable-download-status,#popo-stable-download-queue,#popo-stable-download-style," +
        "." + DOWNLOAD_BUTTON_CLASS + ":not([data-popo-react-owned='true'])"
      ) || Boolean(node.querySelector(
        "#popo-stable-download-status,#popo-stable-download-queue,#popo-stable-download-style," +
        "." + DOWNLOAD_BUTTON_CLASS + ":not([data-popo-react-owned='true'])"
      ));
    }));
    if (legacyAdded) removeRecreatedLegacyUi();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  return () => observer.disconnect();
}

function ensureGlobalStyle(): HTMLStyleElement {
  document.getElementById(GLOBAL_STYLE_ID)?.remove();
  const style = document.createElement("style");
  style.id = GLOBAL_STYLE_ID;
  style.dataset.popoReactOwned = "true";
  style.textContent = globalStyles();
  (document.head || document.documentElement).appendChild(style);
  return style;
}

async function callExtension<T extends object = Record<string, never>>(
  message: Record<string, unknown>
): Promise<T> {
  const response = await chrome.runtime.sendMessage(message) as T & {
    ok?: boolean;
    error?: string;
  };
  if (!response?.ok) throw new Error(response?.error || "扩展后台未响应");
  return response;
}

function usePageSnapshot(): PageSnapshot {
  const [snapshot, setSnapshot] = useState<PageSnapshot>({
    url: location.href,
    rawCount: null,
    countTarget: null,
    folderTargets: []
  });
  useEffect(() => createPageDomAdapter((next) => {
    setSnapshot((current) => {
      const sameTargets = current.folderTargets.length === next.folderTargets.length &&
        current.folderTargets.every((entry, index) => {
          const candidate = next.folderTargets[index];
          return candidate?.key === entry.key && candidate.target === entry.target;
        });
      return current.url === next.url &&
        current.rawCount === next.rawCount &&
        current.countTarget === next.countTarget &&
        sameTargets
        ? current
        : next;
    });
  }), []);
  return snapshot;
}

function useStableCount(url: string, rawCount: number | null): number | null {
  const [confirmed, setConfirmed] = useState<number | null>(null);
  const tracker = useRef({ url: "", candidate: null as number | null, since: 0 });

  useEffect(() => {
    const now = Date.now();
    if (tracker.current.url !== url) {
      tracker.current = { url, candidate: null, since: now };
      setConfirmed(null);
    }
    if (!Number.isInteger(rawCount) || rawCount == null || rawCount < 0) {
      tracker.current.candidate = null;
      tracker.current.since = now;
      setConfirmed(null);
      return;
    }
    if (tracker.current.candidate !== rawCount) {
      tracker.current.candidate = rawCount;
      tracker.current.since = now;
      setConfirmed(null);
    }
    const candidateUrl = url;
    const candidateCount = rawCount;
    const timer = window.setTimeout(() => {
      if (
        tracker.current.url === candidateUrl &&
        tracker.current.candidate === candidateCount &&
        Date.now() - tracker.current.since >= 240
      ) {
        setConfirmed(candidateCount);
      }
    }, 260);
    return () => window.clearTimeout(timer);
  }, [url, rawCount]);

  return confirmed;
}

function useExtensionState(onNotification: (notification: UiNotification) => void): {
  state: QueueState | null;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<QueueState | null>(null);
  const statuses = useRef(new Map<string, QueueJob["status"]>());
  const initialized = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const response = await callExtension<{ state: QueueState }>({ type: "GET_STATE" });
      const nextState = response.state || { jobs: [] };
      if (initialized.current && !nextState.popupOpen) {
        for (const job of nextState.jobs || []) {
          const notification = notificationForTransition(statuses.current.get(job.id) || null, job);
          if (notification) onNotification(notification);
        }
      }
      statuses.current = new Map((nextState.jobs || []).map((job) => [job.id, job.status]));
      initialized.current = true;
      setState(nextState);
    } catch {
      // Extension reloads can briefly interrupt the content-script connection.
    }
  }, [onNotification]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 1000);
    const listener = (message: unknown) => {
      const type = String((message as { type?: unknown })?.type || "");
      if (type.startsWith("FOLDER_TASK_") || type === "POPUP_VISIBILITY_CHANGED") {
        window.setTimeout(() => void refresh(), 0);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      window.clearInterval(timer);
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [refresh]);

  return { state, refresh };
}

function useToasts(): {
  toasts: ToastRecord[];
  pushToast: (notification: UiNotification) => void;
  dismissToast: (id: string) => void;
} {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const pushToast = useCallback((notification: UiNotification) => {
    const now = Date.now();
    setToasts((current) => {
      if (current.some((toast) => toast.id === notification.id)) return current;
      const last = current.at(-1);
      if (
        notification.kind === "success" &&
        last?.kind === "success" &&
        now - last.receivedAt < 1200
      ) {
        const mergedCount = last.mergedCount + 1;
        const merged: ToastRecord = {
          ...last,
          id: last.id + "|" + notification.id,
          title: "多个下载任务已完成",
          message: mergedCount + " 个文件夹下载完成",
          receivedAt: now,
          mergedCount
        };
        return [...current.slice(0, -1), merged];
      }
      return [...current, { ...notification, receivedAt: now, mergedCount: 1 }].slice(-3);
    });
  }, []);
  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  return { toasts, pushToast, dismissToast };
}

function useDownloadServiceNotifications(
  onNotification: (notification: UiNotification) => void,
  suppressed: boolean,
  enabled: boolean
): void {
  const tracker = useRef<ServiceNoticeTracker>({
    connected: null,
    outageSequence: 0,
    outageNotified: false
  });
  const suppressedRef = useRef(suppressed);

  useEffect(() => {
    suppressedRef.current = suppressed;
  }, [suppressed]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const check = async () => {
      let connected: boolean;
      try {
        const response = await callExtension<{ connection: GopeedConnection }>({
          type: "CHECK_GOPEED"
        });
        connected = Boolean(response.connection?.connected);
      } catch {
        return;
      }
      if (disposed) return;
      const result = nextServiceNotice(tracker.current, connected, suppressedRef.current);
      tracker.current = result.tracker;
      if (result.notification) onNotification(result.notification);
    };
    void check();
    const timer = window.setInterval(check, 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [enabled, onNotification]);
}

function ProjectCount({ count }: { count: number | null }) {
  const loading = count == null;
  return (
    <span
      className="popo-react-project-count"
      data-state={loading ? "loading" : "ready"}
      title={loading
        ? "正在统计当前目录第一层项目数"
        : "当前目录第一层：" + count + " 个项目（文件 + 文件夹）"}
    >
      {loading ? "正在统计…" : count + " 个项目"}
    </span>
  );
}

function FolderDownloadButton({
  item,
  state,
  refresh,
  onInspect,
  onError
}: {
  item: FolderItem;
  state: QueueState | null;
  refresh: () => Promise<void>;
  onInspect: (jobId: string) => void;
  onError: (title: string, error: unknown) => void;
}) {
  const [starting, setStarting] = useState(false);
  const job = findMatchingFolderJob(state, item);
  const visualState = starting ? "scanning" : job?.status || "idle";
  const text = starting ? "…" : job ? (job.status === "queued" ? "✓" : "…") : "";
  const title = starting
    ? "正在添加下载"
    : job
      ? (job.status === "queued"
          ? "已添加下载，点击查看排队状态"
          : "该文件夹正在处理中，点击查看状态")
      : "稳定下载此文件夹";

  const handleClick = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (job) {
      onInspect(job.id);
      return;
    }
    setStarting(true);
    try {
      const response = await callExtension<{
        needsWorker?: boolean;
        job?: QueueJob;
      }>({
        type: "START_FOLDER_SCAN",
        folderName: item.name,
        folderItemIndex: item.itemIndex,
        parentUrl: item.parentUrl
      });
      if (response.needsWorker) {
        document.dispatchEvent(new CustomEvent(ENSURE_WORKER_EVENT, {
          detail: { url: item.parentUrl }
        }));
      }
      await refresh();
    } catch (error) {
      onError(item.name, error);
    } finally {
      setStarting(false);
    }
  };

  return (
    <button
      type="button"
      className={DOWNLOAD_BUTTON_CLASS}
      data-popo-react-owned="true"
      data-state={visualState}
      data-job-id={job?.id || ""}
      data-folder-name={item.name}
      disabled={starting}
      title={title}
      aria-label={title}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => void handleClick(event)}
    >
      {text}
    </button>
  );
}

function ProgressBar({ job }: { job: QueueJob }) {
  const percent = jobProgress(job);
  return (
    <div
      className="popo-page-progress"
      data-indeterminate={percent == null ? "true" : undefined}
      role="progressbar"
      aria-label={jobName(job) + " 下载进度"}
      aria-valuemin={percent == null ? undefined : 0}
      aria-valuemax={percent == null ? undefined : 100}
      aria-valuenow={percent == null ? undefined : percent}
    >
      <i style={percent == null ? undefined : { width: percent + "%" }} />
    </div>
  );
}

function QueueDock({
  state,
  expanded,
  focusedJobId,
  onExpandedChange,
  onAction,
  onError
}: {
  state: QueueState | null;
  expanded: boolean;
  focusedJobId: string | null;
  onExpandedChange: (expanded: boolean) => void;
  onAction: () => Promise<void>;
  onError: (title: string, error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const active = liveJobs(state);
  const attention = attentionJobs(state);
  const candidates = [...active, ...attention];
  const primary = candidates.find((job) => job.id === focusedJobId) ||
    candidates.find((job) => job.id === state?.activeJobId) ||
    candidates[0] ||
    null;
  if (!primary) return null;
  const otherQueuedCount = active.filter(
    (job) => job.status === "queued" && job.id !== primary.id
  ).length;

  const summary = active.length
    ? summarizeLiveJobs(active)
    : attention.length + " 个需要处理";

  const run = async (message: Record<string, unknown>) => {
    setBusy(true);
    try {
      await callExtension(message);
      setConfirming(false);
      await onAction();
    } catch (error) {
      onError(jobName(primary), error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside
      className="popo-page-queue"
      data-collapsed={expanded ? "false" : "true"}
      aria-label="POPO 下载任务"
    >
      <div className="popo-page-queue-header">
        <div className="popo-page-queue-heading">
          POPO 下载 <span className="popo-page-queue-summary">· {summary}</span>
        </div>
        <button
          type="button"
          className="popo-page-queue-toggle"
          aria-expanded={expanded}
          onClick={() => onExpandedChange(!expanded)}
        >
          {expanded ? "收起" : "展开"}
        </button>
      </div>
      {expanded && (
        <div className="popo-page-queue-body">
          <div className="popo-page-title-row">
            <strong className="popo-page-job-name" title={jobName(primary)}>
              {jobName(primary)}
            </strong>
            <span className="popo-page-job-state">
              {MODE_LABELS[primary.status]}
            </span>
          </div>
          <div className="popo-page-job-detail">{jobDetail(primary)}</div>
          {primary.status !== "queued" && <ProgressBar job={primary} />}
          {otherQueuedCount > 0 && (
            <div className="popo-page-queue-more">另有 {otherQueuedCount} 个排队</div>
          )}
          {!confirming ? (
            <div className="popo-page-actions">
              {primary.id === state?.activeJobId && primary.status === "downloading" && (
                <button
                  type="button"
                  className="popo-page-action"
                  disabled={busy}
                  onClick={() => void run({ type: "PAUSE" })}
                >
                  暂停
                </button>
              )}
              {primary.id === state?.activeJobId &&
                ["paused", "draining_paused"].includes(primary.status) && (
                  <button
                    type="button"
                    className="popo-page-action"
                    disabled={busy}
                    onClick={() => void run({ type: "RESUME" })}
                  >
                    继续
                  </button>
                )}
              {jobIsActive(primary) && !primary.cancelRequested && (
                <button
                  type="button"
                  className="popo-page-action"
                  data-kind="danger"
                  disabled={busy}
                  onClick={() => void run({ type: "CANCEL_JOB", jobId: primary.id })}
                >
                  停止后续下载
                </button>
              )}
              {primary.status === "cancelled" && recoverableCount(primary) > 0 && (
                <button
                  type="button"
                  className="popo-page-action"
                  disabled={busy}
                  onClick={() => void run({ type: "RESTORE_CANCELLED_JOB", jobId: primary.id })}
                >
                  继续（{recoverableCount(primary)}）
                </button>
              )}
              {primary.status === "failed" && failedRetryCount(primary) > 0 && (
                <button
                  type="button"
                  className="popo-page-action"
                  disabled={busy}
                  onClick={() => void run({ type: "RETRY_JOB", jobId: primary.id })}
                >
                  重试（{failedRetryCount(primary)}）
                </button>
              )}
              {!jobIsActive(primary) && (
                <button
                  type="button"
                  className="popo-page-action"
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                >
                  移除
                </button>
              )}
            </div>
          ) : (
            <div className="popo-page-confirm" role="group" aria-label="确认移除任务">
              <p>只从列表移除，不会删除已下载文件。</p>
              <div className="popo-page-actions">
                <button
                  type="button"
                  className="popo-page-action"
                  data-kind="danger"
                  disabled={busy}
                  onClick={() => void run({ type: "DISMISS_JOB", jobId: primary.id })}
                >
                  确认移除
                </button>
                <button
                  type="button"
                  className="popo-page-action"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  返回
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

function ToastItem({
  toast,
  onDismiss,
  onInspect
}: {
  toast: ToastRecord;
  onDismiss: (id: string) => void;
  onInspect: (jobId: string) => void;
}) {
  useEffect(() => {
    if (toast.timeoutMs == null) return;
    const timer = window.setTimeout(() => onDismiss(toast.id), toast.timeoutMs);
    return () => window.clearTimeout(timer);
  }, [onDismiss, toast.id, toast.timeoutMs]);

  return (
    <aside className="popo-toast" data-kind={toast.kind} role="status">
      <strong>{toast.title}</strong>
      <p>{toast.message}</p>
      <div className="popo-toast-actions">
        {toast.kind === "error" && toast.jobId && (
          <button
            type="button"
            className="popo-toast-action"
            onClick={() => {
              onInspect(toast.jobId);
              onDismiss(toast.id);
            }}
          >
            查看任务
          </button>
        )}
        <button
          type="button"
          className="popo-toast-action"
          data-kind="quiet"
          onClick={() => onDismiss(toast.id)}
          aria-label="关闭提示"
        >
          关闭
        </button>
      </div>
    </aside>
  );
}

function ToastViewport({
  toasts,
  onDismiss,
  onInspect
}: {
  toasts: ToastRecord[];
  onDismiss: (id: string) => void;
  onInspect: (jobId: string) => void;
}) {
  if (!toasts.length) return null;
  return (
    <div className="popo-toast-viewport" aria-label="POPO 下载通知">
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onDismiss={onDismiss}
          onInspect={onInspect}
        />
      ))}
    </div>
  );
}

function PageEnhancerApp() {
  const snapshot = usePageSnapshot();
  const count = useStableCount(snapshot.url, snapshot.rawCount);
  const { toasts, pushToast, dismissToast } = useToasts();
  const { state, refresh } = useExtensionState(pushToast);
  const [expanded, setExpanded] = useState(false);
  const [focusedJobId, setFocusedJobId] = useState<string | null>(null);
  const popupOpen = Boolean(state?.popupOpen);

  useDownloadServiceNotifications(pushToast, popupOpen, state != null);

  useEffect(() => {
    if (popupOpen) setExpanded(false);
  }, [popupOpen]);

  const inspectJob = useCallback((jobId: string) => {
    setFocusedJobId(jobId);
    setExpanded(true);
  }, []);

  const showActionError = useCallback((title: string, error: unknown) => {
    pushToast({
      id: "action-error:" + title + ":" + Date.now(),
      jobId: "",
      kind: "error",
      title,
      message: userFacingError(error),
      timeoutMs: null
    });
  }, [pushToast]);

  const portals = useMemo<ReactNode[]>(() => {
    const values: ReactNode[] = [];
    if (snapshot.countTarget) {
      values.push(createPortal(
        <ProjectCount count={count} />,
        snapshot.countTarget,
        "project-count"
      ));
    }
    for (const entry of snapshot.folderTargets) {
      values.push(createPortal(
        <FolderDownloadButton
          item={entry.item}
          state={state}
          refresh={refresh}
          onInspect={inspectJob}
          onError={showActionError}
        />,
        entry.target,
        entry.key
      ));
    }
    return values;
  }, [
    count,
    inspectJob,
    refresh,
    showActionError,
    snapshot.countTarget,
    snapshot.folderTargets,
    state
  ]);

  return (
    <>
      {portals}
      <QueueDock
        state={state}
        expanded={popupOpen ? false : expanded}
        focusedJobId={focusedJobId}
        onExpandedChange={setExpanded}
        onAction={refresh}
        onError={showActionError}
      />
      <ToastViewport
        toasts={popupOpen ? [] : toasts}
        onDismiss={dismissToast}
        onInspect={inspectJob}
      />
    </>
  );
}

function mountPageUi(): () => void {
  cleanupLegacyUi();
  const stopLegacyGuard = observeLegacyUi();
  const globalStyle = ensureGlobalStyle();
  document.getElementById(ROOT_ID)?.remove();
  const host = document.createElement("div");
  host.id = ROOT_ID;
  host.dataset.popoReactOwned = "true";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = SHADOW_STYLES;
  const mount = document.createElement("div");
  mount.id = "popo-react-page-app";
  shadow.append(style, mount);
  document.documentElement.appendChild(host);
  const root: Root = createRoot(mount);
  root.render(<PageEnhancerApp />);
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    stopLegacyGuard();
    root.unmount();
    host.remove();
    globalStyle.remove();
    document.getElementById(PROJECT_COUNT_ID)?.remove();
    for (const anchor of document.querySelectorAll("." + DOWNLOAD_ANCHOR_CLASS)) anchor.remove();
  };
}

if (window.top === window) {
  const pageGlobal = globalThis as typeof globalThis & PageUiGlobal;
  pageGlobal.__POPO_REACT_PAGE_CLEANUP__?.();
  const cleanup = mountPageUi();
  pageGlobal.__POPO_REACT_PAGE_CLEANUP__ = cleanup;
  window.addEventListener("pagehide", cleanup, { once: true });
}
