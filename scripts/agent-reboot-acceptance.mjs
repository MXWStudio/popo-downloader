"use strict";

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const command = process.argv[2] || "status";
const allowedCommands = new Set(["status", "prepare", "verify", "cleanup"]);
const mutatingCommands = new Set(["prepare", "verify", "cleanup"]);
const allowedOrigin = "chrome-extension://coocdgkmbpkacapjlmnmemebmmdahjaa";
const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!allowedCommands.has(command)) {
  throw new Error("Unknown reboot acceptance command.");
}
if (process.platform !== "win32") {
  throw new Error("POPO Agent reboot acceptance requires Windows.");
}
if (mutatingCommands.has(command) && process.env.POPO_AGENT_REBOOT_ACCEPTANCE !== "1") {
  throw new Error("POPO Agent reboot acceptance requires the explicit write gate.");
}

const localAppData = process.env.LOCALAPPDATA;
if (!localAppData || !path.isAbsolute(localAppData)) {
  throw new Error("LOCALAPPDATA is unavailable or invalid.");
}
const localRoot = path.resolve(localAppData);
const acceptanceRoot = path.resolve(localRoot, "POPO", "Acceptance", "AgentRebootV1");
if (!acceptanceRoot.startsWith(localRoot + path.sep) || acceptanceRoot === localRoot) {
  throw new Error("The fixed reboot acceptance root is invalid.");
}

const agentRoot = path.join(acceptanceRoot, "Agent");
const agentExecutable = path.join(agentRoot, "PopoAgent.exe");
const setupExecutable = path.join(acceptanceRoot, "POPO-Setup.exe");
const endpointPath = path.join(agentRoot, "endpoint.json");
const tokenPath = path.join(agentRoot, "auth.token");
const statePath = path.join(acceptanceRoot, "acceptance-state.json");

function startupTaskName() {
  const normalized = acceptanceRoot.replace(/[\\/]$/, "").toUpperCase();
  const suffix = crypto.createHash("sha256").update(Buffer.from(normalized, "utf8"))
    .digest("hex").slice(0, 12).toUpperCase();
  return "POPO Stable Downloader Update Agent " + suffix;
}

function run(executable, args, options = {}) {
  return spawnSync(executable, args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout || 30_000,
    env: options.env || process.env,
    maxBuffer: 2 * 1024 * 1024
  });
}

function requireSuccess(result, message) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(detail ? `${message}: ${detail}` : message);
  }
}

function compileAgent() {
  requireSuccess(run(compiler, [
    "/nologo",
    "/target:winexe",
    "/optimize+",
    "/codepage:65001",
    "/reference:System.Web.Extensions.dll",
    "/reference:System.Security.dll",
    "/out:" + agentExecutable,
    path.join(repoRoot, "agent", "PopoAgent.cs")
  ]), "The reboot acceptance Agent failed to compile");
}

function compileSetup() {
  requireSuccess(run(compiler, [
    "/nologo",
    "/target:winexe",
    "/define:POPO_SETUP_TEST",
    "/optimize+",
    "/codepage:65001",
    "/reference:System.Drawing.dll",
    "/reference:System.Windows.Forms.dll",
    "/reference:System.Web.Extensions.dll",
    "/out:" + setupExecutable,
    path.join(repoRoot, "setup", "PopoSetup.cs")
  ]), "The reboot acceptance setup helper failed to compile");
}

function setupEnvironment() {
  return { ...process.env, POPO_SETUP_TEST_MODE: "1" };
}

function runSetup(args) {
  return run(setupExecutable, args, {
    cwd: acceptanceRoot,
    env: setupEnvironment(),
    timeout: 30_000
  });
}

function setupFailureCode() {
  const errorPath = path.join(acceptanceRoot, "setup-test-error.txt");
  if (!fs.existsSync(errorPath)) return "setup_failed";
  try {
    const detail = fs.readFileSync(errorPath, "utf8");
    if (/access (?:is )?denied|accessdenied|unauthorizedaccessexception|拒绝访问/i.test(detail)) {
      return "access_denied";
    }
    if (/task definition|task xml|logontrigger|leastprivilege/i.test(detail)) {
      return "task_definition_invalid";
    }
    if (/timed out|timeoutexception/i.test(detail)) {
      return "task_scheduler_timeout";
    }
  } catch {}
  return "setup_failed";
}

