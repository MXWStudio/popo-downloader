"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const buildScript = path.join(root, "scripts", "build-bootstrapper.ps1");
const bootstrapperSource = path.join(root, "bootstrapper", "PopoBootstrapper.cs");

function run(file, args, options = {}) {
  return spawnSync(file, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    ...options
  });
}

function compileSetupStub(outputPath) {
  const sourcePath = path.join(path.dirname(outputPath), "SetupStub.cs");
  fs.writeFileSync(sourcePath, `
using System;
using System.Diagnostics;
using System.IO;
internal static class SetupStub {
  [STAThread]
  private static int Main(string[] args) {
    int exitCode = 37;
    string currentDirectoryMarker = null;
    string holderPath = null;
    string holderPidMarker = null;
    int holdMilliseconds = 0;
    for (int index = 0; index + 1 < args.Length; index++) {
      if (String.Equals(args[index], "--marker", StringComparison.OrdinalIgnoreCase)) {
        File.WriteAllText(args[index + 1], String.Join("|", args));
      }
      if (String.Equals(args[index], "--exit-code", StringComparison.OrdinalIgnoreCase)) {
        exitCode = Int32.Parse(args[index + 1]);
      }
      if (String.Equals(args[index], "--current-directory-marker", StringComparison.OrdinalIgnoreCase)) {
        currentDirectoryMarker = args[index + 1];
      }
      if (String.Equals(args[index], "--holder", StringComparison.OrdinalIgnoreCase)) {
        holderPath = args[index + 1];
      }
      if (String.Equals(args[index], "--hold-milliseconds", StringComparison.OrdinalIgnoreCase)) {
        holdMilliseconds = Int32.Parse(args[index + 1]);
      }
      if (String.Equals(args[index], "--holder-pid-marker", StringComparison.OrdinalIgnoreCase)) {
        holderPidMarker = args[index + 1];
      }
    }
    if (currentDirectoryMarker != null) {
      File.WriteAllText(currentDirectoryMarker, Environment.CurrentDirectory);
    }
    if (holderPath != null && holdMilliseconds > 0) {
      using (Process holder = Process.Start(new ProcessStartInfo {
        FileName = holderPath,
        Arguments = holdMilliseconds.ToString(),
        WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory,
        UseShellExecute = false,
        CreateNoWindow = true
      })) {
        if (holderPidMarker != null) File.WriteAllText(holderPidMarker, holder.Id.ToString());
      }
    }
    return exitCode;
  }
}
`, "utf8");
  const compiled = run(compiler, [
    "/nologo", "/target:winexe", `/out:${outputPath}`, sourcePath
  ]);
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
}

function compileCurrentDirectoryHolder(outputPath) {
  const sourcePath = path.join(path.dirname(outputPath), "CurrentDirectoryHolder.cs");
  fs.writeFileSync(sourcePath, `
using System;
using System.Threading;
internal static class CurrentDirectoryHolder {
  private static int Main(string[] args) {
    Thread.Sleep(Int32.Parse(args[0]));
    return 0;
  }
}
`, "utf8");
  const compiled = run(compiler, [
    "/nologo", "/target:exe", `/out:${outputPath}`, sourcePath
  ]);
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
}

function compileCleanupInvoker(outputPath) {
  const sourcePath = path.join(path.dirname(outputPath), "CleanupInvoker.cs");
  fs.writeFileSync(sourcePath, `
using System;
using System.Reflection;
internal static class CleanupInvoker {
  private static int Main(string[] args) {
    Assembly assembly = Assembly.LoadFile(args[0]);
    Type type = assembly.GetType("PopoBootstrapper", true);
    MethodInfo method = type.GetMethod(
      "TryDeleteTempRoot",
      BindingFlags.NonPublic | BindingFlags.Static
    );
    method.Invoke(null, new object[] { args[1] });
    return 0;
  }
}
`, "utf8");
  const compiled = run(compiler, [
    "/nologo", "/target:exe", `/out:${outputPath}`, sourcePath
  ]);
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
}

