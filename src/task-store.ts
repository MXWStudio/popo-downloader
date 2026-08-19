import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";

const DATABASE_NAME = "popo-stable-downloader";
const DATABASE_VERSION = 3;
const MAX_DIAGNOSTIC_EVENTS = 100;

interface ItemChunkRecord {
  key: string;
  jobId: string;
  generation: string;
  index: number;
  hash: string;
  items: unknown[];
  updatedAt: string;
}

interface GenerationRecord {
  key: string;
  jobId: string;
  generation: string;
  chunkCount: number;
  hashes: string[];
  updatedAt: string;
}

interface WorkflowCheckpointRecord {
  jobId: string;
  version: number;
  sequence: number;
  hash: string;
  snapshot: unknown;
  updatedAt: string;
}

type OperationStatus = "reserved" | "accepted" | "success" | "failed" | "cancelled";

interface OperationRecord {
  key: string;
  jobId: string;
  itemId: string;
  taskKey: string;
  status: OperationStatus;
  taskId: string;
  reservedAt: string;
  acceptedAt: string;
  completedAt: string;
  updatedAt: string;
}

interface DiagnosticEventRecord {
  eventId: string;
  fingerprint: string;
  event: unknown;
  occurrenceCount: number;
  createdAt: string;
  lastSeenAt: string;
  nextAttemptAt: string;
  attemptCount: number;
  lastError: string;
}

interface PopoTaskDatabase extends DBSchema {
  itemChunks: {
    key: string;
    value: ItemChunkRecord;
    indexes: {
      "by-job": string;
      "by-job-generation": [string, string];
    };
  };
  generations: {
    key: string;
    value: GenerationRecord;
    indexes: {
      "by-job": string;
    };
  };
  workflowCheckpoints: {
    key: string;
    value: WorkflowCheckpointRecord;
  };
  operations: {
    key: string;
    value: OperationRecord;
    indexes: {
      "by-job": string;
      "by-job-status": [string, OperationStatus];
    };
  };
  diagnosticEvents: {
    key: string;
    value: DiagnosticEventRecord;
    indexes: {
      "by-created-at": string;
      "by-fingerprint": string;
      "by-next-attempt": string;
    };
  };
}

let databasePromise: Promise<IDBPDatabase<PopoTaskDatabase>> | null = null;

function assertIdentifier(value: unknown, field: string) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 512 || normalized.includes("\u0000")) {
    throw new Error(`IndexedDB ${field} 无效`);
  }
  return normalized;
}

function generationKey(jobId: string, generation: string) {
  return `${jobId}\u0000${generation}`;
}

function chunkKey(jobId: string, generation: string, index: number) {
  return `${generationKey(jobId, generation)}\u0000${String(index).padStart(8, "0")}`;
}

function assertOpaqueIdentifier(value: unknown, field: string) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 131072) throw new Error(`IndexedDB ${field} 无效`);
  return normalized;
}

function operationKey(jobId: string, itemId: string) {
  return JSON.stringify([jobId, itemId]);
}

function hashSerializable(value: unknown) {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("IndexedDB 工作流快照不可序列化");
  let hash = 2166136261;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function database() {
  if (!isAvailable()) throw new Error("当前环境不支持 IndexedDB");
  if (!databasePromise) {
    databasePromise = openDB<PopoTaskDatabase>(DATABASE_NAME, DATABASE_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("itemChunks")) {
          const chunks = db.createObjectStore("itemChunks", { keyPath: "key" });
          chunks.createIndex("by-job", "jobId");
          chunks.createIndex("by-job-generation", ["jobId", "generation"]);
        }
        if (!db.objectStoreNames.contains("generations")) {
          const generations = db.createObjectStore("generations", { keyPath: "key" });
          generations.createIndex("by-job", "jobId");
        }
        if (!db.objectStoreNames.contains("workflowCheckpoints")) {
          db.createObjectStore("workflowCheckpoints", { keyPath: "jobId" });
        }
        if (!db.objectStoreNames.contains("operations")) {
          const operations = db.createObjectStore("operations", { keyPath: "key" });
          operations.createIndex("by-job", "jobId");
          operations.createIndex("by-job-status", ["jobId", "status"]);
        }
        if (!db.objectStoreNames.contains("diagnosticEvents")) {
          const events = db.createObjectStore("diagnosticEvents", { keyPath: "eventId" });
          events.createIndex("by-created-at", "createdAt");
          events.createIndex("by-fingerprint", "fingerprint");
          events.createIndex("by-next-attempt", "nextAttemptAt");
        }
      },
      blocking(_currentVersion, _blockedVersion, event) {
        (event.target as IDBDatabase | null)?.close();
        databasePromise = null;
      },
      terminated() {
        databasePromise = null;
      }
    });
  }
  return databasePromise;
}

