import { createMachine, getNextSnapshot } from "xstate";
import { JOB_STATUSES, type JobStatusSchema } from "./contracts";
import type { z } from "zod";

export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JOB_STATUS_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = Object.freeze({
  queued: ["waiting_worker", "scanning", "cancelled", "failed"],
  waiting_worker: ["scanning", "cancelled", "failed"],
  scanning: ["paused", "scan_complete", "awaiting_confirmation", "starting", "complete", "cancelled", "failed"],
  scan_complete: ["starting", "downloading", "complete", "cancelled", "failed"],
  awaiting_confirmation: ["scanning", "scan_complete", "starting", "complete", "cancelled", "failed"],
  starting: ["scan_complete", "downloading", "cancelled", "failed"],
  downloading: ["paused", "draining", "draining_paused", "complete", "cancelled", "failed"],
  paused: ["scanning", "downloading", "draining", "draining_paused", "cancelled", "failed"],
  draining: ["draining_paused", "complete", "cancelled", "failed"],
  draining_paused: ["draining", "downloading", "cancelled", "failed"],
  complete: [],
  cancelled: [],
  failed: []
});

function eventType(status: JobStatus) {
  return `TO_${status.toUpperCase()}`;
}

const states = Object.fromEntries(JOB_STATUSES.map((status) => {
  const on = Object.fromEntries(JOB_STATUS_TRANSITIONS[status].map((target) => [
    eventType(target),
    { target }
  ]));
  return [status, { on }];
}));

export const jobWorkflowMachine = createMachine({
  id: "popo-job-workflow",
  initial: "queued",
  states
});

export function canTransition(currentStatus: unknown, nextStatus: unknown) {
  const current = String(currentStatus || "");
  const next = String(nextStatus || "");
  if (!JOB_STATUSES.includes(next as JobStatus)) return false;
  if (!current || !JOB_STATUSES.includes(current as JobStatus)) return true;
  if (current === next) return true;

  const snapshot = jobWorkflowMachine.resolveState({ value: current, context: {} });
  const nextSnapshot = getNextSnapshot(jobWorkflowMachine, snapshot, {
    type: eventType(next as JobStatus)
  });
  return nextSnapshot.value === next;
}

export function transitionStatus(currentStatus: unknown, nextStatus: unknown) {
  if (!canTransition(currentStatus, nextStatus)) {
    throw new Error(`非法任务状态转换：${String(currentStatus || "未设置")} → ${String(nextStatus || "未设置")}`);
  }
  return String(nextStatus) as JobStatus;
}

export const PERSISTENT_WORKFLOW_VERSION = 1;

export type PersistentWorkflowValue = {
  scan: "idle" | "running" | "complete" | "incomplete";
  handoff: "idle" | "reserved" | "preparing" | "reconciling" | "complete";
  transfer: "idle" | "active" | "draining" | "complete";
};

export interface PersistentWorkflowCounts {
  discovered: number;
  selected: number;
  skipped: number;
  pending: number;
  preparing: number;
  transferring: number;
  success: number;
  failed: number;
  cancelled: number;
  handedOff: number;
  verifiedDirectories: number;
  unverifiedDirectories: number;
  scanRetries: number;
}

export interface PersistentWorkflowSnapshot {
  version: number;
  sequence: number;
  value: PersistentWorkflowValue;
  nextAction: "scan" | "handoff";
  reservedItemId: string;
  counts: PersistentWorkflowCounts;
  updatedAt: string;
}

const workflowCounts: PersistentWorkflowCounts = Object.freeze({
  discovered: 0,
  selected: 0,
  skipped: 0,
  pending: 0,
  preparing: 0,
  transferring: 0,
  success: 0,
  failed: 0,
  cancelled: 0,
  handedOff: 0,
  verifiedDirectories: 0,
  unverifiedDirectories: 0,
  scanRetries: 0
});

