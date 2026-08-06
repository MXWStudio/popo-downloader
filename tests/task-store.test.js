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
