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
  assert.match(validator, /System32.*env:PATH|env:PATH.*System32/s);
  assert.match(validator, /scripts\/sync-dev-extension\.ps1/);
  assert.doesNotMatch(sender + runner + validator, /POPOStableDownloader|build:release-package/);
});
