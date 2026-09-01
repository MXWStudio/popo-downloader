"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const script = path.join(root, "scripts", "test-release-candidate-install.ps1");
const source = fs.readFileSync(script, "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("candidate acceptance uses a fixed short QA root and keeps evidence identity in metadata", () => {
  assert.match(source, /GetFullPath\('D:\\POPO\\Candidate\\078'\)/);
  assert.match(source, /\("i-\$runId"\)/);
  assert.match(source, /\("e-\$runId"\)/);
  assert.match(source, /Substring\(0, 8\)/);
  assert.match(source, /caseLabel = \$CaseLabel/);
  assert.match(source, /writesSystemRegistration = \$false/);
  assert.match(source, /'--skip-register'/);
  assert.equal(
    packageJson.scripts["test:release-candidate:preflight"],
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-release-candidate-install.ps1"
  );
});

test("candidate acceptance rejects Stable, Dev, repo and non-QA targets", () => {
  assert.match(source, /D:\\POPO\\Stable\\POPOStableDownloader/);
  assert.match(source, /D:\\POPO\\Dev\\POPODevDownloader/);
  assert.match(source, /\$full -eq \$repoRoot/);
  assert.ok(source.includes("StartsWith($qaRoot + '\\',"));
  assert.match(source, /Unsafe \$Purpose outside the fixed QA root/);
  assert.match(source, /FileAttributes\]::ReparsePoint/);
  assert.match(source, /Unsafe \$Purpose uses a reparse point/);
});

test("candidate acceptance enforces legacy .NET file and directory path budgets", () => {
  assert.match(source, /\$maxFile -lt 260/);
  assert.match(source, /\$maxDirectory -lt 248/);
  assert.match(source, /\$maxBootstrapperFile -lt 260/);
  assert.match(source, /\$maxBootstrapperDirectory -lt 248/);
  assert.match(source, /Release candidate path budget exceeded/);
  assert.doesNotMatch(source, /Get-FileHash/);
  assert.match(source, /candidate-/);
  assert.match(source, /Rollback/);
});

test("candidate path preflight passes a short root and rejects the reproduced 126-character boundary", (t) => {
  if (process.platform !== "win32") {
    t.skip("PowerShell candidate path preflight is Windows-only");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-candidate-path-"));
  const payloadRoot = path.join(sandbox, "POPO-Stable-Downloader-0.7.8-win-x64");
  const deepest = path.join(payloadRoot, "Gopeed", "data", "flutter_assets", "packages", "cupertino_icons", "assets");
  const zipPath = path.join(sandbox, "POPO-Stable-Downloader-0.7.8-win-x64.zip");
  fs.mkdirSync(deepest, { recursive: true });
  fs.writeFileSync(path.join(deepest, "CupertinoIcons.ttf"), "fixture", "utf8");
  const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
  const compress = spawnSync("powershell.exe", [
    "-NoProfile", "-Command",
    `Compress-Archive -LiteralPath ${psQuote(payloadRoot)} -DestinationPath ${psQuote(zipPath)} -CompressionLevel NoCompression`
  ], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(compress.status, 0, compress.stdout + compress.stderr);
  try {
    const shortRun = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
      "-PackageZip", zipPath,
      "-InstallRootOverride", "D:\\POPO\\Candidate\\078\\i-12345678"
    ], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    assert.equal(shortRun.status, 0, shortRun.stdout + shortRun.stderr);
    const shortResult = JSON.parse(shortRun.stdout.trim());
    assert.equal(shortResult.pathBudget.safe, true);
    assert.equal(shortResult.writesSystemRegistration, false);

    const prefix = "D:\\POPO\\Candidate\\078\\B077-";
    const longRoot = prefix + "b".repeat(126 - prefix.length);
    const longRun = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
      "-PackageZip", zipPath,
      "-InstallRootOverride", longRoot
    ], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    assert.notEqual(longRun.status, 0);
    assert.match(longRun.stdout + longRun.stderr, /Release candidate path budget exceeded/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