function createFixtureZip(sandbox, version = "0.7.5") {
  const packageName = `POPO-Stable-Downloader-${version}-win-x64`;
  const packageRoot = path.join(sandbox, packageName);
  const requiredFiles = [
    ["release-manifest.json", "{}"],
    [path.join("extension", "manifest.json"), "{}"],
    [path.join("Gopeed", "gopeed.exe"), "fixture"],
    [path.join("native-host", "bin", "PopoFolderPickerHost.exe"), "fixture"],
    [path.join("agent", "bin", "PopoAgent.exe"), "fixture"]
  ];
  for (const [relativePath, content] of requiredFiles) {
    const target = path.join(packageRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  compileSetupStub(path.join(packageRoot, "POPO-Setup.exe"));
  const holderPath = path.join(sandbox, "CurrentDirectoryHolder.exe");
  compileCurrentDirectoryHolder(holderPath);
  const zipPath = path.join(sandbox, `${packageName}.zip`);
  const compressed = run("powershell.exe", [
    "-NoProfile", "-Command",
    "Compress-Archive -LiteralPath $env:POPO_TEST_PACKAGE_ROOT -DestinationPath $env:POPO_TEST_ZIP_PATH -CompressionLevel Optimal"
  ], {
    env: { ...process.env, POPO_TEST_PACKAGE_ROOT: packageRoot, POPO_TEST_ZIP_PATH: zipPath }
  });
  assert.equal(compressed.status, 0, compressed.stdout + compressed.stderr);
  return { packageName, zipPath, holderPath };
}

function buildBootstrapper(sandbox, fixture, version = "0.7.5") {
  const outputPath = path.join(sandbox, `${fixture.packageName}.exe`);
  const built = run("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", buildScript,
    "-RepoRoot", root,
    "-ZipPath", fixture.zipPath,
    "-Version", version,
    "-OutputPath", outputPath
  ]);
  assert.equal(built.status, 0, built.stdout + built.stderr);
  return outputPath;
}

function tempInstallerDirectories(tempPath = os.tmpdir()) {
  return new Set(fs.readdirSync(tempPath).filter((name) => name.startsWith("POPO-Installer-")));
}

function createIsolatedTemp(sandbox) {
  const tempPath = path.join(sandbox, "isolated-temp");
  fs.mkdirSync(tempPath, { recursive: true });
  return {
    tempPath,
    env: { ...process.env, TEMP: tempPath, TMP: tempPath }
  };
}

function waitForProcessExit(pid, timeoutMilliseconds = 10_000) {
  const startedAt = Date.now();
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() - startedAt < timeoutMilliseconds) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    Atomics.wait(waiter, 0, 0, 50);
  }
  throw new Error(`process ${pid} did not exit within ${timeoutMilliseconds}ms`);
}

