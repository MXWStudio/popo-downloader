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

async function readFolderMotionFrame(button) {
  return button.evaluate((element) => {
    const style = (selector) => {
      const target = element.querySelector(selector);
      if (!target) return null;
      const computed = getComputedStyle(target);
      return {
        left: computed.left,
        opacity: computed.opacity,
        transform: computed.transform
      };
    };
    const rail = element.querySelector(".popo-download-rail");
    const estimate = element.querySelector(".popo-download-estimate-fill");
    const fill = element.querySelector(".popo-download-fill");
    const progressElement = estimate || fill;
    return {
      progress: progressElement && rail
        ? Number.parseFloat(progressElement.style.width)
        : null,
      icon: style(".popo-download-resource-block, .popo-download-state-icon-motion"),
      comet: style(".popo-download-activity-comet"),
      bars: Array.from(element.querySelectorAll(".popo-download-work-beat i"))
        .map((target) => getComputedStyle(target).transform),
      packets: Array.from(element.querySelectorAll(".popo-download-activity-packet"))
        .map((target) => {
          const computed = getComputedStyle(target);
          return { left: computed.left, opacity: computed.opacity };
        })
    };
  });
}

async function expectFolderIconMotionInsideSafeArea(button, selector) {
  for (let index = 0; index < 10; index += 1) {
    const bounds = await button.evaluate((element, movingSelector) => {
      const clip = element.querySelector(".popo-download-content");
      const shell = element.querySelector(".popo-download-state-icon");
      const moving = element.querySelector(movingSelector);
      if (!clip || !shell || !moving) return null;
      const toBounds = (target) => {
        const rect = target.getBoundingClientRect();
        return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
      };
      return { clip: toBounds(clip), shell: toBounds(shell), moving: toBounds(moving) };
    }, selector);
    expect(bounds).not.toBeNull();
    expect(bounds.shell.left).toBeGreaterThanOrEqual(bounds.clip.left - .5);
    expect(bounds.shell.right).toBeLessThanOrEqual(bounds.clip.right + .5);
    expect(bounds.shell.top).toBeGreaterThanOrEqual(bounds.clip.top - .5);
    expect(bounds.shell.bottom).toBeLessThanOrEqual(bounds.clip.bottom + .5);
    expect(bounds.moving.left).toBeGreaterThanOrEqual(bounds.shell.left - .5);
    expect(bounds.moving.right).toBeLessThanOrEqual(bounds.shell.right + .5);
    expect(bounds.moving.top).toBeGreaterThanOrEqual(bounds.shell.top - .5);
    expect(bounds.moving.bottom).toBeLessThanOrEqual(bounds.shell.bottom + .5);
    await button.page().waitForTimeout(90);
  }
}