export function isAvailable() {
  return typeof globalThis.indexedDB !== "undefined";
}

export function hashItemChunk(items: unknown) {
  if (!Array.isArray(items)) throw new Error("IndexedDB chunk 必须是数组");
  const value = JSON.stringify(items);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function createGeneration(jobIdValue: unknown, hashesValue: unknown) {
  const jobId = assertIdentifier(jobIdValue, "jobId");
  const hashes = Array.isArray(hashesValue) ? hashesValue.map((value) => String(value || "")) : [];
  let hash = 0xcbf29ce484222325n;
  const input = `${jobId}\u0000${hashes.join("\u0000")}`;
  for (const character of input) {
    hash ^= BigInt(character.codePointAt(0) || 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `v1-${hash.toString(16).padStart(16, "0")}-${hashes.length}`;
}

export async function writeItemChunks(input: {
  jobId: unknown;
  generation: unknown;
  chunks: unknown;
  hashes: unknown;
}) {
  const jobId = assertIdentifier(input.jobId, "jobId");
  const generation = assertIdentifier(input.generation, "generation");
  if (!Array.isArray(input.chunks) || !input.chunks.every(Array.isArray)) {
    throw new Error("IndexedDB chunks 必须是二维数组");
  }
  if (!Array.isArray(input.hashes) || input.hashes.length !== input.chunks.length) {
    throw new Error("IndexedDB chunk hash 数量不一致");
  }
  const hashes = input.hashes.map((value) => String(value || ""));
  const actualHashes = input.chunks.map(hashItemChunk);
  if (actualHashes.some((hash, index) => hash !== hashes[index])) {
    throw new Error("IndexedDB 任务分块内容与摘要不一致");
  }
  const db = await database();
  const existing = await db.get("generations", generationKey(jobId, generation));
  if (existing && existing.chunkCount === input.chunks.length &&
      existing.hashes.every((hash, index) => hash === hashes[index])) {
    return { written: false, chunkCount: existing.chunkCount };
  }

  const tx = db.transaction(["itemChunks", "generations"], "readwrite");
  const now = new Date().toISOString();
  await Promise.all(input.chunks.map((items, index) => tx.objectStore("itemChunks").put({
    key: chunkKey(jobId, generation, index),
    jobId,
    generation,
    index,
    hash: hashes[index] || "",
    items: structuredClone(items),
    updatedAt: now
  })));
  await tx.objectStore("generations").put({
    key: generationKey(jobId, generation),
    jobId,
    generation,
    chunkCount: input.chunks.length,
    hashes,
    updatedAt: now
  });
  await tx.done;
  return { written: true, chunkCount: input.chunks.length };
}

export async function readItemChunks(input: {
  jobId: unknown;
  generation: unknown;
  chunkCount?: unknown;
  hashes?: unknown;
}) {
  const jobId = assertIdentifier(input.jobId, "jobId");
  const generation = assertIdentifier(input.generation, "generation");
  const db = await database();
  const record = await db.get("generations", generationKey(jobId, generation));
  if (!record) throw new Error("IndexedDB 中没有找到任务代次");
  const expectedCount = Number(input.chunkCount);
  if (Number.isInteger(expectedCount) && expectedCount >= 0 && record.chunkCount !== expectedCount) {
    throw new Error("IndexedDB 任务分块数量不一致");
  }
  if (Array.isArray(input.hashes)) {
    const expectedHashes = input.hashes.map((value) => String(value || ""));
    if (expectedHashes.length !== record.hashes.length ||
        record.hashes.some((hash, index) => hash !== expectedHashes[index])) {
      throw new Error("IndexedDB 任务分块摘要不一致");
    }
  }

  const chunks = await Promise.all(Array.from({ length: record.chunkCount }, (_, index) =>
    db.get("itemChunks", chunkKey(jobId, generation, index))
  ));
  if (chunks.some((chunk, index) => !chunk || chunk.index !== index || !Array.isArray(chunk.items))) {
    throw new Error("IndexedDB 任务分块缺失或损坏");
  }
  if (chunks.some((chunk, index) =>
    chunk?.hash !== record.hashes[index] ||
    hashItemChunk(chunk?.items || []) !== record.hashes[index]
  )) {
    throw new Error("IndexedDB 任务分块内容与摘要不一致");
  }
  return chunks.flatMap((chunk) => structuredClone(chunk?.items || []));
}

export async function pruneJobGenerations(jobIdValue: unknown, keepGenerationValue: unknown) {
  const jobId = assertIdentifier(jobIdValue, "jobId");
  const keepGeneration = assertIdentifier(keepGenerationValue, "generation");
  const db = await database();
  const generations = await db.getAllFromIndex("generations", "by-job", jobId);
  const stale = generations.filter((record) => record.generation !== keepGeneration);
  if (!stale.length) return 0;
  const tx = db.transaction(["itemChunks", "generations"], "readwrite");
  for (const record of stale) {
    for (let index = 0; index < record.chunkCount; index += 1) {
      await tx.objectStore("itemChunks").delete(chunkKey(jobId, record.generation, index));
    }
    await tx.objectStore("generations").delete(record.key);
  }
  await tx.done;
  return stale.length;
}

export async function deleteJobItems(jobIdValue: unknown) {
  const jobId = assertIdentifier(jobIdValue, "jobId");
  const db = await database();
  const generations = await db.getAllFromIndex("generations", "by-job", jobId);
  if (!generations.length) return 0;
  const tx = db.transaction(["itemChunks", "generations"], "readwrite");
  for (const record of generations) {
    for (let index = 0; index < record.chunkCount; index += 1) {
      await tx.objectStore("itemChunks").delete(chunkKey(jobId, record.generation, index));
    }
    await tx.objectStore("generations").delete(record.key);
  }
  await tx.done;
  return generations.length;
}

export async function inspectJobStorage(jobIdValue: unknown) {
  const jobId = assertIdentifier(jobIdValue, "jobId");
  const db = await database();
  const generations = await db.getAllFromIndex("generations", "by-job", jobId);
  return {
    jobId,
    generationCount: generations.length,
    chunkCount: generations.reduce((total, record) => total + record.chunkCount, 0)
  };
}

export async function writeWorkflowCheckpoint(input: { jobId: unknown; snapshot: unknown }) {
  const jobId = assertIdentifier(input.jobId, "jobId");
  const snapshot = structuredClone(input.snapshot);
  const sequence = Number((snapshot as { sequence?: unknown } | null)?.sequence);
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error("IndexedDB 工作流序号无效");
  }
  const version = Number((snapshot as { version?: unknown } | null)?.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("IndexedDB 工作流版本无效");
  }
  const hash = hashSerializable(snapshot);
  const db = await database();
  const tx = db.transaction("workflowCheckpoints", "readwrite");
  const store = tx.objectStore("workflowCheckpoints");
  const existing = await store.get(jobId);
  if (existing && existing.sequence > sequence) {
    await tx.done;
    return { written: false, stale: true, sequence: existing.sequence };
  }
  if (existing && existing.sequence === sequence && existing.hash === hash) {
    await tx.done;
    return { written: false, stale: false, sequence };
  }
  await store.put({
    jobId,
    version,
    sequence,
    hash,
    snapshot,
    updatedAt: new Date().toISOString()
  });
  await tx.done;
  return { written: true, stale: false, sequence };
}

export async function readWorkflowCheckpoint(jobIdValue: unknown) {
  const jobId = assertIdentifier(jobIdValue, "jobId");
  const db = await database();
  const record = await db.get("workflowCheckpoints", jobId);
  if (!record) return null;
  if (hashSerializable(record.snapshot) !== record.hash) {
    throw new Error("IndexedDB 工作流快照与摘要不一致");
  }
  return structuredClone(record.snapshot);
}

export async function reserveOperation(input: {
  jobId: unknown;
  itemId: unknown;
  taskKey: unknown;
  reopen?: boolean;
}) {
  const jobId = assertIdentifier(input.jobId, "jobId");
  const itemId = assertOpaqueIdentifier(input.itemId, "itemId");
  const taskKey = assertIdentifier(input.taskKey, "taskKey");
  const key = operationKey(jobId, itemId);
  const db = await database();
  const tx = db.transaction("operations", "readwrite");
  const store = tx.objectStore("operations");
  const existing = await store.get(key);
  if (existing && existing.taskKey !== taskKey) {
    throw new Error("IndexedDB 同一文件的任务身份不一致");
  }
  if (existing && !(input.reopen && ["failed", "cancelled"].includes(existing.status))) {
    await tx.done;
    return structuredClone(existing);
  }
  const now = new Date().toISOString();
  const record: OperationRecord = {
    key,
    jobId,
    itemId,
    taskKey,
    status: "reserved",
    taskId: input.reopen ? "" : existing?.taskId || "",
    reservedAt: existing?.reservedAt || now,
    acceptedAt: input.reopen ? "" : existing?.acceptedAt || "",
    completedAt: "",
    updatedAt: now
  };
  await store.put(record);
  await tx.done;
  return structuredClone(record);
}

async function updateOperation(
  jobIdValue: unknown,
  itemIdValue: unknown,
  update: (record: OperationRecord, now: string) => void
) {
  const jobId = assertIdentifier(jobIdValue, "jobId");
  const itemId = assertOpaqueIdentifier(itemIdValue, "itemId");
  const db = await database();
  const tx = db.transaction("operations", "readwrite");
  const store = tx.objectStore("operations");
  const key = operationKey(jobId, itemId);
  const record = await store.get(key);
  if (!record) throw new Error("IndexedDB 中没有找到文件操作预约");
  const now = new Date().toISOString();
  update(record, now);
  record.updatedAt = now;
  await store.put(record);
  await tx.done;
  return structuredClone(record);
}

export async function markOperationAccepted(input: { jobId: unknown; itemId: unknown; taskId: unknown }) {
  const taskId = assertIdentifier(input.taskId, "taskId");
  return updateOperation(input.jobId, input.itemId, (record, now) => {
    record.status = "accepted";
    record.taskId = taskId;
    record.acceptedAt = now;
    record.completedAt = "";
  });
}

export async function reopenOperation(input: { jobId: unknown; itemId: unknown }) {
  return updateOperation(input.jobId, input.itemId, (record) => {
    record.status = "reserved";
    record.taskId = "";
    record.acceptedAt = "";
    record.completedAt = "";
  });
}

export async function completeOperation(input: {
  jobId: unknown;
  itemId: unknown;
  status: "success" | "failed" | "cancelled";
}) {
  if (!["success", "failed", "cancelled"].includes(input.status)) {
    throw new Error("IndexedDB 文件操作完成状态无效");
  }
  return updateOperation(input.jobId, input.itemId, (record, now) => {
    record.status = input.status;
    record.completedAt = now;
  });
}

export async function readOperation(input: { jobId: unknown; itemId: unknown }) {
  const jobId = assertIdentifier(input.jobId, "jobId");
  const itemId = assertOpaqueIdentifier(input.itemId, "itemId");
  const db = await database();
  const record = await db.get("operations", operationKey(jobId, itemId));
  return record ? structuredClone(record) : null;
}

export async function listJobOperations(jobIdValue: unknown) {
  const jobId = assertIdentifier(jobIdValue, "jobId");
  const db = await database();
  return structuredClone(await db.getAllFromIndex("operations", "by-job", jobId));
}

export async function deleteJobWorkflow(jobIdValue: unknown) {
  const jobId = assertIdentifier(jobIdValue, "jobId");
  const db = await database();
  const operations = await db.getAllFromIndex("operations", "by-job", jobId);
  const tx = db.transaction(["workflowCheckpoints", "operations"], "readwrite");
  await tx.objectStore("workflowCheckpoints").delete(jobId);
  for (const operation of operations) await tx.objectStore("operations").delete(operation.key);
  await tx.done;
  return operations.length;
}

function assertDiagnosticEvent(value: unknown) {
  const event = value && typeof value === "object" && !Array.isArray(value)
    ? structuredClone(value as Record<string, unknown>)
    : null;
  const eventId = String(event?.event_id || "").trim();
  if (!/^[a-f0-9]{32}$/i.test(eventId)) throw new Error("IndexedDB 诊断事件 ID 无效");
  const fingerprint = Array.isArray(event?.fingerprint)
    ? event.fingerprint.map((item) => String(item || "")).join("|").slice(0, 256)
    : String(event?.message || "UNKNOWN_DIAGNOSTIC").slice(0, 256);
  if (!fingerprint) throw new Error("IndexedDB 诊断事件指纹无效");
  return { event, eventId: eventId.toLowerCase(), fingerprint };
}

export async function enqueueDiagnosticEvent(value: unknown) {
  const { event, eventId, fingerprint } = assertDiagnosticEvent(value);
  const db = await database();
  const tx = db.transaction("diagnosticEvents", "readwrite");
  const store = tx.objectStore("diagnosticEvents");
  const matching = await store.index("by-fingerprint").getAll(fingerprint);
  const now = new Date().toISOString();
  const recent = matching
    .filter((record) => Date.now() - Date.parse(record.lastSeenAt) < 15 * 60_000)
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0];
  if (recent) {
    recent.occurrenceCount = Math.min(10_000, recent.occurrenceCount + 1);
    recent.lastSeenAt = now;
    if (recent.event && typeof recent.event === "object") {
      (recent.event as Record<string, unknown>).timestamp = now;
      const extra = (recent.event as Record<string, unknown>).extra;
      if (extra && typeof extra === "object" && !Array.isArray(extra)) {
        (extra as Record<string, unknown>).occurrenceCount = recent.occurrenceCount;
      }
    }
    await store.put(recent);
    await tx.done;
    return { eventId: recent.eventId, merged: true, occurrenceCount: recent.occurrenceCount };
  }
  const record: DiagnosticEventRecord = {
    eventId,
    fingerprint,
    event,
    occurrenceCount: 1,
    createdAt: now,
    lastSeenAt: now,
    nextAttemptAt: now,
    attemptCount: 0,
    lastError: ""
  };
  await store.put(record);
  const all = await store.index("by-created-at").getAll();
  for (const stale of all.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(0, Math.max(0, all.length - MAX_DIAGNOSTIC_EVENTS))) {
    await store.delete(stale.eventId);
  }
  await tx.done;
  return { eventId, merged: false, occurrenceCount: 1 };
}

export async function listDiagnosticEvents(input: { limit?: number; includeDeferred?: boolean } = {}) {
  const db = await database();
  const limit = Math.max(1, Math.min(25, Number(input.limit) || 10));
  const now = new Date().toISOString();
  const records = await db.getAllFromIndex("diagnosticEvents", "by-created-at");
  return structuredClone(records
    .filter((record) => input.includeDeferred || record.nextAttemptAt <= now)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(0, limit));
}

export async function markDiagnosticEventSent(eventIdValue: unknown) {
  const eventId = assertIdentifier(eventIdValue, "diagnostic eventId");
  const db = await database();
  await db.delete("diagnosticEvents", eventId);
}

export async function markDiagnosticEventRetry(input: { eventId: unknown; error: unknown }) {
  const eventId = assertIdentifier(input.eventId, "diagnostic eventId");
  const db = await database();
  const tx = db.transaction("diagnosticEvents", "readwrite");
  const store = tx.objectStore("diagnosticEvents");
  const record = await store.get(eventId);
  if (!record) {
    await tx.done;
    return null;
  }
  record.attemptCount = Math.min(20, record.attemptCount + 1);
  const delayMs = Math.min(6 * 60 * 60_000, 30_000 * (2 ** Math.min(8, record.attemptCount - 1)));
  record.nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
  record.lastError = String(input.error || "发送失败").slice(0, 200);
  await store.put(record);
  await tx.done;
  return structuredClone(record);
}

export async function diagnosticOutboxStatus() {
  const db = await database();
  const records = await db.getAllFromIndex("diagnosticEvents", "by-created-at");
  return {
    pendingCount: records.length,
    oldestAt: records[0]?.createdAt || "",
    newestAt: records[records.length - 1]?.createdAt || ""
  };
}

export async function closeDatabase() {
  if (!databasePromise) return;
  const db = await databasePromise;
  db.close();
  databasePromise = null;
}

export async function resetDatabaseForTests() {
  await closeDatabase();
  if (isAvailable()) await deleteDB(DATABASE_NAME);
}
