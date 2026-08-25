"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const setupSource = fs.readFileSync(
  path.join(__dirname, "..", "setup", "PopoSetup.cs"),
  "utf8"
);
const buildSource = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "build-test-package.ps1"),
  "utf8"
);
const releaseVerifier = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "verify-release-package.ps1"),
  "utf8"
);
const nativeUninstallSource = fs.readFileSync(
  path.join(__dirname, "..", "native-host", "uninstall.ps1"),
  "utf8"
);

test("绿色安装助手固定扩展 ID 并仅写入当前用户目录和注册表", () => {
  assert.match(setupSource, /ComputeExtensionId/);
  assert.match(setupSource, /SpecialFolder\.LocalApplicationData/);
  assert.match(setupSource, /Registry\.CurrentUser\.CreateSubKey/);
  assert.match(setupSource, /NativeMessagingHosts/);
  assert.match(setupSource, /AgentTaskNamePrefix/);
  assert.match(setupSource, /\/SC ONLOGON \/RL LIMITED/);
  assert.match(setupSource, /Software\\Microsoft\\Windows\\CurrentVersion\\Run/);
  assert.match(setupSource, /RegisterAgentRunStartup/);
  assert.match(setupSource, /AgentRunStartupDefinitionMatches/);
  assert.match(setupSource, /DeleteAgentTaskStartup/);
  assert.match(setupSource, /SetupLogFileName = "setup\.log"/);
  assert.match(setupSource, /%LOCALAPPDATA%\\/);
  assert.match(setupSource, /DescribeInstallFailure/);
  assert.match(setupSource, /安装未完成，已自动回滚到原版本/);
  assert.match(setupSource, /维护模式正在自动退出 Gopeed/);
  assert.match(setupSource, /TryStopGopeed/);
  assert.match(setupSource, /process\.CloseMainWindow\(\)/);
  assert.match(setupSource, /process\.Kill\(\)/);
  assert.match(setupSource, /无需再点击，退出后安装会自动继续/);
  assert.match(setupSource, /安装已取消，原版本未更改/);
  assert.match(setupSource, /Registry\.CurrentUser/);
  assert.match(setupSource, /allowed_origins/);
  assert.doesNotMatch(setupSource, /Registry\.LocalMachine|HKEY_LOCAL_MACHINE/);
  assert.match(nativeUninstallSource, /Get-AgentTaskName/);
  assert.match(nativeUninstallSource, /schtasks\.exe \/Delete \/F \/TN/);
  assert.match(nativeUninstallSource, /CurrentVersion\\Run/);
  assert.match(nativeUninstallSource, /Remove-ItemProperty/);
});

