"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));

test("Manifest V3 仅申请任务所需权限", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.7.0.8");
  assert.equal(manifest.version_name, "0.7.0-beta.8");
  const digest = crypto.createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest();
  const alphabet = "abcdefghijklmnop";
  const extensionId = [...digest.subarray(0, 16)]
    .map((value) => alphabet[value >> 4] + alphabet[value & 15])
    .join("");
  assert.equal(extensionId, "coocdgkmbpkacapjlmnmemebmmdahjaa");
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["alarms", "nativeMessaging", "storage", "tabs", "unlimitedStorage"]
  );
  assert.deepEqual(
    manifest.host_permissions,
    [
      "https://docs.popo.netease.com/*",
      "http://127.0.0.1/*",
      "http://localhost/*"
    ]
  );
});

test("页面接口桥运行在主世界，控制逻辑运行在隔离世界", () => {
  assert.equal(manifest.content_scripts.length, 2);
  assert.equal(manifest.content_scripts[0].world, "MAIN");
  assert.equal(manifest.content_scripts[0].all_frames, true);
  assert.equal(manifest.content_scripts[0].js[0], "page-api.js");
  assert.equal(manifest.content_scripts[1].world, undefined);
  assert.equal(manifest.content_scripts[1].all_frames, true);
  assert.deepEqual(manifest.content_scripts[1].js, ["core.js", "queue.js", "content.js"]);
});

test("扩展运行时不包含 Playwright", () => {
  const runtimeFiles = [
    "background.js",
    "content.js",
    "core.js",
    "gopeed.js",
    "queue.js",
    "page-api.js",
    "popup.js"
  ];
  for (const file of runtimeFiles) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.doesNotMatch(source, /playwright/i, file);
  }
});

test("文件夹行按钮、项目总数和直接入队逻辑存在于内容脚本", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(content, /popo-stable-download-button/);
  assert.match(content, /稳定下载此文件夹/);
  assert.match(content, /popo-stable-project-count/);
  assert.match(content, /所有类型/);
  assert.match(content, /margin-right: auto/);
  assert.match(content, /placement\.leftControl\.nextSibling/);
  assert.match(content, /inferVirtualListItemCount/);
  assert.match(content, /\$\{count\} 个项目/);
  assert.match(content, /START_FOLDER_SCAN/);
  assert.doesNotMatch(content, /CONFIRM_FOLDER_DOWNLOAD|SHOW_FOLDER_CONFIRMATION|确认下载/);
  assert.match(content, /popo-stable-download-worker-frame/);
  assert.match(content, /REGISTER_WORKER_FRAME/);
  assert.match(content, /popo-stable-download-queue/);
  assert.match(content, /CANCEL_JOB/);
  assert.match(content, /已添加下载，排队中/);
  assert.match(content, /SOURCE_PAGE_READY/);
  assert.match(content, /needsWorkerRecovery/);
  assert.match(content, /data-collapsed/);
  assert.match(content, /popo-queue-toggle/);
  assert.match(content, /popo-queue-progress/);
  assert.match(content, /正在添加下载/);
  assert.doesNotMatch(content, /下载多个文件/);
  assert.match(content, /folderItemIndex/);
  assert.match(content, /img\[src\*="s3v2-drive-"\]/);
  assert.match(content, /RESOLVE_TEAM_SPACE_ID/);
  assert.match(content, /teamSpace\/id/);
  assert.match(content, /normalizeText\(document\.title\)/);
  assert.match(content, /stableBottomRounds >= 8/);
  assert.match(content, /waitForDirectoryItems\(scroller/);
  assert.match(content, /Virtuoso occasionally leaves its last overscan window stale/);
  assert.match(content, /seenItems/);
  assert.doesNotMatch(content, /case "CLICK_DOWNLOAD"/);
});

test("队列按钮同步不会触发虚拟列表 DOM 监听死循环", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  const applyQueueState = content.match(
    /function applyQueueStateToButton[\s\S]+?(?=\n  function syncFolderButtonsWithQueue)/
  )?.[0] || "";

  assert.match(applyQueueState, /setTextIfChanged\(button/);
  assert.doesNotMatch(applyQueueState, /button\.textContent\s*=/);
  assert.match(content, /function mutationNeedsFolderButtonInstall/);
  assert.match(
    content,
    /mutations\.some\(mutationNeedsFolderButtonInstall\)/
  );
  assert.doesNotMatch(
    content,
    /new MutationObserver\(scheduleFolderButtonInstall\)/
  );
  const renderQueuePanel = content.match(
    /function renderQueuePanel[\s\S]+?(?=\n  async function refreshQueueState)/
  )?.[0] || "";
  assert.match(renderQueuePanel, /panel\.hidden = liveJobs\.length === 0/);
  assert.doesNotMatch(renderQueuePanel, /recentTerminal/);
});