function requireSetupSuccess(result, message) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${message} (${setupFailureCode()}).`);
  }
}

function taskExists() {
  const result = run("schtasks.exe", ["/Query", "/TN", startupTaskName()]);
  return result.status === 0;
}

function verifyTaskDefinition() {
  if (!fs.existsSync(setupExecutable)) return false;
  const result = runSetup([
    "--test-verify-agent-startup",
    "--install-root", acceptanceRoot
  ]);
  return result.status === 0;
}

function writeJsonAtomic(file, value) {
  const temporary = file + ".tmp-" + crypto.randomUUID().replaceAll("-", "");
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function validateState(value) {
  const preparedAt = Date.parse(value?.preparedAt);
  const initialStartedAt = Date.parse(value?.initialStartedAt);
  if (value?.schemaVersion !== 1 || !Number.isFinite(preparedAt) ||
      !Number.isFinite(initialStartedAt) || !Number.isInteger(value?.initialProcessId) ||
      value.initialProcessId <= 0 || value?.taskName !== startupTaskName()) {
    throw new Error("The reboot acceptance state is invalid.");
  }
  return value;
}

function validateEndpoint(value) {
  if (value?.address !== "127.0.0.1" || !Number.isInteger(value?.port) ||
      value.port < 49152 || value.port > 65535 || !Number.isInteger(value?.processId) ||
      value.processId <= 0 || value?.protocol !== 2 || value?.minimumProtocol !== 1 ||
      !Number.isFinite(Date.parse(value?.startedAt))) {
    throw new Error("The rebooted Agent endpoint metadata is invalid.");
  }
  return value;
}

function waitForFile(file, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    Atomics.wait(waitBuffer, 0, 0, 100);
  }
  throw new Error("The rebooted Agent endpoint did not appear.");
}

function processExecutable(processId) {
  const script = [
    "$processId=[int]$env:POPO_ACCEPTANCE_PID",
    "$process=Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $processId)",
    "if ($null -ne $process) { $process.ExecutablePath }"
  ].join("; ");
  return execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", script
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    env: { ...process.env, POPO_ACCEPTANCE_PID: String(processId) }
  }).trim();
}

function unprotectToken() {
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$encrypted=[IO.File]::ReadAllBytes($env:POPO_AGENT_TOKEN_PATH)",
    "$entropy=[Text.Encoding]::UTF8.GetBytes('POPO agent access token v1')",
    "$plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "try { if ($plain.Length -ne 32) { throw 'Invalid token length.' }; [Convert]::ToBase64String($plain) } finally { [Array]::Clear($plain,0,$plain.Length) }"
  ].join("; ");
  return execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", script
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    env: { ...process.env, POPO_AGENT_TOKEN_PATH: tokenPath }
  }).trim();
}

function request(port, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method: "GET",
      headers,
      timeout: 5_000
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Agent request timed out.")));
    req.on("error", reject);
    req.end();
  });
}

async function verifyAuthenticatedEndpoints(endpoint) {
  if (!fs.existsSync(tokenPath)) throw new Error("The rebooted Agent token is missing.");
  let token = unprotectToken();
  try {
    const headers = { Origin: allowedOrigin, "X-Popo-Agent-Token": token };
    const [health, version, status] = await Promise.all([
      request(endpoint.port, "/health", headers),
      request(endpoint.port, "/version", headers),
      request(endpoint.port, "/update-status", headers)
    ]);
    if (health.status !== 200 || health.body?.ok !== true || health.body?.protocol !== 2) {
      throw new Error("The rebooted Agent health response is invalid.");
    }
    if (version.status !== 200 || version.body?.releaseVersion !== "0.7.2" ||
        version.body?.protocol !== 2 || version.body?.minimumProtocol !== 1) {
      throw new Error("The rebooted Agent version response is invalid.");
    }
    if (status.status !== 200 || status.body?.phase !== "shadow" ||
        !["idle", "checking", "available", "failed"].includes(status.body?.state) ||
        !/^shadow-[A-Za-z0-9._-]+$/.test(status.body?.transactionId || "")) {
      throw new Error("The rebooted Agent status response is invalid.");
    }
    const log = fs.readFileSync(path.join(acceptanceRoot, "Logs", "update.log"), "utf8");
    if (log.includes(token) || log.includes(acceptanceRoot)) {
      throw new Error("The rebooted Agent log contains sensitive acceptance data.");
    }
    return status.body.state;
  } finally {
    token = "";
  }
}

function stopAgent() {
  if (!fs.existsSync(agentExecutable)) return;
  run(agentExecutable, ["--product-root", acceptanceRoot, "--shutdown"], {
    cwd: agentRoot,
    timeout: 10_000
  });
}

function deleteTask() {
  if (!taskExists()) return;
  if (fs.existsSync(setupExecutable)) {
    const deletion = runSetup([
      "--quiet", "--test-delete-agent-startup", "--install-root", acceptanceRoot
    ]);
    requireSuccess(deletion, "The reboot acceptance task could not be removed");
  } else {
    const deletion = run("schtasks.exe", ["/Delete", "/TN", startupTaskName(), "/F"]);
    requireSuccess(deletion, "The orphaned reboot acceptance task could not be removed");
  }
  if (taskExists()) throw new Error("The reboot acceptance task still exists after cleanup.");
}

function cleanupAcceptance() {
  stopAgent();
  deleteTask();
  if (fs.existsSync(acceptanceRoot)) fs.rmSync(acceptanceRoot, { recursive: true, force: true });
  if (fs.existsSync(acceptanceRoot) || taskExists()) {
    throw new Error("The reboot acceptance cleanup did not finish.");
  }
}

async function prepare() {
  if (!fs.existsSync(compiler)) throw new Error("The .NET Framework compiler is unavailable.");
  if (fs.existsSync(acceptanceRoot) || taskExists()) {
    throw new Error("Reboot acceptance state already exists. Verify it or run cleanup first.");
  }
  fs.mkdirSync(agentRoot, { recursive: true });
  fs.writeFileSync(path.join(acceptanceRoot, "install-state.json"), JSON.stringify({ version: "0.7.2" }), "utf8");
  fs.writeFileSync(path.join(agentRoot, "release-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    releaseVersion: "0.7.2",
    agentVersion: "0.7.2",
    updateProtocol: 2,
    minimumProtocol: 1
  }, null, 2), "utf8");
  try {
    compileAgent();
    compileSetup();
    requireSetupSuccess(runSetup([
      "--quiet", "--test-agent-startup", "--install-root", acceptanceRoot
    ]), "The reboot acceptance task could not be prepared");
    waitForFile(endpointPath);
    if (!verifyTaskDefinition()) throw new Error("The reboot acceptance task definition is invalid.");
    const endpoint = validateEndpoint(readJson(endpointPath));
    if (path.resolve(processExecutable(endpoint.processId)) !== path.resolve(agentExecutable)) {
      throw new Error("The prepared Agent process does not use the fixed acceptance executable.");
    }
    const preparedAt = new Date().toISOString();
    writeJsonAtomic(statePath, {
      schemaVersion: 1,
      taskName: startupTaskName(),
      preparedAt,
      initialStartedAt: endpoint.startedAt,
      initialProcessId: endpoint.processId
    });
    console.log(JSON.stringify({
      Ok: true,
      Mode: "reboot-prepare",
      PreparedAt: preparedAt,
      TaskDefinitionValid: true,
      Next: "Sign out and sign in again, or restart Windows, then run npm run test:agent-reboot:verify."
    }));
  } catch (error) {
    try { cleanupAcceptance(); } catch {}
    throw error;
  }
}

async function verify() {
  if (!fs.existsSync(statePath)) throw new Error("No prepared reboot acceptance state was found.");
  const state = validateState(readJson(statePath));
  waitForFile(endpointPath);
  const endpoint = validateEndpoint(readJson(endpointPath));
  if (endpoint.processId === state.initialProcessId || endpoint.startedAt === state.initialStartedAt ||
      Date.parse(endpoint.startedAt) <= Date.parse(state.preparedAt)) {
    throw new Error("A later logon or restart has not been observed yet.");
  }
  if (path.resolve(processExecutable(endpoint.processId)) !== path.resolve(agentExecutable)) {
    throw new Error("The restarted Agent process does not use the fixed acceptance executable.");
  }
  if (!verifyTaskDefinition()) throw new Error("The persisted logon task definition is invalid.");
  const agentState = await verifyAuthenticatedEndpoints(endpoint);
  cleanupAcceptance();
  console.log(JSON.stringify({
    Ok: true,
    Mode: "reboot-verify",
    RestartObserved: true,
    TaskDefinitionValid: true,
    AuthenticatedEndpointsValid: true,
    AgentState: agentState,
    Cleaned: true
  }));
}

function status() {
  const prepared = fs.existsSync(statePath);
  let stateValid = false;
  let restartCandidate = false;
  if (prepared) {
    try {
      const state = validateState(readJson(statePath));
      if (fs.existsSync(endpointPath)) {
        const endpoint = validateEndpoint(readJson(endpointPath));
        restartCandidate = endpoint.processId !== state.initialProcessId &&
          endpoint.startedAt !== state.initialStartedAt &&
          Date.parse(endpoint.startedAt) > Date.parse(state.preparedAt);
      }
      stateValid = true;
    } catch {}
  }
  console.log(JSON.stringify({
    Ok: true,
    Mode: "reboot-status",
    Prepared: prepared,
    StateValid: stateValid,
    TaskExists: taskExists(),
    EndpointExists: fs.existsSync(endpointPath),
    RestartCandidate: restartCandidate,
    MutatedSystemState: false
  }));
}

if (command === "prepare") await prepare();
else if (command === "verify") await verify();
else if (command === "cleanup") {
  cleanupAcceptance();
  console.log(JSON.stringify({ Ok: true, Mode: "reboot-cleanup", Cleaned: true }));
} else status();
