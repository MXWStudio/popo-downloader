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

test("绿色安装助手固定扩展 ID 并仅写入当前用户目录和注册表", () => {
  assert.match(setupSource, /ComputeExtensionId/);
  assert.match(setupSource, /SpecialFolder\.LocalApplicationData/);
  assert.match(setupSource, /Registry\.CurrentUser\.CreateSubKey/);
  assert.match(setupSource, /NativeMessagingHosts/);
  assert.match(setupSource, /allowed_origins/);
  assert.doesNotMatch(setupSource, /Registry\.LocalMachine|HKEY_LOCAL_MACHINE/);
});

test("绿色安装助手自动准备完整运行目录并引导加载扩展", () => {
  assert.match(setupSource, /CopyDirectory\(sourceExtension, extensionRoot\)/);
  assert.match(setupSource, /InstallGopeed\(sourceGopeed, gopeedRoot, nativeRoot\)/);
  assert.match(setupSource, /OpenChromeExtensions/);
  assert.match(setupSource, /OpenFolder\(extensionRoot\)/);
  assert.match(setupSource, /加载已解压的扩展程序/);
  assert.match(setupSource, /--quiet/);
  assert.match(setupSource, /--install-root/);
  assert.match(setupSource, /--skip-register/);
  assert.match(buildSource, /POPO-Setup\.exe/);
  assert.match(buildSource, /'queue\.js'/);
  assert.match(buildSource, /Join-Path \$repoRoot 'assets'/);
  assert.doesNotMatch(buildSource, /Copy-Item[^\n]+START-HERE\.cmd/);
});