export const persistentWorkflowMachine = createMachine({
  id: "popo-persistent-workflow",
  type: "parallel",
  states: {
    scan: {
      initial: "idle",
      states: {
        idle: { on: { SCAN_START: "running" } },
        running: { on: { SCAN_COMPLETE: "complete", SCAN_INCOMPLETE: "incomplete" } },
        complete: { on: { SCAN_START: "running" } },
        incomplete: { on: { SCAN_START: "running" } }
      }
    },
    handoff: {
      initial: "idle",
      states: {
        idle: { on: { HANDOFF_RESERVE: "reserved", HANDOFF_COMPLETE: "complete" } },
        reserved: { on: { HANDOFF_PREPARE: "preparing", HANDOFF_RESET: "idle" } },
        preparing: { on: { HANDOFF_RECONCILE: "reconciling", HANDOFF_ACCEPT: "idle", HANDOFF_RESET: "idle" } },
        reconciling: { on: { HANDOFF_ACCEPT: "idle", HANDOFF_RESET: "idle" } },
        complete: { on: { HANDOFF_RESERVE: "reserved", HANDOFF_RESET: "idle" } }
      }
    },
    transfer: {
      initial: "idle",
      states: {
        idle: { on: { TRANSFER_START: "active", TRANSFER_COMPLETE: "complete" } },
        active: { on: { TRANSFER_IDLE: "idle", TRANSFER_DRAIN: "draining", TRANSFER_COMPLETE: "complete" } },
        draining: { on: { TRANSFER_IDLE: "idle", TRANSFER_COMPLETE: "complete" } },
        complete: { on: { TRANSFER_START: "active", TRANSFER_IDLE: "idle" } }
      }
    }
  }
});

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function normalizedWorkflowValue(value: unknown): PersistentWorkflowValue {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<PersistentWorkflowValue>
    : {};
  const candidate = {
    scan: source.scan || "idle",
    handoff: source.handoff || "idle",
    transfer: source.transfer || "idle"
  };
  try {
    const resolved = persistentWorkflowMachine.resolveState({ value: candidate, context: {} });
    return resolved.value as PersistentWorkflowValue;
  } catch {
    return { scan: "idle", handoff: "idle", transfer: "idle" };
  }
}

export function createPersistentWorkflow(now = new Date().toISOString()): PersistentWorkflowSnapshot {
  return {
    version: PERSISTENT_WORKFLOW_VERSION,
    sequence: 0,
    value: { scan: "idle", handoff: "idle", transfer: "idle" },
    nextAction: "scan",
    reservedItemId: "",
    counts: { ...workflowCounts },
    updatedAt: now
  };
}

export function normalizePersistentWorkflow(value: unknown): PersistentWorkflowSnapshot {
  const defaults = createPersistentWorkflow();
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<PersistentWorkflowSnapshot>
    : {};
  const sourceCounts: Partial<PersistentWorkflowCounts> =
    source.counts && typeof source.counts === "object" && !Array.isArray(source.counts)
      ? source.counts
      : {};
  const counts = Object.fromEntries(Object.keys(workflowCounts).map((key) => [
    key,
    nonNegativeInteger(sourceCounts[key as keyof PersistentWorkflowCounts])
  ])) as unknown as PersistentWorkflowCounts;
  return {
    ...defaults,
    version: PERSISTENT_WORKFLOW_VERSION,
    sequence: nonNegativeInteger(source.sequence),
    value: normalizedWorkflowValue(source.value),
    nextAction: source.nextAction === "handoff" ? "handoff" : "scan",
    reservedItemId: String(source.reservedItemId || "").slice(0, 131072),
    counts,
    updatedAt: String(source.updatedAt || defaults.updatedAt)
  };
}

export function updatePersistentWorkflow(
  value: unknown,
  patch: Partial<Omit<PersistentWorkflowSnapshot, "value" | "counts">> & {
    value?: Partial<PersistentWorkflowValue>;
    counts?: Partial<PersistentWorkflowCounts>;
  } = {}
) {
  const current = normalizePersistentWorkflow(value);
  return normalizePersistentWorkflow({
    ...current,
    ...patch,
    value: { ...current.value, ...(patch.value || {}) },
    counts: { ...current.counts, ...(patch.counts || {}) },
    sequence: current.sequence + 1,
    updatedAt: new Date().toISOString()
  });
}

export function transitionPersistentWorkflow(
  value: unknown,
  event: string,
  patch: Parameters<typeof updatePersistentWorkflow>[1] = {}
) {
  const current = normalizePersistentWorkflow(value);
  const snapshot = persistentWorkflowMachine.resolveState({ value: current.value, context: {} });
  const next = getNextSnapshot(persistentWorkflowMachine, snapshot, { type: String(event || "") });
  return updatePersistentWorkflow(current, {
    ...patch,
    value: next.value as PersistentWorkflowValue
  });
}

export function choosePersistentWorkflowAction(input: {
  workflow: unknown;
  hasPending: boolean;
  hasPreparing: boolean;
  activeTransfers: number;
  concurrency: number;
}): "scan" | "handoff" {
  const workflow = normalizePersistentWorkflow(input.workflow);
  if (input.hasPreparing) return "handoff";
  const activeTransfers = nonNegativeInteger(input.activeTransfers);
  const concurrency = Math.max(1, nonNegativeInteger(input.concurrency));
  if (workflow.nextAction === "handoff" && input.hasPending && activeTransfers < concurrency) {
    return "handoff";
  }
  return "scan";
}
