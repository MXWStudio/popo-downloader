"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "publish-stable.yml"), "utf8");
const buildScript = fs.readFileSync(path.join(root, "scripts", "build-test-package.ps1"), "utf8");
const cosPublisher = fs.readFileSync(path.join(root, "scripts", "publish-cos-object.py"), "utf8");
const packageVerifier = fs.readFileSync(path.join(root, "scripts", "verify-release-package.ps1"), "utf8");
const startupAcceptance = fs.readFileSync(path.join(root, "scripts", "test-agent-startup.ps1"), "utf8");
const rebootAcceptance = fs.readFileSync(path.join(root, "scripts", "agent-reboot-acceptance.mjs"), "utf8");
const securityAcceptance = fs.readFileSync(path.join(root, "scripts", "test-agent-security.ps1"), "utf8");
const shadowCycleVerifier = fs.readFileSync(path.join(root, "scripts", "verify-shadow-cycle.mjs"), "utf8");
const agentTests = fs.readFileSync(path.join(root, "tests", "agent.test.js"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("stable release automation validates and publishes in a safe order", () => {
  assert.match(workflow, /tags:\s*\r?\n\s+- "v\*\.\*\.\*"/);
  assert.match(workflow, /permissions:\s*\r?\n\s+contents: write/);
  assert.match(workflow, /concurrency:\s*\r?\n\s+group: stable-release/);
  assert.match(workflow, /Prevent stable channel downgrade/);
  assert.match(workflow, /assert-release-version\.ps1/);
  assert.match(workflow, /npm --prefix release-source run check:full/);
  assert.match(workflow, /TEMP: \$\{\{ runner\.temp \}\}/);
  assert.match(workflow, /TMP: \$\{\{ runner\.temp \}\}/);
  assert.match(workflow, /verify-release-package\.ps1/);
  assert.match(workflow, /POPO_RELEASE_SIGNING_KEY_BASE64/);
  assert.match(workflow, /POPO_DIAGNOSTIC_DSN: \$\{\{ vars\.POPO_DIAGNOSTIC_DSN \}\}/);
  assert.doesNotMatch(workflow, /POPO_DIAGNOSTIC_DSN: \$\{\{ secrets\./);
  assert.match(workflow, /TENCENT_COS_SECRET_ID/);
  assert.match(workflow, /TENCENT_COS_SECRET_KEY/);
  assert.match(workflow, /gh release download/);
  assert.match(workflow, /path: release-source/);
  assert.match(workflow, /path: automation/);
  assert.doesNotMatch(workflow, /gh release upload[^\n]+--clobber/);
  const jobHeader = workflow.slice(workflow.indexOf("jobs:"), workflow.indexOf("    steps:"));
  assert.doesNotMatch(jobHeader, /POPO_RELEASE_SIGNING_KEY_BASE64/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /Restore trusted release automation after signing/);
  assert.match(workflow, /git -C release-source reset --hard HEAD/);
  assert.match(workflow, /git -C release-source clean -ffdx -e node_modules\//);

  const uploadPackage = workflow.indexOf("Upload or reuse immutable package in Tencent COS");
  const verifyPackage = workflow.indexOf("Read back and verify the COS package");
  const publishRelease = workflow.indexOf("Publish the GitHub Release");
  const switchChannel = workflow.indexOf("Switch the stable COS channel last");
  const verifyChannel = workflow.indexOf("Verify the live stable channel");
  assert.ok(uploadPackage < verifyPackage);
  assert.ok(verifyPackage < publishRelease);
  assert.ok(publishRelease < switchChannel);
  assert.ok(switchChannel < verifyChannel);
  assert.match(workflow, /Reusing the verified immutable COS package/);
  assert.match(workflow, /foreach \(\$attempt in 1\.\.3\)/);
  assert.match(workflow, /-w '%\{http_code\}'/);
  assert.doesNotMatch(workflow, /-Method Head/);
});

test("release package includes the bridge agent and one compatible component manifest", () => {
  assert.match(buildScript, /PopoAgent\.exe/);
  assert.match(buildScript, /release-manifest\.json/);
  assert.match(buildScript, /updateProtocol = 2/);
  assert.match(buildScript, /minimumProtocol = 1/);
  assert.match(packageVerifier, /agent\/bin\/PopoAgent\.exe/);
  assert.match(packageVerifier, /agent\/bin\/release-manifest\.json/);
  assert.match(packageVerifier, /Packaged component version is inconsistent/);
  assert.match(packageVerifier, /Packaged update protocol is not compatible/);
  assert.match(packageVerifier, /extension\/runtime\/popo-runtime\.js/);
  assert.match(packageVerifier, /Packaged stable runtime does not contain a valid official diagnostic receiver/);
  assert.match(buildScript, /POPO_DIAGNOSTIC_DSN is required when building a stable package/);
  assert.match(buildScript, /diagnosticConfiguration\(\)/);
  assert.match(buildScript, /valid official diagnostic receiver/);
  assert.doesNotMatch(buildScript, /\/define:POPO_(?:AGENT|SETUP)_TEST/);
});

test("release package signing supports GitHub Actions without removing local DPAPI support", () => {
  assert.match(buildScript, /POPO_RELEASE_SIGNING_KEY_BASE64/);
  assert.match(buildScript, /FromBase64String/);
  assert.match(buildScript, /ProtectedData/);
  assert.match(buildScript, /ReleaseNotesPath/);
  assert.match(buildScript, /Remove-Item Env:POPO_RELEASE_SIGNING_KEY_BASE64/);
  assert.match(buildScript, /SkipRuntimeBuild/);
});

test("development green package is isolated from the stable release channel", () => {
  assert.equal(
    packageJson.scripts["build:dev-package"],
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-test-package.ps1 -Channel Dev"
  );
  assert.equal(
    packageJson.scripts["build:release-package"],
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-test-package.ps1 -Channel Stable"
  );
  assert.match(buildScript, /\$channelManifestPath = if \(\$isDev\) \{ '' \}/);
  assert.match(buildScript, /if \(-not \$isDev\) \{[\s\S]*\$channelManifest = \[ordered\]@\{/);
  assert.match(buildScript, /DEV-TESTING\.md/);
  assert.match(buildScript, /devManifest\.key = \$devExtensionKey/);
  assert.match(buildScript, /devManifest\.version_name = \$versionName/);
});

test("COS publisher reads credentials from the environment and never accepts them as arguments", () => {
  assert.match(cosPublisher, /os\.environ\.get\("TENCENT_COS_SECRET_ID"/);
  assert.match(cosPublisher, /os\.environ\.get\("TENCENT_COS_SECRET_KEY"/);
  assert.match(cosPublisher, /EnableMD5=True/);
  assert.match(cosPublisher, /"ACL": "public-read"/);
  assert.match(cosPublisher, /metadata\["x-cos-forbid-overwrite"\] = "true"/);
  assert.match(cosPublisher, /"x-cos-meta-sha256": actual_sha256/);
  assert.match(cosPublisher, /get_object/);
  assert.match(cosPublisher, /x-cos-meta-sha256/);
  assert.doesNotMatch(cosPublisher, /add_argument\("--secret/);
});

test("Agent startup acceptance is read-only by default and explicitly gated", () => {
  assert.equal(
    packageJson.scripts["test:agent-startup:preflight"],
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-agent-startup.ps1"
  );
  assert.equal(
    packageJson.scripts["test:agent-startup:diagnose"],
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-agent-startup.ps1 -Mode Diagnose"
  );
  assert.equal(
    packageJson.scripts["test:agent-startup"],
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-agent-startup.ps1 -RunAcceptance"
  );
  assert.match(startupAcceptance, /ValidateSet\("Preflight", "Diagnose", "RebootStatus", "RebootPrepare", "RebootVerify", "RebootCleanup"\)/);
  assert.match(startupAcceptance, /if \(\$effectiveMode -eq "Preflight"\) \{\s*return\s*\}/);
  assert.match(startupAcceptance, /\$env:POPO_AGENT_STARTUP_ACCEPTANCE = "1"/);
  assert.match(startupAcceptance, /installer registers, reads back, starts and removes the per-install logon task/);
  assert.match(startupAcceptance, /finally \{/);
  assert.doesNotMatch(startupAcceptance, /Start-Process|RunAs|\/RU\s+SYSTEM|\/RL\s+HIGHEST/i);
  assert.match(
    agentTests,
    /finally \{[\s\S]*--test-delete-agent-startup[\s\S]*assert\.notEqual\(query\.status, 0\)/
  );
});

test("Agent startup diagnosis is read-only and reports a stable policy action", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows Task Scheduler diagnosis is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-startup-diagnose-"));
  const script = path.join(root, "scripts", "test-agent-startup.ps1");
  try {
    const diagnosis = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Mode", "Diagnose"
    ], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, LOCALAPPDATA: sandbox }
    });
    assert.equal(diagnosis.status, 0, diagnosis.stdout + diagnosis.stderr);
    const lines = diagnosis.stdout.trim().split(/\r?\n/).filter(Boolean);
    const result = JSON.parse(lines.at(-1));
    assert.equal(result.Mode, "startup-diagnose");
    assert.equal(result.WritesSystemState, false);
    assert.equal(result.MutatedSystemState, false);
    assert.equal(typeof result.CurrentProcessElevated, "boolean");
    assert.equal(typeof result.CurrentUserInAdministratorsGroup, "boolean");
    assert.match(result.IntegrityLevel, /^(?:low|medium|medium_plus|high|system|unknown)$/);
    assert.match(result.RecommendedAction, /^(?:start_task_scheduler_service|administrator_policy_change_required|retry_from_same_user_elevated_shell|retry_onlogon_acceptance)$/);
    assert.equal(fs.existsSync(path.join(sandbox, "POPO")), false);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Agent reboot acceptance uses a fixed current-user root and cleans only after proof", () => {
  assert.equal(
    packageJson.scripts["test:agent-reboot:status"],
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-agent-startup.ps1 -Mode RebootStatus"
  );
  assert.equal(
    packageJson.scripts["test:agent-reboot:prepare"],
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-agent-startup.ps1 -Mode RebootPrepare"
  );
  assert.equal(
    packageJson.scripts["test:agent-reboot:verify"],
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-agent-startup.ps1 -Mode RebootVerify"
  );
  assert.equal(
    packageJson.scripts["test:agent-reboot:cleanup"],
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-agent-startup.ps1 -Mode RebootCleanup"
  );
  assert.match(rebootAcceptance, /"POPO", "Acceptance", "AgentRebootV1"/);
  assert.match(rebootAcceptance, /POPO_AGENT_REBOOT_ACCEPTANCE !== "1"/);
  assert.match(rebootAcceptance, /allowedCommands = new Set\(\["status", "prepare", "verify", "cleanup"\]\)/);
  assert.match(rebootAcceptance, /endpoint\.processId === state\.initialProcessId/);
  assert.match(rebootAcceptance, /Date\.parse\(endpoint\.startedAt\) <= Date\.parse\(state\.preparedAt\)/);
  assert.match(rebootAcceptance, /verifyAuthenticatedEndpoints\(endpoint\)/);
  assert.match(rebootAcceptance, /function setupFailureCode\(\)/);
  assert.match(rebootAcceptance, /access_denied/);
  assert.match(rebootAcceptance, /requireSetupSuccess\(runSetup/);
  assert.match(rebootAcceptance, /deleteTask\(\);[\s\S]*fs\.rmSync\(acceptanceRoot/);
  assert.doesNotMatch(rebootAcceptance, /Start-Process|RunAs|\/RU\s+SYSTEM|\/RL\s+HIGHEST/i);
});

test("Agent reboot status and invalid commands cannot create acceptance state", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows Task Scheduler status is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-reboot-status-"));
  const script = path.join(root, "scripts", "agent-reboot-acceptance.mjs");
  const options = {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    env: { ...process.env, LOCALAPPDATA: sandbox }
  };
  try {
    const status = spawnSync(process.execPath, [script, "status"], options);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    const result = JSON.parse(status.stdout.trim());
    assert.equal(result.Prepared, false);
    assert.equal(result.TaskExists, false);
    assert.equal(result.MutatedSystemState, false);
    assert.equal(fs.existsSync(path.join(sandbox, "POPO")), false);

    const invalid = spawnSync(process.execPath, [script, "arbitrary-command"], options);
    assert.notEqual(invalid.status, 0);
    assert.equal(fs.existsSync(path.join(sandbox, "POPO")), false);

    const ungatedPrepare = spawnSync(process.execPath, [script, "prepare"], options);
    assert.notEqual(ungatedPrepare.status, 0);
    assert.match(ungatedPrepare.stderr, /explicit write gate/);
    assert.equal(fs.existsSync(path.join(sandbox, "POPO")), false);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Agent security acceptance is fixed-path and never changes Defender configuration", () => {
  assert.equal(
    packageJson.scripts["test:agent-security:status"],
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-agent-security.ps1"
  );
  assert.equal(
    packageJson.scripts["test:agent-security:scan"],
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-agent-security.ps1 -RunScan"
  );
  assert.match(securityAcceptance, /param\(\s*\[switch\]\$RunScan\s*\)/);
  assert.match(securityAcceptance, /POPO\\Acceptance\\AgentRebootV1\\Agent\\PopoAgent\.exe/);
  assert.match(securityAcceptance, /Start-MpScan -ScanType CustomScan -ScanPath \$agentPath/);
  assert.match(securityAcceptance, /AuthenticodeRequired = \$false/);
  assert.match(securityAcceptance, /SettingsChanged = \$false/);
  assert.match(securityAcceptance, /ExclusionsChanged = \$false/);
  assert.match(securityAcceptance, /SmartScreenVerified = \$false/);
  assert.match(securityAcceptance, /ThirdPartyScanVerified = \$false/);
  assert.doesNotMatch(securityAcceptance, /(?:Add|Set)-MpPreference|ExclusionPath|ExclusionProcess/i);
  assert.doesNotMatch(securityAcceptance, /Start-Process|RunAs|Verb\s+RunAs|\/RL\s+HIGHEST/i);
});

test("Agent security status is read-only and scan fails before mutation when the fixed Agent is absent", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows security provider status is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-security-status-"));
  const script = path.join(root, "scripts", "test-agent-security.ps1");
  const options = {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, LOCALAPPDATA: sandbox }
  };
  try {
    const status = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script
    ], options);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    const result = JSON.parse(status.stdout.trim());
    assert.equal(result.Ok, true);
    assert.equal(result.Mode, "security_status");
    assert.equal(result.AgentExists, false);
    assert.equal(result.AuthenticodeRequired, false);
    assert.equal(result.MutatedSystemState, false);
    assert.equal(result.SettingsChanged, false);
    assert.equal(result.ExclusionsChanged, false);
    assert.equal(fs.existsSync(path.join(sandbox, "POPO")), false);

    const scan = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-RunScan"
    ], options);
    assert.notEqual(scan.status, 0);
    const scanResult = JSON.parse(scan.stdout.trim());
    assert.equal(scanResult.ErrorCode, "acceptance_agent_missing");
    assert.equal(scanResult.SettingsChanged, false);
    assert.equal(scanResult.ExclusionsChanged, false);
    assert.equal(fs.existsSync(path.join(sandbox, "POPO")), false);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("shadow cycle verification is local, read-only and evidence bounded", () => {
  assert.equal(
    packageJson.scripts["verify:agent-shadow-cycle"],
    "node scripts/verify-shadow-cycle.mjs"
  );
  assert.match(shadowCycleVerifier, /MAX_EVIDENCE_BYTES = 1024 \* 1024/);
  assert.match(shadowCycleVerifier, /MAX_HISTORY = 64/);
  assert.match(shadowCycleVerifier, /cycle_not_consistent/);
  assert.match(shadowCycleVerifier, /NetworkUsed: false/);
  assert.match(shadowCycleVerifier, /StateChanged: false/);
  assert.doesNotMatch(shadowCycleVerifier, /https?:\/\/|fetch\(|request\(|writeFile|rmSync|unlinkSync/);
});
