import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import {
  Check,
  CircleX,
  Clock3,
  Download,
  FileQuestion,
  Folder,
  LoaderCircle,
  Pause,
  Play,
  Search,
  Trash2,
  TriangleAlert,
  type LucideIcon
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  attentionJobs,
  failedRetryCount,
  findPageDownloadBatch,
  findMatchingFolderJob,
  findMatchingFolderReceipt,
  folderButtonDisplay,
  inferVirtualListItemCount,
  jobDetail,
  jobIsActive,
  jobIsTerminal,
  jobName,
  jobProgress,
  liveJobs,
  MODE_LABELS,
  networkHealthSummary,
  networkReminderVisible,
  nextNetworkNotice,
  nextServiceNotice,
  notificationForTransition,
  recoverableCount,
  summarizeLiveJobs,
  userFacingError,
  type QueueJob,
  type QueueState,
  type NetworkNoticeTracker,
  type ServiceNoticeTracker,
  type GopeedConnection,
  type UiNotification
} from "./ui-model";

const SELECTORS = {
  scroller: '[data-test-id="virtuoso-scroller"], [data-virtuoso-scroller="true"]',
  row: "[data-item-index]",
  name: '[class*="topName"]',
  nameHost: '[class*="pageName"]',
  folderIcon: '[class*="drive-icon-folder"]',
  actions: '[class*="listMore"]'
} as const;

const ROOT_ID = "popo-react-page-root";
const GLOBAL_STYLE_ID = "popo-react-page-global-style";
const PROJECT_COUNT_ID = "popo-stable-project-count";
const DOWNLOAD_ANCHOR_CLASS = "popo-react-download-anchor";
const DOWNLOAD_BUTTON_CLASS = "popo-stable-download-button";
const DOWNLOAD_HOST_ATTRIBUTE = "data-popo-download-host";
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
  pageName: string;
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

function currentDirectoryName(): string {
  const title = normalizeText(document.title);
  if (title && title !== "POPO") return title;
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(
    '[class*="titleInput"], [class*="breadcrumb"]'
  )).map((element) => normalizeText(element.textContent)).filter(Boolean);
  return candidates[candidates.length - 1] || "POPO目录";
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
  const activeHosts = new Set<HTMLElement>();
  const targets: FolderPortalTarget[] = [];
  for (const row of document.querySelectorAll<HTMLElement>(SELECTORS.row)) {
    const item = parseFolderRow(row);
    const existing = row.querySelector<HTMLElement>("." + DOWNLOAD_ANCHOR_CLASS);
    if (!item) {
      existing?.remove();
      for (const host of row.querySelectorAll<HTMLElement>(`[${DOWNLOAD_HOST_ATTRIBUTE}]`)) {
        host.removeAttribute(DOWNLOAD_HOST_ATTRIBUTE);
      }
      continue;
    }
    const nameNode = row.querySelector<HTMLElement>(SELECTORS.name);
    const nameHost = row.querySelector<HTMLElement>(SELECTORS.nameHost) || nameNode?.parentElement;
    if (!nameHost) {
      existing?.remove();
      continue;
    }
    let anchor = existing;
    if (!anchor) {
      anchor = document.createElement("span");
      anchor.className = DOWNLOAD_ANCHOR_CLASS;
    }
    anchor.dataset.popoReactOwned = "true";
    nameHost.setAttribute(DOWNLOAD_HOST_ATTRIBUTE, "true");
    if (anchor.parentElement !== nameHost || anchor !== nameHost.lastElementChild) {
      nameHost.append(anchor);
    }
    const key = [item.parentUrl, item.itemIndex, item.name].join("\u0000");
    anchor.dataset.popoKey = key;
    activeAnchors.add(anchor);
    activeHosts.add(nameHost);
    targets.push({ key, target: anchor, item });
  }
  for (const anchor of document.querySelectorAll<HTMLElement>("." + DOWNLOAD_ANCHOR_CLASS)) {
    if (!activeAnchors.has(anchor)) anchor.remove();
  }
  for (const host of document.querySelectorAll<HTMLElement>(`[${DOWNLOAD_HOST_ATTRIBUTE}]`)) {
    if (!activeHosts.has(host)) host.removeAttribute(DOWNLOAD_HOST_ATTRIBUTE);
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
      pageName: currentDirectoryName(),
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
    for (const host of document.querySelectorAll(`[${DOWNLOAD_HOST_ATTRIBUTE}]`)) {
      host.removeAttribute(DOWNLOAD_HOST_ATTRIBUTE);
    }
  };
}

