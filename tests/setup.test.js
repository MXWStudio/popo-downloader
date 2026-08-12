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

test("绿色安装助手固定扩展 ID 并仅写入当前用户目录和注册表", () => {
  assert.match(setupSource, /ComputeExtensionId/);
  assert.match(setupSource, /SpecialFolder\.LocalApplicationData/);
  assert.match(setupSource, /Registry\.CurrentUser\.CreateSubKey/);
  assert.match(setupSource, /NativeMessagingHosts/);
  assert.match(setupSource, /allowed_origins/);
  assert.doesNotMatch(setupSource, /Registry\.LocalMachine|HKEY_LOCAL_MACHINE/);
});

test("绿色安装助手自动准备完整运行目录并引导加载扩展", () => {
  assert.match(setupSource, /ApplyVerifiedUpdate/);
  assert.match(setupSource, /InstallOptionsForm/);
  assert.match(setupSource, /FolderBrowserDialog/);
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
  assert.doesNotMatch(setupSource, /CopyDirectory\(sourceExtension, extensionRoot\)/);
  assert.doesNotMatch(setupSource, /InstallGopeed\(sourceGopeed, gopeedRoot, nativeRoot\)/);
  assert.doesNotMatch(setupSource, /chrome:\/\/extensions|OpenChromeExtensions/);
  assert.match(setupSource, /OpenFolder\(chromeExtensionRoot\)/);
  assert.match(setupSource, /加载已解压的扩展程序/);
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
