export const JOB_STATUSES = [
  "queued",
  "waiting_worker",
  "scanning",
  "scan_complete",
  "awaiting_confirmation",
  "starting",
  "downloading",
  "paused",
  "draining",
  "draining_paused",
  "complete",
  "cancelled",
  "failed"
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobCounts {
  files?: number | undefined;
  folders?: number | undefined;
  total?: number | undefined;
  discoveredFiles?: number | undefined;
  scanFailures?: number | undefined;
  pending?: number | undefined;
  success?: number | undefined;
  failed?: number | undefined;
  cancelled?: number | undefined;
  active?: number | undefined;
  handedOff?: number | undefined;
  verifiedDirectories?: number | undefined;
  unverifiedDirectories?: number | undefined;
  scanRetries?: number | undefined;
}

export interface QueueJob {
  id: string;
  key?: string | undefined;
  batchId?: string | undefined;
  batchParentUrl?: string | undefined;
  batchPaused?: boolean | undefined;
  status: JobStatus;
  folderName?: string | undefined;
  displayName?: string | undefined;
  folderItemIndex?: string | undefined;
  parentUrl?: string | undefined;
  scope?: "folder" | "page" | undefined;
  queuePosition?: number | undefined;
  counts?: JobCounts | undefined;
  cancelRequested?: boolean | undefined;
  cancelledRetryKeys?: string[] | undefined;
  failureRetryKeys?: string[] | undefined;
  createdAt?: string | undefined;
  startedAt?: string | undefined;
  updatedAt?: string | undefined;
  completedAt?: string | undefined;
  verifiedCompletion?: boolean | undefined;
}

export interface FolderCompletionReceipt {
  key: string;
  parentUrl: string;
  folderItemIndex: string;
  folderName: string;
  completedAt: string;
  counts?: JobCounts | undefined;
}

export const FOLDER_RECEIPT_FEEDBACK_MS = 2 * 60 * 1000;

export function folderReceiptFeedbackRemaining(
  receipt: FolderCompletionReceipt | null | undefined,
  now = Date.now()
): number {
  const completedAt = Date.parse(String(receipt?.completedAt || ""));
  if (!Number.isFinite(completedAt)) return 0;
  const age = Math.max(0, now - completedAt);
  return Math.max(0, FOLDER_RECEIPT_FEEDBACK_MS - age);
}

export interface QueueState {
  jobs?: QueueJob[] | undefined;
  folderReceipts?: FolderCompletionReceipt[] | undefined;
  activeJobId?: string | null | undefined;
  mode?: JobStatus | "idle" | undefined;
  triggerMode?: string | undefined;
  workerFrameId?: number | null | undefined;
  gopeedConnected?: boolean | undefined;
  popupOpen?: boolean | undefined;
  networkHealth?: NetworkHealth | undefined;
}

export interface GopeedSettings {
  gopeedEndpoint?: string | undefined;
  gopeedToken?: string | undefined;
  gopeedDownloadDirOverride?: string | undefined;
  concurrency?: number | undefined;
}

export interface GopeedConnection {
  connected: boolean;
  downloadDir?: string | undefined;
  error?: string | undefined;
}

export type NotificationKind = "success" | "error" | "warning";

export interface UiNotification {
  id: string;
  jobId: string;
  kind: NotificationKind;
  title: string;
  message: string;
  timeoutMs: number | null;
  source?: "network" | undefined;
}

export interface ServiceNoticeTracker {
  connected: boolean | null;
  outageSequence: number;
  outageNotified: boolean;
}

export interface NetworkNoticeTracker {
  peakNoticeSequence: number;
  noticeSequence: number;
}

export const MODE_LABELS: Readonly<Record<JobStatus | "idle", string>> = {
  idle: "可使用",
  queued: "排队中",
  scanning: "查找文件",
  waiting_worker: "准备中",
  awaiting_confirmation: "准备中",
  starting: "准备中",
  downloading: "下载中",
  paused: "已暂停",
  draining: "正在停止",
  draining_paused: "已暂停",
  complete: "已完成",
  cancelled: "已停止",
  failed: "未完成",
  scan_complete: "准备中"
};

const TERMINAL_JOB_STATUSES = new Set<JobStatus>(["complete", "cancelled", "failed"]);
const ACTIVE_JOB_STATUSES = new Set<JobStatus>([
  "queued",
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

export function jobName(job: QueueJob): string {
  return String(job.folderName || job.displayName || "未命名文件夹");
}

export function jobIsTerminal(jobOrStatus: QueueJob | JobStatus): boolean {
  const status = typeof jobOrStatus === "string" ? jobOrStatus : jobOrStatus.status;
  return TERMINAL_JOB_STATUSES.has(status);
}

export function jobIsActive(jobOrStatus: QueueJob | JobStatus): boolean {
  const status = typeof jobOrStatus === "string" ? jobOrStatus : jobOrStatus.status;
  return ACTIVE_JOB_STATUSES.has(status);
}

export function jobNeedsAttention(job: QueueJob): boolean {
  if (job.status === "failed") return true;
  return job.status === "cancelled" && recoverableCount(job) > 0;
}

export function recoverableCount(job: QueueJob): number {
  return job.cancelledRetryKeys?.length || Number(job.counts?.cancelled) || 0;
}

export function failedRetryCount(job: QueueJob): number {
  const fileFailures = job.failureRetryKeys?.length || Number(job.counts?.failed) || 0;
  const directoryIssues = Math.max(
    Number(job.counts?.scanFailures) || 0,
    Number(job.counts?.unverifiedDirectories) || 0
  );
  return fileFailures + directoryIssues;
}

export function jobDetail(job: QueueJob): string {
  const counts = job.counts || {};
  const directoryIssues = Math.max(
    Number(counts.scanFailures) || 0,
    Number(counts.unverifiedDirectories) || 0
  );
  const directoryIssueSuffix = directoryIssues ? ` · 遗漏 ${directoryIssues} 个目录` : "";
  if (job.status === "queued") {
    const position = Number(job.queuePosition) || 0;
    return position > 0 ? `排队第 ${position}` : "排队中";
  }
  if (["waiting_worker", "scanning"].includes(job.status)) {
    const discovered = Number(counts.discoveredFiles) || 0;
    const handedOff = Number(counts.handedOff) || 0;
    const detail = handedOff
      ? `边查找边下载 · 已找到 ${discovered} 个 · 已交付 ${handedOff} 个`
      : `已找到 ${discovered} 个文件`;
    return `${detail}${directoryIssueSuffix}`;
  }
  const success = Number(counts.success) || 0;
  const failed = Number(counts.failed) || 0;
  const cancelled = Number(counts.cancelled) || 0;
  const total = Number(counts.files ?? counts.total) || 0;
  if (job.status === "cancelled") {
    return cancelled ? `已完成 ${success} 个 · ${cancelled} 个可继续` : `已完成 ${success} 个`;
  }
  if (job.status === "failed") {
    if (directoryIssues) {
      const fileDetail = total ? `文件已完成 ${success} / ${total}` : "文件查找未完整";
      return `${fileDetail}${directoryIssueSuffix}`;
    }
    return failed ? `已完成 ${success} 个 · ${failed} 个未完成` : "未能开始，请打开 POPO 后重试";
  }
  if (job.status === "complete") {
    const completed = Object.prototype.hasOwnProperty.call(counts, "success") ? success : total;
    return `已完成 ${completed} 个文件`;
  }
  if (!total) return "正在准备文件";
  const paused = ["paused", "draining_paused"].includes(job.status) ? "已暂停 · " : "";
  return `${paused}文件已完成 ${success} / ${total}${directoryIssueSuffix}`;
}

export function jobProgress(job: QueueJob): number | null {
  if (["queued", "waiting_worker", "scanning"].includes(job.status)) return null;
  const counts = job.counts || {};
  const total = Number(counts.files ?? counts.total) || 0;
  if (!total) return jobIsTerminal(job) ? 0 : null;
  const success = Number(counts.success) || 0;
  return Math.max(0, Math.min(100, Math.round(success * 100 / total)));
}

export type FolderButtonVisualState =
  | "idle"
  | "queued"
  | "preparing"
  | "scanning"
  | "ready"
  | "downloading"
  | "paused"
  | "success"
  | "empty"
  | "warning"
  | "failed";

export interface FolderButtonDisplay {
  visualState: FolderButtonVisualState;
  primary: string;
  secondary: string;
  progress: number | null;
  indeterminate: boolean;
  warningSegment: boolean;
}

export interface PageDownloadBatchSummary {
  id: string;
  jobs: QueueJob[];
  paused: boolean;
  activeCount: number;
  queuedCount: number;
}

function countValue(value: unknown): number {
  return Math.max(0, Number(value) || 0);
}

export function folderButtonDisplay(
  job: QueueJob | null | undefined,
  starting = false
): FolderButtonDisplay {
  if (starting) {
    return {
      visualState: "preparing",
      primary: "正在添加",
      secondary: "",
      progress: null,
      indeterminate: true,
      warningSegment: false
    };
  }
  if (!job) {
    return {
      visualState: "idle",
      primary: "",
      secondary: "",
      progress: null,
      indeterminate: false,
      warningSegment: false
    };
  }

  const counts = job.counts || {};
  const discovered = countValue(counts.discoveredFiles ?? counts.files ?? counts.total);
  const total = countValue(counts.files ?? counts.total ?? counts.discoveredFiles);
  const success = countValue(counts.success);
  const failed = countValue(counts.failed);
  const scanFailures = countValue(counts.scanFailures);
  const unverifiedDirectories = countValue(counts.unverifiedDirectories);
  const scanIssueCount = Math.max(scanFailures, unverifiedDirectories);
  const warningSegment = scanIssueCount > 0;
  const handedOff = countValue(counts.handedOff);

  if (job.batchPaused && !jobIsTerminal(job)) {
    const position = countValue(job.queuePosition);
    return {
      visualState: "paused",
      primary: "批次已暂停",
      secondary: job.status === "queued" && position ? `第 ${position}` : "",
      progress: null,
      indeterminate: false,
      warningSegment: false
    };
  }

  if (job.status === "queued") {
    const position = countValue(job.queuePosition);
    return {
      visualState: "queued",
      primary: "排队中",
      secondary: position ? `第 ${position}` : "",
      progress: null,
      indeterminate: false,
      warningSegment: false
    };
  }
  if (job.status === "waiting_worker") {
    return {
      visualState: "preparing",
      primary: "准备查找",
      secondary: "",
      progress: null,
      indeterminate: true,
      warningSegment: false
    };
  }
  if (job.status === "scanning") {
    return {
      visualState: "scanning",
      primary: handedOff ? "边找边下" : "查找中",
      secondary: handedOff
        ? `找到 ${discovered} · 已交付 ${handedOff}`
        : `已找到 ${discovered} 个`,
      progress: null,
      indeterminate: true,
      warningSegment: false
    };
  }
  if (["scan_complete", "awaiting_confirmation", "starting"].includes(job.status)) {
    if (scanIssueCount > 0) {
      return {
        visualState: "warning",
        primary: `找到 ${discovered} 个`,
        secondary: scanFailures
          ? `遗漏 ${scanFailures} 处`
          : `${unverifiedDirectories} 处未核对`,
        progress: 100,
        indeterminate: false,
        warningSegment: true
      };
    }
    if (!discovered) {
      return {
        visualState: "empty",
        primary: "未找到文件",
        secondary: "",
        progress: 0,
        indeterminate: false,
        warningSegment: false
      };
    }
    return {
      visualState: "ready",
      primary: `已找到 ${discovered} 个`,
      secondary: "准备下载",
      progress: 100,
      indeterminate: false,
      warningSegment: false
    };
  }
  if (["downloading", "draining"].includes(job.status)) {
    return {
      visualState: "downloading",
      primary: job.status === "draining" ? "正在停止" : "下载中",
      secondary: total
        ? `文件 ${success} / ${total}${scanIssueCount ? ` · 遗漏 ${scanIssueCount} 个目录` : ""}`
        : scanIssueCount ? `遗漏 ${scanIssueCount} 个目录` : "",
      progress: jobProgress(job),
      indeterminate: jobProgress(job) == null,
      warningSegment
    };
  }
  if (["paused", "draining_paused"].includes(job.status)) {
    return {
      visualState: "paused",
      primary: "已暂停",
      secondary: total
        ? `文件 ${success} / ${total}${scanIssueCount ? ` · 遗漏 ${scanIssueCount} 个目录` : ""}`
        : scanIssueCount ? `遗漏 ${scanIssueCount} 个目录` : "",
      progress: jobProgress(job),
      indeterminate: false,
      warningSegment
    };
  }
  if (job.status === "complete") {
    if (scanIssueCount > 0) {
      return {
        visualState: "warning",
        primary: `找到 ${discovered} 个`,
        secondary: scanFailures
          ? `遗漏 ${scanFailures} 处`
          : `${unverifiedDirectories} 处未核对`,
        progress: 100,
        indeterminate: false,
        warningSegment: true
      };
    }
    if (failed > 0) {
      return {
        visualState: "warning",
        primary: `完成 ${success} 个`,
        secondary: `未完成 ${failed} 个`,
        progress: jobProgress(job),
        indeterminate: false,
        warningSegment: true
      };
    }
    if (!total && !discovered) {
      return {
        visualState: "empty",
        primary: "未找到文件",
        secondary: "重试",
        progress: 0,
        indeterminate: false,
        warningSegment: false
      };
    }
    return {
      visualState: "success",
      primary: `${job.verifiedCompletion ? "已下载" : "已完成"} ${success || total || discovered} 个`,
      secondary: job.verifiedCompletion ? "无遗漏" : "",
      progress: 100,
      indeterminate: false,
      warningSegment: false
    };
  }
  if (job.status === "cancelled") {
    const recoverable = recoverableCount(job);
    return {
      visualState: "warning",
      primary: "已停止",
      secondary: recoverable ? `可继续 ${recoverable} 个` : "重试",
      progress: jobProgress(job),
      indeterminate: false,
      warningSegment: true
    };
  }

  if (scanIssueCount > 0) {
    return {
      visualState: "failed",
      primary: "目录未完整",
      secondary: `${total ? `文件 ${success} / ${total} · ` : ""}遗漏 ${scanIssueCount} 个目录 · 重试`,
      progress: total ? Math.round(success * 100 / total) : 0,
      indeterminate: false,
      warningSegment: false
    };
  }
  if (failed > 0) {
    return {
      visualState: "failed",
      primary: `未完成 ${failed} 个`,
      secondary: "重试",
      progress: total ? Math.round(success * 100 / total) : 0,
      indeterminate: false,
      warningSegment: false
    };
  }
  return {
    visualState: "failed",
    primary: discovered ? "下载未开始" : "查找失败",
    secondary: "重试",
    progress: 0,
    indeterminate: false,
    warningSegment: false
  };
}

export function liveJobs(state: QueueState | null | undefined): QueueJob[] {
  return (state?.jobs || []).filter(jobIsActive);
}

export function attentionJobs(state: QueueState | null | undefined): QueueJob[] {
  return (state?.jobs || []).filter(jobNeedsAttention).reverse();
}

export function completedJobs(state: QueueState | null | undefined): QueueJob[] {
  return (state?.jobs || []).filter((job) => job.status === "complete").reverse();
}

export function summarizeLiveJobs(jobs: QueueJob[]): string {
  const queued = jobs.filter((job) => job.status === "queued").length;
  const running = jobs.length - queued;
  if (running && queued) return `${running} 个进行中 · ${queued} 个排队`;
  if (running) return `${running} 个进行中`;
  if (queued) return `${queued} 个排队`;
  return "没有正在下载";
}

export function modeBadgeLabel(state: QueueState | null | undefined): string {
  const active = liveJobs(state);
  if (active.some((job) => ["paused", "draining_paused"].includes(job.status))) return "已暂停";
  if (active.length) return "任务进行中";
  if (attentionJobs(state).length) return "需要处理";
  return "可使用";
}

function normalizeText(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeParentUrl(value: unknown): string {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    return url.href;
  } catch {
    return normalizeText(value);
  }
}

export function findPageDownloadBatch(
  state: QueueState | null | undefined,
  parentUrl: string
): PageDownloadBatchSummary | null {
  const normalizedParentUrl = normalizeParentUrl(parentUrl);
  const groups = new Map<string, QueueJob[]>();
  for (const job of state?.jobs || []) {
    if (!job.batchId || !jobIsActive(job)) continue;
    if (normalizeParentUrl(job.batchParentUrl || job.parentUrl) !== normalizedParentUrl) continue;
    const group = groups.get(job.batchId) || [];
    group.push(job);
    groups.set(job.batchId, group);
  }
  const candidates = [...groups.entries()].map(([id, jobs]) => ({
    id,
    jobs,
    createdAt: jobs.reduce(
      (latest, job) => String(job.createdAt || "") > latest ? String(job.createdAt || "") : latest,
      ""
    )
  }));
  candidates.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const current = candidates[0];
  if (!current) return null;
  return {
    id: current.id,
    jobs: current.jobs,
    paused: current.jobs.some((job) =>
      Boolean(job.batchPaused) || ["paused", "draining_paused"].includes(job.status)
    ),
    activeCount: current.jobs.length,
    queuedCount: current.jobs.filter((job) => job.status === "queued").length
  };
}

export function makeFolderJobKey(input: {
  parentUrl: string;
  folderItemIndex: string;
  folderName: string;
}): string {
  return [
    normalizeParentUrl(input.parentUrl),
    normalizeText(input.folderItemIndex),
    normalizeText(input.folderName).toLocaleLowerCase()
  ].join("\u0000");
}

export function findMatchingFolderJob(
  state: QueueState | null | undefined,
  item: { parentUrl: string; itemIndex: string; name: string }
): QueueJob | null {
  const key = makeFolderJobKey({
    parentUrl: item.parentUrl,
    folderItemIndex: item.itemIndex,
    folderName: item.name
  });
  return (state?.jobs || []).find((job) => jobIsActive(job) && (
    job.key === key || (
      normalizeParentUrl(job.parentUrl) === normalizeParentUrl(item.parentUrl) &&
      normalizeText(job.folderItemIndex) === normalizeText(item.itemIndex) &&
      normalizeText(job.folderName).toLocaleLowerCase() === normalizeText(item.name).toLocaleLowerCase()
    )
  )) || null;
}

export function findMatchingFolderReceipt(
  state: QueueState | null | undefined,
  item: { parentUrl: string; itemIndex: string; name: string }
): FolderCompletionReceipt | null {
  const key = makeFolderJobKey({
    parentUrl: item.parentUrl,
    folderItemIndex: item.itemIndex,
    folderName: item.name
  });
  return (state?.folderReceipts || []).find((receipt) => receipt.key === key || (
    normalizeParentUrl(receipt.parentUrl) === normalizeParentUrl(item.parentUrl) &&
    normalizeText(receipt.folderItemIndex) === normalizeText(item.itemIndex) &&
    normalizeText(receipt.folderName).toLocaleLowerCase() === normalizeText(item.name).toLocaleLowerCase()
  )) || null;
}

export function notificationForTransition(
  previousStatus: JobStatus | null,
  job: QueueJob
): UiNotification | null {
  if (previousStatus == null || previousStatus === job.status) return null;
  const stamp = job.completedAt || job.updatedAt || job.id;
  if (job.status === "complete") {
    return {
      id: `${job.id}:complete:${stamp}`,
      jobId: job.id,
      kind: "success",
      title: jobName(job),
      message: jobDetail(job),
      timeoutMs: 3000
    };
  }
  if (job.status === "failed") {
    return {
      id: `${job.id}:failed:${stamp}`,
      jobId: job.id,
      kind: "error",
      title: jobName(job),
      message: jobDetail(job),
      timeoutMs: null
    };
  }
  return null;
}

export function nextServiceNotice(
  tracker: ServiceNoticeTracker,
  connected: boolean,
  suppressed = false
): { tracker: ServiceNoticeTracker; notification: UiNotification | null } {
  if (connected) {
    return {
      tracker: {
        connected: true,
        outageSequence: tracker.outageSequence,
        outageNotified: false
      },
      notification: null
    };
  }

  const newOutage = tracker.connected !== false;
  const outageSequence = tracker.outageSequence + (newOutage ? 1 : 0);
  if (tracker.outageNotified || suppressed) {
    return {
      tracker: { connected: false, outageSequence, outageNotified: true },
      notification: null
    };
  }

  return {
    tracker: { connected: false, outageSequence, outageNotified: true },
    notification: {
      id: `download-service-disconnected:${outageSequence}`,
      jobId: "",
      kind: "error",
      title: "下载服务不可用",
      message: "请打开右上扩展检查设置。",
      timeoutMs: null
    }
  };
}

export function formatNetworkSpeed(bytesPerSecond: unknown): string {
  const speed = Math.max(0, Number(bytesPerSecond) || 0);
  if (speed >= 1024 * 1024) {
    const value = speed / (1024 * 1024);
    return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} MB/s`;
  }
  if (speed >= 1024) return `${(speed / 1024).toFixed(0)} KB/s`;
  return `${Math.round(speed)} B/s`;
}

export function networkReminderVisible(health: NetworkHealth | null | undefined): boolean {
  return Boolean(
    health &&
    !health.suppressed &&
    health.activeTasks >= 3 &&
    ["slow", "severe"].includes(health.status)
  );
}

export function networkHealthSummary(health: NetworkHealth | null | undefined): string {
  if (!health) return "";
  const speed = formatNetworkSpeed(health.medianSpeed);
  const baseline = formatNetworkSpeed(health.baselineSpeed);
  if (health.status === "severe") {
    return `多个任务接近停滞 · 当前中位速度 ${speed} · 平时约 ${baseline}`;
  }
  if (health.status === "slow") {
    return `多个任务明显低速 · 当前中位速度 ${speed} · 平时约 ${baseline}`;
  }
  if (health.highProbabilityWindow && health.activeTasks > 0) {
    return `16:30–18:30 是本地线路慢速高发时段 · 当前中位速度 ${speed}`;
  }
  if (health.activeTasks >= 3 && ["warming", "normal"].includes(health.status)) {
    return `网络速度正常 · 当前中位速度 ${speed}`;
  }
  return "正在等待足够的并行任务判断本地网络";
}

export function nextNetworkNotice(
  tracker: NetworkNoticeTracker,
  health: NetworkHealth | null | undefined,
  suppressed = false
): { tracker: NetworkNoticeTracker; notification: UiNotification | null } {
  if (!health) return { tracker, notification: null };
  const nextTracker = {
    peakNoticeSequence: Math.max(tracker.peakNoticeSequence, health.peakNoticeSequence || 0),
    noticeSequence: Math.max(tracker.noticeSequence, health.noticeSequence || 0)
  };
  if (suppressed || health.suppressed) return { tracker: nextTracker, notification: null };

  if ((health.noticeSequence || 0) > tracker.noticeSequence &&
      ["slow", "severe"].includes(health.status)) {
    return {
      tracker: nextTracker,
      notification: {
        id: `network-speed:${health.jobId || "active"}:${health.noticeSequence}`,
        jobId: health.jobId || "",
        kind: "warning",
        source: "network",
        title: health.status === "severe" ? "当前下载接近停滞" : "当前下载速度明显偏低",
        message: `${networkHealthSummary(health)}。可能是本地网络拥堵，下载仍在继续，与代理设置无关。`,
        timeoutMs: 10_000
      }
    };
  }

  if ((health.peakNoticeSequence || 0) > tracker.peakNoticeSequence) {
    return {
      tracker: nextTracker,
      notification: {
        id: `network-window:${health.peakNotifiedDate || health.peakNoticeSequence}`,
        jobId: health.jobId || "",
        kind: "warning",
        source: "network",
        title: "进入本地线路慢速高发时段",
        message: "16:30–18:30 出现慢速的概率较高；下载会继续，只有实际持续低速时才会再次提醒。",
        timeoutMs: 8_000
      }
    };
  }

  return { tracker: nextTracker, notification: null };
}

export function inferVirtualListItemCount(input: {
  indices?: Array<string | null> | undefined;
  knownSizes?: Array<string | null> | undefined;
  paddingBottom?: string | undefined;
  explicitEmpty?: boolean | undefined;
} = {}): number | null {
  if (input.explicitEmpty) return 0;
  const numericIndices = (input.indices || [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0);
  if (!numericIndices.length) return null;
  const maxIndex = Math.max(...numericIndices);
  const sizes = (input.knownSizes || [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  const bottomPixels = Number.parseFloat(input.paddingBottom || "");
  if (!sizes.length || !Number.isFinite(bottomPixels) || bottomPixels <= 0) return maxIndex + 1;
  const knownSize = sizes[Math.floor(sizes.length / 2)];
  if (knownSize == null) return null;
  const remaining = bottomPixels / knownSize;
  const roundedRemaining = Math.round(remaining);
  if (Math.abs(remaining - roundedRemaining) > 0.08) return null;
  return maxIndex + 1 + roundedRemaining;
}

export function userFacingError(error: unknown): string {
  const detail = String(error instanceof Error ? error.message : error || "").replace(/^Error:\s*/, "");
  if (/已经不在列表|没有可重试|没有可恢复|已经恢复完成|任务.*进行/.test(detail)) return detail;
  if (/请先打开|POPO 页面|页面已关闭/.test(detail)) return "请先打开 POPO 页面，再试一次。";
  return "操作没有完成，请稍后重试。";
}
import type { NetworkHealth } from "./network-monitor";

export type { NetworkHealth, NetworkHealthStatus } from "./network-monitor";
