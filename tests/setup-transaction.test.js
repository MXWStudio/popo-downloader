"use strict";

const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const repoRoot = path.join(__dirname, "..");
const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const setupRegistryRoots = new Set();
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

function buildFixture(packageRoot, versionName, marker, options = {}) {
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
  if (options.key) manifest.key = options.key;
  if (options.name) {
    manifest.name = options.name;
    manifest.action.default_title = options.name;
  }
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

function compileSetup(packageRoot, options = {}) {
  const output = path.join(packageRoot, options.dev ? "POPO-Dev-Setup.exe" : "POPO-Setup.exe");
  const result = spawnSync(compiler, [
    "/nologo",
    "/target:winexe",
    options.dev ? "/define:POPO_SETUP_TEST;POPO_DEV_BUILD" : "/define:POPO_SETUP_TEST",
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
  if (options.registerStartupOnly) args.push("--test-register-agent-startup-only");
  if (options.verifyRunStartup) args.push("--test-verify-agent-run-startup");
  if (options.deleteStartup) args.push("--test-delete-agent-startup");
  if (!options.register) args.push("--skip-register");
  args.push("--install-root", installRoot);
  if (options.repair) args.push("--repair");
  if (options.migrateFrom) args.push("--migrate-from", options.migrateFrom);
  if (options.failAfterSwap) args.push("--test-fail-after-swap");
  const registrySuffix = crypto.createHash("sha256")
    .update(path.resolve(path.dirname(installRoot)).toUpperCase(), "utf8")
    .digest("hex").slice(0, 24);
  const registryRoot = `Software\\POPOSetupTests\\SetupTransaction_${registrySuffix}`;
  setupRegistryRoots.add(registryRoot);
  return spawnSync(setupExecutable, args, {
    cwd: path.dirname(setupExecutable),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    env: {
      ...process.env,
      LOCALAPPDATA: path.join(path.dirname(installRoot), "local-appdata"),
      POPO_SETUP_TEST_LOG_ROOT: path.join(path.dirname(installRoot), "local-appdata"),
      POPO_SETUP_TEST_MODE: "1",
      POPO_SETUP_TEST_REGISTRY_ROOT: registryRoot,
      POPO_SETUP_TEST_FAIL_AGENT_STARTUP: options.failAgentStartup ? "1" : "",
      POPO_SETUP_TEST_SCHTASKS_DENIED: options.schtasksDenied ? "1" : "",
      POPO_SETUP_TEST_FAIL_AGENT_RUN_STARTUP: options.failAgentRunStartup ? "1" : "",
      POPO_SETUP_TEST_SKIP_AGENT_START: options.skipAgentStart ? "1" : ""
    }
  });
}

function childHasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForCondition(condition, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (condition()) return;
    await delay(intervalMs);
  }
  const details = typeof options.describeFailure === "function"
    ? options.describeFailure()
    : options.describeFailure;
  assert.fail(details || `condition was not met within ${timeoutMs} ms`);
}

async function waitForHelperReady(child, readyPath, label, describeFailure) {
  await waitForCondition(() => {
    if (fs.existsSync(readyPath) && !childHasExited(child)) return true;
    if (childHasExited(child)) {
      assert.fail(`${label} exited before ready\n${describeFailure()}`);
    }
    return false;
  }, {
    timeoutMs: 8_000,
    describeFailure: () => `${label} did not become ready\n${describeFailure()}`
  });
}

async function stopChildProcess(child, label) {
  if (childHasExited(child)) return;
  child.kill();
  await waitForCondition(() => childHasExited(child), {
    timeoutMs: 5_000,
    describeFailure: () => `${label} did not exit during test cleanup; pid=${child.pid}; ` +
      `exitCode=${child.exitCode}; signalCode=${child.signalCode}`
  });
}

function compileTestHelper(executable, sourceText) {
  const source = executable + ".cs";
  fs.writeFileSync(source, sourceText, "utf8");
  const result = spawnSync(compiler, [
    "/nologo",
    "/target:winexe",
    "/optimize+",
    "/out:" + executable,
    source
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  fs.rmSync(source, { force: true });
}

function compileMaintenanceObserver(executable) {
  compileTestHelper(executable, String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using Microsoft.Win32;

internal static class MaintenanceObserver
{
    private static void WriteAtomically(string path, string content)
    {
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(temporary, content);
        File.Move(temporary, path);
    }

    private static void WriteStatus(
        string path,
        bool markerObserved,
        bool markerCurrentlyExists,
        string lastNativeHostState,
        string firstMarkerObservedAt,
        string pausedObservedAt)
    {
        File.WriteAllText(path,
            "markerObserved=" + markerObserved.ToString().ToLowerInvariant() +
            ";markerCurrentlyExists=" + markerCurrentlyExists.ToString().ToLowerInvariant() +
            ";lastNativeHostState=" + lastNativeHostState +
            ";firstMarkerObservedAt=" + firstMarkerObservedAt +
            ";pausedObservedAt=" + pausedObservedAt);
    }

    private static string GetNativeHostState(string registryPath)
    {
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(registryPath, false))
        {
            object value = key == null ? null : key.GetValue("");
            return value == null ? "paused" : "registered";
        }
    }

    private static int Main(string[] args)
    {
        string marker = Path.Combine(args[0], "Updates", "maintenance.json");
        string evidence = args[1];
        string registryPath = args[2];
        string ready = args[3];
        string status = args[4];
        bool markerObserved = false;
        string lastNativeHostState = "not-checked";
        string firstMarkerObservedAt = "";
        string pausedObservedAt = "";
        WriteStatus(status, false, false, lastNativeHostState, "", "");
        WriteAtomically(ready, Process.GetCurrentProcess().Id.ToString());
        DateTime deadline = DateTime.UtcNow.AddSeconds(10);
        while (DateTime.UtcNow <= deadline)
        {
            bool markerCurrentlyExists = File.Exists(marker);
            if (!markerObserved)
            {
                if (!markerCurrentlyExists)
                {
                    WriteStatus(status, false, false, lastNativeHostState, "", "");
                    Thread.Sleep(25);
                    continue;
                }
                markerObserved = true;
                firstMarkerObservedAt = DateTime.UtcNow.ToString("O");
            }

            if (!markerCurrentlyExists)
            {
                WriteStatus(status, true, false, lastNativeHostState,
                    firstMarkerObservedAt, pausedObservedAt);
                return 3;
            }

            lastNativeHostState = GetNativeHostState(registryPath);
            WriteStatus(status, true, true, lastNativeHostState,
                firstMarkerObservedAt, pausedObservedAt);
            if (lastNativeHostState == "paused")
            {
                if (!File.Exists(marker))
                {
                    WriteStatus(status, true, false, lastNativeHostState,
                        firstMarkerObservedAt, pausedObservedAt);
                    return 3;
                }
                pausedObservedAt = DateTime.UtcNow.ToString("O");
                WriteStatus(status, true, true, lastNativeHostState,
                    firstMarkerObservedAt, pausedObservedAt);
                WriteAtomically(evidence, "marker=active;nativeHost=paused");
                return 0;
            }
            Thread.Sleep(25);
        }
        WriteStatus(status, markerObserved, File.Exists(marker), lastNativeHostState,
            firstMarkerObservedAt, pausedObservedAt);
        return 2;
    }
}
`);
}

function compileGopeedSentinel(executable) {
  compileTestHelper(executable, String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

internal static class GopeedSentinel
{
    private static void WriteAtomically(string path, string content)
    {
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(temporary, content);
        File.Move(temporary, path);
    }

    private static int Main(string[] args)
    {
        WriteAtomically(args[0], Process.GetCurrentProcess().Id.ToString());
        Thread.Sleep(Timeout.Infinite);
        return 0;
    }
}
`);
}

after(() => {
  for (const registryRoot of setupRegistryRoots) {
    spawnSync("reg.exe", ["delete", `HKCU\\${registryRoot}`, "/f"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000
    });
  }
});

function snapshotRegistryKey(keyPath) {
  const result = spawnSync("reg.exe", ["query", keyPath, "/s"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function readInstallState(installRoot) {
  return JSON.parse(fs.readFileSync(path.join(installRoot, "install-state.json"), "utf8"));
}

function verifyBrowsedInstallRoot(setupExecutable, selectedPath, expectedPath) {
  return spawnSync(setupExecutable, [
    "--test-resolve-browsed-install-root",
    "--selected-path",
    selectedPath,
    "--expected-path",
    expectedPath
  ], {
    cwd: path.dirname(setupExecutable),
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    env: {
      ...process.env,
      POPO_SETUP_TEST_MODE: "1"
    }
  });
}

test("浏览安装位置不会在同名产品目录后重复追加一层", {
  timeout: 60_000
}, (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-install-root-selection-"));
  const stablePackage = path.join(sandbox, "stable-package");
  const devPackage = path.join(sandbox, "dev-package");
  try {
    fs.mkdirSync(stablePackage, { recursive: true });
    fs.mkdirSync(devPackage, { recursive: true });
    const stableSetup = compileSetup(stablePackage);
    const devSetup = compileSetup(devPackage, { dev: true });
    const cases = [
      {
        selected: "D:\\",
        stable: "D:\\POPOStableDownloader",
        dev: "D:\\POPODevDownloader"
      },
      {
        selected: "D:\\InstallParent",
        stable: "D:\\InstallParent\\POPOStableDownloader",
        dev: "D:\\InstallParent\\POPODevDownloader"
      },
      {
        selected: "D:\\POPOStableDownloader",
        stable: "D:\\POPOStableDownloader"
      },
      {
        selected: "D:\\POPOStableDownloader\\",
        stable: "D:\\POPOStableDownloader"
      },
      {
        selected: "D:\\POPODevDownloader",
        dev: "D:\\POPODevDownloader"
      },
      {
        selected: "D:\\POPODevDownloader\\",
        dev: "D:\\POPODevDownloader"
      }
    ];
    for (const item of cases) {
      if (item.stable) {
        const result = verifyBrowsedInstallRoot(stableSetup, item.selected, item.stable);
        assert.equal(result.status, 0, `stable ${item.selected}: ${result.stdout}${result.stderr}`);
      }
      if (item.dev) {
        const result = verifyBrowsedInstallRoot(devSetup, item.selected, item.dev);
        assert.equal(result.status, 0, `dev ${item.selected}: ${result.stdout}${result.stderr}`);
      }
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("legacy .NET path boundary fails safely before candidate activation", {
  timeout: 60_000
}, (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-path-boundary-"));
  const packageRoot = path.join(sandbox, "package");
  const prefix = path.join(sandbox, "B");
  if (prefix.length >= 126) {
    fs.rmSync(sandbox, { recursive: true, force: true });
    t.skip("temporary root is already too long for the fixed 126-character boundary");
    return;
  }
  const installRoot = prefix + "b".repeat(126 - prefix.length);
  try {
    buildFixture(packageRoot, "0.7.8", "path-boundary");
    const deepGopeedDirectory = path.join(
      packageRoot,
      "Gopeed",
      "data",
      "flutter_assets",
      "assets",
      "extension"
    );
    fs.mkdirSync(deepGopeedDirectory, { recursive: true });
    fs.writeFileSync(path.join(deepGopeedDirectory, "default_icon.png"), "fixture", "utf8");
    const setup = compileSetup(packageRoot);
    const result = runSetup(setup, installRoot);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const errorPath = path.join(installRoot, "setup-test-error.txt");
    assert.equal(fs.existsSync(errorPath), true);
    const error = fs.readFileSync(errorPath, "utf8");
    assert.match(error, /System\.IO\.PathTooLongException/);
    assert.match(error, /PopoSetup\.CopyDirectory/);
    assert.equal(fs.existsSync(path.join(installRoot, "install-state.json")), false);
    assert.equal(fs.existsSync(path.join(installRoot, "Extension")), false);
    assert.equal(fs.existsSync(path.join(installRoot, "NativeHost")), false);
    assert.equal(fs.existsSync(path.join(installRoot, "Agent")), false);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("development green install cannot overwrite a stable green install", {
  timeout: 60_000
}, (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-dev-isolation-"));
  const stablePackage = path.join(sandbox, "stable-package");
  const devPackage = path.join(sandbox, "dev-package");
  const stableRoot = path.join(sandbox, "POPOStableDownloader");
  const devRoot = path.join(sandbox, "POPODevDownloader");
  const devKey = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAktkTv13QYDbQoZCW7Dnk84LsxiHEj0H2a0y7Ir8AY12pAb1hG6vfB7aQ0nyudGhxAmudVdPluPJy3zx48SHAHwu2YJDfVUIdN+LhUU6FkeN9XlHp9dtzYxyO7/oG5NS2XGBu7rPxoJS0Owme5rpj6Oks3oiFI95TaTn2DOVB7FryTbdPTvBX9czDvOxvPG45hABm0Djz/DDX5luSmCXDPCnNkERgkU4f/WTAJFble76uph6RXlyFD5PzdPETpYvngjALceH2t+FcWjf2+CZjwudPkUQRrM/Z1DF77md2ovZV8B9zQnlympk8JQCb44tY1jtvypTE9W1IHaCXjZIizwIDAQAB";
  try {
    buildFixture(stablePackage, "0.7.4", "stable-sentinel");
    const stableSetup = compileSetup(stablePackage);
    const stableInstall = runSetup(stableSetup, stableRoot);
    assert.equal(stableInstall.status, 0, stableInstall.stdout + stableInstall.stderr);
    const stableStateBefore = fs.readFileSync(path.join(stableRoot, "install-state.json"), "utf8");
    fs.writeFileSync(path.join(stableRoot, "must-not-change.txt"), "stable-preserved", "utf8");

    buildFixture(devPackage, "0.7.4-dev", "dev-sentinel", {
      key: devKey,
      name: "POPO Dev 下载助手"
    });
    const devSetup = compileSetup(devPackage, { dev: true });
    const devInstall = runSetup(devSetup, devRoot);
    assert.equal(devInstall.status, 0, devInstall.stdout + devInstall.stderr);

    const devState = readInstallState(devRoot);
    assert.equal(devState.version, "0.7.4-dev");
    assert.equal(devState.extensionId, "folfhehnopknchpoaajfpboibbhnlanf");
    assert.ok(fs.existsSync(path.join(
      devRoot,
      "NativeHost",
      "com.popo.dev_downloader.folder_picker.json"
    )));
    assert.ok(!fs.existsSync(path.join(
      devRoot,
      "NativeHost",
      "com.popo.stable_downloader.folder_picker.json"
    )));
    assert.equal(
      fs.readFileSync(path.join(stableRoot, "install-state.json"), "utf8"),
      stableStateBefore
    );
    assert.equal(
      fs.readFileSync(path.join(stableRoot, "must-not-change.txt"), "utf8"),
      "stable-preserved"
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("修复时暂停扩展自动拉起 Gopeed，自动退出后继续并恢复本机助手", {
  timeout: 60_000
}, async (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-maintenance-repair-"));
  const packageRoot = path.join(sandbox, "package");
  const installRoot = path.join(sandbox, "installed");
  const observerExecutable = path.join(sandbox, "maintenance-observer.exe");
  const observerReady = path.join(sandbox, "maintenance-observer.ready");
  const observerStatus = path.join(sandbox, "maintenance-observer.status");
  const gopeedReady = path.join(sandbox, "gopeed-sentinel.ready");
  const evidence = path.join(sandbox, "maintenance-evidence.txt");
  const marker = path.join(installRoot, "Updates", "maintenance.json");
  let observerProcess;
  let gopeedProcess;
  let repair;
  let nativeRegistryPath = "";
  const describeFailure = () => {
    let observerState = "missing";
    try {
      if (fs.existsSync(observerStatus)) observerState = fs.readFileSync(observerStatus, "utf8");
    } catch (error) {
      observerState = `unreadable: ${error.message}`;
    }
    const registry = nativeRegistryPath
      ? snapshotRegistryKey(`HKCU\\${nativeRegistryPath}`)
      : { status: "not-ready", stdout: "", stderr: "" };
    return [
      `observer pid=${observerProcess?.pid ?? "none"}; exitCode=${observerProcess?.exitCode ?? "null"}; ` +
        `signalCode=${observerProcess?.signalCode ?? "null"}`,
      `gopeed pid=${gopeedProcess?.pid ?? "none"}; exitCode=${gopeedProcess?.exitCode ?? "null"}; ` +
        `signalCode=${gopeedProcess?.signalCode ?? "null"}`,
      `observer ready exists=${fs.existsSync(observerReady)}`,
      `observer status=${observerState}`,
      `gopeed ready exists=${fs.existsSync(gopeedReady)}`,
      `maintenance marker exists=${fs.existsSync(marker)}`,
      `native host registry status=${registry.status}; stdout=${registry.stdout}; stderr=${registry.stderr}`,
      `setup status=${repair?.status ?? "not-started"}`,
      `setup stdout=${repair?.stdout ?? ""}`,
      `setup stderr=${repair?.stderr ?? ""}`
    ].join("\n");
  };
  try {
    buildFixture(packageRoot, "0.7.5", "maintenance-repair");
    const setupExecutable = compileSetup(packageRoot);
    const initial = runSetup(setupExecutable, installRoot, {
      register: true,
      skipAgentStart: true
    });
    assert.equal(initial.status, 0, initial.stdout + initial.stderr);

    const registrySuffix = crypto.createHash("sha256")
      .update(path.resolve(path.dirname(installRoot)).toUpperCase(), "utf8")
      .digest("hex").slice(0, 24);
    nativeRegistryPath = `Software\\POPOSetupTests\\SetupTransaction_${registrySuffix}` +
      "\\NativeMessagingHosts\\com.popo.stable_downloader.folder_picker";
    const gopeedExecutable = path.join(
      installRoot,
      "NativeHost",
      "Gopeed",
      "gopeed.exe"
    );
    compileMaintenanceObserver(observerExecutable);
    compileGopeedSentinel(gopeedExecutable);
    observerProcess = spawn(
      observerExecutable,
      [installRoot, evidence, nativeRegistryPath, observerReady, observerStatus],
      { windowsHide: true, stdio: "ignore" }
    );
    gopeedProcess = spawn(gopeedExecutable, [gopeedReady], {
      windowsHide: true,
      stdio: "ignore"
    });
    await waitForHelperReady(
      observerProcess,
      observerReady,
      "maintenance observer",
      describeFailure
    );
    await waitForHelperReady(gopeedProcess, gopeedReady, "Gopeed sentinel", describeFailure);
    assert.ok(!childHasExited(observerProcess), describeFailure());
    assert.ok(!childHasExited(gopeedProcess), describeFailure());

    repair = runSetup(setupExecutable, installRoot, {
      register: true,
      repair: true,
      skipAgentStart: true
    });
    assert.equal(repair.status, 0, repair.stdout + repair.stderr);
    await waitForCondition(() => {
      if (fs.existsSync(evidence)) return true;
      if (childHasExited(observerProcess)) {
        assert.fail("maintenance observer exited before producing evidence\n" + describeFailure());
      }
      return false;
    }, {
      timeoutMs: 11_000,
      describeFailure: () => "maintenance evidence was not produced\n" + describeFailure()
    });
    await waitForCondition(() => childHasExited(observerProcess), {
      timeoutMs: 8_000,
      describeFailure: () => "maintenance observer did not exit\n" + describeFailure()
    });
    await waitForCondition(() => childHasExited(gopeedProcess), {
      timeoutMs: 8_000,
      describeFailure: () => "Setup did not automatically stop the Gopeed sentinel\n" +
        describeFailure()
    });
    assert.equal(
      fs.readFileSync(evidence, "utf8"),
      "marker=active;nativeHost=paused"
    );
    assert.ok(!fs.existsSync(marker));
    const registered = snapshotRegistryKey(`HKCU\\${nativeRegistryPath}`);
    assert.equal(registered.status, 0, registered.stdout + registered.stderr);
    assert.match(registered.stdout, /com\.popo\.stable_downloader\.folder_picker\.json/i);

    buildFixture(packageRoot, "0.7.5", "maintenance-rollback");
    const failed = runSetup(setupExecutable, installRoot, {
      register: true,
      failAfterSwap: true,
      skipAgentStart: true
    });
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.ok(!fs.existsSync(path.join(installRoot, "Updates", "maintenance.json")));
    const restored = snapshotRegistryKey(`HKCU\\${nativeRegistryPath}`);
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    assert.match(restored.stdout, /com\.popo\.stable_downloader\.folder_picker\.json/i);
  } finally {
    await stopChildProcess(observerProcess, "maintenance observer");
    await stopChildProcess(gopeedProcess, "Gopeed sentinel");
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("0.7.2 覆盖到 0.7.5、迁移和回滚均保留数据与兼容扩展路径", {
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
    buildFixture(packageRoot, "0.7.2", "candidate-one");
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
    assert.equal(readInstallState(installRoot).version, "0.7.2");
    assert.equal(
      fs.readFileSync(path.join(installRoot, "Agent", ".popo-agent-version"), "utf8"),
      "fixture-agent-candidate-one"
    );
    assert.equal(fs.readFileSync(taskDatabase, "utf8"), "persistent-task-history");
    assert.equal(fs.readFileSync(sessionPreferences, "utf8"), '{"port":10888}');

    buildFixture(packageRoot, "0.7.5", "candidate-two");
    const failed = runSetup(setupExecutable, installRoot, { failAfterSwap: true });
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.equal(
      fs.readFileSync(path.join(installRoot, "Extension", "runtime", "popup.js"), "utf8"),
      originalPopup
    );
    assert.equal(readInstallState(installRoot).version, "0.7.2");
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
    assert.equal(state.version, "0.7.5");
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
    assert.equal(repairedState.version, "0.7.5");
    assert.equal(repairedState.updateMode, "repair");
    assert.equal(fs.readFileSync(taskDatabase, "utf8"), "persistent-task-history");
    assert.equal(fs.readFileSync(sessionPreferences, "utf8"), '{"port":10888}');

    const migratedRoot = path.join(sandbox, "migrated");
    const migrated = runSetup(setupExecutable, migratedRoot, { migrateFrom: installRoot });
    assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);
    const migratedState = readInstallState(migratedRoot);
    assert.equal(migratedState.version, "0.7.5");
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

test("schtasks 被拒绝时安装器改用 HKCU Run，且不会保留计划任务", {
  timeout: 60_000
}, (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-agent-run-fallback-"));
  const installRoot = path.join(sandbox, "installed");
  try {
    fs.mkdirSync(path.join(installRoot, "Agent"), { recursive: true });
    fs.writeFileSync(path.join(installRoot, "Agent", "PopoAgent.exe"), "fixture-agent", "utf8");
    const setupExecutable = compileSetup(sandbox);
    const registration = runSetup(setupExecutable, installRoot, {
      register: true,
      registerStartupOnly: true,
      schtasksDenied: true
    });
    assert.equal(registration.status, 0, registration.stdout + registration.stderr);
    const verify = runSetup(setupExecutable, installRoot, {
      register: true,
      verifyRunStartup: true
    });
    assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  } finally {
    const setupExecutable = path.join(sandbox, "POPO-Setup.exe");
    if (fs.existsSync(setupExecutable)) {
      runSetup(setupExecutable, installRoot, { register: true, deleteStartup: true });
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("迁移会将 HKCU Run 启动项转移到新目录并清理旧目录", {
  timeout: 60_000
}, (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-migrate-run-startup-"));
  const packageRoot = path.join(sandbox, "package");
  const oldRoot = path.join(sandbox, "old");
  const newRoot = path.join(sandbox, "new");
  const productRegistryBefore = snapshotRegistryKey("HKCU\\Software\\POPOStableDownloader");
  const nativeRegistryBefore = snapshotRegistryKey(
    "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.popo.stable_downloader.folder_picker"
  );
  let setupExecutable = "";
  try {
    buildFixture(packageRoot, "0.7.5", "migrate-run-startup");
    setupExecutable = compileSetup(packageRoot);
    const initial = runSetup(setupExecutable, oldRoot, {
      register: true,
      schtasksDenied: true,
      skipAgentStart: true
    });
    assert.equal(initial.status, 0, initial.stdout + initial.stderr);
    assert.equal(runSetup(setupExecutable, oldRoot, {
      register: true,
      verifyRunStartup: true
    }).status, 0);

    const migration = runSetup(setupExecutable, newRoot, {
      register: true,
      migrateFrom: oldRoot,
      schtasksDenied: true,
      skipAgentStart: true
    });
    assert.equal(migration.status, 0, migration.stdout + migration.stderr);
    assert.equal(runSetup(setupExecutable, newRoot, {
      register: true,
      verifyRunStartup: true
    }).status, 0);
    assert.equal(runSetup(setupExecutable, oldRoot, {
      register: true,
      verifyRunStartup: true
    }).status, 2);
    assert.ok(!fs.existsSync(path.join(oldRoot, "Agent")));
    assert.ok(fs.existsSync(path.join(newRoot, "Agent", "PopoAgent.exe")));
    assert.deepEqual(
      snapshotRegistryKey("HKCU\\Software\\POPOStableDownloader"),
      productRegistryBefore
    );
    assert.deepEqual(
      snapshotRegistryKey(
        "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.popo.stable_downloader.folder_picker"
      ),
      nativeRegistryBefore
    );
  } finally {
    if (setupExecutable) {
      runSetup(setupExecutable, newRoot, { register: true, deleteStartup: true });
      runSetup(setupExecutable, oldRoot, { register: true, deleteStartup: true });
    }
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

test("计划任务与 HKCU Run 都失败时安装事务回滚并保留脱敏错误链日志", {
  timeout: 60_000
}, (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-agent-two-startups-fail-"));
  const packageRoot = path.join(sandbox, "package");
  const installRoot = path.join(sandbox, "installed");
  try {
    buildFixture(packageRoot, "0.7.5-test.1", "both-startups-fail");
    const setupExecutable = compileSetup(packageRoot);
    const result = runSetup(setupExecutable, installRoot, {
      register: true,
      schtasksDenied: true,
      failAgentRunStartup: true
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(!fs.existsSync(path.join(installRoot, "Extension")));
    assert.ok(!fs.existsSync(path.join(installRoot, "NativeHost")));
    assert.ok(!fs.existsSync(path.join(installRoot, "Agent")));
    assert.ok(!fs.existsSync(path.join(installRoot, "install-state.json")));
    const logPath = path.join(sandbox, "local-appdata", "POPOStableDownloader", "Logs", "setup.log");
    const log = fs.readFileSync(logPath, "utf8");
    assert.match(log, /Simulated schtasks access denied/);
    assert.match(log, /Simulated current-user Run startup registration failure/);
    assert.doesNotMatch(log, /token=[^\[]/i);
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