function globalStyles(): string {
  return [
    "[" + DOWNLOAD_HOST_ATTRIBUTE + "]{box-sizing:border-box!important;position:relative!important;padding-right:244px!important;}",
    "." + DOWNLOAD_ANCHOR_CLASS + "{position:absolute!important;top:0!important;right:0!important;bottom:0!important;z-index:2!important;display:inline-flex!important;align-items:center!important;justify-content:flex-end!important;width:244px!important;}",
    "." + DOWNLOAD_BUTTON_CLASS + "{--popo-gradient-surface:linear-gradient(145deg,#1d2a39 0%,#111923 100%);--popo-gradient-highlight:none;--popo-surface-border:#415267;--popo-surface-ink:#9ec9ff;box-sizing:border-box!important;position:relative!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;flex:0 0 30px!important;width:30px!important;height:30px!important;overflow:visible!important;margin:0 3px!important;padding:0!important;border:1px solid var(--popo-surface-border)!important;border-radius:8px!important;color:var(--popo-surface-ink)!important;background-color:#111923!important;background-image:var(--popo-gradient-highlight),var(--popo-gradient-surface)!important;background-size:220% 100%,100% 100%!important;background-position:-130% 0,0 0!important;background-repeat:no-repeat!important;font:600 11px/1 'Segoe UI','Microsoft YaHei',sans-serif!important;white-space:nowrap!important;cursor:pointer!important;box-shadow:0 7px 18px rgba(4,10,18,.22),inset 0 1px 0 rgba(255,255,255,.055)!important;color-scheme:dark;}",
    "." + DOWNLOAD_BUTTON_CLASS + "[data-expanded='true']{justify-content:flex-start!important;overflow:hidden!important;}",
    "." + DOWNLOAD_BUTTON_CLASS + "[data-state='queued']{flex-basis:124px!important;width:124px!important;height:32px!important;padding:0 8px!important;}",
    "." + DOWNLOAD_BUTTON_CLASS + "[data-state='preparing']{flex-basis:150px!important;width:150px!important;height:40px!important;padding:0 10px 8px!important;}",
    "." + DOWNLOAD_BUTTON_CLASS + "[data-state='scanning'],." + DOWNLOAD_BUTTON_CLASS + "[data-state='downloading'],." + DOWNLOAD_BUTTON_CLASS + "[data-state='paused']{flex-basis:232px!important;width:232px!important;height:48px!important;padding:0 10px 10px!important;border-radius:10px!important;}",
    "." + DOWNLOAD_BUTTON_CLASS + "[data-state='ready'],." + DOWNLOAD_BUTTON_CLASS + "[data-state='success'],." + DOWNLOAD_BUTTON_CLASS + "[data-state='empty']{flex-basis:166px!important;width:166px!important;height:40px!important;padding:0 10px 8px!important;}",
    "." + DOWNLOAD_BUTTON_CLASS + "[data-state='warning'],." + DOWNLOAD_BUTTON_CLASS + "[data-state='failed']{flex-basis:196px!important;width:196px!important;height:40px!important;padding:0 10px 8px!important;}",
    "." + DOWNLOAD_BUTTON_CLASS + ":hover{filter:brightness(1.08)!important;border-color:#5f88b8!important;box-shadow:0 9px 22px rgba(4,10,18,.3),0 0 0 1px rgba(103,170,255,.12)!important;}",
    "." + DOWNLOAD_BUTTON_CLASS + ":disabled{cursor:wait!important;opacity:.82!important;}",
    "." + DOWNLOAD_BUTTON_CLASS + "[data-state='preparing'],." + DOWNLOAD_BUTTON_CLASS + "[data-state='scanning']{--popo-gradient-surface:linear-gradient(145deg,#17385a 0%,#12263b 52%,#101a27 100%);--popo-surface-border:#3e709e;--popo-surface-ink:#9ed1ff;cursor:progress!important;}",
    "." + DOWNLOAD_BUTTON_CLASS + "[data-state='queued']{--popo-gradient-surface:linear-gradient(145deg,#263241 0%,#19222e 100%);--popo-surface-border:#4a596c;--popo-surface-ink:#b8c5d5;}",
    "." + DOWNLOAD_BUTTON_CLASS + "[data-state='ready'],." + DOWNLOAD_BUTTON_CLASS + "[data-state='success']{--popo-gradient-surface:linear-gradient(145deg,#173a34 0%,#10241f 100%);--popo-surface-border:#3e7566;--popo-surface-ink:#82ddc0;}",
    "." + DOWNLOAD_BUTTON_CLASS + "[data-state='downloading']{--popo-gradient-surface:linear-gradient(145deg,#153c55 0%,#123843 52%,#10251f 100%);--popo-surface-border:#398493;--popo-surface-ink:#9ee6dd;}",
    "." + DOWNLOAD_BUTTON_CLASS + "[data-state='paused']{--popo-gradient-surface:linear-gradient(145deg,#393633 0%,#252421 100%);--popo-surface-border:#625d55;--popo-surface-ink:#d3cbc0;}",
    "." + DOWNLOAD_BUTTON_CLASS + "[data-state='empty'],." + DOWNLOAD_BUTTON_CLASS + "[data-state='warning']{--popo-gradient-surface:linear-gradient(145deg,#403318 0%,#282114 100%);--popo-surface-border:#796238;--popo-surface-ink:#f1d17f;}",
    "." + DOWNLOAD_BUTTON_CLASS + "[data-state='failed']{--popo-gradient-surface:linear-gradient(145deg,#46262c 0%,#29191e 100%);--popo-surface-border:#814c55;--popo-surface-ink:#ffadb7;}",
    "." + DOWNLOAD_BUTTON_CLASS + "[data-state='scanning'],." + DOWNLOAD_BUTTON_CLASS + "[data-state='downloading']{--popo-gradient-highlight:linear-gradient(105deg,transparent 28%,rgba(255,255,255,.035) 39%,rgba(142,208,255,.17) 48%,rgba(255,255,255,.05) 57%,transparent 69%);animation:popo-gradient-surface-flow 4.8s ease-in-out infinite!important;}",
    ".popo-download-idle-icon{display:inline-flex!important;align-items:center!important;justify-content:center!important;width:18px!important;height:18px!important;}",
    ".popo-download-idle-icon svg{display:block!important;width:18px!important;height:18px!important;}",
    ".popo-download-content{position:relative!important;z-index:5!important;display:flex!important;align-items:center!important;width:100%!important;min-width:0!important;gap:6px!important;overflow:hidden!important;}",
    ".popo-download-state-icon{position:relative!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;flex:0 0 20px!important;width:20px!important;height:22px!important;overflow:visible!important;}",
    ".popo-download-state-icon-motion{display:inline-flex!important;align-items:center!important;justify-content:center!important;width:14px!important;height:14px!important;transform-origin:50% 50%!important;}",
    ".popo-download-state-icon-motion svg{display:block!important;width:14px!important;height:14px!important;overflow:visible!important;}",
    ".popo-download-injection-icon .popo-download-folder-glyph{position:absolute!important;z-index:2!important;right:1px!important;bottom:0!important;display:block!important;width:17px!important;height:17px!important;overflow:visible!important;}",
    ".popo-download-resource-block{position:absolute!important;z-index:1!important;top:0!important;left:7px!important;display:block!important;width:6px!important;height:6px!important;border:1px solid currentColor!important;border-radius:2px!important;background:#dff2ff!important;box-shadow:0 0 5px rgba(18,104,232,.42)!important;}",
    ".popo-download-primary{flex:none!important;font-weight:700!important;line-height:1!important;}",
    ".popo-download-secondary{min-width:0!important;margin-left:auto!important;overflow:hidden!important;color:currentColor!important;font-size:10px!important;font-weight:600!important;line-height:1!important;text-overflow:ellipsis!important;opacity:.82!important;}",
    "." + DOWNLOAD_BUTTON_CLASS + "[data-state='queued'] .popo-download-secondary{flex:0 0 auto!important;min-width:max-content!important;overflow:visible!important;text-overflow:clip!important;opacity:.9!important;}",
    ".popo-download-work-beat{display:inline-flex!important;align-items:flex-end!important;gap:2px!important;flex:0 0 auto!important;height:12px!important;}",
    ".popo-download-work-beat i{display:block!important;width:2px!important;height:8px!important;border-radius:999px!important;background:currentColor!important;transform-origin:50% 100%!important;}",
    ".popo-download-work-beat i:first-child{height:4px!important;}.popo-download-work-beat i:last-child{height:6px!important;}",
    ".popo-download-rail{position:absolute!important;right:10px!important;bottom:5px!important;left:10px!important;height:8px!important;overflow:hidden!important;border-radius:999px!important;background:rgba(70,100,138,.16)!important;box-shadow:inset 0 0 0 1px rgba(70,100,138,.08)!important;}",
    ".popo-download-fill,.popo-download-estimate-fill{position:absolute!important;z-index:2!important;inset:0 auto 0 0!important;display:block!important;height:100%!important;overflow:hidden!important;border-radius:inherit!important;background:linear-gradient(90deg,#1268e8,#13a17a)!important;}",
    ".popo-download-estimate-fill{z-index:1!important;background:linear-gradient(90deg,rgba(18,104,232,.5),rgba(19,161,122,.62))!important;}",
    ".popo-download-wave{position:absolute!important;z-index:3!important;inset:0 auto 0 0!important;display:block!important;width:36%!important;height:100%!important;border-radius:inherit!important;background:linear-gradient(90deg,transparent,rgba(55,190,255,.72) 24%,#1268e8 52%,rgba(30,195,166,.8) 76%,transparent)!important;box-shadow:0 0 7px rgba(18,104,232,.48)!important;}",
    ".popo-download-activity-comet{position:absolute!important;z-index:3!important;top:0!important;bottom:0!important;width:30%!important;border-radius:inherit!important;background:linear-gradient(90deg,transparent,rgba(121,190,255,.82),rgba(255,255,255,.95),transparent)!important;}",
    ".popo-download-activity-packet{position:absolute!important;z-index:4!important;top:1px!important;display:block!important;width:6px!important;height:6px!important;border-radius:50%!important;background:#dff2ff!important;box-shadow:0 0 7px rgba(120,192,255,.9)!important;}",
    ".popo-download-activity-packet:nth-of-type(2){top:2px!important;width:4px!important;height:4px!important;}.popo-download-activity-packet:nth-of-type(3){top:1.5px!important;width:5px!important;height:5px!important;}",
    ".popo-download-warning-segment{position:absolute!important;right:0!important;bottom:0!important;width:13px!important;height:100%!important;border-radius:999px!important;background:#e6a700!important;box-shadow:-3px 0 5px rgba(230,167,0,.25)!important;}",
    "." + DOWNLOAD_BUTTON_CLASS + "[data-state='success'] .popo-download-fill,." + DOWNLOAD_BUTTON_CLASS + "[data-state='ready'] .popo-download-fill{background:#0b9b74!important;}",
    "." + DOWNLOAD_BUTTON_CLASS + "[data-state='failed'] .popo-download-fill{background:#d64550!important;}",
    "@keyframes popo-gradient-surface-flow{0%,100%{background-position:-130% 0,0 0;box-shadow:0 7px 18px rgba(4,10,18,.22),inset 0 1px 0 rgba(255,255,255,.055)}50%{background-position:130% 0,0 0;box-shadow:0 10px 25px rgba(16,82,126,.3),inset 0 1px 0 rgba(255,255,255,.075)}}",
    "@media(prefers-reduced-motion:reduce){." + DOWNLOAD_BUTTON_CLASS + "[data-state='scanning'],." + DOWNLOAD_BUTTON_CLASS + "[data-state='downloading']{animation:none!important;background-position:50% 0,0 0!important;}.popo-download-fill,.popo-download-estimate-fill{transition:none!important;}}",
    "#" + PROJECT_COUNT_ID + "{display:contents!important;}",
    ".popo-react-project-count{all:initial;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;min-width:72px;height:32px;margin-left:10px;margin-right:auto;padding:0 10px;border:1px solid #526f8f;border-radius:7px;color:#eef6ff;background-color:#132235;background-image:radial-gradient(circle at 18% 0%,rgba(111,186,255,.26),transparent 58%),linear-gradient(135deg,#2c4968 0%,#19334d 52%,#0f1a26 100%);background-size:100% 100%;box-shadow:0 6px 16px rgba(4,10,18,.22),inset 0 1px 0 rgba(255,255,255,.09);font:600 13px/1 'Segoe UI','Microsoft YaHei',sans-serif;white-space:nowrap;color-scheme:dark;}",
    ".popo-react-project-count[data-state='loading']{color:#91a0b2;}",
    ".popo-page-download-controls{all:initial;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;margin:0 8px;color-scheme:dark;}",
    ".popo-page-download-all{all:initial;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:0 0 auto;min-width:96px;height:32px;margin:0;padding:0 12px;border:1px solid #3f719d;border-radius:7px;color:#eaf5ff;background-color:#12314c;background-image:linear-gradient(145deg,#1d5275 0%,#173b58 55%,#10283d 100%);box-shadow:0 6px 16px rgba(4,10,18,.22),inset 0 1px 0 rgba(255,255,255,.09);font:600 13px/1 'Segoe UI','Microsoft YaHei',sans-serif;white-space:nowrap;cursor:pointer;color-scheme:dark;}",
    ".popo-page-download-all svg{width:15px;height:15px;stroke:currentColor;}",
    ".popo-page-download-all:hover{filter:brightness(1.08);border-color:#61a2d7;}",
    ".popo-page-download-all:disabled{cursor:wait;opacity:.62;}",
    ".popo-page-download-all[data-state='queued'],.popo-page-download-all[data-state='preparing'],.popo-page-download-all[data-state='scanning'],.popo-page-download-all[data-state='downloading']{border-color:#3e8ba0;background-image:linear-gradient(145deg,#18506a 0%,#133d4b 55%,#102c30 100%);}",
    ".popo-page-download-all[data-state='success']{border-color:#3e7566;color:#9ce5cf;background-image:linear-gradient(145deg,#173a34 0%,#10241f 100%);}",
    ".popo-page-download-all[data-state='failed'],.popo-page-download-all[data-state='warning']{border-color:#84515a;color:#ffc1c7;background-image:linear-gradient(145deg,#46262c 0%,#29191e 100%);}",
    ".popo-page-batch-action{all:initial;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:32px;padding:0 10px;border:1px solid #536579;border-radius:7px;color:#dce8f5;background:linear-gradient(145deg,#263342,#19232f);box-shadow:0 6px 16px rgba(4,10,18,.2),inset 0 1px 0 rgba(255,255,255,.06);font:600 12px/1 'Segoe UI','Microsoft YaHei',sans-serif;white-space:nowrap;cursor:pointer;color-scheme:dark;}",
    ".popo-page-batch-action svg{width:14px;height:14px;stroke:currentColor;}.popo-page-batch-action:hover{filter:brightness(1.1);}.popo-page-batch-action:disabled{cursor:wait;opacity:.62;}",
    ".popo-page-batch-action[data-kind='danger']{border-color:#87505b;color:#ffc1c7;background:linear-gradient(145deg,#46262c,#29191e);}",
    "@media(prefers-color-scheme:dark){.popo-react-project-count,.popo-page-download-all{box-shadow:0 6px 16px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.05);}}",
    ":is(html,body).dark .popo-react-project-count,:is(html,body)[data-theme='dark'] .popo-react-project-count,:is(html,body)[data-color-mode='dark'] .popo-react-project-count{color:#eef6ff;border-color:#526f8f;}"
  ].join("\n");
}

