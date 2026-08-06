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
  total?: number | undefined;
  discoveredFiles?: number | undefined;
  pending?: number | undefined;
  success?: number | undefined;
  failed?: number | undefined;
  cancelled?: number | undefined;
}

export interface QueueJob {
  id: string;
  key?: string | undefined;
  status: JobStatus;
  folderName?: string | undefined;
  displayName?: string | undefined;
  folderItemIndex?: string | undefined;
  parentUrl?: string | undefined;
  queuePosition?: number | undefined;
  counts?: JobCounts | undefined;
  cancelRequested?: boolean | undefined;
  cancelledRetryKeys?: string[] | undefined;
  failureRetryKeys?: string[] | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  completedAt?: string | undefined;
}

export interface QueueState {
  jobs?: QueueJob[] | undefined;
  activeJobId?: string | null | undefined;
  mode?: JobStatus | "idle" | undefined;
  triggerMode?: string | undefined;
  workerFrameId?: number | null | undefined;
  gopeedConnected?: boolean | undefined;
  popupOpen?: boolean | undefined;
}

export interface GopeedSettings {
  gopeedEndpoint?: string | undefined;
  gopeedToken?: string | undefined;
  gopeedDownloadDirOverride?: string | undefined;
}

export interface GopeedConnection {
  connected: boolean;
  downloadDir?: string | undefined;
  error?: string | undefined;
}

export type NotificationKind = "success" | "error";

export interface UiNotification {
  id: string;
  jobId: string;
  kind: NotificationKind;
  title: string;
  message: string;
  timeoutMs: number | null;
}

export interface ServiceNoticeTracker {
  connected: boolean | null;
  outageSequence: number;
  outageNotified: boolean;
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
  return job.failureRetryKeys?.length || Number(job.counts?.failed) || 0;
}

export function jobDetail(job: QueueJob): string {
  const counts = job.counts || {};
  if (job.status === "queued") {
    const position = Number(job.queuePosition) || 0;
    return position > 0 ? `排队第 ${position}` : "排队中";
  }
  if (["waiting_worker", "scanning"].includes(job.status)) {
    return `已找到 ${Number(counts.discoveredFiles) || 0} 个文件`;
  }
  const success = Number(counts.success) || 0;
  const failed = Number(counts.failed) || 0;
  const cancelled = Number(counts.cancelled) || 0;
  const total = Number(counts.files ?? counts.total) || 0;
  if (job.status === "cancelled") {
    return cancelled ? `已完成 ${success} 个 · ${cancelled} 个可继续` : `已完成 ${success} 个`;
  }
  if (job.status === "failed") {
    return failed ? `已完成 ${success} 个 · ${failed} 个未完成` : "未能开始，请打开 POPO 后重试";
  }
  if (job.status === "complete") return `已完成 ${success || total} 个文件`;
  if (!total) return "正在准备文件";
  const paused = ["paused", "draining_paused"].includes(job.status) ? "已暂停 · " : "";
  return `${paused}已完成 ${success} / ${total}`;
}

export function jobProgress(job: QueueJob): number | null {
  if (["queued", "waiting_worker", "scanning"].includes(job.status)) return null;
  const counts = job.counts || {};
  const total = Number(counts.files ?? counts.total) || 0;
  if (!total) return jobIsTerminal(job) ? 0 : null;
  const finished = (Number(counts.success) || 0) +
    (Number(counts.failed) || 0) +
    (Number(counts.cancelled) || 0);
  return Math.max(0, Math.min(100, Math.round(finished * 100 / total)));
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