async function expectFolderMotionToAdvance(button, { minimumProgress = null } = {}) {
  const before = await readFolderMotionFrame(button);
  await button.page().waitForTimeout(360);
  const after = await readFolderMotionFrame(button);
  if (minimumProgress != null) expect(before.progress).toBeGreaterThanOrEqual(minimumProgress);
  expect(after.icon).not.toEqual(before.icon);
  expect(after.comet).not.toEqual(before.comet);
  expect(after.bars).not.toEqual(before.bars);
  expect(after.packets).not.toEqual(before.packets);
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
    <title>整页素材</title>
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
    const state = { jobs: [], folderReceipts: [], activeJobId: null, mode: "idle", popupOpen: false };
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
          const receipt = state.folderReceipts.find((candidate) =>
            candidate.parentUrl === message.parentUrl &&
            candidate.folderItemIndex === message.folderItemIndex &&
            candidate.folderName === message.folderName
          );
          const receiptAge = receipt ? Date.now() - Date.parse(receipt.completedAt) : Infinity;
          if (receipt && receiptAge >= 0 && receiptAge < 2 * 60 * 1000) {
            return {
              ok: true,
              duplicate: true,
              alreadyCompleted: true,
              job: {
                id: `receipt:${receipt.key}`,
                status: "complete",
                verifiedCompletion: true,
                ...receipt
              },
              state: JSON.parse(JSON.stringify(state)),
              queuePosition: 0,
              needsWorker: false
            };
          }
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
        if (message.type === "START_PAGE_DOWNLOAD") {
          const batchId = "batch-page";
          const folders = [
            { folderName: "文件夹 A", folderItemIndex: "0" },
            { folderName: "文件夹 B", folderItemIndex: "1" }
          ];
          const added = [];
          let duplicateCount = 0;
          for (const folder of folders) {
            if (state.jobs.some((job) =>
              job.parentUrl === message.parentUrl &&
              job.folderItemIndex === folder.folderItemIndex &&
              job.folderName === folder.folderName
            )) {
              duplicateCount += 1;
              continue;
            }
            const job = {
              id: "job-" + (state.jobs.length + 1),
              status: "queued",
              scope: "folder",
              batchId,
              batchParentUrl: message.parentUrl,
              batchPaused: false,
              ...folder,
              parentUrl: message.parentUrl,
              queuePosition: state.jobs.length + 1,
              counts: {}
            };
            state.jobs.push(job);
            added.push(job);
          }
          return {
            ok: true,
            jobs: added,
            addedCount: added.length,
            duplicateCount,
            completedCount: 0,
            folderCount: folders.length,
            batchId,
            state: JSON.parse(JSON.stringify(state)),
            needsWorker: false
          };
        }
        if (["PAUSE_DOWNLOAD_BATCH", "RESUME_DOWNLOAD_BATCH"].includes(message.type)) {
          const paused = message.type === "PAUSE_DOWNLOAD_BATCH";
          for (const job of state.jobs) {
            if (job.batchId === message.batchId) job.batchPaused = paused;
          }
          return { ok: true, state: JSON.parse(JSON.stringify(state)) };
        }
        if (message.type === "REMOVE_DOWNLOAD_BATCH") {
          const removedCount = state.jobs.filter((job) => job.batchId === message.batchId).length;
          state.jobs = state.jobs.filter((job) => job.batchId !== message.batchId);
          return { ok: true, state: JSON.parse(JSON.stringify(state)), removedCount };
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
  await expect(page.locator(".popo-react-project-count")).toHaveCSS(
    "background-image",
    /radial-gradient.*linear-gradient/
  );
  const pageDownloadButton = page.locator("button.popo-page-download-all");
  await expect(pageDownloadButton).toHaveText("一键下载");
  await expect(pageDownloadButton).toHaveAttribute("title", /整页素材/);
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
  await expect(firstButton).toHaveAttribute("data-state", "idle");
  await expect(firstButton.locator(".popo-download-idle-icon svg.lucide-download")).toBeVisible();
  await expect(firstButton).toHaveCSS("background-image", /linear-gradient/);
  await firstButton.click();
  await expect(firstButton).toContainText("排队中");
  await expect(firstButton).toContainText("第 1");
  await expect(firstButton).toHaveCSS("width", "124px");
  await expect(firstButton.locator(".popo-download-secondary")).toHaveText("第 1");
  await pageDownloadButton.click();
  await expect(pageDownloadButton).toContainText("已排队 1 个");
  await expect(page.locator("[data-item-index='1'] button.popo-stable-download-button")).toContainText("排队中");
  const batchPauseButton = page.locator(".popo-page-batch-action").filter({ hasText: "全部暂停" });
  const batchRemoveButton = page.locator(".popo-page-batch-action").filter({ hasText: "全部移除" });
  await expect(batchPauseButton).toBeVisible();
  await expect(batchRemoveButton).toBeVisible();
  await batchPauseButton.click();
  await expect(page.locator("[data-item-index='1'] button.popo-stable-download-button")).toContainText("批次已暂停");
  const batchResumeButton = page.locator(".popo-page-batch-action").filter({ hasText: "全部继续" });
  await batchResumeButton.click();
  await expect(page.locator("[data-item-index='1'] button.popo-stable-download-button")).toContainText("排队中");
  await batchRemoveButton.click();
  await expect(page.locator(".popo-page-batch-action").filter({ hasText: "确认移除" })).toBeVisible();
  await page.locator(".popo-page-batch-action").filter({ hasText: "确认移除" }).click();
  await expect(page.locator("[data-item-index='1'] button.popo-stable-download-button")).toHaveAttribute("data-state", "idle");
  await expect(page.locator(".popo-page-batch-action")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__popoUiTest.calls
    .filter((message) => message.type === "START_PAGE_DOWNLOAD"))).toEqual([{
      type: "START_PAGE_DOWNLOAD",
      pageName: "整页素材",
      parentUrl: "https://example.test/team/pc/test/pageDetail/folder"
    }]);
  const firstQueueLayout = await firstButton.evaluate((element) => {
    const content = element.querySelector(".popo-download-content");
    const secondary = element.querySelector(".popo-download-secondary");
    return content && secondary
      ? {
          contentClientWidth: content.clientWidth,
          contentScrollWidth: content.scrollWidth,
          secondaryClientWidth: secondary.clientWidth,
          secondaryScrollWidth: secondary.scrollWidth
        }
      : null;
  });
  expect(firstQueueLayout).not.toBeNull();
  expect(firstQueueLayout.contentScrollWidth).toBeLessThanOrEqual(
    firstQueueLayout.contentClientWidth
  );
  expect(firstQueueLayout.secondaryScrollWidth).toBeLessThanOrEqual(
    firstQueueLayout.secondaryClientWidth
  );
  await page.evaluate(() => {
    const job = window.__popoUiTest.state.jobs[0];
    job.queuePosition = 123;
    for (const listener of window.__popoUiTest.listeners) {
      listener({ type: "FOLDER_TASK_STATUS" });
    }
  });
  await expect(firstButton.locator(".popo-download-secondary")).toHaveText("第 123");
  const threeDigitQueueLayout = await firstButton.evaluate((element) => {
    const content = element.querySelector(".popo-download-content");
    const secondary = element.querySelector(".popo-download-secondary");
    return content && secondary
      ? {
          contentClientWidth: content.clientWidth,
          contentScrollWidth: content.scrollWidth,
          secondaryClientWidth: secondary.clientWidth,
          secondaryScrollWidth: secondary.scrollWidth
        }
      : null;
  });
  expect(threeDigitQueueLayout).not.toBeNull();
  expect(threeDigitQueueLayout.contentScrollWidth).toBeLessThanOrEqual(
    threeDigitQueueLayout.contentClientWidth
  );
  expect(threeDigitQueueLayout.secondaryScrollWidth).toBeLessThanOrEqual(
    threeDigitQueueLayout.secondaryClientWidth
  );
  await expect(page.locator(".popo-page-queue")).toContainText("1 个排队");
  await expect(page.locator(".popo-page-queue")).toHaveAttribute("data-status", "queued");
  await expect(page.locator(".popo-page-queue")).toHaveCSS("background-image", /linear-gradient/);
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
  await expect(page.locator(".popo-page-queue")).toHaveAttribute("data-status", "scanning");
  await expect(firstButton).toHaveCSS("background-image", /linear-gradient/);
  await expect(firstButton).toContainText("查找中");
  await expect(firstButton).toContainText("已找到 383 个");
  await expect(firstButton.locator(".popo-download-state-icon")).toHaveCount(1);
  await expect(firstButton.locator(".popo-download-state-icon svg.lucide-search")).toBeVisible();
  await expect(firstButton.locator(".popo-download-state-icon")).toHaveCSS("width", "20px");
  await expect(firstButton.locator(".popo-download-state-icon")).toHaveCSS("height", "22px");
  await expect(firstButton.locator(".popo-download-rail")).toBeVisible();
  await expect(firstButton.locator(".popo-download-rail")).toHaveCSS("height", "8px");
  await expect(firstButton.locator(".popo-download-estimate-fill")).toBeVisible();
  await expect(firstButton.locator(".popo-download-activity-comet")).toBeVisible();
  await expect(firstButton.locator(".popo-download-activity-packet")).toHaveCount(3);
  await expect(firstButton.locator(".popo-download-rail")).toHaveCSS("background-image", "none");
  const initialScanProgress = await firstButton.locator(".popo-download-estimate-fill").evaluate(
    (element) => Number.parseFloat(element.style.width)
  );
  expect(initialScanProgress).toBeGreaterThanOrEqual(12);
  await expectFolderMotionToAdvance(firstButton, { minimumProgress: 12 });
  await expectFolderIconMotionInsideSafeArea(firstButton, ".popo-download-state-icon-motion");
  await expect.poll(
    () => firstButton.locator(".popo-download-estimate-fill").evaluate(
      (element) => Number.parseFloat(element.style.width)
    ),
    { timeout: 2_000 }
  ).toBeGreaterThan(initialScanProgress);
  const [buttonBox, ownerBox] = await Promise.all([
    firstButton.boundingBox(),
    page.locator("[data-item-index='0'] .ownerName").boundingBox()
  ]);
  expect(buttonBox).not.toBeNull();
  expect(ownerBox).not.toBeNull();
  await expect(firstButton).toHaveCSS("width", "232px");
  await expect(firstButton).toHaveCSS("height", "48px");
  expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(ownerBox.x);

  await page.evaluate(() => {
    const job = window.__popoUiTest.state.jobs[0];
    job.status = "downloading";
    job.counts = { files: 750, discoveredFiles: 750, success: 22, failed: 0, cancelled: 0 };
    for (const listener of window.__popoUiTest.listeners) {
      listener({ type: "FOLDER_TASK_STATUS" });
    }
  });
  await expect(firstButton).toHaveAttribute("data-state", "downloading");
  await expect(page.locator(".popo-page-queue")).toHaveAttribute("data-status", "downloading");
  await expect(firstButton.locator(".popo-download-state-icon")).toHaveCount(1);
  await expect(firstButton.locator(".popo-download-injection-icon svg.lucide-folder")).toBeVisible();
  await expect(firstButton.locator(".popo-download-resource-block")).toHaveCount(1);
  await expect(firstButton.locator(".popo-download-fill")).toBeVisible();
  await expect(firstButton.locator(".popo-download-activity-comet")).toHaveCount(1);
  await expect(firstButton.locator(".popo-download-activity-comet")).toBeVisible();
  await expect(firstButton).toHaveAttribute("aria-busy", "true");
  await expectFolderMotionToAdvance(firstButton);
  await expectFolderIconMotionInsideSafeArea(firstButton, ".popo-download-resource-block");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(firstButton).toHaveCSS("animation-name", "none");
  await expect(page.locator(".popo-page-queue")).toHaveCSS("animation-name", "none");

  await page.evaluate(() => {
    window.__popoUiTest.state.networkHealth = {
      version: 1,
      jobId: "job-1",
      status: "slow",
      activeTasks: 5,
      medianSpeed: 2.5 * 1024 * 1024,
      baselineSpeed: 20 * 1024 * 1024,
      observedAt: new Date().toISOString(),
      sessionStartedAt: new Date(Date.now() - 180_000).toISOString(),
      lowSince: new Date(Date.now() - 90_000).toISOString(),
      severeSince: "",
      recoverySince: "",
      statusChangedAt: new Date().toISOString(),
      highProbabilityWindow: false,
      peakNoticeSequence: 0,
      peakNotifiedDate: "",
      noticeSequence: 1,
      lastNoticeAt: new Date().toISOString(),
      snoozedUntil: "",
      snoozeReminderPending: false,
      mutedDate: "",
      suppressed: false
    };
    for (const listener of window.__popoUiTest.listeners) {
      listener({ type: "FOLDER_TASK_STATUS" });
    }
  });
  await expect(page.locator(".popo-network-notice")).toContainText("本地线路可能拥堵");
  await expect(page.locator(".popo-toast[data-kind='warning']")).toContainText("当前下载速度明显偏低");
  await page.locator(".popo-toast[data-kind='warning']").getByRole("button", {
    name: "15 分钟后提醒"
  }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__popoUiTest.calls.filter(
      (message) => message.type === "SNOOZE_NETWORK_REMINDER"
    ).length
  )).toBe(1);
  await expect(page.locator(".popo-toast[data-kind='warning']")).toHaveCount(0);
  await page.evaluate(() => {
    window.__popoUiTest.state.networkHealth.status = "normal";
    window.__popoUiTest.state.networkHealth.suppressed = true;
    for (const listener of window.__popoUiTest.listeners) {
      listener({ type: "FOLDER_TASK_STATUS" });
    }
  });
  await expect(page.locator(".popo-network-notice")).toHaveCount(0);

  await page.evaluate(() => {
    window.__popoUiTest.state.popupOpen = true;
    for (const listener of window.__popoUiTest.listeners) {
      listener({ type: "POPUP_VISIBILITY_CHANGED", open: true });
    }
  });
  await expect(page.locator(".popo-page-queue")).toHaveAttribute("data-collapsed", "true");

  await page.evaluate(() => {
    const job = window.__popoUiTest.state.jobs[0];
    const completedAt = new Date().toISOString();
    window.__popoUiTest.state.folderReceipts = [{
      key: [job.parentUrl, job.folderItemIndex, job.folderName.toLocaleLowerCase()].join("\u0000"),
      parentUrl: job.parentUrl,
      folderItemIndex: job.folderItemIndex,
      folderName: job.folderName,
      completedAt,
      counts: {
        files: 383,
        discoveredFiles: 383,
        success: 383,
        failed: 0,
        cancelled: 0,
        scanFailures: 0,
        unverifiedDirectories: 0
      }
    }];
    window.__popoUiTest.state.jobs = window.__popoUiTest.state.jobs.filter(
      (candidate) => candidate.id !== job.id
    );
    for (const listener of window.__popoUiTest.listeners) {
      listener({ type: "FOLDER_TASK_FINISHED" });
    }
  });
  await expect(page.locator(".popo-toast")).toHaveCount(0);
  await expect(firstButton).toHaveAttribute("data-state", "success");
  await expect(firstButton).toContainText("已下载 383 个");
  await expect(firstButton).toContainText("无遗漏");
  const completedJobCount = await page.evaluate(() => window.__popoUiTest.state.jobs.length);
  await firstButton.click();
  await expect(firstButton).toHaveAttribute("data-state", "success");
  await expect(firstButton).toHaveAttribute("title", /2 分钟后可重新查重/);
  await expect.poll(() => page.evaluate(() => window.__popoUiTest.state.jobs.length))
    .toBe(completedJobCount);
  await expect.poll(() => page.evaluate(() =>
    window.__popoUiTest.calls.filter((message) => message.type === "START_FOLDER_SCAN").at(-1)
  )).toMatchObject({ folderName: "文件夹 A", folderItemIndex: "0" });
  await page.evaluate(() => {
    window.__popoUiTest.state.folderReceipts[0].completedAt =
      new Date(Date.now() - (2 * 60 * 1000 - 100)).toISOString();
    for (const listener of window.__popoUiTest.listeners) {
      listener({ type: "FOLDER_TASK_STATUS" });
    }
  });
  await expect(firstButton).toHaveAttribute("data-state", "idle", { timeout: 2000 });
  await expect(firstButton).toHaveAttribute("title", /已有文件会跳过，缺少文件会下载/);
  const downloadedMarker = page.locator(
    "[data-item-index='0'] [data-popo-downloaded-marker='true']"
  );
  await expect(downloadedMarker).toBeVisible();
  await expect(downloadedMarker).toHaveAttribute("aria-label", "文件夹 A：已下载过");
  await firstButton.click();
  await expect(firstButton).toHaveAttribute("data-state", "queued");
  await expect(downloadedMarker).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__popoUiTest.state.jobs.length))
    .toBe(completedJobCount + 1);
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
  await expect(page.locator(".popo-toast[data-kind='error']")).toHaveCSS(
    "background-image",
    /linear-gradient/
  );
  await expect(recycledButton).toHaveAttribute("data-state", "failed");
  await expect(recycledButton).toContainText("未完成 1 个");
  await expect(recycledButton).toContainText("重试");
  const startCountBeforeRetry = await page.evaluate(() =>
    window.__popoUiTest.calls.filter(
      (message) => message.type === "START_FOLDER_SCAN"
    ).length
  );
  await recycledButton.click();
  await expect.poll(() => page.evaluate(() =>
    window.__popoUiTest.calls.filter(
      (message) => message.type === "START_FOLDER_SCAN"
    ).length
  )).toBe(startCountBeforeRetry + 1);
  await expect(recycledButton).toHaveAttribute("data-state", "queued");
});