const SHADOW_STYLES = [
  ":host{all:initial;color-scheme:dark;--popo-gradient-surface:linear-gradient(145deg,#1b2735 0%,#111923 100%);--popo-gradient-blue:linear-gradient(145deg,#17385a 0%,#12263b 56%,#101a27 100%);--popo-gradient-download:linear-gradient(145deg,#153c55 0%,#123843 54%,#10251f 100%);--popo-gradient-queued:linear-gradient(145deg,#263241 0%,#19222e 100%);--popo-gradient-paused:linear-gradient(145deg,#393633 0%,#252421 100%);--popo-gradient-warning:linear-gradient(145deg,#403318 0%,#282114 100%);--popo-gradient-failed:linear-gradient(145deg,#46262c 0%,#29191e 100%);--popo-gradient-success:linear-gradient(145deg,#173a34 0%,#10241f 100%);--popo-gradient-highlight:linear-gradient(105deg,transparent 29%,rgba(255,255,255,.03) 40%,rgba(140,207,255,.14) 49%,rgba(255,255,255,.045) 58%,transparent 70%);--popo-ink:#edf3fb;--popo-muted:#a5b2c2;--popo-line:#3b4a5d;--popo-control:linear-gradient(145deg,#263342,#19232f);}",
  "*{box-sizing:border-box;}",
  "button{font:600 11px/1 'Segoe UI','Microsoft YaHei',sans-serif;}",
  ".popo-page-queue{--popo-current-surface:var(--popo-gradient-surface);position:fixed;left:20px;bottom:20px;z-index:2147483645;width:min(380px,calc(100vw - 40px));max-height:min(62vh,560px);overflow:hidden;border:1px solid var(--popo-line);border-radius:12px;color:var(--popo-ink);background-color:#111923;background-image:var(--popo-current-surface);background-repeat:no-repeat;box-shadow:0 16px 42px rgba(2,7,13,.42),inset 0 1px 0 rgba(255,255,255,.05);font-family:'Segoe UI','Microsoft YaHei',sans-serif;}",
  ".popo-page-queue[data-status='queued'],.popo-page-queue[data-status='waiting_worker']{--popo-current-surface:var(--popo-gradient-queued);}",
  ".popo-page-queue[data-status='scanning'],.popo-page-queue[data-status='scan_complete'],.popo-page-queue[data-status='awaiting_confirmation'],.popo-page-queue[data-status='starting']{--popo-current-surface:var(--popo-gradient-blue);}",
  ".popo-page-queue[data-status='downloading']{--popo-current-surface:var(--popo-gradient-download);}",
  ".popo-page-queue[data-status='paused'],.popo-page-queue[data-status='draining'],.popo-page-queue[data-status='draining_paused'],.popo-page-queue[data-status='cancelled']{--popo-current-surface:var(--popo-gradient-paused);}",
  ".popo-page-queue[data-status='complete']{--popo-current-surface:var(--popo-gradient-success);}",
  ".popo-page-queue[data-status='failed']{--popo-current-surface:var(--popo-gradient-failed);}",
  ".popo-page-queue[data-status='scanning'],.popo-page-queue[data-status='downloading']{background-image:var(--popo-gradient-highlight),var(--popo-current-surface);background-size:220% 100%,100% 100%;animation:popo-shadow-surface-flow 5.2s ease-in-out infinite;}",
  ".popo-page-queue[data-collapsed='true']{width:min(330px,calc(100vw - 40px));}",
  ".popo-page-queue-header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 13px;background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.012));}",
  ".popo-page-queue[data-collapsed='false'] .popo-page-queue-header{border-bottom:1px solid rgba(151,174,201,.16);}",
  ".popo-page-queue-heading{min-width:0;overflow:hidden;color:var(--popo-ink);font-size:13px;font-weight:700;text-overflow:ellipsis;white-space:nowrap;}",
  ".popo-page-queue-summary{color:var(--popo-muted);font-size:11px;font-weight:500;}",
  ".popo-page-queue-toggle,.popo-page-action,.popo-toast-action{min-width:0;height:27px;padding:0 9px;border:1px solid #46566a;border-radius:7px;color:#a8cdff;background-color:#1a2430;background-image:var(--popo-control);box-shadow:inset 0 1px 0 rgba(255,255,255,.045);cursor:pointer;}",
  ".popo-page-queue-toggle:disabled,.popo-page-action:disabled,.popo-toast-action:disabled{cursor:wait;opacity:.6;}",
  ".popo-page-queue-body{max-height:min(52vh,470px);overflow:auto;padding:11px 13px 13px;}",
  ".popo-page-title-row{display:flex;align-items:center;justify-content:space-between;gap:10px;}",
  ".popo-page-job-name{overflow:hidden;color:var(--popo-ink);font-size:13px;font-weight:650;text-overflow:ellipsis;white-space:nowrap;}",
  ".popo-page-job-state{flex:none;color:#8bc4ff;font-size:11px;font-weight:650;}",
  ".popo-page-queue[data-status='queued'] .popo-page-job-state,.popo-page-queue[data-status='waiting_worker'] .popo-page-job-state{color:#bac6d5;}",
  ".popo-page-queue[data-status='paused'] .popo-page-job-state,.popo-page-queue[data-status='draining'] .popo-page-job-state,.popo-page-queue[data-status='draining_paused'] .popo-page-job-state,.popo-page-queue[data-status='cancelled'] .popo-page-job-state{color:#d5cdc2;}",
  ".popo-page-queue[data-status='complete'] .popo-page-job-state{color:#82ddc0;}",
  ".popo-page-queue[data-status='failed'] .popo-page-job-state{color:#ffadb7;}",
  ".popo-page-job-detail{margin-top:5px;color:var(--popo-muted);font-size:11px;line-height:1.45;}",
  ".popo-network-notice{margin-top:9px;padding:9px;border:1px solid #756039;border-radius:8px;color:#f1d17f;background:var(--popo-gradient-warning);font-size:11px;line-height:1.45;}",
  ".popo-network-notice strong{display:block;margin-bottom:3px;color:#ffe2a0;font-size:11px;}",
  ".popo-network-notice .popo-page-actions{margin-top:7px;}",
  ".popo-page-queue-more{margin-top:7px;color:var(--popo-muted);font-size:11px;line-height:1.45;}",
  ".popo-page-progress{overflow:hidden;height:7px;margin-top:8px;border-radius:999px;background:rgba(7,14,23,.44);box-shadow:inset 0 0 0 1px rgba(148,178,210,.1);}",
  ".popo-page-progress i{display:block;width:0;height:100%;border-radius:inherit;background:linear-gradient(90deg,#1268e8,#0aa17a);transition:width .2s ease;}",
  ".popo-page-progress[data-indeterminate='true'] i{width:38%;animation:popo-react-progress 1.2s ease-in-out infinite alternate;}",
  "@keyframes popo-react-progress{from{transform:translateX(-25%)}to{transform:translateX(190%)}}",
  ".popo-page-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:6px;margin-top:9px;}",
  ".popo-page-action[data-kind='danger']{color:#ffafb7;border-color:#774750;background-image:var(--popo-gradient-failed);}",
  ".popo-page-confirm{margin-top:9px;padding:8px;border:1px solid #58534d;border-radius:8px;background-image:var(--popo-gradient-paused);}",
  ".popo-page-confirm p{margin:0;color:#c7c0b7;font-size:11px;line-height:1.5;}",
  ".popo-toast-viewport{position:fixed;right:24px;bottom:24px;z-index:2147483646;display:grid;width:min(340px,calc(100vw - 48px));gap:8px;font-family:'Segoe UI','Microsoft YaHei',sans-serif;}",
  ".popo-toast{padding:13px 15px;border:1px solid #3f6f62;border-radius:11px;color:var(--popo-ink);background-color:#10241f;background-image:var(--popo-gradient-success);box-shadow:0 14px 38px rgba(2,7,13,.4),inset 0 1px 0 rgba(255,255,255,.05);}",
  ".popo-toast[data-kind='error']{border-color:#7d4a53;background-color:#29191e;background-image:var(--popo-gradient-failed);}",
  ".popo-toast strong{display:block;overflow:hidden;font-size:13px;text-overflow:ellipsis;white-space:nowrap;}",
  ".popo-toast[data-kind='warning']{border-color:#756039;background-image:var(--popo-gradient-warning);}",
  ".popo-toast[data-kind='warning'] strong{color:#ffe2a0;}",
  ".popo-toast p{margin:4px 0 0;color:var(--popo-muted);font-size:12px;line-height:1.45;}",
  ".popo-toast-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:8px;}",
  ".popo-toast-action[data-kind='quiet']{color:#aab6c6;border-color:#465365;}",
  "@keyframes popo-shadow-surface-flow{0%,100%{background-position:-130% 0,0 0}50%{background-position:130% 0,0 0}}",
  "@media(prefers-reduced-motion:reduce){.popo-page-queue[data-status='scanning'],.popo-page-queue[data-status='downloading']{animation:none;background-position:50% 0,0 0}.popo-page-progress[data-indeterminate='true'] i{animation:none;transform:translateX(80%)}.popo-page-progress i{transition:none}}",
  "@media(prefers-color-scheme:dark){:host{color-scheme:dark}.popo-page-queue,.popo-toast{box-shadow:0 16px 44px rgba(0,0,0,.46),inset 0 1px 0 rgba(255,255,255,.05)}}",
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
    pageName: currentDirectoryName(),
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
        current.pageName === next.pageName &&
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

function useNetworkNotifications(
  state: QueueState | null,
  onNotification: (notification: UiNotification) => void,
  suppressed: boolean
): void {
  const tracker = useRef<NetworkNoticeTracker>({
    peakNoticeSequence: 0,
    noticeSequence: 0
  });

  useEffect(() => {
    const result = nextNetworkNotice(tracker.current, state?.networkHealth, suppressed);
    tracker.current = result.tracker;
    if (!result.notification) return;
    const storageKey = `popo-network-notice:${result.notification.id}`;
    try {
      if (window.sessionStorage.getItem(storageKey)) return;
      window.sessionStorage.setItem(storageKey, "1");
    } catch {
      // Session storage can be blocked by page policy; in-memory tracking still de-duplicates.
    }
    onNotification(result.notification);
  }, [onNotification, state?.networkHealth, suppressed]);
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

function PageDownloadButton({
  pageName,
  parentUrl,
  count,
  state,
  refresh,
  onError
}: {
  pageName: string;
  parentUrl: string;
  count: number | null;
  state: QueueState | null;
  refresh: () => Promise<void>;
  onError: (title: string, error: unknown) => void;
}) {
  const [starting, setStarting] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [confirmRemoving, setConfirmRemoving] = useState(false);
  const [outcome, setOutcome] = useState<{
    addedCount: number;
    duplicateCount: number;
    completedCount: number;
    folderCount: number;
    coveredByLegacyPageDownload: boolean;
  } | null>(null);
  const batch = useMemo(() => findPageDownloadBatch(state, parentUrl), [parentUrl, state]);
  const label = starting
    ? "正在核对…"
    : outcome?.addedCount
      ? `已排队 ${outcome.addedCount} 个`
      : outcome?.coveredByLegacyPageDownload
        ? "整页任务进行中"
        : outcome?.folderCount === 0
          ? "没有子文件夹"
          : outcome && outcome.completedCount === outcome.folderCount
            ? "均已下载"
            : outcome
              ? "文件夹均已入队"
              : "一键下载";

  useEffect(() => {
    if (!outcome) return;
    const timer = window.setTimeout(() => {
      setOutcome(null);
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [outcome]);

  useEffect(() => {
    if (!confirmRemoving) return;
    const timer = window.setTimeout(() => setConfirmRemoving(false), 5000);
    return () => window.clearTimeout(timer);
  }, [confirmRemoving]);

  useEffect(() => {
    if (!batch) setConfirmRemoving(false);
  }, [batch]);

  const handleClick = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setStarting(true);
    setOutcome(null);
    try {
      const response = await callExtension<{
        needsWorker?: boolean;
        addedCount?: number;
        duplicateCount?: number;
        completedCount?: number;
        folderCount?: number;
        coveredByLegacyPageDownload?: boolean;
      }>({
        type: "START_PAGE_DOWNLOAD",
        pageName,
        parentUrl
      });
      setOutcome({
        addedCount: response.addedCount || 0,
        duplicateCount: response.duplicateCount || 0,
        completedCount: response.completedCount || 0,
        folderCount: response.folderCount || 0,
        coveredByLegacyPageDownload: Boolean(response.coveredByLegacyPageDownload)
      });
      if (response.needsWorker) {
        document.dispatchEvent(new CustomEvent(ENSURE_WORKER_EVENT, {
          detail: { url: parentUrl }
        }));
      }
      await refresh();
    } catch (error) {
      onError("一键下载", error);
    } finally {
      setStarting(false);
    }
  };

  const handleBatchAction = async (
    event: React.MouseEvent<HTMLButtonElement>,
    type: "PAUSE_DOWNLOAD_BATCH" | "RESUME_DOWNLOAD_BATCH" | "REMOVE_DOWNLOAD_BATCH"
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (!batch) return;
    setBatchBusy(true);
    try {
      await callExtension({ type, batchId: batch.id });
      setConfirmRemoving(false);
      await refresh();
    } catch (error) {
      onError(type === "REMOVE_DOWNLOAD_BATCH" ? "移除一键下载" : "一键下载批次", error);
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <span className="popo-page-download-controls">
      <button
        type="button"
        className="popo-page-download-all"
        data-state={starting ? "preparing" : outcome?.addedCount ? "queued" : "idle"}
        disabled={starting || batchBusy || count == null || count === 0}
        title={count == null
          ? "正在核对当前页面项目数"
          : count === 0
            ? "当前页面没有可下载项目"
            : `核对“${pageName}”的完整列表，把每个第一层文件夹按页面顺序分别加入下载队列`}
        aria-busy={starting || undefined}
        aria-live="polite"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => void handleClick(event)}
      >
        <Download aria-hidden="true" focusable="false" strokeWidth={1.8} />
        <span>{label}</span>
      </button>
      {batch && (
        <>
          <button
            type="button"
            className="popo-page-batch-action"
            disabled={batchBusy || starting}
            title={batch.paused ? "继续这次一键下载批次" : "暂停这次一键下载批次"}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => void handleBatchAction(
              event,
              batch.paused ? "RESUME_DOWNLOAD_BATCH" : "PAUSE_DOWNLOAD_BATCH"
            )}
          >
            {batch.paused
              ? <Play aria-hidden="true" focusable="false" strokeWidth={1.8} />
              : <Pause aria-hidden="true" focusable="false" strokeWidth={1.8} />}
            <span>{batch.paused ? "全部继续" : "全部暂停"}</span>
          </button>
          <button
            type="button"
            className="popo-page-batch-action"
            data-kind="danger"
            disabled={batchBusy || starting}
            title="移除这次一键下载批次；已交给 Gopeed 的文件不会删除"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              if (!confirmRemoving) {
                event.preventDefault();
                event.stopPropagation();
                setConfirmRemoving(true);
                return;
              }
              void handleBatchAction(event, "REMOVE_DOWNLOAD_BATCH");
            }}
          >
            <Trash2 aria-hidden="true" focusable="false" strokeWidth={1.8} />
            <span>{confirmRemoving ? "确认移除" : "全部移除"}</span>
          </button>
        </>
      )}
    </span>
  );
}

const FOLDER_STATE_ICONS: Partial<Record<
  ReturnType<typeof folderButtonDisplay>["visualState"],
  LucideIcon
>> = {
  queued: Clock3,
  preparing: LoaderCircle,
  scanning: Search,
  ready: Check,
  paused: Pause,
  success: Check,
  empty: FileQuestion,
  warning: TriangleAlert,
  failed: CircleX
};

function FolderButtonStateIcon({
  visualState,
  reducedMotion
}: {
  visualState: ReturnType<typeof folderButtonDisplay>["visualState"];
  reducedMotion: boolean | null;
}) {
  if (visualState === "downloading") {
    return (
      <span
        className="popo-download-state-icon popo-download-injection-icon"
        aria-hidden="true"
      >
        <Folder
          className="popo-download-folder-glyph"
          aria-hidden="true"
          focusable="false"
          strokeWidth={1.8}
        />
        <motion.i
          className="popo-download-resource-block"
          initial={reducedMotion ? false : { y: -1, opacity: 0, scale: .72, rotate: -8 }}
          animate={reducedMotion
            ? { y: 4, opacity: .82, scale: .9, rotate: 0 }
            : {
                y: [-1, 2, 7, 10],
                opacity: [0, 1, 1, 0],
                scale: [.72, 1, .94, .64],
                rotate: [-8, 4, 0, 0]
              }}
          transition={reducedMotion
            ? { duration: 0 }
            : { duration: .9, ease: "easeIn" as const, repeat: Infinity }}
        />
      </span>
    );
  }

  const Icon = FOLDER_STATE_ICONS[visualState];
  if (!Icon) return null;

  const activeMotion = (() => {
    if (reducedMotion) return { initial: false, animate: {}, transition: { duration: 0 } };
    if (visualState === "scanning") {
      return {
        initial: { x: -1, y: 1, rotate: -8, scale: .86, opacity: .68 },
        animate: {
          x: [-1, 1, -1],
          y: [1, -2, 0, 1],
          rotate: [-8, 7, 1, -8],
          scale: [.86, 1.13, .96, .86],
          opacity: [.68, 1, .84, .68]
        },
        transition: { duration: .92, ease: "easeInOut" as const, repeat: Infinity }
      };
    }
    if (visualState === "preparing") {
      return {
        initial: { rotate: 0 },
        animate: { rotate: [0, 360] },
        transition: { duration: 1.1, ease: "linear" as const, repeat: Infinity }
      };
    }
    if (visualState === "queued") {
      return {
        initial: { scale: .9, opacity: .65 },
        animate: { scale: [.9, 1.08, .9], opacity: [.65, 1, .65] },
        transition: { duration: 1.4, ease: "easeInOut" as const, repeat: Infinity }
      };
    }
    return { initial: false, animate: {}, transition: { duration: 0 } };
  })();

  return (
    <span
      className="popo-download-state-icon"
      aria-hidden="true"
    >
      <motion.span
        className="popo-download-state-icon-motion"
        initial={activeMotion.initial}
        animate={activeMotion.animate}
        transition={activeMotion.transition}
      >
        <Icon aria-hidden="true" focusable="false" strokeWidth={1.8} />
      </motion.span>
    </span>
  );
}

function FolderWorkBeat({
  active,
  reducedMotion
}: {
  active: boolean;
  reducedMotion: boolean | null;
}) {
  if (!active) return null;
  return (
    <span className="popo-download-work-beat" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <motion.i
          key={index}
          initial={reducedMotion ? false : { scaleY: .45, opacity: .48 }}
          animate={reducedMotion
            ? { scaleY: 1, opacity: .75 }
            : { scaleY: [.45, 1.2, .55], opacity: [.48, 1, .58] }}
          transition={reducedMotion
            ? { duration: 0 }
            : {
                duration: .72,
                delay: index * -.24,
                ease: "easeInOut",
                repeat: Infinity
              }}
        />
      ))}
    </span>
  );
}

