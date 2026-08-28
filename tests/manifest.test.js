"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));

test("Manifest V3 仅申请任务所需权限", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.7.8");
  assert.equal(manifest.version_name, "0.7.8");
  assert.equal(manifest.name, "POPO 稳定下载助手");
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
      "https://*.ingest.sentry.io/*",
      "https://*.ingest.us.sentry.io/*",
      "http://127.0.0.1/*",
      "http://localhost/*"
    ]
  );
});

test("页面接口桥、全框架工作脚本和顶层 React 界面分层运行", () => {
  assert.equal(manifest.content_scripts.length, 3);
  assert.equal(manifest.content_scripts[0].world, "MAIN");
  assert.equal(manifest.content_scripts[0].all_frames, true);
  assert.equal(manifest.content_scripts[0].js[0], "page-api.js");
  assert.equal(manifest.content_scripts[1].world, undefined);
  assert.equal(manifest.content_scripts[1].all_frames, true);
  assert.deepEqual(manifest.content_scripts[1].js, ["core.js", "queue.js", "content.js"]);
  assert.equal(manifest.content_scripts[2].world, undefined);
  assert.equal(manifest.content_scripts[2].all_frames, false);
  assert.deepEqual(manifest.content_scripts[2].js, ["runtime/page-ui.js"]);
});

test("扩展运行时不包含 Playwright", () => {
  const runtimeFiles = [
    "background.js",
    "content.js",
    "core.js",
    "gopeed.js",
    "queue.js",
    "page-api.js",
    "runtime/popup.js",
    "runtime/page-ui.js"
  ];
  for (const file of runtimeFiles) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.doesNotMatch(source, /playwright/i, file);
  }
});

