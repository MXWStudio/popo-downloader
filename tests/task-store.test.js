"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
require("fake-indexeddb/auto");
const { taskStore } = require("../runtime/popo-runtime.cjs");

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

test.beforeEach(async () => {
  await taskStore.resetDatabaseForTests();
});

test.after(async () => {
  await taskStore.resetDatabaseForTests();
});

test("IndexedDB 原子保存、读取并回收一万文件的旧代次", async () => {
  const items = Array.from({ length: 10000 }, (_, index) => ({
    id: `item-${index}`,
    status: index % 2 ? "pending" : "success"
  }));
  const chunks = Array.from({ length: 50 }, (_, index) => items.slice(index * 200, (index + 1) * 200));
  const hashes = chunks.map(taskStore.hashItemChunk);
  const firstGeneration = taskStore.createGeneration("job-10k", hashes);

  const firstWrite = await taskStore.writeItemChunks({
    jobId: "job-10k",
    generation: firstGeneration,
    chunks,
    hashes
  });
  assert.equal(firstWrite.written, true);
  assert.deepEqual(
    await taskStore.readItemChunks({
      jobId: "job-10k",
      generation: firstGeneration,
      chunkCount: chunks.length,
      hashes
    }),
    items
  );

  const duplicateWrite = await taskStore.writeItemChunks({
    jobId: "job-10k",
    generation: firstGeneration,
    chunks,
    hashes
  });
  assert.equal(duplicateWrite.written, false);

  const nextChunks = chunks.map((chunk) => chunk.map((item) => ({ ...item })));
  nextChunks[49][199].status = "failed";
  const nextHashes = nextChunks.map(taskStore.hashItemChunk);
  const nextGeneration = taskStore.createGeneration("job-10k", nextHashes);
  await taskStore.writeItemChunks({
    jobId: "job-10k",
    generation: nextGeneration,
    chunks: nextChunks,
    hashes: nextHashes
  });
  assert.equal((await taskStore.inspectJobStorage("job-10k")).generationCount, 2);
  assert.equal(await taskStore.pruneJobGenerations("job-10k", nextGeneration), 1);
  assert.equal((await taskStore.inspectJobStorage("job-10k")).generationCount, 1);
  await assert.rejects(
    taskStore.readItemChunks({ jobId: "job-10k", generation: firstGeneration }),
    /没有找到任务代次/
  );
});

test("IndexedDB 摘要不一致时拒绝把任务数据交给队列", async () => {
  const chunks = [[{ id: "item-1" }]];
  const hashes = chunks.map(taskStore.hashItemChunk);
  const generation = taskStore.createGeneration("job-bad-hash", hashes);
  await taskStore.writeItemChunks({
    jobId: "job-bad-hash",
    generation,
    chunks,
    hashes
  });
  await assert.rejects(
    taskStore.readItemChunks({
      jobId: "job-bad-hash",
      generation,
      chunkCount: 1,
      hashes: ["bad"]
    }),
    /摘要不一致/
  );
});