test("弹窗已移除全局扫描和筛选设置", () => {
  const popup = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf8");
  const popupScript = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
  assert.doesNotMatch(popup, /扫描当前文件夹|文件格式|包含关键词|导出 CSV|导出 JSON|清空任务/);
  assert.match(popup, /点击文件夹右侧、三个点左边的蓝色下载按钮/);
  assert.match(popup, /Gopeed 下载引擎/);
  assert.match(popup, /保存根目录/);
  assert.match(popup, /gopeedDownloadDirOverride/);
  assert.match(popup, /chooseDownloadDirectoryButton/);
  assert.match(popup, /clearDownloadDirectoryButton/);
  assert.doesNotMatch(popup, /id="gopeedDownloadDirOverride"[^>]*type="text"/);
  assert.doesNotMatch(popup, /下载多个文件/);
  assert.doesNotMatch(popupScript, /recentTerminal/);
  assert.match(popupScript, /clearRecoveredRefreshError/);
});

test("POPO Logo 在弹窗和网页按钮中支持明暗主题", () => {
  const popup = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf8");
  const popupCss = fs.readFileSync(path.join(__dirname, "..", "popup.css"), "utf8");
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  const logo = fs.readFileSync(path.join(__dirname, "..", "assets", "popo-logo.svg"), "utf8");

  assert.match(popup, /class="brand-logo"[^>]+assets\/popo-logo\.svg/);
  assert.match(popupCss, /@media \(prefers-color-scheme: dark\)/);
  assert.match(content, /chrome\.runtime\.getURL\("assets\/popo-logo\.svg"\)/);
  assert.match(content, /data-theme="dark"/);
  assert.match(logo, /@media \(prefers-color-scheme: dark\)/);
  assert.deepEqual(manifest.icons, {
    16: "assets/popo-logo-16.png",
    32: "assets/popo-logo-32.png",
    48: "assets/popo-logo-48.png",
    128: "assets/popo-logo-128.png"
  });
  assert.deepEqual(manifest.action.default_icon, {
    16: "assets/popo-logo-16.png",
    32: "assets/popo-logo-32.png"
  });
  for (const size of [16, 32, 48, 128]) {
    const png = fs.readFileSync(path.join(__dirname, "..", "assets", `popo-logo-${size}.png`));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  assert.deepEqual(manifest.web_accessible_resources, [
    {
      resources: ["assets/popo-logo.svg"],
      matches: ["https://docs.popo.netease.com/*"]
    }
  ]);
});

test("下载由 Gopeed 统一管理并固定任务并发 5", () => {
  const background = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  assert.match(background, /concurrency:\s*5/);
  assert.match(background, /gopeedConnections:\s*1/);
  assert.match(background, /version:\s*4/);
  assert.match(background, /activeJobId/);
  assert.match(background, /applyCancelPolicy/);
  assert.match(background, /ITEM_CHUNK_SIZE/);
  assert.match(background, /activeTransfers/);
  assert.match(background, /POPO_WORKER_UNAVAILABLE/);
  assert.match(background, /registerSourcePage/);
  assert.match(background, /本次不计失败/);
  assert.match(background, /setBadgeText/);
  assert.match(background, /startOrReplaceGopeedTask/);
  assert.match(background, /continueGopeedTask/);
  assert.match(background, /requestDirectDownloadUrl/);
  assert.match(background, /连续 3 次未返回下载地址/);
  assert.doesNotMatch(background, /chrome\.downloads/);
  assert.doesNotMatch(background, /type:\s*"CLICK_DOWNLOAD"/);
  assert.match(background, /itemIndex:\s*item\.itemIndex/);
  assert.match(background, /looksLikeFileTitle/);
  assert.match(background, /系统元数据文件已自动忽略/);
  assert.match(background, /gopeedDownloadDirOverride/);
  assert.match(background, /sendNativeMessage\(FOLDER_PICKER_HOST/);
  assert.match(background, /action: "ensure_gopeed"/);
  assert.match(background, /CHOOSE_DOWNLOAD_DIRECTORY/);
  assert.match(background, /startScannedDownload\(state, \{ automatic: true \}\)/);
  assert.match(background, /rootProjectCount/);
  assert.doesNotMatch(background, /SHOW_FOLDER_CONFIRMATION|CONFIRM_FOLDER_DOWNLOAD/);
});

test("弹窗为每个任务显示文件进度条", () => {
  const popup = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
  const popupCss = fs.readFileSync(path.join(__dirname, "..", "popup.css"), "utf8");
  assert.match(popup, /function jobProgress/);
  assert.match(popup, /popup-job-progress/);
  assert.match(popup, /aria-valuenow/);
  assert.match(popupCss, /\.popup-job-progress/);
});
