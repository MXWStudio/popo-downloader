"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));

test("Manifest V3 仅申请任务所需权限", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.6.0.3");
  assert.equal(manifest.version_name, "0.6.0-beta.3");
  const digest = crypto.createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest();
  const alphabet = "abcdefghijklmnop";
  const extensionId = [...digest.subarray(0, 16)]
    .map((value) => alphabet[value >> 4] + alphabet[value & 15])
    .join("");
  assert.equal(extensionId, "coocdgkmbpkacapjlmnmemebmmdahjaa");
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["alarms", "nativeMessaging", "storage", "tabs"]
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
  assert.deepEqual(manifest.content_scripts[1].js, ["core.js", "content.js"]);
});

test("扩展运行时不包含 Playwright", () => {
  const runtimeFiles = [
    "background.js",
    "content.js",
    "core.js",
    "gopeed.js",
    "page-api.js",
    "popup.js"
  ];
  for (const file of runtimeFiles) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.doesNotMatch(source, /playwright/i, file);
  }
});

test("文件夹行按钮与数量确认文案存在于内容脚本", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(content, /popo-stable-download-button/);
  assert.match(content, /稳定下载此文件夹/);
  assert.match(content, /发现 \$\{fileCount\} 个文件，确认下载/);
  assert.match(content, /START_FOLDER_SCAN/);
  assert.match(content, /CONFIRM_FOLDER_DOWNLOAD/);
  assert.match(content, /popo-stable-download-worker-frame/);
  assert.match(content, /REGISTER_WORKER_FRAME/);
  assert.match(content, /文件将交给本机 Gopeed 下载/);
  assert.doesNotMatch(content, /下载多个文件/);
  assert.match(content, /folderItemIndex/);
  assert.match(content, /img\[src\*="s3v2-drive-"\]/);
  assert.match(content, /normalizeText\(document\.title\)/);
  assert.match(content, /stableBottomRounds >= 8/);
  assert.match(content, /waitForDirectoryItems\(scroller/);
  assert.match(content, /Virtuoso occasionally leaves its last overscan window stale/);
  assert.match(content, /seenItems/);
  assert.doesNotMatch(content, /case "CLICK_DOWNLOAD"/);
});

test("弹窗已移除全局扫描和筛选设置", () => {
  const popup = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf8");
  assert.doesNotMatch(popup, /扫描当前文件夹|文件格式|包含关键词|导出 CSV|导出 JSON|清空任务/);
  assert.match(popup, /点击文件夹右侧、三个点左边的蓝色下载按钮/);
  assert.match(popup, /Gopeed 下载引擎/);
  assert.match(popup, /保存根目录/);
  assert.match(popup, /gopeedDownloadDirOverride/);
  assert.match(popup, /chooseDownloadDirectoryButton/);
  assert.match(popup, /clearDownloadDirectoryButton/);
  assert.doesNotMatch(popup, /id="gopeedDownloadDirOverride"[^>]*type="text"/);
  assert.doesNotMatch(popup, /下载多个文件/);
});

test("下载由 Gopeed 统一管理并固定任务并发 5", () => {
  const background = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  assert.match(background, /concurrency:\s*5/);
  assert.match(background, /gopeedConnections:\s*1/);
  assert.match(background, /version:\s*3/);
  assert.match(background, /activeTransfers/);
  assert.match(background, /createGopeedTask/);
  assert.match(background, /patchGopeedTask/);
  assert.match(background, /continueGopeedTask/);
  assert.doesNotMatch(background, /chrome\.downloads/);
  assert.doesNotMatch(background, /type:\s*"CLICK_DOWNLOAD"/);
  assert.match(background, /itemIndex:\s*item\.itemIndex/);
  assert.match(background, /looksLikeFileTitle/);
  assert.match(background, /系统元数据文件已自动忽略/);
  assert.match(background, /gopeedDownloadDirOverride/);
  assert.match(background, /sendNativeMessage\(FOLDER_PICKER_HOST/);
  assert.match(background, /action: "ensure_gopeed"/);
  assert.match(background, /CHOOSE_DOWNLOAD_DIRECTORY/);
});
