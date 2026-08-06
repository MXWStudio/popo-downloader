import { createMachine, getNextSnapshot } from "xstate";
import { JOB_STATUSES, type JobStatusSchema } from "./contracts";
import type { z } from "zod";

export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JOB_STATUS_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = Object.freeze({
  queued: ["waiting_worker", "scanning", "cancelled", "failed"],
  waiting_worker: ["scanning", "cancelled", "failed"],
  scanning: ["scan_complete", "awaiting_confirmation", "starting", "complete", "cancelled", "failed"],
  scan_complete: ["starting", "downloading", "complete", "cancelled", "failed"],
  awaiting_confirmation: ["scanning", "scan_complete", "starting", "complete", "cancelled", "failed"],
  starting: ["scan_complete", "downloading", "cancelled", "failed"],
  downloading: ["paused", "draining", "draining_paused", "complete", "cancelled", "failed"],
  paused: ["downloading", "draining", "draining_paused", "cancelled", "failed"],
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