const OPTIMISTIC_SCAN_START = 12;
const OPTIMISTIC_SCAN_LIMIT = 89;
const OPTIMISTIC_SCAN_TIME_CONSTANT_MS = 10_700;

function optimisticScanProgressAt(startedAt: string | undefined, now = Date.now()): number {
  const parsedStartedAt = Date.parse(String(startedAt || ""));
  const elapsed = Number.isFinite(parsedStartedAt)
    ? Math.max(0, now - parsedStartedAt)
    : 0;
  const progress = OPTIMISTIC_SCAN_LIMIT -
    (OPTIMISTIC_SCAN_LIMIT - OPTIMISTIC_SCAN_START) *
    Math.exp(-elapsed / OPTIMISTIC_SCAN_TIME_CONSTANT_MS);
  return Math.min(OPTIMISTIC_SCAN_LIMIT, Math.max(OPTIMISTIC_SCAN_START, progress));
}

function useOptimisticScanProgress(
  active: boolean,
  reducedMotion: boolean | null,
  startedAt: string | undefined
): number {
  const fallbackStartedAt = useRef(Date.now());
  const wasActive = useRef(active);
  const [progress, setProgress] = useState(
    active ? optimisticScanProgressAt(startedAt) : 0
  );
  useEffect(() => {
    if (!active) {
      wasActive.current = false;
      fallbackStartedAt.current = Date.now();
      setProgress(0);
      return;
    }
    const parsedStartedAt = Date.parse(String(startedAt || ""));
    if (!Number.isFinite(parsedStartedAt) && !wasActive.current) {
      fallbackStartedAt.current = Date.now();
    }
    wasActive.current = true;
    const progressStartedAt = Number.isFinite(parsedStartedAt)
      ? startedAt
      : new Date(fallbackStartedAt.current).toISOString();
    if (reducedMotion) {
      setProgress(optimisticScanProgressAt(progressStartedAt));
      return;
    }
    const update = () => setProgress(optimisticScanProgressAt(progressStartedAt));
    update();
    const timer = window.setInterval(update, 120);
    return () => window.clearInterval(timer);
  }, [active, reducedMotion, startedAt]);
  return progress;
}