test("开发绿色版与正式版使用独立安装身份", () => {
  assert.match(setupSource, /#if POPO_DEV_BUILD/);
  assert.match(setupSource, /com\.popo\.dev_downloader\.folder_picker/);
  assert.match(setupSource, /Software\\POPODevDownloader/);
  assert.match(setupSource, /ProductDirectoryName = "POPODevDownloader"/);
  assert.match(setupSource, /POPO Dev Downloader Update Agent/);
  assert.match(setupSource, /ProductDisplayName = "POPO Dev 下载助手"/);
  assert.match(setupSource, /ProductShortName = "POPO Dev"/);
  assert.match(buildSource, /ValidateSet\('Stable', 'Dev'\)/);
  assert.match(buildSource, /\/define:POPO_DEV_BUILD/);
  assert.match(buildSource, /POPO-Dev-Setup\.exe/);
  assert.match(buildSource, /POPO-Dev-Downloader-/);
  assert.match(buildSource, /folfhehnopknchpoaajfpboibbhnlanf/);
  assert.match(buildSource, /if \(-not \$isDev\) \{[\s\S]*signature = \$signature/);
});

test("绿色安装助手自动准备完整运行目录并引导加载扩展", () => {
  assert.match(setupSource, /ApplyVerifiedUpdate/);
  assert.match(setupSource, /InstallOptionsForm/);
  assert.match(setupSource, /detectionLabel\.Text = "安装版本  " \+ packageVersion/);
  assert.match(setupSource, /installedVersion \+ "  →  " \+ packageVersion/);
  assert.match(setupSource, /\? "覆盖升级"/);
  assert.match(setupSource, /operation = "修复"/);
  assert.doesNotMatch(setupSource, /CheckBox repairBox|重新校验并修复全部/);
  assert.doesNotMatch(setupSource, /安装助手会根据本机现状自动选择正确操作/);
  assert.doesNotMatch(setupSource, /private readonly Label operationLabel/);
  assert.doesNotMatch(setupSource, /private readonly Label explanationLabel/);
  assert.doesNotMatch(setupSource, /程序位置：/);
  assert.match(setupSource, /FolderBrowserDialog/);
  assert.match(setupSource, /ResolveBrowsedInstallRoot/);
  assert.match(setupSource, /selected\.TrimEnd\(/);
  assert.match(setupSource, /selectedDirectory\.Name/);
  assert.match(setupSource, /GetSuggestedInstallRoot/);
  assert.match(setupSource, /FindExistingInstallRoot/);
  assert.match(setupSource, /SaveInstallRoot/);
  assert.match(setupSource, /InstallRootValueName/);
  assert.match(setupSource, /--repair/);
  assert.match(setupSource, /migrating \? "migration" : forceRepair \? "repair" : "verified-candidate"/);
  assert.match(setupSource, /--migrate-from/);
  assert.match(setupSource, /SeedMigrationData/);
  assert.match(setupSource, /FinalizeMigration/);
  assert.match(setupSource, /SyncCompatibilityExtension/);
  assert.match(setupSource, /chromeExtensionPath/);
  assert.match(setupSource, /candidate-/);
  assert.match(setupSource, /VerifyCandidate/);
  assert.match(setupSource, /DirectoriesMatch/);
  assert.match(setupSource, /PackagedDirectoryMatches/);
  assert.match(setupSource, /previous installation was restored/);
  assert.match(setupSource, /\{ "updateMode", updateMode \}/);
  assert.match(setupSource, /\.popo-native-version/);
  assert.match(setupSource, /nativeCodeVersionMatches/);
  assert.match(setupSource, /Candidate update agent/);
  assert.match(setupSource, /StopAgent\(productRoot\)/);
  assert.match(setupSource, /StartAgent\(productRoot\)/);
  assert.match(setupSource, /WaitForAgentReady/);
  assert.match(setupSource, /AgentStartupExists/);
  assert.match(setupSource, /--test-verify-agent-startup/);
  assert.match(setupSource, /DeleteAgentStartup/);
  assert.match(setupSource, /release-manifest\.json/);
  assert.doesNotMatch(setupSource, /CopyDirectory\(sourceExtension, extensionRoot\)/);
  assert.doesNotMatch(setupSource, /InstallGopeed\(sourceGopeed, gopeedRoot, nativeRoot\)/);
  assert.doesNotMatch(setupSource, /chrome:\/\/extensions|OpenChromeExtensions/);
  assert.match(setupSource, /OpenFolder\(chromeExtensionRoot\)/);
  assert.match(setupSource, /请加载即将打开的 Extension 文件夹/);
  assert.match(setupSource, /--quiet/);
  assert.match(setupSource, /if \(!quiet\)\s*\{\s*try \{ Clipboard\.SetText/);
  assert.match(setupSource, /--install-root/);
  assert.match(setupSource, /--skip-register/);
  assert.match(setupSource, /"runtime", "popup\.js"/);
  assert.match(setupSource, /"runtime", "page-ui\.js"/);
  assert.match(buildSource, /POPO-Setup\.exe/);
  assert.match(buildSource, /System\.Drawing\.dll/);
  assert.match(buildSource, /latest\.json/);
  assert.match(buildSource, /channel = 'stable'/);
  assert.match(buildSource, /ProtectedData/);
  assert.match(buildSource, /signature = \$signature/);
  assert.match(buildSource, /popo-package-compile-/);
  assert.match(buildSource, /GetTempPath/);
  assert.match(buildSource, /'queue\.js'/);
  assert.match(buildSource, /Join-Path \$repoRoot 'assets'/);
  assert.doesNotMatch(buildSource, /Copy-Item[^\n]+START-HERE\.cmd/);
  assert.match(releaseVerifier, /VerifyData/);
  assert.match(releaseVerifier, /Get-FileHash/);
  assert.match(releaseVerifier, /\.popo-native-version/);
});