test("directory navigation keeps controls below native cover and mounts them once", async () => {
  await launchExtension();
  const page = await context.newPage();
  await page.route("https://example.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><html><body></body></html>"
  }));
  await page.goto("https://example.test/team/pc/test/pageDetail/folder-a");
  await page.setContent(`
    <title>目录 A</title>
    <div id="toolbar-a"><button><span>所有类型</span></button></div>
    <div data-test-id="virtuoso-scroller">
      <div data-test-id="virtuoso-item-list">
        <div data-item-index="0" data-known-size="48" style="display:flex;width:900px;height:48px;align-items:center">
          <div class="pageName" style="flex:1"><span class="drive-icon-folder"></span><span class="topName">旧目录文件夹</span></div>
        </div>
      </div>
    </div>
  `);
  await page.evaluate(() => {
    const runtime = {
      getURL: () => "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
      sendMessage: async (message) => message.type === "GET_STATE"
        ? { ok: true, state: { jobs: [], folderReceipts: [], activeJobId: null, mode: "idle", popupOpen: false }, settings: {} }
        : { ok: true, connection: { connected: true }, settings: {} },
      onMessage: { addListener() {}, removeListener() {} }
    };
    window.chrome = window.chrome || {};
    Object.defineProperty(window.chrome, "runtime", { configurable: true, value: runtime });
  });
  await page.addScriptTag({ path: resolve(projectRoot, "page-api.js") });
  await page.addScriptTag({ path: resolve(projectRoot, "runtime/page-ui.js") });

  await expect(page.locator("button.popo-stable-download-button")).toHaveCount(1);
  await expect(page.locator("#popo-directory-transition-overlay")).toHaveCount(0);
  const transitionCoverHidesButton = await page.evaluate(() => {
    const cover = document.createElement("div");
    cover.className = "popo-native-transition-cover";
    Object.assign(cover.style, {
      position: "fixed",
      inset: "0",
      zIndex: "1",
      background: "white"
    });
    document.body.append(cover);
    const button = document.querySelector("button.popo-stable-download-button");
    const rect = button.getBoundingClientRect();
    const topmost = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
    return Boolean(topmost?.closest(".popo-native-transition-cover"));
  });
  expect(transitionCoverHidesButton).toBe(true);
  await page.evaluate(() => document.querySelector(".popo-native-transition-cover").remove());
  await page.evaluate(() => {
    const tooltip = document.createElement("div");
    tooltip.className = "popo-native-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.textContent = "旧目录文件名";
    Object.assign(tooltip.style, {
      position: "fixed",
      top: "260px",
      left: "180px",
      zIndex: "999999",
      padding: "8px",
      background: "#111923",
      color: "white"
    });
    document.body.append(tooltip);
    history.pushState({}, "", "/team/pc/test/pageDetail/folder-b");
  });
  await expect(page.locator("button.popo-stable-download-button")).toHaveCount(0);
  await expect(page.locator(".popo-react-project-count")).toHaveCount(0);
  const transitionOverlay = page.locator("#popo-directory-transition-overlay");
  await expect(transitionOverlay).toBeVisible();
  await expect(transitionOverlay).toContainText("正在加载目录");
  await expect(page.locator("html")).toHaveAttribute("data-popo-directory-transition", "true");
  await expect(page.locator(".popo-native-tooltip")).toHaveCSS("visibility", "hidden");
  const overlayCoversListArea = await page.evaluate(() => {
    const overlay = document.querySelector("#popo-directory-transition-overlay");
    const rect = overlay.getBoundingClientRect();
    return document.elementFromPoint(
      rect.left + rect.width / 2,
      Math.min(rect.bottom - 20, rect.top + 240)
    )?.closest("#popo-directory-transition-overlay") === overlay;
  });
  expect(overlayCoversListArea).toBe(true);
  await page.waitForTimeout(150);
  await expect(page.locator("button.popo-stable-download-button")).toHaveCount(0);

  await page.evaluate(() => {
    document.title = "目录 B";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "该文件夹暂无内容";
    document.body.append(empty);
  });
  await page.waitForTimeout(200);
  await expect(page.locator("button.popo-stable-download-button")).toHaveCount(0);
  await expect(page.locator(".popo-react-project-count")).toHaveCount(0);
  await expect(page.getByText("正在统计…")).toHaveCount(0);

  await page.evaluate(() => {
    document.querySelector(".empty-state").remove();
    document.querySelector('[data-test-id="virtuoso-scroller"]').style.opacity = "0";
    const scroller = document.createElement("div");
    scroller.dataset.testId = "virtuoso-scroller";
    scroller.innerHTML = `
      <div data-test-id="virtuoso-item-list">
        <div data-item-index="0" data-known-size="48" style="display:flex;width:900px;height:48px;align-items:center">
          <div class="pageName" style="flex:1"><span class="drive-icon-folder"></span><span class="topName">新目录文件夹</span></div>
        </div>
      </div>
    `;
    document.body.append(scroller);
  });
  const button = page.locator("button.popo-stable-download-button");
  await expect(button).toHaveCount(1);
  await expect(button).toHaveAttribute("data-folder-name", "新目录文件夹");
  await expect(page.locator('[style*="opacity: 0"] button.popo-stable-download-button')).toHaveCount(0);
  await expect(page.locator(".popo-react-project-count")).toHaveText("1 个项目");
  await expect(transitionOverlay).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-popo-directory-transition", "true");
  await page.evaluate(() => document.querySelector(".popo-native-tooltip")?.remove());
  await expect(page.getByText("正在统计…")).toHaveCount(0);

  await page.evaluate(() => {
    const empty = document.createElement("div");
    empty.className = "empty-state late-transition";
    empty.textContent = "该文件夹暂无内容";
    document.body.append(empty);
  });
  await expect(button).toHaveCount(0);
  await expect(page.locator(".popo-react-project-count")).toHaveCount(0);
  await page.evaluate(() => document.querySelector(".late-transition").remove());
  await expect(button).toHaveCount(1);
  await expect(button).toHaveAttribute("data-folder-name", "新目录文件夹");
  await page.waitForTimeout(450);
  await expect(button).toHaveCount(1);

  const sameUrl = page.url();
  await page.evaluate(() => {
    window.__popoNativeDirectoryEvents = { pointerup: 0, click: 0, dblclick: 0 };
    const name = document.querySelector(
      '[data-test-id="virtuoso-scroller"]:not([style*="opacity: 0"]) .topName'
    );
    for (const type of ["pointerup", "click", "dblclick"]) {
      name.addEventListener(type, () => {
        window.__popoNativeDirectoryEvents[type] += 1;
      });
    }
  });
  await page.locator('[data-test-id="virtuoso-scroller"]:not([style*="opacity: 0"]) .topName').dblclick();
  await expect.poll(() => page.evaluate(() => window.__popoNativeDirectoryEvents)).toEqual({
    pointerup: 2,
    click: 2,
    dblclick: 1
  });
  await expect(page).toHaveURL(sameUrl);
  await expect(button).toHaveCount(0);
  await expect(page.locator(".popo-react-project-count")).toHaveCount(0);
  await page.evaluate(() => {
    document.title = "新目录文件夹";
    const empty = document.createElement("div");
    empty.className = "empty-state same-url-transition";
    empty.textContent = "该文件夹暂无内容";
    document.body.append(empty);
  });
  await page.waitForTimeout(150);
  await expect(button).toHaveCount(0);
  await page.evaluate(() => {
    document.querySelector(".same-url-transition").remove();
    document.querySelectorAll('[data-test-id="virtuoso-scroller"]')[1]
      .querySelector(".topName").textContent = "同地址子目录";
  });
  await expect(button).toHaveCount(1);
  await expect(button).toHaveAttribute("data-folder-name", "同地址子目录");
  await expect(page).toHaveURL(sameUrl);

  await page.locator('[data-test-id="virtuoso-scroller"]:not([style*="opacity: 0"]) .topName').dblclick();
  await expect(transitionOverlay).toBeVisible();
  await expect(button).toHaveCount(0);
  await page.waitForTimeout(5_200);
  await expect(transitionOverlay).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-popo-directory-transition", "true");
  await expect(button).toHaveCount(1);
  await expect(button).toHaveAttribute("data-folder-name", "同地址子目录");
});