test("IndexedDB 分块内容被篡改时由内容摘要阻止恢复", async () => {
  const chunks = [[{ id: "item-original", status: "pending" }]];
  const hashes = chunks.map(taskStore.hashItemChunk);
  const generation = taskStore.createGeneration("job-corrupted", hashes);
  await taskStore.writeItemChunks({
    jobId: "job-corrupted",
    generation,
    chunks,
    hashes
  });

  const database = await requestResult(indexedDB.open("popo-stable-downloader"));
  const transaction = database.transaction(["itemChunks"], "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore("itemChunks");
  const records = await requestResult(store.getAll());
  records[0].items[0].id = "item-tampered";
  store.put(records[0]);
  await done;
  database.close();

  await assert.rejects(
    taskStore.readItemChunks({
      jobId: "job-corrupted",
      generation,
      chunkCount: 1,
      hashes
    }),
    /内容与摘要不一致/
  );
});

test("IndexedDB 按单调序号保存工作流检查点并拒绝损坏快照", async () => {
  const first = {
    version: 1,
    sequence: 3,
    value: { scan: "running", handoff: "idle", transfer: "active" },
    nextAction: "scan",
    reservedItemId: "",
    counts: { discovered: 20 },
    updatedAt: "2026-08-10T00:00:00.000Z"
  };
  assert.deepEqual(await taskStore.writeWorkflowCheckpoint({
    jobId: "job-workflow",
    snapshot: first
  }), { written: true, stale: false, sequence: 3 });
  assert.deepEqual(await taskStore.readWorkflowCheckpoint("job-workflow"), first);

  const stale = { ...first, sequence: 2 };
  assert.deepEqual(await taskStore.writeWorkflowCheckpoint({
    jobId: "job-workflow",
    snapshot: stale
  }), { written: false, stale: true, sequence: 3 });
  assert.equal((await taskStore.readWorkflowCheckpoint("job-workflow")).sequence, 3);

  const database = await requestResult(indexedDB.open("popo-stable-downloader"));
  const transaction = database.transaction(["workflowCheckpoints"], "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore("workflowCheckpoints");
  const record = await requestResult(store.get("job-workflow"));
  record.snapshot.nextAction = "handoff";
  store.put(record);
  await done;
  database.close();
  await assert.rejects(
    taskStore.readWorkflowCheckpoint("job-workflow"),
    /快照与摘要不一致/
  );
});

test("文件操作预约按任务与文件幂等且保留 Gopeed 接管事实", async () => {
  const identity = {
    jobId: "job-ledger",
    itemId: "https://example.test/parent\u00007\u0000video.mp4",
    taskKey: "stable-task-key"
  };
  const reserved = await taskStore.reserveOperation(identity);
  assert.equal(reserved.status, "reserved");
  assert.deepEqual(await taskStore.reserveOperation(identity), reserved);

  const accepted = await taskStore.markOperationAccepted({
    jobId: identity.jobId,
    itemId: identity.itemId,
    taskId: "gopeed-task-1"
  });
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.taskId, "gopeed-task-1");
  assert.equal((await taskStore.reserveOperation(identity)).taskId, "gopeed-task-1");

  const reopened = await taskStore.reopenOperation(identity);
  assert.equal(reopened.status, "reserved");
  assert.equal(reopened.taskId, "");
  await taskStore.markOperationAccepted({
    jobId: identity.jobId,
    itemId: identity.itemId,
    taskId: "gopeed-task-2"
  });
  const completed = await taskStore.completeOperation({
    jobId: identity.jobId,
    itemId: identity.itemId,
    status: "success"
  });
  assert.equal(completed.status, "success");
  assert.equal(completed.taskId, "gopeed-task-2");
  assert.equal((await taskStore.listJobOperations(identity.jobId)).length, 1);
  assert.equal(await taskStore.deleteJobWorkflow(identity.jobId), 1);
  assert.equal(await taskStore.readOperation(identity), null);
});

test("数据库从 v1 升级到 v2 时保留原文件分块并新增工作流账本", async () => {
  const openRequest = indexedDB.open("popo-stable-downloader", 1);
  openRequest.onupgradeneeded = () => {
    const database = openRequest.result;
    const chunks = database.createObjectStore("itemChunks", { keyPath: "key" });
    chunks.createIndex("by-job", "jobId");
    chunks.createIndex("by-job-generation", ["jobId", "generation"]);
    const generations = database.createObjectStore("generations", { keyPath: "key" });
    generations.createIndex("by-job", "jobId");
  };
  const legacyDatabase = await requestResult(openRequest);
  const chunks = [[{ id: "legacy-item", status: "pending" }]];
  const hashes = chunks.map(taskStore.hashItemChunk);
  const generation = taskStore.createGeneration("legacy-job", hashes);
  const transaction = legacyDatabase.transaction(["itemChunks", "generations"], "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore("itemChunks").put({
    key: `legacy-job\u0000${generation}\u000000000000`,
    jobId: "legacy-job",
    generation,
    index: 0,
    hash: hashes[0],
    items: chunks[0],
    updatedAt: "2026-08-10T00:00:00.000Z"
  });
  transaction.objectStore("generations").put({
    key: `legacy-job\u0000${generation}`,
    jobId: "legacy-job",
    generation,
    chunkCount: 1,
    hashes,
    updatedAt: "2026-08-10T00:00:00.000Z"
  });
  await done;
  legacyDatabase.close();

  assert.deepEqual(await taskStore.readItemChunks({
    jobId: "legacy-job",
    generation,
    chunkCount: 1,
    hashes
  }), chunks[0]);
  await taskStore.writeWorkflowCheckpoint({
    jobId: "legacy-job",
    snapshot: { version: 1, sequence: 1 }
  });
  assert.equal((await taskStore.readWorkflowCheckpoint("legacy-job")).sequence, 1);
});
