const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.join(__dirname, "..");

test("routine Windows workflow verifies and packages only the Dev channel", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github", "workflows", "windows-validation.yml"),
    "utf8"
  );
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /npm run check:full:windows/);
  assert.match(workflow, /npm run build:dev-package/);
  assert.match(workflow, /Build isolated Dev package[\s\S]*shell: powershell/);
  assert.match(workflow, /POPO-Dev-Downloader-/);
  assert.doesNotMatch(workflow, /build:release-package|stable\/latest\.json|contents: write/);
});

test("remote validation uses an isolated Git snapshot and the fixed Dev sync", () => {
  const sender = fs.readFileSync(path.join(root, "scripts", "remote-windows-dev.sh"), "utf8");
  const runner = fs.readFileSync(path.join(root, "scripts", "windows-remote-runner.sh"), "utf8");
  const validator = fs.readFileSync(path.join(root, "scripts", "windows-dev-validate.ps1"), "utf8");

  assert.match(sender, /git .* bundle create/);
  assert.match(sender, /for-each-ref .* --contains/);
  assert.match(sender, /cat > .*working-tree\.patch/);
  assert.match(sender, /git .* diff --binary --full-index HEAD/);
  assert.match(sender, /ls-files --others --exclude-standard/);
  assert.match(sender, /POPODevValidation/);
  assert.match(runner, /git clone --quiet/);
  assert.match(runner, /GIT_TERMINAL_PROMPT=0 git clone/);
  assert.match(runner, /git -C .* apply/);
  assert.match(validator, /npm run check:full:windows/);
  assert.match(validator, /POPO_WINDOWS_TESTS=PASS/);
  assert.match(validator, /POPO_DEV_SYNC=PASS/);
  assert.match(sender, /POPO_WINDOWS_BUILD_DEV_PACKAGE/);
  assert.match(sender, /POPO_WINDOWS_INSTALL_DEV_PACKAGE/);
  assert.match(sender, /POPO_WINDOWS_SOURCE_MODE/);
  assert.match(runner, /-BuildDevPackage/);
  assert.match(runner, /-InstallDevPackage/);
  assert.match(validator, /npm run build:dev-package/);
  assert.match(validator, /POPO-Dev-Setup\.exe/);
  assert.match(validator, /POPO_DEV_INSTALL=PASS/);
  assert.match(validator, /com\.popo\.dev_downloader\.folder_picker/);
  assert.match(validator, /folfhehnopknchpoaajfpboibbhnlanf/);
  assert.ok(
    validator.indexOf("POPO_WINDOWS_TESTS=PASS") <
      validator.indexOf("scripts/sync-dev-extension.ps1"),
    "Dev sync must remain after the full Windows test PASS marker"
  );
  assert.match(validator, /System32.*env:PATH|env:PATH.*System32/s);
  assert.match(validator, /scripts\/sync-dev-extension\.ps1/);
  assert.match(sender, /WINDOWS VERIFY:/);
  assert.match(sender, /SOURCE: Mac working tree/);
  assert.match(sender, /MAC COMMIT:/);
  assert.match(sender, /DIRTY CHANGES:/);
  assert.match(sender, /WINDOWS TESTS:/);
  assert.match(sender, /DEV PACKAGE INSTALL:/);
  assert.match(sender, /DEV SYNC:/);
  assert.match(sender, /DEV TARGET:/);
  assert.match(sender, /STABLE TOUCHED: NO/);
  assert.match(sender, /Reload "POPO Dev 下载助手" in chrome:\/\/extensions/);
  assert.doesNotMatch(sender + runner + validator, /POPOStableDownloader|build:release-package/);
});

test("real-browser smoke stays short and expands only for download logic", () => {
  const smoke = fs.readFileSync(path.join(root, "scripts", "print-windows-smoke.mjs"), "utf8");
  assert.match(smoke, /扩展重新加载正常/);
  assert.match(smoke, /POPO 页面识别正常/);
  assert.match(smoke, /单文件下载正常/);
  assert.match(smoke, /文件夹\/批量下载正常/);
  assert.match(smoke, /--download-logic/);
  assert.match(smoke, /暂停正常/);
  assert.match(smoke, /继续正常/);
  assert.match(smoke, /失败重试正常/);
});