function FolderProgressFill({
  className,
  progress,
  reducedMotion,
  transitionMs
}: {
  className: string;
  progress: number;
  reducedMotion: boolean | null;
  transitionMs: number;
}) {
  const [transitionEnabled, setTransitionEnabled] = useState(false);
  useLayoutEffect(() => {
    if (reducedMotion) return;
    const frame = window.requestAnimationFrame(() => setTransitionEnabled(true));
    return () => window.cancelAnimationFrame(frame);
  }, [reducedMotion]);
  return (
    <span
      className={className}
      style={{
        width: `${progress}%`,
        transition: transitionEnabled && !reducedMotion
          ? `width ${transitionMs}ms cubic-bezier(.22,.78,.24,1)`
          : "none"
      }}
    />
  );
}

function FolderButtonRail({
  display,
  reducedMotion,
  motionKey,
  scanStartedAt
}: {
  display: ReturnType<typeof folderButtonDisplay>;
  reducedMotion: boolean | null;
  motionKey: string;
  scanStartedAt: string | undefined;
}) {
  const scanning = display.visualState === "scanning";
  const downloading = display.visualState === "downloading";
  const working = scanning || downloading;
  const estimatedProgress = useOptimisticScanProgress(
    scanning,
    reducedMotion,
    scanStartedAt
  );
  const visible = display.indeterminate || display.progress != null;
  return (
    <AnimatePresence>
      {visible && (
        <motion.span
          key={display.indeterminate ? "indeterminate" : "determinate"}
          className="popo-download-rail"
          aria-hidden="true"
          initial={false}
          animate={{ opacity: 1 }}
          exit={{ opacity: reducedMotion ? 1 : 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.16 }}
        >
          {scanning ? (
            <FolderProgressFill
              key={`estimate:${motionKey}`}
              className="popo-download-estimate-fill"
              progress={estimatedProgress}
              reducedMotion={reducedMotion}
              transitionMs={180}
            />
          ) : display.indeterminate && !downloading ? (
            <motion.span
              key={`wave:${motionKey}`}
              className="popo-download-wave"
              initial={reducedMotion ? false : { x: "-120%" }}
              animate={reducedMotion ? { x: "70%" } : { x: ["-120%", "260%"] }}
              transition={reducedMotion
                ? { duration: 0 }
                : { duration: 1.15, ease: "easeInOut", repeat: Infinity }}
            />
          ) : display.progress != null ? (
            <FolderProgressFill
              key={`fill:${motionKey}`}
              className="popo-download-fill"
              progress={display.progress || 0}
              reducedMotion={reducedMotion}
              transitionMs={240}
            />
          ) : null}
          {working && (
            <>
              <motion.span
                key={`comet:${motionKey}`}
                className="popo-download-activity-comet"
                initial={reducedMotion
                  ? false
                  : { left: "-30%", opacity: 0, scaleX: .55 }}
                animate={reducedMotion
                  ? { left: "72%", opacity: .7, scaleX: 1 }
                  : {
                      left: ["-30%", "70%", "74%", "108%"],
                      opacity: [0, 1, .72, 0],
                      scaleX: [.55, 1.22, .7, 1]
                    }}
                transition={reducedMotion
                  ? { duration: 0 }
                  : { duration: 1.22, ease: "easeInOut", repeat: Infinity }}
              />
              {[0, 1, 2].map((index) => (
                <motion.i
                  key={`${motionKey}:packet:${index}`}
                  className="popo-download-activity-packet"
                  initial={reducedMotion
                    ? false
                    : { left: "-6%", y: 0, opacity: 0, scale: .55 }}
                  animate={reducedMotion
                    ? { left: `${32 + index * 18}%`, opacity: .72, scale: 1 }
                    : {
                        left: ["-6%", "38%", "43%", "103%"],
                        y: [0, -1, 1, 0],
                        opacity: [0, 1, .75, 0],
                        scale: [.55, 1.3, .7, 1.05]
                      }}
                  transition={reducedMotion
                    ? { duration: 0 }
                    : {
                        duration: 1.88,
                        delay: index * -.62,
                        ease: "easeInOut",
                        repeat: Infinity
                      }}
                />
              ))}
            </>
          )}
          {display.warningSegment && (
            <motion.span
              className="popo-download-warning-segment"
              initial={reducedMotion ? false : { opacity: 0, scaleX: 0 }}
              animate={{ opacity: 1, scaleX: 1 }}
              transition={{ duration: reducedMotion ? 0 : 0.18 }}
            />
          )}
        </motion.span>
      )}
    </AnimatePresence>
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
  const [outcome, setOutcome] = useState<QueueJob | null>(null);
  const lastActiveJob = useRef<QueueJob | null>(null);
  const reducedMotion = useReducedMotion();
  const activeJob = findMatchingFolderJob(state, item);
  const receipt = findMatchingFolderReceipt(state, item);
  const receiptJob = useMemo<QueueJob | null>(() => receipt ? {
    id: `receipt:${receipt.key}`,
    key: receipt.key,
    status: "complete",
    folderName: receipt.folderName,
    folderItemIndex: receipt.folderItemIndex,
    parentUrl: receipt.parentUrl,
    completedAt: receipt.completedAt,
    counts: receipt.counts,
    verifiedCompletion: true
  } : null, [receipt]);
  const transitionOutcome = !activeJob && lastActiveJob.current
    ? (state?.jobs || []).find((candidate) =>
        candidate.id === lastActiveJob.current?.id && jobIsTerminal(candidate)
      ) || null
    : null;
  const visibleJob = activeJob || transitionOutcome || outcome || receiptJob;
  const display = folderButtonDisplay(visibleJob, starting);
  const motionKey = `${visibleJob?.id || "transient"}:${display.visualState}`;
  const terminalJob = visibleJob && jobIsTerminal(visibleJob) ? visibleJob : null;
  const statusText = [display.primary, display.secondary].filter(Boolean).join("，");
  const title = starting
    ? "正在添加下载"
    : activeJob
      ? `${statusText || "任务进行中"}，点击查看任务`
      : receiptJob && visibleJob === receiptJob
        ? "已核对完成，数量一致且无遗漏；点击可重新下载"
      : terminalJob
        ? `${statusText}，点击${terminalJob.status === "cancelled" && recoverableCount(terminalJob) > 0
            ? "继续"
            : terminalJob.status === "complete" && display.visualState === "success"
              ? "重新查找"
              : "重试"}`
        : "稳定下载此文件夹";

  useEffect(() => {
    if (activeJob) {
      lastActiveJob.current = activeJob;
      setOutcome(null);
      return;
    }
    const previous = lastActiveJob.current;
    if (!previous) return;
    const terminal = (state?.jobs || []).find((candidate) =>
      candidate.id === previous.id && jobIsTerminal(candidate)
    );
    if (!terminal) return;
    lastActiveJob.current = null;
    setOutcome(terminal);
  }, [activeJob, state?.jobs]);

  useEffect(() => {
    if (!outcome) return;
    const outcomeId = outcome.id;
    const timer = window.setTimeout(() => {
      setOutcome((current) => current?.id === outcomeId ? null : current);
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [outcome?.completedAt, outcome?.id]);

  const requestFolderScan = async () => {
    const response = await callExtension<{
      needsWorker?: boolean;
      job?: QueueJob;
      coveredByPageDownload?: boolean;
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
    return response;
  };

  const handleClick = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (activeJob) {
      onInspect(activeJob.id);
      return;
    }
    setOutcome(null);
    lastActiveJob.current = null;
    setStarting(true);
    try {
      if (terminalJob?.status === "failed" && terminalJob.failureRetryKeys?.length) {
        await callExtension({ type: "RETRY_JOB", jobId: terminalJob.id });
      } else if (
        terminalJob?.status === "cancelled" &&
        recoverableCount(terminalJob) > 0
      ) {
        await callExtension({ type: "RESTORE_CANCELLED_JOB", jobId: terminalJob.id });
      } else {
        const response = await requestFolderScan();
        if (response.coveredByPageDownload && response.job) {
          onInspect(response.job.id);
        }
      }
      await refresh();
    } catch (error) {
      if (terminalJob) setOutcome(terminalJob);
      onError(item.name, error);
    } finally {
      setStarting(false);
    }
  };

  return (
    <motion.button
      layout
      initial={false}
      transition={reducedMotion
        ? { duration: 0 }
        : { layout: { type: "spring", stiffness: 420, damping: 34 } }}
      whileTap={reducedMotion ? {} : { scale: 0.97 }}
      type="button"
      className={DOWNLOAD_BUTTON_CLASS}
      data-popo-react-owned="true"
      data-state={display.visualState}
      data-expanded={display.visualState === "idle" ? "false" : "true"}
      data-job-status={visibleJob?.status || ""}
      data-job-id={visibleJob?.id || ""}
      data-folder-name={item.name}
      disabled={starting}
      title={title}
      aria-label={`${item.name}：${title}`}
      aria-busy={[
        "preparing",
        "scanning",
        "downloading"
      ].includes(display.visualState) || undefined}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => void handleClick(event)}
    >
      {display.visualState === "idle" && (
        <motion.span
          className="popo-download-idle-icon"
          aria-hidden="true"
          initial={false}
          whileHover={reducedMotion ? {} : { y: 1, scale: 1.08 }}
        >
          <Download aria-hidden="true" focusable="false" strokeWidth={1.8} />
        </motion.span>
      )}
      <AnimatePresence mode="popLayout">
        {display.primary && (
          <motion.span
            key={`${visibleJob?.id || "transient"}:${display.visualState}:${visibleJob?.status || "starting"}`}
            className="popo-download-content"
            initial={reducedMotion ? false : { opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: reducedMotion ? 1 : 0, y: reducedMotion ? 0 : -3 }}
            transition={{ duration: reducedMotion ? 0 : 0.16 }}
          >
            <FolderButtonStateIcon
              visualState={display.visualState}
              reducedMotion={reducedMotion}
            />
            <span className="popo-download-primary">{display.primary}</span>
            <FolderWorkBeat
              active={["scanning", "downloading"].includes(display.visualState)}
              reducedMotion={reducedMotion}
            />
            {display.secondary && (
              <span className="popo-download-secondary">{display.secondary}</span>
            )}
          </motion.span>
        )}
      </AnimatePresence>
      <FolderButtonRail
        display={display}
        reducedMotion={reducedMotion}
        motionKey={motionKey}
        scanStartedAt={visibleJob?.startedAt}
      />
    </motion.button>
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
  const networkVisible = networkReminderVisible(state?.networkHealth) &&
    state?.networkHealth?.jobId === primary.id;

  const baseSummary = active.length
    ? summarizeLiveJobs(active)
    : attention.length + " 个需要处理";
  const summary = networkVisible ? `${baseSummary} · 网络慢` : baseSummary;

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
      data-status={primary.status}
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
          {networkVisible && (
            <div className="popo-network-notice" role="status">
              <strong>本地线路可能拥堵</strong>
              <span>{networkHealthSummary(state?.networkHealth)}。下载仍在继续，与代理设置无关。</span>
              <div className="popo-page-actions">
                <button
                  type="button"
                  className="popo-page-action"
                  disabled={busy}
                  onClick={() => void run({ type: "SNOOZE_NETWORK_REMINDER" })}
                >
                  15 分钟后提醒
                </button>
                <button
                  type="button"
                  className="popo-page-action"
                  disabled={busy}
                  onClick={() => void run({ type: "MUTE_NETWORK_REMINDER_TODAY" })}
                >
                  今日不再提醒
                </button>
              </div>
            </div>
          )}
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
  onInspect,
  onNetworkSnooze
}: {
  toast: ToastRecord;
  onDismiss: (id: string) => void;
  onInspect: (jobId: string) => void;
  onNetworkSnooze: () => Promise<void>;
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
        {toast.source === "network" && (
          <button
            type="button"
            className="popo-toast-action"
            onClick={() => {
              void onNetworkSnooze()
                .then(() => onDismiss(toast.id))
                .catch(() => undefined);
            }}
          >
            15 分钟后提醒
          </button>
        )}
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
          aria-label={toast.source === "network" ? "继续下载并关闭提示" : "关闭提示"}
        >
          {toast.source === "network" ? "继续下载" : "关闭"}
        </button>
      </div>
    </aside>
  );
}

function ToastViewport({
  toasts,
  onDismiss,
  onInspect,
  onNetworkSnooze
}: {
  toasts: ToastRecord[];
  onDismiss: (id: string) => void;
  onInspect: (jobId: string) => void;
  onNetworkSnooze: () => Promise<void>;
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
          onNetworkSnooze={onNetworkSnooze}
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
  useNetworkNotifications(state, pushToast, popupOpen);

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

  const snoozeNetworkReminder = useCallback(async () => {
    try {
      await callExtension({ type: "SNOOZE_NETWORK_REMINDER" });
      await refresh();
    } catch (error) {
      showActionError("网络提醒", error);
      throw error;
    }
  }, [refresh, showActionError]);

  const portals = useMemo<ReactNode[]>(() => {
    const values: ReactNode[] = [];
    if (snapshot.countTarget) {
      values.push(createPortal(
        <>
          <ProjectCount count={count} />
          <PageDownloadButton
            pageName={snapshot.pageName}
            parentUrl={snapshot.url}
            count={count}
            state={state}
            refresh={refresh}
            onError={showActionError}
          />
        </>,
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
    state,
    snapshot.countTarget,
    snapshot.folderTargets,
    snapshot.pageName,
    snapshot.url
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
        onNetworkSnooze={snoozeNetworkReminder}
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
