export const NETWORK_BASELINE_BYTES_PER_SECOND = 20 * 1024 * 1024;
export const NETWORK_MIN_ACTIVE_TASKS = 3;
export const NETWORK_WARMUP_MS = 60_000;
export const NETWORK_SLOW_DURATION_MS = 90_000;
export const NETWORK_SEVERE_DURATION_MS = 60_000;
export const NETWORK_RECOVERY_DURATION_MS = 30_000;
export const NETWORK_SLOW_RATIO = 0.2;
export const NETWORK_SEVERE_RATIO = 0.05;
export const NETWORK_RECOVERY_RATIO = 0.4;

export type NetworkHealthStatus = "idle" | "warming" | "normal" | "slow" | "severe";

export interface NetworkHealth {
  version: 1;
  jobId: string;
  status: NetworkHealthStatus;
  activeTasks: number;
  medianSpeed: number;
  baselineSpeed: number;
  observedAt: string;
  sessionStartedAt: string;
  lowSince: string;
  severeSince: string;
  recoverySince: string;
  statusChangedAt: string;
  highProbabilityWindow: boolean;
  peakNoticeSequence: number;
  peakNotifiedDate: string;
  noticeSequence: number;
  lastNoticeAt: string;
  snoozedUntil: string;
  snoozeReminderPending: boolean;
  mutedDate: string;
  suppressed: boolean;
}

export interface NetworkSampleInput {
  jobId?: unknown;
  speeds?: unknown;
  nowMs?: number | undefined;
  baselineSpeed?: number | undefined;
}

interface ShanghaiClock {
  date: string;
  minuteOfDay: number;
}

const shanghaiFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});

function nonNegativeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  return Math.floor(nonNegativeNumber(value, fallback));
}

function iso(value: unknown): string {
  const text = String(value || "");
  return Number.isFinite(Date.parse(text)) ? text : "";
}

function elapsedSince(value: string, nowMs: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : 0;
}

