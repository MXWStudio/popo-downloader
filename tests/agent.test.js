"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");

const repoRoot = path.join(__dirname, "..");
const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const allowedOrigin = "chrome-extension://coocdgkmbpkacapjlmnmemebmmdahjaa";

function setupTestEnvironment(sandbox) {
  const suffix = crypto.createHash("sha256")
    .update(path.resolve(sandbox).toUpperCase(), "utf8")
    .digest("hex").slice(0, 24);
  return {
    ...process.env,
    POPO_SETUP_TEST_MODE: "1",
    POPO_SETUP_TEST_REGISTRY_ROOT: `Software\\POPOSetupTests\\Agent_${suffix}`
  };
}

function cleanupSetupTestRegistry(environment) {
  const registryRoot = environment.POPO_SETUP_TEST_REGISTRY_ROOT;
  if (!registryRoot) return;
  spawnSync("reg.exe", ["delete", `HKCU\\${registryRoot}`, "/f"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000
  });
}

function compileAgent(output) {
  const result = spawnSync(compiler, [
    "/nologo",
    "/target:winexe",
    "/define:POPO_AGENT_TEST",
    "/optimize+",
    "/codepage:65001",
    "/reference:System.Web.Extensions.dll",
    "/reference:System.Security.dll",
    "/out:" + output,
    path.join(repoRoot, "agent", "PopoAgent.cs")
  ], { cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function compileNativeHost(output) {
  const result = spawnSync(compiler, [
    "/nologo",
    "/target:winexe",
    "/optimize+",
    "/codepage:65001",
    "/reference:System.Windows.Forms.dll",
    "/reference:System.Drawing.dll",
    "/reference:System.IO.Compression.dll",
    "/reference:System.IO.Compression.FileSystem.dll",
    "/reference:System.Web.Extensions.dll",
    "/out:" + output,
    path.join(repoRoot, "native-host", "FolderPickerHost.cs")
  ], { cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function invokeNativeHost(executable, message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(payload.length, 0);
  const result = spawnSync(executable, [], {
    cwd: path.dirname(executable),
    input: Buffer.concat([length, payload]),
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024
  });
  assert.ok(result.status === 0 || result.status === 1, String(result.stderr || ""));
  assert.ok(result.stdout.length >= 4, String(result.stderr || ""));
  const responseLength = result.stdout.readUInt32LE(0);
  assert.equal(result.stdout.length, responseLength + 4);
  return JSON.parse(result.stdout.subarray(4).toString("utf8"));
}

test("native host verifies that a completed task file still exists with the expected size", (t) => {
  if (process.platform !== "win32") {
    t.skip("Native Host executable verification is Windows-only");
    return;
  }
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "popo-native-file-check-"));
  try {
    const executable = path.join(temporaryRoot, "PopoFolderPickerHost.exe");
    compileNativeHost(executable);
    const expectedSize = fs.statSync(__filename).size;
    const response = invokeNativeHost(executable, {
      action: "verify_files",
      files: [
        { key: "present", path: __filename, expectedSize },
        { key: "missing", path: path.join(temporaryRoot, "missing.bin"), expectedSize: 10 }
      ]
    });
    assert.equal(response.ok, true);
    assert.deepEqual(response.files, [
      { key: "present", exists: true, size: expectedSize, sizeMatches: true },
      { key: "missing", exists: false, size: 0, sizeMatches: false }
    ]);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("native host refuses to auto-start Gopeed while setup maintenance is active", (t) => {
  if (process.platform !== "win32") {
    t.skip("Native Host maintenance handling is Windows-only");
    return;
  }
  const productRoot = fs.mkdtempSync(path.join(os.tmpdir(), "popo-native-maintenance-"));
  try {
    const nativeRoot = path.join(productRoot, "NativeHost");
    const updatesRoot = path.join(productRoot, "Updates");
    fs.mkdirSync(nativeRoot, { recursive: true });
    fs.mkdirSync(updatesRoot, { recursive: true });
    fs.writeFileSync(path.join(productRoot, "install-state.json"), "{}", "utf8");
    fs.writeFileSync(path.join(updatesRoot, "maintenance.json"), JSON.stringify({
      schemaVersion: 1,
      processId: process.pid,
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }), "utf8");
    const executable = path.join(nativeRoot, "PopoFolderPickerHost.exe");
    compileNativeHost(executable);
    const response = invokeNativeHost(executable, { action: "ensure_gopeed" });
    assert.equal(response.ok, false);
    assert.equal(response.maintenance, true);
    assert.equal(response.retryable, true);
    assert.match(response.error, /安装或修复/);
  } finally {
    fs.rmSync(productRoot, { recursive: true, force: true });
  }
});

function writeAgentReleaseManifest(agentRoot, version = "0.7.2") {
  fs.writeFileSync(path.join(agentRoot, "release-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    releaseVersion: version,
    agentVersion: version,
    updateProtocol: 2,
    minimumProtocol: 1
  }, null, 2), "utf8");
}

function compileSetup(output) {
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
  ], { cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function startupTaskName(installRoot) {
  const normalized = path.resolve(installRoot).replace(/[\\/]$/, "").toUpperCase();
  const suffix = crypto.createHash("sha256").update(Buffer.from(normalized, "utf8"))
    .digest("hex").slice(0, 12).toUpperCase();
  return "POPO Stable Downloader Update Agent " + suffix;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function dpapiUnprotect(file) {
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$encrypted=[IO.File]::ReadAllBytes($env:POPO_AGENT_TOKEN_PATH)",
    "$entropy=[Text.Encoding]::UTF8.GetBytes('POPO agent access token v1')",
    "$plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "try {[Convert]::ToBase64String($plain)} finally {[Array]::Clear($plain,0,$plain.Length)}"
  ].join("; ");
  return execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", script
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    env: { ...process.env, POPO_AGENT_TOKEN_PATH: file }
  }).trim();
}

function request(port, pathname, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers,
      timeout: 3_000
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: body ? JSON.parse(body) : null
      }));
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function waitForFile(file, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for " + file);
}

async function waitForJsonFile(file, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (predicate(value)) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for updated JSON in " + file);
}

test("fixed agent exposes only authenticated loopback shadow status and remains single-instance", {
  timeout: 120_000
}, async (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-agent-test-"));
  const agentRoot = path.join(sandbox, "Agent");
  const updatesRoot = path.join(sandbox, "Updates");
  const logsRoot = path.join(sandbox, "Logs");
  const executable = path.join(agentRoot, "PopoAgent.exe");
  const manifestPath = path.join(sandbox, "signed-latest.json");
  fs.mkdirSync(agentRoot, { recursive: true });
  fs.mkdirSync(updatesRoot, { recursive: true });
  fs.mkdirSync(logsRoot, { recursive: true });
  fs.writeFileSync(path.join(sandbox, "install-state.json"), JSON.stringify({ version: "0.7.2" }), "utf8");
  writeAgentReleaseManifest(agentRoot);
  compileAgent(executable);

  const online = path.join(repoRoot, "dist", "latest.json");
  if (fs.existsSync(online)) {
    fs.copyFileSync(online, manifestPath);
  } else {
    fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 0 }), "utf8");
  }

  const args = ["--product-root", sandbox, "--test-manifest", manifestPath];
  const agent = spawn(executable, args, {
    cwd: agentRoot,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, POPO_AGENT_TEST_MODE: "1" }
  });
  try {
    const endpointFile = path.join(agentRoot, "endpoint.json");
    const tokenFile = path.join(agentRoot, "auth.token");
    await waitForFile(endpointFile);
    await waitForFile(tokenFile);
    const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8"));
    assert.equal(endpoint.address, "127.0.0.1");
    assert.ok(endpoint.port >= 49152 && endpoint.port <= 65535);
    assert.equal(endpoint.protocol, 2);
    assert.equal(endpoint.minimumProtocol, 1);
    assert.equal(Object.hasOwn(endpoint, "token"), false);

    const noOrigin = await request(endpoint.port, "/health");
    assert.equal(noOrigin.status, 403);
    const noToken = await request(endpoint.port, "/health", { Origin: allowedOrigin });
    assert.equal(noToken.status, 401);
    const wrongOrigin = await request(endpoint.port, "/health", {
      Origin: "https://example.com",
      "X-Popo-Agent-Token": "wrong"
    });
    assert.equal(wrongOrigin.status, 403);
    const unknownPath = await request(endpoint.port, "/arbitrary-file", {
      Origin: allowedOrigin
    });
    assert.equal(unknownPath.status, 404);

    const token = dpapiUnprotect(tokenFile);
    assert.ok(token.length >= 40);
    const headers = { Origin: allowedOrigin, "X-Popo-Agent-Token": token };
    const health = await request(endpoint.port, "/health", headers);
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.protocol, 2);
    assert.equal(health.headers["access-control-allow-origin"], allowedOrigin);
    const chromiumExtensionHealth = await request(endpoint.port, "/health", {
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      "X-Popo-Agent-Token": token
    });
    assert.equal(chromiumExtensionHealth.status, 200);
    assert.equal(chromiumExtensionHealth.body.ok, true);
    const version = await request(endpoint.port, "/version", headers);
    assert.equal(version.status, 200);
    assert.equal(version.body.releaseVersion, "0.7.2");
    const status = await request(endpoint.port, "/update-status", headers);
    assert.equal(status.status, 200);
    assert.equal(status.body.phase, "shadow");
    assert.match(status.body.transactionId, /^shadow-/);
    assert.ok(["idle", "available", "failed"].includes(status.body.state));
    const writeAttempt = await request(endpoint.port, "/update-status", headers, "POST");
    assert.equal(writeAttempt.status, 405);

    const second = spawnSync(executable, ["--product-root", sandbox], {
      cwd: agentRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000
    });
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.equal(JSON.parse(fs.readFileSync(endpointFile, "utf8")).processId, agent.pid);

    const log = fs.readFileSync(path.join(logsRoot, "update.log"), "utf8");
    assert.equal(log.includes(token), false);
    assert.equal(log.includes(sandbox), false);
    assert.doesNotMatch(log, /X-Popo-Agent-Token\s*[:=]\s*[A-Za-z0-9+/=_-]{16,}/i);
  } finally {
    spawnSync(executable, ["--product-root", sandbox, "--shutdown"], {
      cwd: agentRoot,
      windowsHide: true,
      timeout: 5_000
    });
    await Promise.race([
      new Promise((resolve) => agent.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000))
    ]);
    if (agent.exitCode === null) agent.kill();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("agent replaces a damaged encrypted token and restores authenticated access", {
  timeout: 60_000
}, async (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-agent-token-recovery-"));
  const agentRoot = path.join(sandbox, "Agent");
  const executable = path.join(agentRoot, "PopoAgent.exe");
  fs.mkdirSync(agentRoot, { recursive: true });
  fs.writeFileSync(path.join(sandbox, "install-state.json"), JSON.stringify({ version: "0.7.2" }), "utf8");
  fs.writeFileSync(path.join(agentRoot, "auth.token"), "not-dpapi", "utf8");
  writeAgentReleaseManifest(agentRoot);
  compileAgent(executable);
  const agent = spawn(executable, ["--product-root", sandbox], {
    cwd: agentRoot,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      POPO_AGENT_TEST_MODE: "1",
      POPO_AGENT_TEST_DENY_TOKEN_ACL: "1"
    }
  });
  try {
    const endpointFile = path.join(agentRoot, "endpoint.json");
    const tokenFile = path.join(agentRoot, "auth.token");
    await waitForFile(endpointFile);
    const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8"));
    const token = dpapiUnprotect(tokenFile);
    assert.ok(token.length >= 40);
    const health = await request(endpoint.port, "/health", {
      Origin: allowedOrigin,
      "X-Popo-Agent-Token": token
    });
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    const log = fs.readFileSync(path.join(sandbox, "Logs", "update.log"), "utf8");
    assert.match(log, /AGENT_TOKEN_RECOVERED/);
    assert.match(log, /AGENT_TOKEN_ACL_UNAVAILABLE/);
    assert.equal(log.includes("not-dpapi"), false);
  } finally {
    spawnSync(executable, ["--product-root", sandbox, "--shutdown"], {
      cwd: agentRoot,
      windowsHide: true,
      timeout: 5_000
    });
    await Promise.race([
      new Promise((resolve) => agent.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000))
    ]);
    if (agent.exitCode === null) agent.kill();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("native host returns only a compatible endpoint owned by the fixed agent process", {
  timeout: 120_000
}, async (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-agent-bootstrap-"));
  const agentRoot = path.join(sandbox, "Agent");
  const nativeRoot = path.join(sandbox, "NativeHost");
  const agentExecutable = path.join(agentRoot, "PopoAgent.exe");
  const nativeExecutable = path.join(nativeRoot, "PopoFolderPickerHost.exe");
  fs.mkdirSync(agentRoot, { recursive: true });
  fs.mkdirSync(nativeRoot, { recursive: true });
  fs.writeFileSync(path.join(sandbox, "install-state.json"), JSON.stringify({ version: "0.7.2" }), "utf8");
  writeAgentReleaseManifest(agentRoot);
  compileAgent(agentExecutable);
  compileNativeHost(nativeExecutable);
  const agent = spawn(agentExecutable, ["--product-root", sandbox], {
    cwd: agentRoot,
    windowsHide: true,
    stdio: "ignore"
  });
  try {
    const endpointFile = path.join(agentRoot, "endpoint.json");
    await waitForFile(endpointFile);
    const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8"));
    const connection = invokeNativeHost(nativeExecutable, { action: "agent_connection" });
    assert.equal(connection.ok, true, connection.error);
    assert.equal(connection.endpoint, "http://127.0.0.1:" + endpoint.port);
    assert.equal(connection.protocol, 2);
    assert.equal(connection.minimumProtocol, 1);
    assert.equal(connection.token, dpapiUnprotect(path.join(agentRoot, "auth.token")));

    endpoint.port = endpoint.port === 65535 ? 65534 : endpoint.port + 1;
    fs.writeFileSync(endpointFile, JSON.stringify(endpoint), "utf8");
    const tampered = invokeNativeHost(nativeExecutable, { action: "agent_connection" });
    assert.equal(tampered.ok, false);
    assert.match(tampered.error, /endpoint does not belong to its process/);
  } finally {
    spawnSync(agentExecutable, ["--product-root", sandbox, "--shutdown"], {
      cwd: agentRoot,
      windowsHide: true,
      timeout: 5_000
    });
    await Promise.race([
      new Promise((resolve) => agent.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000))
    ]);
    if (agent.exitCode === null) agent.kill();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("native host rejects a stale endpoint after an agent crash and accepts the restarted agent", {
  timeout: 120_000
}, async (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-agent-crash-recovery-"));
  const agentRoot = path.join(sandbox, "Agent");
  const nativeRoot = path.join(sandbox, "NativeHost");
  const agentExecutable = path.join(agentRoot, "PopoAgent.exe");
  const nativeExecutable = path.join(nativeRoot, "PopoFolderPickerHost.exe");
  const endpointFile = path.join(agentRoot, "endpoint.json");
  const invalidManifest = path.join(sandbox, "invalid-latest.json");
  fs.mkdirSync(agentRoot, { recursive: true });
  fs.mkdirSync(nativeRoot, { recursive: true });
  fs.writeFileSync(path.join(sandbox, "install-state.json"), JSON.stringify({ version: "0.7.2" }), "utf8");
  fs.writeFileSync(invalidManifest, JSON.stringify({ schemaVersion: 0 }), "utf8");
  writeAgentReleaseManifest(agentRoot);
  compileAgent(agentExecutable);
  compileNativeHost(nativeExecutable);
  const args = ["--product-root", sandbox, "--test-manifest", invalidManifest];
  let agent = spawn(agentExecutable, args, {
    cwd: agentRoot,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, POPO_AGENT_TEST_MODE: "1" }
  });
  try {
    const firstEndpoint = await waitForJsonFile(
      endpointFile,
      (value) => value.processId === agent.pid
    );
    const firstConnection = invokeNativeHost(nativeExecutable, { action: "agent_connection" });
    assert.equal(firstConnection.ok, true, firstConnection.error);

    agent.kill();
    await new Promise((resolve) => agent.once("exit", resolve));
    assert.ok(fs.existsSync(endpointFile));
    assert.equal(JSON.parse(fs.readFileSync(endpointFile, "utf8")).processId, firstEndpoint.processId);
    const stale = invokeNativeHost(nativeExecutable, { action: "agent_connection" });
    assert.equal(stale.ok, false);

    agent = spawn(agentExecutable, args, {
      cwd: agentRoot,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, POPO_AGENT_TEST_MODE: "1" }
    });
    const restartedEndpoint = await waitForJsonFile(
      endpointFile,
      (value) => value.processId === agent.pid && value.processId !== firstEndpoint.processId
    );
    const restarted = invokeNativeHost(nativeExecutable, { action: "agent_connection" });
    assert.equal(restarted.ok, true, restarted.error);
    assert.equal(restarted.endpoint, "http://127.0.0.1:" + restartedEndpoint.port);
    assert.equal(restarted.protocol, 2);
    const health = await request(restartedEndpoint.port, "/health", {
      Origin: allowedOrigin,
      "X-Popo-Agent-Token": restarted.token
    });
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
  } finally {
    if (agent?.exitCode === null) {
      spawnSync(agentExecutable, ["--product-root", sandbox, "--shutdown"], {
        cwd: agentRoot,
        windowsHide: true,
        timeout: 5_000
      });
      await Promise.race([
        new Promise((resolve) => agent.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000))
      ]);
    }
    if (agent?.exitCode === null) agent.kill();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("agent recovers an interrupted checking state before the next shadow check", {
  timeout: 60_000
}, (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-agent-recovery-"));
  const agentRoot = path.join(sandbox, "Agent");
  const updatesRoot = path.join(sandbox, "Updates");
  fs.mkdirSync(agentRoot, { recursive: true });
  fs.mkdirSync(updatesRoot, { recursive: true });
  fs.writeFileSync(path.join(sandbox, "install-state.json"), JSON.stringify({ version: "0.7.2" }), "utf8");
  writeAgentReleaseManifest(agentRoot);
  fs.writeFileSync(path.join(updatesRoot, "state.json"), JSON.stringify({
    state: "checking",
    currentVersion: "0.7.2",
    targetVersion: "",
    transactionId: "shadow-interrupted"
  }), "utf8");
  const executable = path.join(agentRoot, "PopoAgent.exe");
  compileAgent(executable);
  const fakeSecret = "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
  const invalidManifest = path.join(sandbox, "token=" + fakeSecret + ".json");
  try {
    const result = spawnSync(executable, [
      "--product-root", sandbox,
      "--once",
      "--test-manifest", invalidManifest
    ], {
      cwd: agentRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, POPO_AGENT_TEST_MODE: "1" }
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const state = JSON.parse(fs.readFileSync(path.join(updatesRoot, "state.json"), "utf8"));
    assert.equal(state.state, "failed");
    assert.equal(state.errorCode, "SHADOW_CHECK_FAILED");
    const log = fs.readFileSync(path.join(sandbox, "Logs", "update.log"), "utf8");
    assert.match(log, /INTERRUPTED_SHADOW_CHECK/);
    assert.match(log, /SHADOW_CHECK_FAILED/);
    const messages = log.trim().split(/\r?\n/).map((line) => JSON.parse(line).message).join("\n");
    assert.match(messages, /<install-root>/);
    assert.match(messages, /<redacted>/);
    assert.equal(log.includes(sandbox), false);
    assert.equal(log.includes(fakeSecret), false);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("agent exposes a stable signature failure code for shadow comparison", {
  timeout: 60_000
}, (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-agent-signature-"));
  const agentRoot = path.join(sandbox, "Agent");
  const updatesRoot = path.join(sandbox, "Updates");
  const tamperedManifest = path.join(sandbox, "latest-tampered.json");
  fs.mkdirSync(agentRoot, { recursive: true });
  fs.mkdirSync(updatesRoot, { recursive: true });
  fs.writeFileSync(path.join(sandbox, "install-state.json"), JSON.stringify({ version: "0.7.2" }), "utf8");
  writeAgentReleaseManifest(agentRoot);
  const manifest = {
    schemaVersion: 1,
    channel: "stable",
    version: "0.7.3",
    chromeVersion: "0.7.3",
    publishedAt: "2026-08-14T00:00:00.000Z",
    artifact: "POPO-Stable-Downloader-v0.7.3.zip",
    url: "https://popo-updates-1461466196.cos.ap-guangzhou.myqcloud.com/stable/POPO-Stable-Downloader-v0.7.3.zip",
    sha256: "0".repeat(64),
    size: 1024,
    signature: Buffer.alloc(384).toString("base64")
  };
  fs.writeFileSync(tamperedManifest, JSON.stringify(manifest), "utf8");
  const executable = path.join(agentRoot, "PopoAgent.exe");
  compileAgent(executable);
  try {
    const result = spawnSync(executable, [
      "--product-root", sandbox,
      "--once",
      "--test-manifest", tamperedManifest
    ], {
      cwd: agentRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, POPO_AGENT_TEST_MODE: "1" }
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const state = JSON.parse(fs.readFileSync(path.join(updatesRoot, "state.json"), "utf8"));
    assert.equal(state.state, "failed");
    assert.equal(state.errorCode, "SHADOW_SIGNATURE_INVALID");
    const log = fs.readFileSync(path.join(sandbox, "Logs", "update.log"), "utf8");
    assert.match(log, /SHADOW_SIGNATURE_INVALID/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("agent classifies Gopeed activity itself without an extension status report", {
  timeout: 60_000
}, (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-agent-gopeed-"));
  const agentRoot = path.join(sandbox, "Agent");
  const updatesRoot = path.join(sandbox, "Updates");
  fs.mkdirSync(agentRoot, { recursive: true });
  fs.mkdirSync(updatesRoot, { recursive: true });
  fs.writeFileSync(path.join(sandbox, "install-state.json"), JSON.stringify({ version: "0.7.2" }), "utf8");
  writeAgentReleaseManifest(agentRoot);
  const tasksFile = path.join(sandbox, "gopeed-tasks.json");
  fs.writeFileSync(tasksFile, JSON.stringify({
    code: 0,
    data: [
      { id: "active", status: "running" },
      { id: "paused", status: "pause" },
      { id: "done", status: "done" }
    ]
  }), "utf8");
  const executable = path.join(agentRoot, "PopoAgent.exe");
  compileAgent(executable);
  try {
    const result = spawnSync(executable, [
      "--product-root", sandbox,
      "--test-observe-gopeed",
      "--test-gopeed-tasks", tasksFile
    ], {
      cwd: agentRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, POPO_AGENT_TEST_MODE: "1" }
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const state = JSON.parse(fs.readFileSync(path.join(updatesRoot, "state.json"), "utf8"));
    assert.equal(state.gopeed.status, "busy");
    assert.equal(state.gopeed.busy, true);
    assert.equal(state.gopeed.activeTasks, 2);
    assert.equal(state.gopeed.processId, 4242);
    assert.equal(state.gopeed.port, 54321);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("installer accepts only the fixed least-privilege logon task definition", {
  timeout: 60_000
}, (t) => {
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-agent-startup-xml-"));
  const setupExecutable = path.join(sandbox, "POPO-Setup.exe");
  const validXmlPath = path.join(sandbox, "valid-task.xml");
  const wrongCommandXmlPath = path.join(sandbox, "wrong-command-task.xml");
  const extraTriggerXmlPath = path.join(sandbox, "extra-trigger-task.xml");
  const wrongUserXmlPath = path.join(sandbox, "wrong-user-task.xml");
  const expectedAgent = path.join(sandbox, "Agent", "PopoAgent.exe");
  const currentUserSid = execFileSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"
  ], { encoding: "utf8", windowsHide: true, timeout: 15_000 }).trim();
  const taskXml = ({ command = expectedAgent, extraTrigger = "", userId = currentUserSid } = {}) => [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `<Principals><Principal id="Author"><UserId>${escapeXml(userId)}</UserId>`,
    "<RunLevel>LeastPrivilege</RunLevel></Principal></Principals>",
    `<Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger>${extraTrigger}</Triggers>`,
    `<Actions Context="Author"><Exec><Command>${escapeXml(command)}</Command>`,
    `<Arguments>--product-root &quot;${escapeXml(sandbox)}&quot;</Arguments></Exec></Actions>`,
    "</Task>"
  ].join("");
  fs.writeFileSync(validXmlPath, taskXml(), "utf8");
  fs.writeFileSync(wrongCommandXmlPath, taskXml({ command: "C:\\Windows\\System32\\cmd.exe" }), "utf8");
  fs.writeFileSync(extraTriggerXmlPath, taskXml({ extraTrigger: "<TimeTrigger />" }), "utf8");
  fs.writeFileSync(wrongUserXmlPath, taskXml({ userId: "S-1-5-18" }), "utf8");
  compileSetup(setupExecutable);
  const testEnv = setupTestEnvironment(sandbox);
  const validate = (xmlPath) => spawnSync(setupExecutable, [
    "--test-validate-agent-startup-xml", xmlPath,
    "--install-root", sandbox
  ], {
    cwd: sandbox,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    env: testEnv
  });
  try {
    const valid = validate(validXmlPath);
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    assert.equal(validate(wrongCommandXmlPath).status, 2);
    assert.equal(validate(extraTriggerXmlPath).status, 2);
    assert.equal(validate(wrongUserXmlPath).status, 2);
    const missingTask = spawnSync(setupExecutable, [
      "--test-verify-agent-startup", "--install-root", sandbox
    ], {
      cwd: sandbox,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      env: testEnv
    });
    assert.equal(missingTask.status, 2, missingTask.stdout + missingTask.stderr);
  } finally {
    cleanupSetupTestRegistry(testEnv);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("installer registers, reads back, starts and removes the per-install logon task", {
  timeout: 120_000
}, async (t) => {
  if (process.env.POPO_AGENT_STARTUP_ACCEPTANCE !== "1") {
    t.skip("set POPO_AGENT_STARTUP_ACCEPTANCE=1 for Windows startup acceptance");
    return;
  }
  if (!fs.existsSync(compiler)) {
    t.skip("Windows .NET Framework compiler is unavailable");
    return;
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "popo-agent-startup-"));
  const agentRoot = path.join(sandbox, "Agent");
  const agentExecutable = path.join(agentRoot, "PopoAgent.exe");
  const setupExecutable = path.join(sandbox, "POPO-Setup.exe");
  const taskName = startupTaskName(sandbox);
  fs.mkdirSync(agentRoot, { recursive: true });
  fs.writeFileSync(path.join(sandbox, "install-state.json"), JSON.stringify({ version: "0.7.2" }), "utf8");
  writeAgentReleaseManifest(agentRoot);
  compileAgent(agentExecutable);
  compileSetup(setupExecutable);
  const testEnv = setupTestEnvironment(sandbox);
  try {
    const install = spawnSync(setupExecutable, [
      "--quiet", "--test-agent-startup", "--install-root", sandbox
    ], {
      cwd: sandbox,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      env: testEnv
    });
    const setupError = path.join(sandbox, "setup-test-error.txt");
    assert.equal(
      install.status,
      0,
      install.stdout + install.stderr + (fs.existsSync(setupError) ? fs.readFileSync(setupError, "utf8") : "")
    );
    await waitForFile(path.join(agentRoot, "endpoint.json"));
    const query = spawnSync("schtasks.exe", ["/Query", "/TN", taskName, "/FO", "LIST", "/V"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000
    });
    assert.equal(query.status, 0, query.stdout + query.stderr);
    assert.match(query.stdout, /POPO Stable Downloader Update Agent/);
    assert.ok(query.stdout.toUpperCase().includes(path.resolve(agentExecutable).toUpperCase()));
  } finally {
    spawnSync(setupExecutable, [
      "--quiet", "--test-delete-agent-startup", "--install-root", sandbox
    ], {
      cwd: sandbox,
      windowsHide: true,
      timeout: 30_000,
      env: testEnv
    });
    const query = spawnSync("schtasks.exe", ["/Query", "/TN", taskName], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000
    });
    cleanupSetupTestRegistry(testEnv);
    assert.notEqual(query.status, 0);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