test("React 页面根接管项目数、文件夹按钮、任务条和通知", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  const pageUi = fs.readFileSync(path.join(__dirname, "..", "src", "page-ui.tsx"), "utf8");
  assert.match(pageUi, /function PageEnhancerApp/);
  assert.match(pageUi, /createPortal/);
  assert.match(pageUi, /ProjectCount/);
  assert.match(pageUi, /PageDownloadButton/);
  assert.match(pageUi, /FolderDownloadButton/);
  assert.match(pageUi, /QueueDock/);
  assert.match(pageUi, /ToastViewport/);
  assert.match(pageUi, /POPUP_VISIBILITY_CHANGED/);
  assert.match(pageUi, /popupOpen \? false : expanded/);
  assert.match(pageUi, /popupOpen \? \[\] : toasts/);
  assert.match(pageUi, /observeLegacyUi/);
  assert.match(pageUi, /nextServiceNotice/);
  assert.match(pageUi, /popo-stable-download-button/);
  assert.match(pageUi, /稳定下载此文件夹/);
  assert.match(pageUi, /popo-stable-project-count/);
  assert.match(pageUi, /所有类型/);
  assert.match(pageUi, /inferVirtualListItemCount/);
  assert.match(pageUi, /count \+ " 个项目"/);
  assert.match(pageUi, /START_FOLDER_SCAN/);
  assert.match(pageUi, /START_PAGE_DOWNLOAD/);
  assert.match(pageUi, /一键下载/);
  assert.doesNotMatch(pageUi, /CONFIRM_FOLDER_DOWNLOAD|SHOW_FOLDER_CONFIRMATION|确认下载/);
  assert.match(content, /popo-stable-download-worker-frame/);
  assert.match(content, /PAGE_SCAN_FRAME_NAME_PREFIX/);
  assert.match(content, /scanDirectoryInHiddenFrame/);
  assert.match(content, /REGISTER_WORKER_FRAME/);
  assert.match(content, /SOURCE_PAGE_READY/);
  assert.match(content, /needsWorkerRecovery/);
  assert.match(content, /popo-stable-download:ensure-worker/);
  const topFrameBoot = content.match(
    /if \(IS_TOP_FRAME\) \{[\s\S]+?(?=\n  \} else \{)/
  )?.[0] || "";
  assert.doesNotMatch(topFrameBoot, /startFolderButtonObserver/);
  assert.match(topFrameBoot, /startQueueStatePolling/);
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

test("页面只创建一个 React 根且 Portal 监听不会形成 DOM 死循环", () => {
  const pageUi = fs.readFileSync(path.join(__dirname, "..", "src", "page-ui.tsx"), "utf8");
  assert.equal((pageUi.match(/createRoot\(/g) || []).length, 1);
  assert.match(pageUi, /createPortal/);
  assert.match(pageUi, /function mutationNeedsReconcile/);
  assert.match(pageUi, /popoReactOwned/);
  assert.match(pageUi, /mutations\.some\(mutationNeedsReconcile\)/);
  assert.match(pageUi, /new MutationObserver/);
  assert.match(pageUi, /继续（/);
  assert.match(pageUi, /DISMISS_JOB/);
  assert.match(pageUi, /确认移除/);
  assert.match(pageUi, /只从列表移除，不会删除已下载文件/);
  assert.doesNotMatch(pageUi, /window\.confirm/);
  assert.doesNotMatch(pageUi, /恢复未开始文件|隐藏工作区|连接下载引擎/);
});

test("弹窗只展示普通用户需要的任务和保存位置", () => {
  const popup = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf8");
  const popupScript = fs.readFileSync(path.join(__dirname, "..", "src", "popup.tsx"), "utf8");
  assert.doesNotMatch(popup, /扫描当前文件夹|文件格式|包含关键词|导出 CSV|导出 JSON|清空任务/);
  assert.match(popup, /id="popup-root"/);
  assert.match(popup, /runtime\/popup\.js/);
  assert.doesNotMatch(popup, /src="popup\.js"/);
  assert.match(popupScript, /在 POPO 中，点击文件夹旁的蓝色下载按钮/);
  assert.match(popupScript, /下载服务/);
  assert.match(popupScript, /popo-popup-ui/);
  assert.match(popupScript, /engine-alert/);
  assert.match(popupScript, /engine-settings/);
  assert.match(popupScript, /job\.status !== "queued"/);
  assert.match(popupScript, /保存位置/);
  assert.match(popupScript, /默认下载文件夹/);
  assert.match(popupScript, /gopeedDownloadDirOverride/);
  assert.match(popupScript, /chooseDownloadDirectoryButton/);
  assert.match(popupScript, /clearDownloadDirectoryButton/);
  assert.doesNotMatch(popupScript, /下载多个文件|Gopeed 下载引擎|绿色安装版|并发设置/);
  assert.doesNotMatch(popupScript, /下载服务运行正常/);
  assert.doesNotMatch(popupScript, /recentTerminal/);
  assert.doesNotMatch(popupScript, /phaseLabels|failurePreview|failureItems|当前层|递归已发现/);
  assert.match(popupScript, /继续（/);
  assert.match(popupScript, /DISMISS_JOB/);
  assert.match(popupScript, /确认移除/);
  assert.match(popupScript, /返回/);
  assert.match(popupScript, /只从列表移除，不会删除已下载文件/);
  assert.doesNotMatch(popupScript, /window\.confirm/);
  assert.match(popupScript, /current\?\.transient \? null : current/);
});

test("POPO Logo 保留在弹窗和扩展图标中并支持明暗主题", () => {
  const popup = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf8");
  const popupSource = fs.readFileSync(path.join(__dirname, "..", "src", "popup.tsx"), "utf8");
  const popupCss = fs.readFileSync(path.join(__dirname, "..", "popup.css"), "utf8");
  const pageUi = fs.readFileSync(path.join(__dirname, "..", "src", "page-ui.tsx"), "utf8");
  const logo = fs.readFileSync(path.join(__dirname, "..", "assets", "popo-logo.svg"), "utf8");

  assert.match(popup, /runtime\/popup\.js/);
  assert.match(popupSource, /className="brand-logo"/);
  assert.match(popupSource, /assets\/popo-logo\.svg/);
  assert.match(popupCss, /@media \(prefers-color-scheme: dark\)/);
  assert.match(pageUi, /from "lucide-react"/);
  assert.match(pageUi, /className="popo-download-idle-icon"/);
  assert.doesNotMatch(pageUi, /chrome\.runtime\.getURL\("assets\/popo-logo\.svg"\)/);
  assert.doesNotMatch(pageUi, /repeating-linear-gradient/);
  assert.match(pageUi, /data-theme='dark'/);
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

test("网页行内按钮使用 Lucide 图标和无刻度粗进度条", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
  );
  const pageUi = fs.readFileSync(path.join(__dirname, "..", "src", "page-ui.tsx"), "utf8");

  assert.equal(packageJson.dependencies["lucide-react"], "1.29.0");
  assert.match(pageUi, /popo-download-idle-icon/);
  assert.match(pageUi, /popo-download-estimate-fill/);
  assert.match(pageUi, /popo-download-activity-comet/);
  assert.match(pageUi, /popo-download-injection-icon/);
  assert.match(pageUi, /popo-download-resource-block/);
  assert.match(pageUi, /<Folder/);
  assert.match(pageUi, /height:8px!important/);
  assert.match(pageUi, /flex-basis:124px!important/);
  assert.match(pageUi, /min-width:max-content!important/);
  assert.match(pageUi, /radial-gradient\(circle at 18% 0%/);
  assert.doesNotMatch(pageUi, /repeating-linear-gradient/);
  assert.doesNotMatch(pageUi, /chrome\.runtime\.getURL\("assets\/popo-logo\.svg"\)/);
});

test("网页、任务摘要、通知和弹窗共享克制的深色渐变状态系统", () => {
  const pageUi = fs.readFileSync(path.join(__dirname, "..", "src", "page-ui.tsx"), "utf8");
  const popupCss = fs.readFileSync(path.join(__dirname, "..", "popup.css"), "utf8");

  assert.match(pageUi, /--popo-gradient-surface/);
  assert.match(pageUi, /--popo-gradient-blue/);
  assert.match(pageUi, /--popo-gradient-download/);
  assert.match(pageUi, /--popo-gradient-queued/);
  assert.match(pageUi, /--popo-gradient-paused/);
  assert.match(pageUi, /--popo-gradient-warning/);
  assert.match(pageUi, /--popo-gradient-failed/);
  assert.match(pageUi, /data-status=\{primary\.status\}/);
  assert.match(pageUi, /popo-gradient-surface-flow/);
  assert.match(pageUi, /prefers-reduced-motion:reduce/);

  assert.match(popupCss, /--gradient-surface:/);
  assert.match(popupCss, /--gradient-blue:/);
  assert.match(popupCss, /--gradient-download:/);
  assert.match(popupCss, /--gradient-queued:/);
  assert.match(popupCss, /--gradient-paused:/);
  assert.match(popupCss, /--gradient-warning:/);
  assert.match(popupCss, /--gradient-failed:/);
  assert.match(popupCss, /\.popup-queue-item\[data-status="scanning"\]/);
  assert.match(popupCss, /\.popup-queue-item\[data-status="downloading"\]/);
  assert.match(popupCss, /@keyframes popup-surface-flow/);
  assert.match(popupCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(popupCss, /repeating-linear-gradient|rainbow|particle/i);
});

test("下载由 Gopeed 统一管理且并行上限可在 1 到 5 之间调节", () => {
  const background = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  const popup = fs.readFileSync(path.join(__dirname, "..", "src", "popup.tsx"), "utf8");
  assert.match(background, /concurrency:\s*5/);
  assert.match(background, /MAX_DOWNLOAD_CONCURRENCY\s*=\s*5/);
  assert.match(background, /SET_DOWNLOAD_CONCURRENCY/);
  assert.match(background, /任务进行或暂停时不能调整并行下载数/);
  assert.match(popup, /id="downloadConcurrency"/);
  assert.match(popup, /\[1, 2, 3, 4, 5\]/);
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
  assert.match(background, /resolveDownloadFilename/);
  assert.match(background, /item\.downloadName\s*=\s*resolvedDownloadName/);
  assert.match(background, /连续 3 次未返回下载地址/);
  assert.match(background, /DOWNLOAD_URL_RECOVERED_FROM_PAGE/);
  assert.match(background, /DOWNLOAD_BATCH_CONTINUED_AFTER_INCOMPLETE_FOLDER/);
  assert.match(content, /GET_OBSERVED_DOWNLOAD_URL/);
  const pageApi = fs.readFileSync(path.join(__dirname, "..", "page-api.js"), "utf8");
  assert.match(pageApi, /PerformanceObserver/);
  assert.match(pageApi, /popo-stable-download:observed-url/);
  assert.match(pageApi, /popo-stable-download:request-observed-urls/);
  assert.match(pageApi, /popo-stable-download:page-route-change/);
  assert.match(pageApi, /pushState/);
  assert.match(pageApi, /replaceState/);
  assert.match(background, /const currentVersion = chrome\.runtime\.getManifest\(\)\.version;/);
  assert.doesNotMatch(background, /const currentVersion = chrome\.runtime\.getManifest\(\)\.version_name/);
  assert.match(background, /function isDevelopmentBuild\(\)/);
  assert.match(background, /开发版使用当前项目源码，已停用正式版自动更新/);
  assert.match(background, /chrome\.alarms\.clear\(UPDATE_ALARM\)/);
  assert.doesNotMatch(background, /chrome\.downloads/);
  assert.doesNotMatch(background, /type:\s*"CLICK_DOWNLOAD"/);
  assert.match(background, /itemIndex:\s*item\.itemIndex/);
  assert.match(background, /looksLikeFileTitle/);
  assert.match(background, /系统元数据文件已自动忽略/);
  assert.match(background, /gopeedDownloadDirOverride/);
  assert.match(background, /sendNativeMessage\(FOLDER_PICKER_HOST/);
  assert.match(background, /action: "ensure_gopeed"/);
  assert.match(background, /action: "agent_connection"/);
  assert.match(background, /X-Popo-Agent-Token/);
  assert.match(background, /popoAgentShadowComparison/);
  assert.match(background, /popoAgentShadowComparisonHistory/);
  assert.match(background, /MAX_RETAINED_AGENT_SHADOW_COMPARISONS = 64/);
  assert.match(background, /GET_UPDATE_DIAGNOSTICS/);
  assert.match(background, /buildUpdateDiagnostics/);
  assert.match(background, /normalizeUpdateDiagnosticVersion/);
  assert.match(background, /normalizeUpdateDiagnosticErrorCode/);
  assert.match(background, /normalizeShadowDiagnosticTransactionId/);
  assert.match(popup, /GET_UPDATE_DIAGNOSTICS/);
  assert.match(popup, /copyUpdateDiagnosticsButton/);
  assert.match(popup, /复制诊断信息/);
  assert.match(background, /DOWNLOAD_STALLED/);
  assert.match(background, /GOPEED_TASK_MISSING/);
  assert.match(background, /GET_DIAGNOSTIC_STATUS/);
  assert.match(background, /SEND_DIAGNOSTICS/);
  assert.match(popup, /立即发送诊断/);
  assert.match(background, /AGENT_PROTOCOL_VERSION < connectionMinimumProtocol/);
  assert.match(background, /statusProtocol !== connectionProtocol/);
  assert.match(background, /UPDATE_ALARM/);
  assert.match(background, /action: "check_update"/);
  assert.match(background, /action: "apply_update"/);
  assert.match(background, /action: "update_status"/);
  assert.match(background, /chrome\.runtime\.reload\(\)/);
  assert.match(background, /CHOOSE_DOWNLOAD_DIRECTORY/);
  assert.match(background, /startScannedDownload\(state, \{ automatic: true \}\)/);
  assert.match(background, /rootProjectCount/);
  assert.doesNotMatch(background, /SHOW_FOLDER_CONFIRMATION|CONFIRM_FOLDER_DOWNLOAD/);
});

test("弹窗为每个任务显示文件进度条", () => {
  const popup = fs.readFileSync(path.join(__dirname, "..", "src", "popup.tsx"), "utf8");
  const popupHtml = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf8");
  const popupCss = fs.readFileSync(path.join(__dirname, "..", "popup.css"), "utf8");
  assert.match(popup, /jobProgress/);
  assert.match(popup, /popup-job-progress/);
  assert.match(popup, /job\.status !== "queued"/);
  assert.match(popup, /aria-valuenow/);
  assert.match(popup, /chrome\.runtime\.getManifest\(\)/);
  assert.match(popup, /id="versionInfo"/);
  assert.match(popupHtml, /id="popup-root"/);
  assert.doesNotMatch(popupHtml, /版本 0\.7\.0-beta\.6/);
  assert.match(popupCss, /\.popup-job-progress/);
});