test("active folder motion starts on page load and restarts after row and UI remounts", async () => {
  await launchExtension();
  const page = await context.newPage();
  await page.route("https://example.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><html><body></body></html>"
  }));
  await page.goto("https://example.test/team/pc/test/pageDetail/motion-recovery");
  await page.setContent(`
    <div id="toolbar"><button><span>所有类型</span></button></div>
    <div data-test-id="virtuoso-scroller">
      <div data-test-id="virtuoso-item-list">
        <div data-item-index="0" data-known-size="48" style="display:flex;width:900px;height:48px;align-items:center">
          <div class="pageName" style="flex:1"><span class="drive-icon-folder"></span><span class="topName">Motion recovery folder</span></div>
          <div class="ownerName" style="flex:0 0 150px">Owner</div>
        </div>
      </div>
    </div>
  `);
  await page.evaluate(() => {
    const parentUrl = location.href;
    const folderName = "Motion recovery folder";
    const state = {
      jobs: [{
        id: "motion-job",
        key: [parentUrl, "0", folderName.toLowerCase()].join("\u0000"),
        status: "scanning",
        folderName,
        folderItemIndex: "0",
        parentUrl,
        startedAt: new Date(Date.now() - 8_000).toISOString(),
        counts: { discoveredFiles: 42 }
      }],
      activeJobId: "motion-job",
      mode: "scanning",
      popupOpen: false
    };
    const listeners = new Set();
    const runtime = {
      getURL: () => "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
      sendMessage: async (message) => {
        if (message.type === "GET_STATE") {
          return { ok: true, state: JSON.parse(JSON.stringify(state)), settings: {} };
        }
        if (message.type === "CHECK_GOPEED") {
          return { ok: true, connection: { connected: true }, settings: {} };
        }
        return { ok: true, state: JSON.parse(JSON.stringify(state)) };
      },
      onMessage: {
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener)
      }
    };
    window.chrome = window.chrome || {};
    Object.defineProperty(window.chrome, "runtime", { configurable: true, value: runtime });
    window.__popoMotionTest = {
      state,
      emit() {
        for (const listener of listeners) listener({ type: "FOLDER_TASK_STATUS" });
      }
    };
  });
  await page.addScriptTag({ path: resolve(projectRoot, "runtime/page-ui.js") });

  const activeButton = page.locator(
    '[data-item-index="0"] button.popo-stable-download-button'
  );
  await expect(activeButton).toHaveAttribute("data-state", "scanning");
  await expectFolderMotionToAdvance(activeButton, { minimumProgress: 45 });

  await page.evaluate(() => {
    const row = document.querySelector('[data-item-index="0"]');
    const replacement = row.cloneNode(true);
    replacement.querySelector(".popo-react-download-anchor")?.remove();
    replacement.querySelector(".pageName")?.removeAttribute("data-popo-download-host");
    row.replaceWith(replacement);
  });
  await expect(activeButton).toHaveAttribute("data-state", "scanning");
  await expectFolderMotionToAdvance(activeButton, { minimumProgress: 45 });

  await page.evaluate(() => {
    const job = window.__popoMotionTest.state.jobs[0];
    job.status = "downloading";
    job.counts = { files: 100, discoveredFiles: 100, success: 24, failed: 0, cancelled: 0 };
    window.__popoMotionTest.state.mode = "downloading";
    window.__popoMotionTest.emit();
  });
  await expect(activeButton).toHaveAttribute("data-state", "downloading");
  await expectFolderMotionToAdvance(activeButton, { minimumProgress: 24 });

  await page.evaluate(() => window.__POPO_REACT_PAGE_CLEANUP__?.());
  await page.addScriptTag({ path: resolve(projectRoot, "runtime/page-ui.js") });
  await expect(activeButton).toHaveAttribute("data-state", "downloading");
  await expectFolderMotionToAdvance(activeButton, { minimumProgress: 24 });
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
  await expect(popup.locator(".popup-queue-item")).toHaveAttribute("data-status", "cancelled");
  await expect(popup.locator(".popup-queue-item")).toHaveCSS("background-image", /linear-gradient/);
  await expect(popup.getByRole("button", { name: "继续（2）" })).toBeVisible();
  await expect(popup.getByRole("button", { name: "移除" })).toBeVisible();
  await expect(popup.locator("body")).not.toContainText("隐藏工作区");
  await expect(popup.locator("body")).not.toContainText("Gopeed");
  await expect(popup.locator("body")).not.toContainText("API");

  const settingsPanel = popup.locator(".engine-settings");
  if (await settingsPanel.getAttribute("open") == null) {
    await settingsPanel.locator(":scope > summary").click();
  }
  const concurrencySelect = popup.locator("#downloadConcurrency");
  await expect(concurrencySelect).toBeVisible();
  await expect(concurrencySelect).toHaveValue("5");
  await expect(concurrencySelect).toBeEnabled();
  await concurrencySelect.selectOption("2");
  await expect(concurrencySelect).toHaveValue("2");
  await expect.poll(() => session.worker.evaluate(async () => {
    const { popoSettings, popoState } = await chrome.storage.local.get([
      "popoSettings",
      "popoState"
    ]);
    return {
      saved: popoSettings?.concurrency,
      active: popoState?.settings?.concurrency
    };
  })).toEqual({ saved: 2, active: 2 });

  await session.worker.evaluate(async () => {
    const { popoState } = await chrome.storage.local.get("popoState");
    popoState.jobs = [{
      id: "job-e2e-active",
      key: "e2e-active-key",
      folderName: "正在处理的文件夹",
      status: "paused",
      createdAt: new Date().toISOString(),
      counts: { files: 2, success: 0, failed: 0, cancelled: 0 }
    }, ...popoState.jobs];
    popoState.activeJobId = "job-e2e-active";
    popoState.mode = "paused";
    await chrome.storage.local.set({ popoState });
  });
  await expect(concurrencySelect).toBeDisabled();
  await expect(concurrencySelect).toHaveAttribute(
    "title",
    "任务进行或暂停时不能调整并行下载数"
  );

  await session.worker.evaluate(async () => {
    const { popoState } = await chrome.storage.local.get("popoState");
    popoState.jobs = popoState.jobs.filter((job) => job.id !== "job-e2e-active");
    popoState.activeJobId = null;
    popoState.mode = "idle";
    await chrome.storage.local.set({ popoState });
  });
  await expect(concurrencySelect).toBeEnabled();

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

