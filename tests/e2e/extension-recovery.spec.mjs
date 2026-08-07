import { chromium, expect, test } from "@playwright/test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const extensionEntries = [
  "manifest.json",
  "background.js",
  "content.js",
  "core.js",
  "gopeed.js",
  "page-api.js",
  "popup.css",
  "popup.html",
  "queue.js",
  "assets",
  "runtime/popo-runtime.js",
  "runtime/popup.js",
  "runtime/page-ui.js"
];

let sandboxRoot;
let extensionDir;
let userDataDir;
let context;

async function copyExtension() {
  await mkdir(extensionDir, { recursive: true });
  for (const entry of extensionEntries) {
    const source = resolve(projectRoot, entry);
    const destination = resolve(extensionDir, entry);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
  }
}

async function launchExtension() {
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`
    ]
  });
  const existing = context.serviceWorkers()
    .find((worker) => worker.url().startsWith("chrome-extension://"));
  const worker = existing || await context.waitForEvent("serviceworker", {
    predicate: (candidate) => candidate.url().startsWith("chrome-extension://")
  });
  return {
    worker,
    extensionId: new URL(worker.url()).host
  };
}

async function openPopup(extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator("#versionInfo")).toBeVisible();
  return page;
}

async function closeExtensionContext() {
  const activeContext = context;
  context = undefined;
  if (!activeContext) return;
  await Promise.allSettled(
    activeContext.pages().map((page) => page.close({ runBeforeUnload: false }))
  );
  await activeContext.close().catch(() => {});
}

test.beforeAll(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "popo-playwright-"));
  extensionDir = join(sandboxRoot, "extension");
  userDataDir = join(sandboxRoot, "profile");
  await copyExtension();
});

test.afterEach(async () => {
  await closeExtensionContext();
});

test.afterAll(async () => {
  await rm(sandboxRoot, { recursive: true, force: true });
});

test("single React page root renders project count and recycled folder-row portals", async () => {
  await launchExtension();
  const page = await context.newPage();
  await page.route("https://example.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><html><body></body></html>"
  }));
  await page.goto("https://example.test/team/pc/test/pageDetail/folder");
  await page.setContent(`
    <div id="toolbar">
      <button id="type-filter"><span>所有类型</span></button>
      <button>排序</button>
    </div>
    <div data-test-id="virtuoso-scroller">
      <div data-test-id="virtuoso-item-list" style="padding-bottom: 672px">
        <div data-item-index="0" data-known-size="48" style="display:flex;width:900px;height:48px;align-items:center">
          <div class="pageName" style="flex:1"><span class="drive-icon-folder"></span><span class="topName">文件夹 A</span></div>
          <div class="ownerName" style="flex:0 0 150px">成员 A</div>
          <div class="timeDate" style="flex:0 0 140px">今天</div>
          <div class="listMore"><button aria-label="更多 A">…</button></div>
        </div>
        <div data-item-index="1" data-known-size="48" style="display:flex;width:900px;height:48px;align-items:center">
          <div class="pageName" style="flex:1"><span class="drive-icon-folder"></span><span class="topName">文件夹 B</span></div>
          <div class="ownerName" style="flex:0 0 150px">成员 B</div>
          <div class="timeDate" style="flex:0 0 140px">今天</div>
          <div class="listMore"><button aria-label="更多 B">…</button></div>
        </div>
        <div data-item-index="2" data-known-size="48" style="display:flex;width:900px;height:48px;align-items:center">
          <div class="pageName" style="flex:1"><span class="topName">普通文件.psd</span></div>
          <div class="ownerName" style="flex:0 0 150px">成员 C</div>
          <div class="timeDate" style="flex:0 0 140px">今天</div>
          <div class="listMore"><button aria-label="更多文件">…</button></div>
        </div>
      </div>
    </div>
  `);
  await page.evaluate(() => {
    const state = { jobs: [], activeJobId: null, mode: "idle", popupOpen: false };
    const calls = [];
    const listeners = new Set();
    const runtime = {
      getURL: () => "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
      sendMessage: async (message) => {
        calls.push(message);
        if (message.type === "GET_STATE") {
          return { ok: true, state: JSON.parse(JSON.stringify(state)), settings: {} };
        }
        if (message.type === "CHECK_GOPEED") {
          return { ok: true, connection: { connected: true }, settings: {} };
        }
        if (message.type === "START_FOLDER_SCAN") {
          const job = {
            id: "job-" + (state.jobs.length + 1),
            status: "queued",
            folderName: message.folderName,
            folderItemIndex: message.folderItemIndex,
            parentUrl: message.parentUrl,
            queuePosition: state.jobs.length + 1,
            counts: {}
          };
          state.jobs.push(job);
          return {
            ok: true,
            job,
            state: JSON.parse(JSON.stringify(state)),
            queuePosition: job.queuePosition,
            needsWorker: false
          };
        }
        return { ok: true, state: JSON.parse(JSON.stringify(state)) };
      },
      onMessage: {
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener)
      }
    };
    window.chrome = window.chrome || {};
    Object.defineProperty(window.chrome, "runtime", {
      configurable: true,
      value: runtime
    });
    window.__popoUiTest = { state, calls, listeners };
  });
  await page.addScriptTag({ path: resolve(projectRoot, "runtime/page-ui.js") });

  await expect(page.locator("#popo-react-page-root")).toHaveCount(1);
  await expect(page.locator(".popo-react-project-count")).toHaveText("17 个项目");
  await expect(page.locator("button.popo-stable-download-button")).toHaveCount(2);
  await expect(page.locator("[data-item-index='2'] button.popo-stable-download-button")).toHaveCount(0);
  await expect(page.locator("[data-item-index='0'] .pageName > .popo-react-download-anchor")).toHaveCount(1);
  await expect(page.locator("[data-item-index='0'] .listMore .popo-react-download-anchor")).toHaveCount(0);
  await expect(page.locator("[data-item-index='0'] .pageName")).toHaveAttribute("data-popo-download-host", "true");
  await page.evaluate(() => {
    const oldStatus = document.createElement("aside");
    oldStatus.id = "popo-stable-download-status";
    oldStatus.textContent = "正在准备 1 / 8";
    const oldQueue = document.createElement("aside");
    oldQueue.id = "popo-stable-download-queue";
    document.body.append(oldStatus, oldQueue);
  });
  await expect(page.locator("#popo-stable-download-status,#popo-stable-download-queue")).toHaveCount(0);

  const firstButton = page.locator(
    "[data-item-index='0'] button.popo-stable-download-button"
  );
  await firstButton.click();
  await expect(firstButton).toContainText("排队中");
  await expect(firstButton).toContainText("第 1");
  await expect(page.locator(".popo-page-queue")).toContainText("1 个排队");
  await page.locator(".popo-page-queue-toggle").click();
  await expect(page.locator(".popo-page-queue")).toHaveAttribute("data-collapsed", "false");

  await page.evaluate(() => {
    const job = window.__popoUiTest.state.jobs[0];
    job.status = "scanning";
    job.counts = { discoveredFiles: 383 };
    for (const listener of window.__popoUiTest.listeners) {
      listener({ type: "FOLDER_TASK_STATUS" });
    }
  });
  await expect(firstButton).toHaveAttribute("data-state", "scanning");
  await expect(firstButton).toContainText("查找中");
  await expect(firstButton).toContainText("已找到 383 个");
  await expect(firstButton.locator(".popo-download-state-icon")).toBeVisible();
  await expect(firstButton.locator(".popo-download-rail")).toBeVisible();
  await expect(firstButton.locator(".popo-download-wave")).toBeVisible();
  const [buttonBox, ownerBox] = await Promise.all([
    firstButton.boundingBox(),
    page.locator("[data-item-index='0'] .ownerName").boundingBox()
  ]);
  expect(buttonBox).not.toBeNull();
  expect(ownerBox).not.toBeNull();
  expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(ownerBox.x);

  await page.evaluate(() => {
    window.__popoUiTest.state.popupOpen = true;
    for (const listener of window.__popoUiTest.listeners) {
      listener({ type: "POPUP_VISIBILITY_CHANGED", open: true });
    }
  });
  await expect(page.locator(".popo-page-queue")).toHaveAttribute("data-collapsed", "true");

  await page.evaluate(() => {
    const job = window.__popoUiTest.state.jobs[0];
    job.status = "complete";
    job.completedAt = new Date().toISOString();
    job.counts = {
      files: 383,
      discoveredFiles: 383,
      success: 383,
      failed: 0,
      cancelled: 0
    };
    for (const listener of window.__popoUiTest.listeners) {
      listener({ type: "FOLDER_TASK_FINISHED" });
    }
  });
  await expect(page.locator(".popo-toast")).toHaveCount(0);
  await expect(firstButton).toHaveAttribute("data-state", "success");
  await expect(firstButton).toContainText("已完成 383 个");
  await page.evaluate(() => {
    window.__popoUiTest.state.popupOpen = false;
    for (const listener of window.__popoUiTest.listeners) {
      listener({ type: "POPUP_VISIBILITY_CHANGED", open: false });
    }
  });
  await expect(page.locator(".popo-toast")).toHaveCount(0);

  await page.evaluate(() => {
    const row = document.querySelector("[data-item-index='0']");
    row.setAttribute("data-item-index", "4");
    row.querySelector(".topName").textContent = "回收后的文件夹";
  });
  const recycledButton = page.locator(
    "[data-item-index='4'] button.popo-stable-download-button"
  );
  await expect(recycledButton).toHaveAttribute("data-state", "idle");
  await recycledButton.click();
  await expect.poll(() => page.evaluate(() => {
    const starts = window.__popoUiTest.calls.filter(
      (message) => message.type === "START_FOLDER_SCAN"
    );
    return starts.at(-1)?.folderName;
  })).toBe("回收后的文件夹");

  await page.evaluate(() => {
    const job = window.__popoUiTest.state.jobs.at(-1);
    job.status = "downloading";
    job.counts = { files: 2, success: 0, failed: 0, cancelled: 0 };
    for (const listener of window.__popoUiTest.listeners) {
      listener({ type: "FOLDER_TASK_STATUS" });
    }
  });
  await expect(page.locator(".popo-toast")).toHaveCount(0);
  await page.evaluate(() => {
    const job = window.__popoUiTest.state.jobs.at(-1);
    job.status = "failed";
    job.completedAt = new Date().toISOString();
    job.counts = { files: 2, success: 1, failed: 1, cancelled: 0 };
    for (const listener of window.__popoUiTest.listeners) {
      listener({ type: "FOLDER_TASK_ERROR" });
    }
  });
  await expect(page.locator(".popo-toast[data-kind='error']")).toContainText("1 个未完成");
  await expect(recycledButton).toHaveAttribute("data-state", "failed");
  await expect(recycledButton).toContainText("未完成 1 个");
  await expect(recycledButton).toContainText("重试");
  await recycledButton.click();
  await expect.poll(() => page.evaluate(() =>
    window.__popoUiTest.calls.filter(
      (message) => message.type === "START_FOLDER_SCAN"
    ).length
  )).toBe(3);
  await expect(recycledButton).toHaveAttribute("data-state", "queued");
});

test("popup uses simple wording and safely removes cancelled history", async () => {
  const session = await launchExtension();
  const popup = await openPopup(session.extensionId);
  const pageErrors = [];
  const dialogs = [];
  popup.on("pageerror", (error) => pageErrors.push(String(error)));
  popup.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await expect.poll(() => session.worker.evaluate(async () => {
    const { popoState } = await chrome.storage.local.get("popoState");
    return Boolean(popoState);
  })).toBe(true);
  const now = new Date().toISOString();
  await session.worker.evaluate(async ({ now }) => {
    const settings = {
      recursive: true,
      formats: "",
      includeKeywords: "",
      excludeKeywords: "",
      downloadRoot: "POPO",
      preserveStructure: true,
      concurrency: 5,
      gopeedEndpoint: "http://127.0.0.1:1",
      gopeedToken: "",
      gopeedDownloadDirOverride: "",
      gopeedConnections: 1,
      maxRetries: 2,
      timeouts: {}
    };
    const state = {
      version: 4,
      runToken: "run-e2e-dismiss",
      jobs: [{
        id: "job-e2e-dismiss",
        key: "e2e-dismiss-key",
        sourceTabId: null,
        folderName: "Cancelled E2E folder",
        status: "cancelled",
        cancelRequested: true,
        createdAt: now,
        completedAt: now,
        counts: { files: 3, success: 1, failed: 0, cancelled: 2 },
        cancelledRetryKeys: ["folder\u0000a.psd", "folder\u0000b.psd"],
        lastMessage: "POPO 阻止了隐藏工作区加载；Gopeed API 未连接"
      }],
      activeJobId: null,
      mode: "idle",
      phase: "idle",
      settings,
      activeTransfers: [],
      scanQueue: [],
      resolveQueue: [],
      scanFailures: [],
      scannedFolderCount: 0,
      items: [],
      preparingItemId: null,
      logs: [],
      updatedAt: now,
      itemStorageBackend: "indexeddb",
      itemStorageGeneration: "",
      itemStorageJobId: "",
      itemChunkCount: 0,
      itemChunkHashes: []
    };
    await chrome.storage.local.set({ popoSettings: settings, popoState: state });
  }, { now });

  await popup.reload();

  await expect(popup.locator(".popup-queue-name")).toHaveText("Cancelled E2E folder");
  await expect(popup.locator(".popup-queue-status")).toHaveText("已停止");
  await expect(popup.getByRole("button", { name: "继续（2）" })).toBeVisible();
  await expect(popup.getByRole("button", { name: "移除" })).toBeVisible();
  await expect(popup.locator("body")).not.toContainText("隐藏工作区");
  await expect(popup.locator("body")).not.toContainText("Gopeed");
  await expect(popup.locator("body")).not.toContainText("API");

  await popup.getByRole("button", { name: "移除" }).click();
  await expect(popup.locator(".popup-remove-note")).toHaveText("只从列表移除，不会删除已下载文件。");
  await expect(popup.getByRole("button", { name: "确认移除" })).toBeVisible();
  await expect(popup.getByRole("button", { name: "返回" })).toBeVisible();
  await expect(popup.locator(".popup-queue-item")).toHaveCount(1);

  await popup.getByRole("button", { name: "返回" }).click();
  await expect(popup.locator(".popup-remove-note")).toHaveCount(0);
  await expect(popup.getByRole("button", { name: "继续（2）" })).toBeVisible();
  await expect(popup.getByRole("button", { name: "移除" })).toBeVisible();

  await popup.getByRole("button", { name: "移除" }).click();
  await popup.getByRole("button", { name: "确认移除" }).click();
  await expect(popup.locator(".popup-queue-item")).toHaveCount(0);
  await expect(popup.locator("#idleCard")).toBeVisible();

  const storedJobs = await session.worker.evaluate(async () => {
    const { popoState } = await chrome.storage.local.get("popoState");
    return popoState.jobs;
  });
  expect(storedJobs).toEqual([]);
  expect(dialogs).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("paused IndexedDB task survives popup refresh and browser restart", async () => {
  let session = await launchExtension();
  let popup = await openPopup(session.extensionId);
  await popup.reload();
  await expect(popup.locator("#modeBadge")).toBeVisible();

  const seeded = await session.worker.evaluate(async () => {
    const now = new Date().toISOString();
    const jobId = "job-e2e-recovery";
    const items = [{
      id: "item-e2e-1",
      name: "recovery-video.mp4",
      parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/folder1",
      selected: true,
      status: "paused",
      attempts: 1
    }];
    const hashes = [globalThis.PopoRuntime.taskStore.hashItemChunk(items)];
    const generation = globalThis.PopoRuntime.taskStore.createGeneration(jobId, hashes);
    await globalThis.PopoRuntime.taskStore.writeItemChunks({
      jobId,
      generation,
      chunks: [items],
      hashes
    });
    const settings = {
      recursive: true,
      formats: "",
      includeKeywords: "",
      excludeKeywords: "",
      downloadRoot: "POPO",
      preserveStructure: true,
      concurrency: 5,
      gopeedEndpoint: "http://127.0.0.1:1",
      gopeedToken: "",
      gopeedDownloadDirOverride: "",
      gopeedConnections: 1,
      maxRetries: 2,
      timeouts: {}
    };
    const state = {
      version: 4,
      runToken: "run-e2e-recovery",
      jobs: [{
        id: jobId,
        key: "e2e-key",
        sourceTabId: null,
        folderName: "E2E recovery folder",
        folderItemIndex: "1",
        parentUrl: items[0].parentUrl,
        status: "paused",
        cancelRequested: false,
        createdAt: now,
        startedAt: now,
        completedAt: "",
        counts: { files: 1, pending: 1, success: 0, failed: 0, cancelled: 0 },
        lastMessage: "paused for restart test"
      }],
      activeJobId: jobId,
      mode: "paused",
      phase: "paused",
      settings,
      triggerMode: "folder_button",
      sourceTabId: null,
      selectedFolderName: "E2E recovery folder",
      rootUrl: items[0].parentUrl,
      teamSpaceKey: "team1",
      teamSpaceId: "team1",
      scanQueue: [],
      resolveQueue: [],
      scanFailures: [],
      scannedFolderCount: 0,
      items: [],
      preparingItemId: null,
      activeTransfers: [],
      activeItemId: null,
      gopeedDownloadDir: "",
      gopeedConnected: false,
      gopeedLastError: "",
      startedAt: now,
      completedAt: "",
      updatedAt: now,
      lastMessage: "paused for restart test",
      itemStorageBackend: "indexeddb",
      itemStorageGeneration: generation,
      itemStorageJobId: jobId,
      itemChunkCount: 1,
      itemChunkHashes: hashes,
      logs: []
    };
    await chrome.storage.local.set({ popoSettings: settings, popoState: state });
    return { jobId, generation };
  });

  await popup.reload();
  await expect(popup.locator(".popup-queue-item")).toHaveCount(1);
  await expect(popup.locator(".popup-queue-name")).toHaveText("E2E recovery folder");

  await closeExtensionContext();

  session = await launchExtension();
  const restored = await session.worker.evaluate(async () => {
    const { popoState } = await chrome.storage.local.get("popoState");
    const items = await globalThis.PopoRuntime.taskStore.readItemChunks({
      jobId: popoState.itemStorageJobId,
      generation: popoState.itemStorageGeneration,
      chunkCount: popoState.itemChunkCount,
      hashes: popoState.itemChunkHashes
    });
    return {
      activeJobId: popoState.activeJobId,
      backend: popoState.itemStorageBackend,
      generation: popoState.itemStorageGeneration,
      itemCount: items.length,
      firstName: items[0]?.name
    };
  });

  expect(restored).toEqual({
    activeJobId: seeded.jobId,
    backend: "indexeddb",
    generation: seeded.generation,
    itemCount: 1,
    firstName: "recovery-video.mp4"
  });

  popup = await openPopup(session.extensionId);
  await popup.reload();
  await expect(popup.locator(".popup-queue-name")).toHaveText("E2E recovery folder");
  await expect(popup.locator("#errorBox")).toBeHidden();
});
