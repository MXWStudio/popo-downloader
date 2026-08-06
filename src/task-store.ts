import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";

const DATABASE_NAME = "popo-stable-downloader";
const DATABASE_VERSION = 1;

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

function database() {
  if (!isAvailable()) throw new Error("当前环境不支持 IndexedDB");
  if (!databasePromise) {
    databasePromise = openDB<PopoTaskDatabase>(DATABASE_NAME, DATABASE_VERSION, {
      upgrade(db) {
        const chunks = db.createObjectStore("itemChunks", { keyPath: "key" });
        chunks.createIndex("by-job", "jobId");
        chunks.createIndex("by-job-generation", ["jobId", "generation"]);
        const generations = db.createObjectStore("generations", { keyPath: "key" });
        generations.createIndex("by-job", "jobId");
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