function shanghaiClock(nowMs: number): ShanghaiClock {
  const parts = Object.fromEntries(
    shanghaiFormatter.formatToParts(new Date(nowMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  const hour = nonNegativeInteger(parts.hour);
  const minute = nonNegativeInteger(parts.minute);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: hour * 60 + minute
  };
}

export function isHighProbabilityWindow(nowMs = Date.now()): boolean {
  const minuteOfDay = shanghaiClock(nowMs).minuteOfDay;
  return minuteOfDay >= 16 * 60 + 30 && minuteOfDay < 18 * 60 + 30;
}

export function medianSpeed(values: unknown): number {
  const speeds = Array.isArray(values)
    ? values.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0)
    : [];
  if (!speeds.length) return 0;
  speeds.sort((left, right) => left - right);
  const middle = Math.floor(speeds.length / 2);
  return speeds.length % 2
    ? speeds[middle]!
    : (speeds[middle - 1]! + speeds[middle]!) / 2;
}

export function createNetworkHealth(nowMs = Date.now()): NetworkHealth {
  const now = new Date(nowMs).toISOString();
  return {
    version: 1,
    jobId: "",
    status: "idle",
    activeTasks: 0,
    medianSpeed: 0,
    baselineSpeed: NETWORK_BASELINE_BYTES_PER_SECOND,
    observedAt: now,
    sessionStartedAt: "",
    lowSince: "",
    severeSince: "",
    recoverySince: "",
    statusChangedAt: now,
    highProbabilityWindow: false,
    peakNoticeSequence: 0,
    peakNotifiedDate: "",
    noticeSequence: 0,
    lastNoticeAt: "",
    snoozedUntil: "",
    snoozeReminderPending: false,
    mutedDate: "",
    suppressed: false
  };
}

export function normalizeNetworkHealth(value: unknown, nowMs = Date.now()): NetworkHealth {
  const fallback = createNetworkHealth(nowMs);
  if (!value || typeof value !== "object") return fallback;
  const input = value as Partial<NetworkHealth>;
  const status: NetworkHealthStatus = ["idle", "warming", "normal", "slow", "severe"]
    .includes(String(input.status))
      ? input.status as NetworkHealthStatus
      : "idle";
  return {
    version: 1,
    jobId: String(input.jobId || "").slice(0, 200),
    status,
    activeTasks: nonNegativeInteger(input.activeTasks),
    medianSpeed: nonNegativeNumber(input.medianSpeed),
    baselineSpeed: Math.max(1, nonNegativeNumber(
      input.baselineSpeed,
      NETWORK_BASELINE_BYTES_PER_SECOND
    )),
    observedAt: iso(input.observedAt) || fallback.observedAt,
    sessionStartedAt: iso(input.sessionStartedAt),
    lowSince: iso(input.lowSince),
    severeSince: iso(input.severeSince),
    recoverySince: iso(input.recoverySince),
    statusChangedAt: iso(input.statusChangedAt) || fallback.statusChangedAt,
    highProbabilityWindow: Boolean(input.highProbabilityWindow),
    peakNoticeSequence: nonNegativeInteger(input.peakNoticeSequence),
    peakNotifiedDate: String(input.peakNotifiedDate || "").slice(0, 10),
    noticeSequence: nonNegativeInteger(input.noticeSequence),
    lastNoticeAt: iso(input.lastNoticeAt),
    snoozedUntil: iso(input.snoozedUntil),
    snoozeReminderPending: Boolean(input.snoozeReminderPending),
    mutedDate: String(input.mutedDate || "").slice(0, 10),
    suppressed: Boolean(input.suppressed)
  };
}

function resetObservation(
  previous: NetworkHealth,
  nowMs: number,
  jobId: string,
  highProbabilityWindow: boolean
): NetworkHealth {
  return {
    ...previous,
    jobId,
    status: "idle",
    activeTasks: 0,
    medianSpeed: 0,
    observedAt: new Date(nowMs).toISOString(),
    sessionStartedAt: "",
    lowSince: "",
    severeSince: "",
    recoverySince: "",
    statusChangedAt: previous.status === "idle"
      ? previous.statusChangedAt
      : new Date(nowMs).toISOString(),
    highProbabilityWindow,
    snoozeReminderPending: false
  };
}

export function updateNetworkHealth(value: unknown, input: NetworkSampleInput): NetworkHealth {
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const now = new Date(nowMs).toISOString();
  const clock = shanghaiClock(nowMs);
  const jobId = String(input.jobId || "").slice(0, 200);
  const speeds = Array.isArray(input.speeds)
    ? input.speeds.map((speed) => Number(speed)).filter((speed) => Number.isFinite(speed) && speed >= 0)
    : [];
  let next = normalizeNetworkHealth(value, nowMs);
  next.baselineSpeed = Math.max(1, nonNegativeNumber(
    input.baselineSpeed,
    next.baselineSpeed || NETWORK_BASELINE_BYTES_PER_SECOND
  ));

  if (next.jobId && jobId && next.jobId !== jobId) {
    next = resetObservation(next, nowMs, jobId, false);
  }
  next.jobId = jobId;
  next.activeTasks = speeds.length;
  next.medianSpeed = medianSpeed(speeds);
  next.observedAt = now;
  next.highProbabilityWindow = speeds.length > 0 && isHighProbabilityWindow(nowMs);

  const snoozeEndsAt = Date.parse(next.snoozedUntil);
  const snoozeExpired = next.snoozeReminderPending &&
    Number.isFinite(snoozeEndsAt) && snoozeEndsAt <= nowMs;
  if (snoozeExpired) next.snoozedUntil = "";
  const mutedToday = next.mutedDate === clock.date;
  const snoozed = Number.isFinite(Date.parse(next.snoozedUntil)) &&
    Date.parse(next.snoozedUntil) > nowMs;
  next.suppressed = mutedToday || snoozed;

  if (
    next.highProbabilityWindow &&
    next.peakNotifiedDate !== clock.date &&
    !next.suppressed
  ) {
    next.peakNotifiedDate = clock.date;
    next.peakNoticeSequence += 1;
  }

  if (speeds.length < NETWORK_MIN_ACTIVE_TASKS) {
    const reset = resetObservation(next, nowMs, jobId, next.highProbabilityWindow);
    reset.suppressed = next.suppressed;
    return reset;
  }

  if (!next.sessionStartedAt) {
    next.sessionStartedAt = now;
    next.statusChangedAt = now;
  }
  if (elapsedSince(next.sessionStartedAt, nowMs) < NETWORK_WARMUP_MS) {
    next.status = "warming";
    next.lowSince = "";
    next.severeSince = "";
    next.recoverySince = "";
    return next;
  }

  const slowThreshold = next.baselineSpeed * NETWORK_SLOW_RATIO;
  const severeThreshold = next.baselineSpeed * NETWORK_SEVERE_RATIO;
  const recoveryThreshold = next.baselineSpeed * NETWORK_RECOVERY_RATIO;
  const previousStatus = next.status;
  const previousNoticeSequence = next.noticeSequence;

  if (["slow", "severe"].includes(previousStatus)) {
    if (next.medianSpeed >= recoveryThreshold) {
      next.recoverySince ||= now;
      if (elapsedSince(next.recoverySince, nowMs) >= NETWORK_RECOVERY_DURATION_MS) {
        next.status = "normal";
        next.statusChangedAt = now;
        next.lowSince = "";
        next.severeSince = "";
        next.recoverySince = "";
        next.snoozeReminderPending = false;
      }
    } else {
      next.recoverySince = "";
      if (next.medianSpeed < severeThreshold) {
        next.severeSince ||= now;
        if (
          previousStatus !== "severe" &&
          elapsedSince(next.severeSince, nowMs) >= NETWORK_SEVERE_DURATION_MS
        ) {
          next.status = "severe";
        }
      } else {
        next.severeSince = "";
      }
    }
  } else if (next.medianSpeed < slowThreshold) {
    next.lowSince ||= now;
    if (next.medianSpeed < severeThreshold) next.severeSince ||= now;
    else next.severeSince = "";
    if (elapsedSince(next.severeSince, nowMs) >= NETWORK_SEVERE_DURATION_MS) {
      next.status = "severe";
    } else if (elapsedSince(next.lowSince, nowMs) >= NETWORK_SLOW_DURATION_MS) {
      next.status = "slow";
    } else {
      next.status = "normal";
    }
  } else {
    next.status = "normal";
    next.lowSince = "";
    next.severeSince = "";
    next.recoverySince = "";
  }

  const enteredSlow = !["slow", "severe"].includes(previousStatus) &&
    ["slow", "severe"].includes(next.status);
  const escalated = previousStatus === "slow" && next.status === "severe";
  if (enteredSlow || escalated) {
    next.statusChangedAt = now;
    next.noticeSequence += 1;
    next.lastNoticeAt = now;
  }

  if (
    snoozeExpired &&
    next.snoozeReminderPending &&
    ["slow", "severe"].includes(next.status) &&
    !mutedToday &&
    next.noticeSequence === previousNoticeSequence
  ) {
    next.noticeSequence += 1;
    next.lastNoticeAt = now;
  }
  if (snoozeExpired) next.snoozeReminderPending = false;
  next.suppressed = mutedToday || (
    Number.isFinite(Date.parse(next.snoozedUntil)) && Date.parse(next.snoozedUntil) > nowMs
  );
  return next;
}

export function snoozeNetworkReminder(
  value: unknown,
  minutes = 15,
  nowMs = Date.now()
): NetworkHealth {
  const next = normalizeNetworkHealth(value, nowMs);
  const safeMinutes = Math.max(1, Math.min(120, nonNegativeInteger(minutes, 15)));
  next.snoozedUntil = new Date(nowMs + safeMinutes * 60_000).toISOString();
  next.snoozeReminderPending = ["slow", "severe"].includes(next.status);
  next.suppressed = true;
  return next;
}

export function muteNetworkReminderToday(value: unknown, nowMs = Date.now()): NetworkHealth {
  const next = normalizeNetworkHealth(value, nowMs);
  next.mutedDate = shanghaiClock(nowMs).date;
  next.snoozedUntil = "";
  next.snoozeReminderPending = false;
  next.suppressed = true;
  return next;
}
