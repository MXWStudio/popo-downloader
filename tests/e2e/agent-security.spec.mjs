import { chromium, expect, test } from "@playwright/test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const fixedExtensionId = "coocdgkmbpkacapjlmnmemebmmdahjaa";
const extensionEntries = [
  "manifest.json",
  "background.js",
  "content.js",
  "core.js",
  "gopeed.js",
  "page-api.js",
  "popup.css",
  "popup.html",
  "queue.js",
  "assets",
  "runtime/popo-runtime.js",
  "runtime/popup.js",
  "runtime/page-ui.js"
];

async function copyExtension(extensionRoot) {
  await mkdir(extensionRoot, { recursive: true });
  for (const entry of extensionEntries) {
    const destination = resolve(extensionRoot, entry);
    await mkdir(dirname(destination), { recursive: true });
    await cp(resolve(projectRoot, entry), destination, { recursive: true });
  }
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
    resolve(projectRoot, "agent", "PopoAgent.cs")
  ], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}

function unprotectToken(tokenPath) {
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$encrypted=[IO.File]::ReadAllBytes($env:POPO_AGENT_TOKEN_PATH)",
    "$entropy=[Text.Encoding]::UTF8.GetBytes('POPO agent access token v1')",
    "$plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "try {[Convert]::ToBase64String($plain)} finally {[Array]::Clear($plain,0,$plain.Length)}"
  ].join("; ");
  return spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", script
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    env: { ...process.env, POPO_AGENT_TOKEN_PATH: tokenPath }
  }).stdout.trim();
}

async function waitForJson(file, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (predicate(value)) return value;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("Timed out waiting for " + file);
}

test("ordinary pages cannot read the agent while the fixed extension can", async () => {
  test.skip(process.platform !== "win32" || !existsSync(compiler), "Windows .NET Framework compiler is required");
  const sandbox = await mkdtemp(join(tmpdir(), "popo-agent-browser-security-"));
  const agentRoot = join(sandbox, "Agent");
  const extensionRoot = join(sandbox, "extension");
  const profileRoot = join(sandbox, "profile");
  const agentExecutable = join(agentRoot, "PopoAgent.exe");
  const endpointPath = join(agentRoot, "endpoint.json");
  const invalidManifest = join(sandbox, "invalid-latest.json");
  let context;
  let agent;
  try {
    await mkdir(agentRoot, { recursive: true });
    await copyExtension(extensionRoot);
    await writeFile(join(sandbox, "install-state.json"), JSON.stringify({ version: "0.7.2" }), "utf8");
    await writeFile(invalidManifest, JSON.stringify({ schemaVersion: 0 }), "utf8");
    await writeFile(join(agentRoot, "release-manifest.json"), JSON.stringify({
      schemaVersion: 1,
      releaseVersion: "0.7.2",
      agentVersion: "0.7.2",
      updateProtocol: 2,
      minimumProtocol: 1
    }, null, 2), "utf8");
    compileAgent(agentExecutable);
    agent = spawn(agentExecutable, [
      "--product-root", sandbox,
      "--test-manifest", invalidManifest
    ], {
      cwd: agentRoot,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, POPO_AGENT_TEST_MODE: "1" }
    });
    const endpoint = await waitForJson(endpointPath, (value) => value.processId === agent.pid);
    const token = unprotectToken(join(agentRoot, "auth.token"));
    expect(token.length).toBeGreaterThanOrEqual(40);

    context = await chromium.launchPersistentContext(profileRoot, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionRoot}`,
        `--load-extension=${extensionRoot}`
      ]
    });
    const existingWorker = context.serviceWorkers()
      .find((worker) => worker.url().startsWith("chrome-extension://"));
    const worker = existingWorker || await context.waitForEvent("serviceworker", {
      predicate: (candidate) => candidate.url().startsWith("chrome-extension://")
    });
    const extensionId = new URL(worker.url()).host;
    expect(extensionId).toBe(fixedExtensionId);
    const healthUrl = `http://127.0.0.1:${endpoint.port}/health`;

    const attacker = await context.newPage();
    await attacker.route("https://attacker.example/**", (route) => route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>attacker</title>"
    }));
    await attacker.goto("https://attacker.example/probe");
    const attackerResult = await attacker.evaluate(async ({ url, stolenToken }) => {
      try {
        const response = await fetch(url, {
          headers: { "X-Popo-Agent-Token": stolenToken },
          cache: "no-store"
        });
        return { readable: true, status: response.status, body: await response.text() };
      } catch (error) {
        return { readable: false, error: String(error) };
      }
    }, { url: healthUrl, stolenToken: token });
    expect(attackerResult.readable).toBe(false);

    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/popup.html`);
    const extensionResult = await extensionPage.evaluate(async ({ url, accessToken }) => {
      const response = await fetch(url, {
        headers: { "X-Popo-Agent-Token": accessToken },
        cache: "no-store"
      });
      return {
        status: response.status,
        body: await response.text(),
        allowOrigin: response.headers.get("access-control-allow-origin")
      };
    }, { url: healthUrl, accessToken: token });
    expect(extensionResult.status, JSON.stringify(extensionResult)).toBe(200);
    const extensionHealth = JSON.parse(extensionResult.body);
    expect(extensionResult.allowOrigin).toBe(`chrome-extension://${fixedExtensionId}`);
    expect(extensionHealth.ok).toBe(true);
    expect(extensionHealth.protocol).toBe(2);

    const noToken = await extensionPage.evaluate(async (url) => {
      const response = await fetch(url, { cache: "no-store" });
      return { status: response.status, body: await response.text() };
    }, healthUrl);
    expect(noToken).toEqual({ status: 401, body: "" });
  } finally {
    if (context) await context.close().catch(() => {});
    if (agent?.exitCode === null) {
      spawnSync(agentExecutable, ["--product-root", sandbox, "--shutdown"], {
        cwd: agentRoot,
        windowsHide: true,
        timeout: 5_000
      });
      await Promise.race([
        new Promise((resolveExit) => agent.once("exit", resolveExit)),
        new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))
      ]);
    }
    if (agent?.exitCode === null) agent.kill();
    await rm(sandbox, { recursive: true, force: true });
  }
});