test("popup copies a bounded redacted update diagnostic snapshot", async () => {
  const session = await launchExtension();
  await session.worker.evaluate(async () => {
    const outcomes = ["matched", "mismatch", "shadow_unavailable", "matched_failure"];
    const history = Array.from({ length: 70 }, (_, index) => ({
      schemaVersion: 1,
      outcome: outcomes[index % outcomes.length],
      comparable: index % 4 !== 2,
      matches: index % 4 === 0 || index % 4 === 3,
      shadowTarget: "0.7.3",
      legacyTarget: index % 4 === 1 ? "0.7.2" : "0.7.3",
      shadowState: index % 4 === 2 ? "unavailable" : "available",
      shadowErrorCode: index % 4 === 2 ? "AGENT_UNAVAILABLE" : "",
      legacyErrorCode: "",
      shadowFailureKind: index % 4 === 2 ? "network" : "",
      legacyFailureKind: "",
      shadowTransactionId: `shadow-e2e-${index}`,
      shadowUpdatedAt: new Date(Date.UTC(2026, 7, 14, 0, index)).toISOString(),
      checkedAt: new Date(Date.UTC(2026, 7, 14, 1, index)).toISOString(),
      token: "e2e-history-secret",
      endpoint: "http://127.0.0.1:54321"
    }));
    Object.assign(history[10], {
      shadowTarget: "https://e2e-secret.example/version",
      legacyTarget: "D:\\private\\e2e-version.txt",
      shadowState: "private-state",
      shadowErrorCode: "SHADOW_E2E_SECRET_TOKEN",
      legacyErrorCode: "LEGACY_E2E_SECRET_CODE",
      shadowFailureKind: "e2e-secret-kind",
      legacyFailureKind: "e2e-secret-kind",
      shadowTransactionId: "shadow-D:\\private\\e2e-transaction.txt",
      shadowUpdatedAt: "D:\\private\\e2e-time.txt"
    });
    await chrome.storage.local.set({
      popoUpdateStatus: {
        state: "up_to_date",
        currentVersion: "0.7.2",
        targetVersion: "D:\\private\\legacy-e2e-version.txt",
        message: "e2e legacy secret message",
        updatedAt: "2026-08-14T01:00:00.000Z"
      },
      popoAgentShadowStatus: {
        available: true,
        state: "checking",
        currentVersion: "0.7.2",
        targetVersion: "https://agent-e2e-secret.example/version",
        transactionId: "shadow-e2e-current",
        message: "D:\\private\\agent.log",
        errorCode: "AGENT_E2E_SECRET_TOKEN",
        protocol: 2,
        minimumProtocol: 1,
        updatedAt: "2026-08-14T01:01:00.000Z",
        token: "e2e-agent-secret"
      },
      popoAgentShadowComparison: {
        ...history.at(-1),
        shadowTransactionId: "shadow-e2e-latest",
        checkedAt: "2026-08-14T02:00:00.000Z",
        path: "D:\\private\\package.zip"
      },
      popoAgentShadowComparisonHistory: history
    });
  });

  const popup = await openPopup(session.extensionId);
  const pageErrors = [];
  popup.on("pageerror", (error) => pageErrors.push(String(error)));
  await popup.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText(value) {
          window.__copiedUpdateDiagnostics = value;
        }
      }
    });
  });
  const diagnosticsPanel = popup.locator(".update-diagnostics");
  await diagnosticsPanel.locator(":scope > summary").click();
  await popup.locator("#copyUpdateDiagnosticsButton").click();
  await expect(popup.locator("#copyUpdateDiagnosticsButton")).toHaveText("已复制");
  const copied = await popup.evaluate(() => window.__copiedUpdateDiagnostics || "");
  const diagnostics = JSON.parse(copied);
  expect(diagnostics.schemaVersion).toBe(1);
  expect(diagnostics.phase).toBe("shadow");
  expect(diagnostics.history).toHaveLength(64);
  expect(diagnostics.history[0].shadowTransactionId).toBe("shadow-e2e-6");
  expect(diagnostics.history[4]).toMatchObject({
    shadowTarget: "",
    legacyTarget: "",
    shadowState: "unavailable",
    shadowErrorCode: "",
    legacyErrorCode: "",
    shadowFailureKind: "",
    legacyFailureKind: "",
    shadowTransactionId: "",
    shadowUpdatedAt: ""
  });
  expect(diagnostics.latestComparison.shadowTransactionId).toBe("shadow-e2e-latest");
  expect(diagnostics.agent.transactionId).toBe("shadow-e2e-current");
  expect(diagnostics.agent.targetVersion).toBe("");
  expect(diagnostics.agent.errorCode).toBe("");
  expect(diagnostics.legacyUpdate.targetVersion).toBe("");
  expect(diagnostics.summary.total).toBe(64);
  for (const sensitive of [
    "e2e-history-secret",
    "e2e-agent-secret",
    "127.0.0.1:54321",
    "e2e legacy secret message",
    "private\\agent.log",
    "private\\package.zip",
    "e2e-secret.example/version",
    "private\\e2e-version.txt",
    "private-state",
    "E2E_SECRET_TOKEN",
    "E2E_SECRET_CODE",
    "e2e-secret-kind",
    "private\\e2e-transaction.txt",
    "private\\e2e-time.txt",
    "private\\legacy-e2e-version.txt",
    "agent-e2e-secret.example/version"
  ]) {
    expect(copied).not.toContain(sensitive);
  }
  const retainedHistoryCount = await session.worker.evaluate(async () => {
    const { popoAgentShadowComparisonHistory } = await chrome.storage.local.get(
      "popoAgentShadowComparisonHistory"
    );
    return popoAgentShadowComparisonHistory.length;
  });
  expect(retainedHistoryCount).toBe(70);
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
  await expect(popup.locator(".popup-queue-item")).toHaveAttribute("data-status", "paused");
  await expect(popup.locator(".popup-queue-item")).toHaveCSS("background-image", /linear-gradient/);

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