test("Bootstrapper extracts the official ZIP, forwards arguments, propagates Setup exit code, and cleans TEMP", {
  timeout: 120_000
}, (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-bootstrapper-test-"));
  try {
    const fixture = createFixtureZip(sandbox);
    const bootstrapper = buildBootstrapper(sandbox, fixture);
    const versionResult = run("powershell.exe", [
      "-NoProfile", "-Command",
      "[Diagnostics.FileVersionInfo]::GetVersionInfo($env:POPO_TEST_EXE) | Select-Object FileVersion,ProductVersion | ConvertTo-Json -Compress"
    ], { env: { ...process.env, POPO_TEST_EXE: bootstrapper } });
    assert.equal(versionResult.status, 0, versionResult.stdout + versionResult.stderr);
    const versionInfo = JSON.parse(versionResult.stdout.trim());
    assert.equal(versionInfo.FileVersion, "0.7.5.0");
    assert.equal(versionInfo.ProductVersion, "0.7.5");
    const isolated = createIsolatedTemp(sandbox);
    const marker = path.join(sandbox, "marker with spaces.txt");
    const launched = run(bootstrapper, ["--quiet", "--marker", marker], {
      env: isolated.env
    });
    assert.equal(launched.status, 37, launched.stdout + launched.stderr);
    assert.equal(fs.readFileSync(marker, "utf8"), `--quiet|--marker|${marker}`);
    assert.deepEqual(tempInstallerDirectories(isolated.tempPath), new Set());

    const cancelled = run(bootstrapper, ["--quiet", "--exit-code", "2"], {
      env: isolated.env
    });
    assert.equal(cancelled.status, 2, cancelled.stdout + cancelled.stderr);
    assert.deepEqual(tempInstallerDirectories(isolated.tempPath), new Set());

    const checksum = fs.readFileSync(`${bootstrapper}.sha256.txt`, "utf8").trim();
    assert.match(checksum, /^[a-f0-9]{64}  POPO-Stable-Downloader-0\.7\.5-win-x64\.exe$/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Bootstrapper clearly fails before Setup when TEMP cannot contain a directory", {
  timeout: 120_000
}, (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-bootstrapper-temp-failure-"));
  try {
    const fixture = createFixtureZip(sandbox);
    const bootstrapper = buildBootstrapper(sandbox, fixture);
    const invalidTemp = path.join(sandbox, "not-a-directory");
    fs.writeFileSync(invalidTemp, "file blocks directory creation", "utf8");
    const marker = path.join(sandbox, "must-not-exist.txt");
    const rejected = run(bootstrapper, ["--quiet", "--marker", marker], {
      env: { ...process.env, TEMP: invalidTemp, TMP: invalidTemp }
    });
    assert.equal(rejected.status, 15, rejected.stdout + rejected.stderr);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Bootstrapper retries a transient TEMP root lock and removes the root", {
  timeout: 120_000
}, (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-bootstrapper-retry-"));
  let holderPid = null;
  try {
    const fixture = createFixtureZip(sandbox);
    const bootstrapper = buildBootstrapper(sandbox, fixture);
    const isolated = createIsolatedTemp(sandbox);
    const cwdMarker = path.join(sandbox, "setup-current-directory.txt");
    const holderPidMarker = path.join(sandbox, "holder.pid");
    const launched = run(bootstrapper, [
      "--quiet",
      "--current-directory-marker", cwdMarker,
      "--holder", fixture.holderPath,
      "--hold-milliseconds", "350",
      "--holder-pid-marker", holderPidMarker
    ], { env: isolated.env });
    assert.equal(launched.status, 37, launched.stdout + launched.stderr);
    holderPid = Number(fs.readFileSync(holderPidMarker, "utf8"));
    waitForProcessExit(holderPid);
    holderPid = null;
    assert.deepEqual(tempInstallerDirectories(isolated.tempPath), new Set());
    assert.equal(fs.readFileSync(cwdMarker, "utf8"), sandbox);
    const cleanupLog = fs.readFileSync(
      path.join(isolated.tempPath, "POPO-Bootstrapper-cleanup.log"),
      "utf8"
    );
    assert.match(cleanupLog, /outcome=recovered attempt=[2-8]/);
  } finally {
    if (holderPid !== null) waitForProcessExit(holderPid);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Bootstrapper safely reports a permanent TEMP root lock without changing Setup success or deleting an external path", {
  timeout: 120_000
}, (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-bootstrapper-permanent-lock-"));
  let holderPid = null;
  try {
    const fixture = createFixtureZip(sandbox);
    const bootstrapper = buildBootstrapper(sandbox, fixture);
    const isolated = createIsolatedTemp(sandbox);
    const holderPidMarker = path.join(sandbox, "holder.pid");
    const externalRoot = path.join(sandbox, "POPO-Installer-0123456789abcdef0123456789abcdef");
    const externalSentinel = path.join(externalRoot, "must-survive.txt");
    fs.mkdirSync(externalRoot);
    fs.writeFileSync(externalSentinel, "protected", "utf8");

    const launched = run(bootstrapper, [
      "--quiet",
      "--holder", fixture.holderPath,
      "--hold-milliseconds", "5000",
      "--holder-pid-marker", holderPidMarker,
      "--exit-code", "0"
    ], { env: isolated.env });
    assert.equal(launched.status, 0, launched.stdout + launched.stderr);
    holderPid = Number(fs.readFileSync(holderPidMarker, "utf8"));
    const leftovers = [...tempInstallerDirectories(isolated.tempPath)];
    assert.equal(leftovers.length, 1);
    assert.deepEqual(fs.readdirSync(path.join(isolated.tempPath, leftovers[0])), []);

    const cleanupLog = fs.readFileSync(
      path.join(isolated.tempPath, "POPO-Bootstrapper-cleanup.log"),
      "utf8"
    );
    assert.match(cleanupLog, /outcome=failed attempt=8/);
    assert.match(cleanupLog, /type=System\.IO\.IOException/);
    assert.match(cleanupLog, /hresult=0x80070020 win32=32/);

    waitForProcessExit(holderPid);
    holderPid = null;

    const cleanupInvoker = path.join(sandbox, "CleanupInvoker.exe");
    compileCleanupInvoker(cleanupInvoker);
    const reflectedCleanup = run(cleanupInvoker, [bootstrapper, externalRoot], {
      env: isolated.env
    });
    assert.equal(reflectedCleanup.status, 0, JSON.stringify({
      signal: reflectedCleanup.signal,
      error: reflectedCleanup.error && reflectedCleanup.error.message,
      stdout: reflectedCleanup.stdout,
      stderr: reflectedCleanup.stderr
    }));
    assert.equal(fs.readFileSync(externalSentinel, "utf8"), "protected");
  } finally {
    if (holderPid !== null) waitForProcessExit(holderPid);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Bootstrapper rejects a corrupted embedded ZIP before Setup starts", {
  timeout: 120_000
}, (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-bootstrapper-corrupt-"));
  try {
    const fixture = createFixtureZip(sandbox);
    const bootstrapper = buildBootstrapper(sandbox, fixture);
    const executable = fs.readFileSync(bootstrapper);
    const payload = fs.readFileSync(fixture.zipPath);
    const payloadOffset = executable.indexOf(payload);
    assert.ok(payloadOffset >= 0, "embedded ZIP bytes were not found in the Bootstrapper");
    executable[payloadOffset + Math.floor(payload.length / 2)] ^= 0x01;
    const corruptedPath = path.join(sandbox, "corrupted.exe");
    fs.writeFileSync(corruptedPath, executable);
    const marker = path.join(sandbox, "must-not-exist.txt");
    const isolated = createIsolatedTemp(sandbox);
    const rejected = run(corruptedPath, ["--quiet", "--marker", marker], {
      env: isolated.env
    });
    assert.equal(rejected.status, 11, rejected.stdout + rejected.stderr);
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(tempInstallerDirectories(isolated.tempPath), new Set());
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Bootstrapper rejects a build with no embedded payload resource", {
  timeout: 60_000
}, (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-bootstrapper-missing-"));
  try {
    const source = fs.readFileSync(bootstrapperSource, "utf8")
      .replaceAll("__POPO_PAYLOAD_RESOURCE_NAME__", "POPO.ReleasePayload.zip")
      .replaceAll("__POPO_PAYLOAD_SHA256__", "0".repeat(64))
      .replaceAll("__POPO_PAYLOAD_ROOT_NAME__", "POPO-Stable-Downloader-0.7.5-win-x64");
    const generatedSource = path.join(sandbox, "PopoBootstrapper.generated.cs");
    const executable = path.join(sandbox, "missing-payload.exe");
    fs.writeFileSync(generatedSource, source, "utf8");
    const compiled = run(compiler, [
      "/nologo", "/target:winexe", "/optimize+", "/codepage:65001",
      "/reference:System.Windows.Forms.dll",
      "/reference:System.IO.Compression.dll",
      "/reference:System.IO.Compression.FileSystem.dll",
      `/out:${executable}`,
      generatedSource
    ]);
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const isolated = createIsolatedTemp(sandbox);
    const rejected = run(executable, ["--quiet"], { env: isolated.env });
    assert.equal(rejected.status, 10, rejected.stdout + rejected.stderr);
    assert.deepEqual(tempInstallerDirectories(isolated.tempPath), new Set());
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Bootstrapper build refuses an official ZIP missing required payload files", (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-bootstrapper-incomplete-"));
  try {
    const fixture = createFixtureZip(sandbox);
    const expanded = path.join(sandbox, fixture.packageName);
    fs.rmSync(path.join(expanded, "agent", "bin", "PopoAgent.exe"));
    fs.rmSync(fixture.zipPath);
    const compressed = run("powershell.exe", [
      "-NoProfile", "-Command",
      "Compress-Archive -LiteralPath $env:POPO_TEST_PACKAGE_ROOT -DestinationPath $env:POPO_TEST_ZIP_PATH"
    ], {
      env: { ...process.env, POPO_TEST_PACKAGE_ROOT: expanded, POPO_TEST_ZIP_PATH: fixture.zipPath }
    });
    assert.equal(compressed.status, 0, compressed.stdout + compressed.stderr);
    const outputPath = path.join(sandbox, `${fixture.packageName}.exe`);
    const rejected = run("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", buildScript,
      "-RepoRoot", root,
      "-ZipPath", fixture.zipPath,
      "-Version", "0.7.5",
      "-OutputPath", outputPath
    ]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stdout + rejected.stderr, /missing a Bootstrapper requirement/);
    assert.equal(fs.existsSync(outputPath), false);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
