"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");

const root = path.join(__dirname, "..");
const modulePath = path.join(root, "scripts", "PopoDevExtension.psm1");
const syncScript = path.join(root, "scripts", "sync-dev-extension.ps1");
const fixedDevTarget = "D:\\POPO\\Dev\\POPODevDownloader\\Extension";
const stableTarget = "D:\\POPO\\Stable\\POPOStableDownloader\\Extension";
const sourceManifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

function runPowerShell(args, options = {}) {
  return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    ...options
  });
}

function extensionId(key) {
  const hash = crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest();
  return [...hash.subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((nibble) => String.fromCharCode("a".charCodeAt(0) + nibble))
    .join("");
}

function createFixture() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-dev-extension-sync-"));
  const repo = path.join(sandbox, "repo");
  const target = path.join(sandbox, "POPODevDownloader", "Extension");
  const stable = path.join(sandbox, "Stable", "Extension");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(stable, { recursive: true });
  fs.writeFileSync(path.join(repo, "manifest.json"), JSON.stringify(sourceManifest), "utf8");
  for (const name of ["background.js", "content.js", "core.js", "queue.js", "gopeed.js", "page-api.js", "popup.css", "popup.html"]) {
    fs.writeFileSync(path.join(repo, name), `source:${name}`, "utf8");
  }
  fs.mkdirSync(path.join(repo, "assets"));
  fs.writeFileSync(path.join(repo, "assets", "icon.png"), "asset", "utf8");
  fs.mkdirSync(path.join(repo, "runtime"));
  fs.writeFileSync(path.join(repo, "runtime", "bundle.js"), "runtime", "utf8");
  fs.writeFileSync(path.join(stable, "stable.marker"), "unchanged", "utf8");
  return { sandbox, repo, target, stable };
}

function invokeFixtureSync(fixture) {
  const command = [
    `Import-Module '${modulePath.replaceAll("'", "''")}' -Force`,
    `Invoke-PopoDevExtensionSync -RepoRoot '${fixture.repo.replaceAll("'", "''")}' -TargetDirectory '${fixture.target.replaceAll("'", "''")}' -ExpectedTargetDirectory '${fixture.target.replaceAll("'", "''")}' -StableDirectory '${fixture.stable.replaceAll("'", "''")}' | ConvertTo-Json -Compress`
  ].join("; ");
  return runPowerShell(["-Command", command]);
}

test("Dev Extension source synchronizes successfully and preserves the fixed Dev identity", (t) => {
  if (process.platform !== "win32") {
    t.skip("PowerShell Dev Extension synchronization is Windows-only");
    return;
  }
  const fixture = createFixture();
  try {
    const result = invokeFixtureSync(fixture);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const summary = JSON.parse(result.stdout.trim());
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture.target, "manifest.json"), "utf8"));
    assert.equal(manifest.name, "POPO Dev 下载助手");
    assert.equal(manifest.action.default_title, "POPO Dev 下载助手");
    assert.equal(manifest.version_name, `${sourceManifest.version}-dev`);
    assert.equal(extensionId(manifest.key), "folfhehnopknchpoaajfpboibbhnlanf");
    assert.notEqual(extensionId(sourceManifest.key), extensionId(manifest.key));
    assert.equal(summary.IdentitiesDiffer, true);
    const marker = JSON.parse(fs.readFileSync(path.join(fixture.target, "dev-sync.json"), "utf8"));
    assert.equal(marker.schemaVersion, 1);
    assert.equal(marker.channel, "dev");
    assert.match(marker.label, /^DEV · \d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(Number.isNaN(Date.parse(marker.syncedAtUtc)), false);
    assert.equal(summary.SyncBatchTime, marker.label.slice("DEV · ".length));
    assert.equal(summary.SyncedAtUtc, marker.syncedAtUtc);
    assert.equal(fs.readFileSync(path.join(fixture.stable, "stable.marker"), "utf8"), "unchanged");
  } finally {
    fs.rmSync(fixture.sandbox, { recursive: true, force: true });
  }
});

test("successful Dev sync advances the visible batch while a failed sync preserves it", async (t) => {
  if (process.platform !== "win32") {
    t.skip("PowerShell Dev Extension synchronization is Windows-only");
    return;
  }
  const fixture = createFixture();
  try {
    assert.equal(invokeFixtureSync(fixture).status, 0);
    const markerPath = path.join(fixture.target, "dev-sync.json");
    const first = fs.readFileSync(markerPath, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(invokeFixtureSync(fixture).status, 0);
    const second = fs.readFileSync(markerPath, "utf8");
    assert.notEqual(second, first);

    fs.rmSync(path.join(fixture.repo, "background.js"));
    const failed = invokeFixtureSync(fixture);
    assert.notEqual(failed.status, 0);
    assert.equal(fs.readFileSync(markerPath, "utf8"), second);
    assert.equal(fs.readFileSync(path.join(fixture.stable, "stable.marker"), "utf8"), "unchanged");
  } finally {
    fs.rmSync(fixture.sandbox, { recursive: true, force: true });
  }
});

test("a file removed from Extension source cannot remain in Dev output", (t) => {
  if (process.platform !== "win32") {
    t.skip("PowerShell Dev Extension synchronization is Windows-only");
    return;
  }
  const fixture = createFixture();
  try {
    assert.equal(invokeFixtureSync(fixture).status, 0);
    fs.writeFileSync(path.join(fixture.target, "removed-from-source.js"), "stale", "utf8");
    fs.mkdirSync(path.join(fixture.target, "obsolete"));
    fs.writeFileSync(path.join(fixture.target, "obsolete", "old.txt"), "stale", "utf8");
    const result = invokeFixtureSync(fixture);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(path.join(fixture.target, "removed-from-source.js")), false);
    assert.equal(fs.existsSync(path.join(fixture.target, "obsolete")), false);
  } finally {
    fs.rmSync(fixture.sandbox, { recursive: true, force: true });
  }
});

test("production sync wrapper rejects the Stable extension directory", (t) => {
  if (process.platform !== "win32") {
    t.skip("PowerShell Dev Extension target validation is Windows-only");
    return;
  }
  const result = runPowerShell(["-File", syncScript, "-TargetDirectory", stableTarget]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to synchronize the Stable extension directory/);
});

test("production sync wrapper rejects an unrecognized target and the repository root", (t) => {
  if (process.platform !== "win32") {
    t.skip("PowerShell Dev Extension target validation is Windows-only");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-dev-extension-invalid-"));
  try {
    const wrong = runPowerShell(["-File", syncScript, "-TargetDirectory", sandbox]);
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /Refusing unrecognized Dev extension target/);

    const repository = runPowerShell(["-File", syncScript, "-TargetDirectory", root]);
    assert.notEqual(repository.status, 0);
    assert.match(repository.stderr, /Refusing unrecognized Dev extension target|Refusing to synchronize into the repository/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("production sync wrapper keeps the fixed Dev target in source", () => {
  const source = fs.readFileSync(syncScript, "utf8");
  assert.match(source, /D:\\POPO\\Dev\\POPODevDownloader\\Extension/);
  assert.equal(fixedDevTarget, "D:\\POPO\\Dev\\POPODevDownloader\\Extension");
});
