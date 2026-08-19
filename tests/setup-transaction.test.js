"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.join(__dirname, "..");
const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const extensionFiles = [
  "manifest.json",
  "background.js",
  "content.js",
  "core.js",
  "gopeed.js",
  "page-api.js",
  "popup.css",
  "popup.html",
  "queue.js"
];

function buildFixture(packageRoot, versionName, marker) {
  const extensionRoot = path.join(packageRoot, "extension");
  const gopeedRoot = path.join(packageRoot, "Gopeed");
  const nativeRoot = path.join(packageRoot, "native-host", "bin");
  const agentRoot = path.join(packageRoot, "agent", "bin");
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.mkdirSync(gopeedRoot, { recursive: true });
  fs.mkdirSync(nativeRoot, { recursive: true });
  fs.mkdirSync(agentRoot, { recursive: true });
  for (const file of extensionFiles) {
    fs.copyFileSync(path.join(repoRoot, file), path.join(extensionRoot, file));
  }
  fs.cpSync(path.join(repoRoot, "runtime"), path.join(extensionRoot, "runtime"), {
    recursive: true
  });
  const manifestPath = path.join(extensionRoot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.version_name = versionName;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  fs.appendFileSync(
    path.join(extensionRoot, "runtime", "popup.js"),
    "\n// " + marker + "\n",
    "utf8"
  );
  fs.writeFileSync(path.join(gopeedRoot, "gopeed.exe"), "fixture-gopeed", "utf8");
  fs.writeFileSync(path.join(gopeedRoot, "libgopeed.dll"), "fixture-libgopeed", "utf8");
  fs.writeFileSync(
    path.join(gopeedRoot, ".popo-bundle-version"),
    "fixture-" + marker,
    "utf8"
  );
  fs.writeFileSync(
    path.join(nativeRoot, "PopoFolderPickerHost.exe"),
    "fixture-native-host",
    "utf8"
  );
  fs.writeFileSync(
    path.join(nativeRoot, ".popo-native-version"),
    "fixture-native-" + marker,
    "utf8"
  );
  fs.writeFileSync(path.join(agentRoot, "PopoAgent.exe"), "fixture-agent", "utf8");
  fs.writeFileSync(
    path.join(agentRoot, ".popo-agent-version"),
    "fixture-agent-" + marker,
    "utf8"
  );
  const releaseManifest = JSON.stringify({
    schemaVersion: 1,
    releaseVersion: versionName,
    extensionVersion: versionName,
    agentVersion: versionName,
    nativeHostVersion: versionName,
    installerVersion: versionName,
    updateProtocol: 2,
    minimumProtocol: 1
  }, null, 2);
  fs.writeFileSync(path.join(packageRoot, "release-manifest.json"), releaseManifest, "utf8");
  fs.writeFileSync(path.join(agentRoot, "release-manifest.json"), releaseManifest, "utf8");
}

function compileSetup(packageRoot) {
  const output = path.join(packageRoot, "POPO-Setup.exe");
  const result = spawnSync(compiler, [
    "/nologo",
    "/target:winexe",
    "/define:POPO_SETUP_TEST",
    "/optimize+",
    "/codepage:65001",
    "/reference:System.Drawing.dll",
    "/reference:System.Windows.Forms.dll",
    "/reference:System.Web.Extensions.dll",
    "/out:" + output,
    path.join(repoRoot, "setup", "PopoSetup.cs")
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return output;
}

function runSetup(setupExecutable, installRoot, options = {}) {
  const args = ["--quiet"];
  if (!options.register) args.push("--skip-register");
  args.push("--install-root", installRoot);
  if (options.repair) args.push("--repair");
  if (options.migrateFrom) args.push("--migrate-from", options.migrateFrom);
  if (options.failAfterSwap) args.push("--test-fail-after-swap");
  return spawnSync(setupExecutable, args, {
    cwd: path.dirname(setupExecutable),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    env: {
      ...process.env,
      POPO_SETUP_TEST_MODE: options.failAfterSwap || options.failAgentStartup ? "1" : "",
      POPO_SETUP_TEST_FAIL_AGENT_STARTUP: options.failAgentStartup ? "1" : ""
    }
  });
}

function readInstallState(installRoot) {
  return JSON.parse(fs.readFileSync(path.join(installRoot, "install-state.json"), "utf8"));
}

test("verified candidate update restores the previous install on swap failure", {
  timeout: 120_000
}, (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-update-test-"));
  const packageRoot = path.join(sandbox, "package");
  const installRoot = path.join(sandbox, "installed");
  try {
    buildFixture(packageRoot, "0.7.0-test.1", "candidate-one");
    const setupExecutable = compileSetup(packageRoot);

    const initial = runSetup(setupExecutable, installRoot);
    assert.equal(initial.status, 0, initial.stdout + initial.stderr);
    const originalPopup = fs.readFileSync(
      path.join(installRoot, "Extension", "runtime", "popup.js"),
      "utf8"
    );
    assert.match(originalPopup, /candidate-one/);
    assert.equal(readInstallState(installRoot).updateMode, "verified-candidate");
    assert.equal(
      fs.readFileSync(path.join(installRoot, "Agent", ".popo-agent-version"), "utf8"),
      "fixture-agent-candidate-one"
    );
    const gopeedStorage = path.join(installRoot, "NativeHost", "Gopeed", "storage");
    const taskDatabase = path.join(gopeedStorage, "gopeed.db");
    const sessionPreferences = path.join(gopeedStorage, "session.json");
    fs.mkdirSync(gopeedStorage, { recursive: true });
    fs.writeFileSync(taskDatabase, "persistent-task-history", "utf8");
    fs.writeFileSync(sessionPreferences, '{"port":10888}', "utf8");

    fs.rmSync(path.join(packageRoot, "extension", "runtime", "popo-runtime.js"));
    const invalidCandidate = runSetup(setupExecutable, installRoot);
    assert.equal(invalidCandidate.status, 1, invalidCandidate.stdout + invalidCandidate.stderr);
    assert.equal(
      fs.readFileSync(path.join(installRoot, "Extension", "runtime", "popup.js"), "utf8"),
      originalPopup
    );
    assert.equal(readInstallState(installRoot).version, "0.7.0-test.1");
    assert.equal(
      fs.readFileSync(path.join(installRoot, "Agent", ".popo-agent-version"), "utf8"),
      "fixture-agent-candidate-one"
    );
    assert.equal(fs.readFileSync(taskDatabase, "utf8"), "persistent-task-history");
    assert.equal(fs.readFileSync(sessionPreferences, "utf8"), '{"port":10888}');

    buildFixture(packageRoot, "0.7.0-test.2", "candidate-two");
    const failed = runSetup(setupExecutable, installRoot, { failAfterSwap: true });
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.equal(
      fs.readFileSync(path.join(installRoot, "Extension", "runtime", "popup.js"), "utf8"),
      originalPopup
    );
    assert.equal(readInstallState(installRoot).version, "0.7.0-test.1");
    assert.equal(
      fs.readFileSync(path.join(installRoot, "Agent", ".popo-agent-version"), "utf8"),
      "fixture-agent-candidate-one"
    );
    assert.equal(fs.readFileSync(taskDatabase, "utf8"), "persistent-task-history");
    assert.equal(fs.readFileSync(sessionPreferences, "utf8"), '{"port":10888}');
    const pendingCandidates = fs.existsSync(path.join(installRoot, "Updates"))
      ? fs.readdirSync(path.join(installRoot, "Updates"))
        .filter((name) => name.startsWith("candidate-"))
      : [];
    assert.deepEqual(pendingCandidates, []);

    const updated = runSetup(setupExecutable, installRoot);
    assert.equal(updated.status, 0, updated.stdout + updated.stderr);
    const newPopup = fs.readFileSync(
      path.join(installRoot, "Extension", "runtime", "popup.js"),
      "utf8"
    );
    assert.match(newPopup, /candidate-two/);
    const state = readInstallState(installRoot);
    assert.equal(state.version, "0.7.0-test.2");
    assert.equal(state.updateMode, "verified-candidate");
    assert.equal(
      fs.readFileSync(path.join(installRoot, "Agent", ".popo-agent-version"), "utf8"),
      "fixture-agent-candidate-two"
    );
    assert.ok(state.rollbackPath);
    assert.equal(fs.readFileSync(taskDatabase, "utf8"), "persistent-task-history");
    assert.equal(fs.readFileSync(sessionPreferences, "utf8"), '{"port":10888}');
    assert.equal(
      fs.readFileSync(
        path.join(state.rollbackPath, "NativeHost", "Gopeed", "storage", "gopeed.db"),
        "utf8"
      ),
      "persistent-task-history"
    );
    assert.equal(
      fs.readFileSync(
        path.join(installRoot, "NativeHost", "Gopeed", ".popo-bundle-version"),
        "utf8"
      ),
      "fixture-candidate-two"
    );
    assert.ok(fs.existsSync(path.join(
      state.rollbackPath,
      "Extension",
      "runtime",
      "popup.js"
    )));
    assert.equal(
      fs.readFileSync(path.join(state.rollbackPath, "Agent", ".popo-agent-version"), "utf8"),
      "fixture-agent-candidate-one"
    );
    assert.match(
      fs.readFileSync(
        path.join(state.rollbackPath, "Extension", "runtime", "popup.js"),
        "utf8"
      ),
      /candidate-one/
    );

    const generatedGopeedFiles = [
      ["host.exe", "runtime-host"],
      ["updater.exe", "runtime-updater"],
      ["com.gopeed.gopeed.json", "runtime-config"]
    ];
    for (const [name, value] of generatedGopeedFiles) {
      fs.writeFileSync(
        path.join(installRoot, "NativeHost", "Gopeed", name),
        value,
        "utf8"
      );
    }
    fs.appendFileSync(
      path.join(packageRoot, "extension", "runtime", "popup.js"),
      "\n// extension-only-update\n",
      "utf8"
    );
    const extensionOnly = runSetup(setupExecutable, installRoot);
    assert.equal(extensionOnly.status, 0, extensionOnly.stdout + extensionOnly.stderr);
    assert.match(
      fs.readFileSync(path.join(installRoot, "Extension", "runtime", "popup.js"), "utf8"),
      /extension-only-update/
    );
    for (const [name, value] of generatedGopeedFiles) {
      assert.equal(
        fs.readFileSync(path.join(installRoot, "NativeHost", "Gopeed", name), "utf8"),
        value
      );
    }
    assert.equal(fs.readFileSync(taskDatabase, "utf8"), "persistent-task-history");
    const extensionOnlyState = readInstallState(installRoot);

    const repeated = runSetup(setupExecutable, installRoot);
    assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
    const repeatedState = readInstallState(installRoot);
    assert.equal(repeatedState.rollbackPath, extensionOnlyState.rollbackPath);
    assert.equal(fs.readFileSync(taskDatabase, "utf8"), "persistent-task-history");
    assert.equal(fs.readFileSync(sessionPreferences, "utf8"), '{"port":10888}');

    const repaired = runSetup(setupExecutable, installRoot, { repair: true });
    assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
    const repairedState = readInstallState(installRoot);
    assert.equal(repairedState.version, "0.7.0-test.2");
    assert.equal(repairedState.updateMode, "repair");
    assert.equal(fs.readFileSync(taskDatabase, "utf8"), "persistent-task-history");
    assert.equal(fs.readFileSync(sessionPreferences, "utf8"), '{"port":10888}');

    const migratedRoot = path.join(sandbox, "migrated");
    const migrated = runSetup(setupExecutable, migratedRoot, { migrateFrom: installRoot });
    assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);
    const migratedState = readInstallState(migratedRoot);
    assert.equal(migratedState.version, "0.7.0-test.2");
    assert.equal(migratedState.updateMode, "migration");
    assert.equal(
      fs.readFileSync(path.join(migratedRoot, "Agent", ".popo-agent-version"), "utf8"),
      "fixture-agent-candidate-two"
    );
    assert.equal(migratedState.chromeExtensionPath, path.join(installRoot, "Extension"));
    assert.equal(
      fs.readFileSync(path.join(migratedRoot, "NativeHost", "Gopeed", "storage", "gopeed.db"), "utf8"),
      "persistent-task-history"
    );
    assert.equal(
      fs.readFileSync(path.join(migratedRoot, "NativeHost", "Gopeed", "storage", "session.json"), "utf8"),
      '{"port":10888}'
    );
    assert.match(
      fs.readFileSync(path.join(installRoot, "Extension", "runtime", "popup.js"), "utf8"),
      /extension-only-update/
    );
    const migrationMarker = JSON.parse(
      fs.readFileSync(path.join(installRoot, "migration-state.json"), "utf8")
    );
    assert.equal(migrationMarker.migratedTo, migratedRoot);
    assert.ok(!fs.existsSync(path.join(installRoot, "NativeHost")));
    assert.ok(!fs.existsSync(path.join(installRoot, "Agent")));

    fs.appendFileSync(
      path.join(packageRoot, "extension", "runtime", "popup.js"),
      "\n// post-migration-update\n",
      "utf8"
    );
    const postMigrationUpdate = runSetup(setupExecutable, migratedRoot);
    assert.equal(postMigrationUpdate.status, 0, postMigrationUpdate.stdout + postMigrationUpdate.stderr);
    assert.match(
      fs.readFileSync(path.join(migratedRoot, "Extension", "runtime", "popup.js"), "utf8"),
      /post-migration-update/
    );
    assert.match(
      fs.readFileSync(path.join(installRoot, "Extension", "runtime", "popup.js"), "utf8"),
      /post-migration-update/
    );
    assert.equal(
      readInstallState(migratedRoot).chromeExtensionPath,
      path.join(installRoot, "Extension")
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("agent startup registration failure rolls back every newly activated component", {
  timeout: 60_000
}, (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-agent-rollback-"));
  const packageRoot = path.join(sandbox, "package");
  const installRoot = path.join(sandbox, "installed");
  try {
    buildFixture(packageRoot, "0.7.3-test.1", "agent-startup-failure");
    const setupExecutable = compileSetup(packageRoot);
    const result = runSetup(setupExecutable, installRoot, {
      register: true,
      failAgentStartup: true
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(!fs.existsSync(path.join(installRoot, "Extension")));
    assert.ok(!fs.existsSync(path.join(installRoot, "NativeHost")));
    assert.ok(!fs.existsSync(path.join(installRoot, "Agent")));
    assert.ok(!fs.existsSync(path.join(installRoot, "install-state.json")));
    const candidates = fs.existsSync(path.join(installRoot, "Updates"))
      ? fs.readdirSync(path.join(installRoot, "Updates")).filter((name) => name.startsWith("candidate-"))
      : [];
    assert.deepEqual(candidates, []);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("agent startup registration failure restores install state when components are unchanged", {
  timeout: 60_000
}, (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-agent-state-rollback-"));
  const packageRoot = path.join(sandbox, "package");
  const installRoot = path.join(sandbox, "installed");
  try {
    buildFixture(packageRoot, "0.7.3-test.2", "agent-state-rollback");
    const setupExecutable = compileSetup(packageRoot);
    const initial = runSetup(setupExecutable, installRoot);
    assert.equal(initial.status, 0, initial.stdout + initial.stderr);

    const installStatePath = path.join(installRoot, "install-state.json");
    const originalState = readInstallState(installRoot);
    originalState.installedAt = "2000-01-01T00:00:00.000Z";
    originalState.transactionSentinel = "must-survive-agent-startup-failure";
    const originalStateText = JSON.stringify(originalState, null, 2);
    fs.writeFileSync(installStatePath, originalStateText, "utf8");

    const failed = runSetup(setupExecutable, installRoot, {
      register: true,
      failAgentStartup: true
    });
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.equal(fs.readFileSync(installStatePath, "utf8"), originalStateText);
    assert.ok(fs.existsSync(path.join(installRoot, "Extension", "manifest.json")));
    assert.ok(fs.existsSync(path.join(installRoot, "NativeHost", "PopoFolderPickerHost.exe")));
    assert.ok(fs.existsSync(path.join(installRoot, "Agent", "PopoAgent.exe")));
    assert.ok(!fs.existsSync(path.join(installRoot, "Rollback")));
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
