import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  buildCollisionSafeDownloadFilename,
  buildDownloadFilename
} = require("../core.js");
const {
  buildTaskIdentityLabels,
  classifyTaskStatus,
  getConfig,
  listTasks,
  normalizeDownloadDirectory,
  selectTaskByIdentity,
  splitDownloadTarget,
  startOrReplaceTask
} = require("../gopeed.js");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18790;
const DEFAULT_DOWNLOAD_DIR = "D:\\POPO\\Validation\\FilenameSmoke";
const DOWNLOAD_ROOT = "STEP2-文件名验收";
const JOB_ID = "popo-step2-filename-smoke-v1";

const MP4_BASE64 = "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";
const ZIP_BASE64 = "UEsDBAoAAAAAAB1vIV01wPefKwAAACsAAAAXABwAQVVYLWFyY2hpdmUtcGF5bG9hZC50eHRVVAkAAypplmoraZZqdXgLAAEE9QEAAAQUAAAAUE9QTyBTVEVQIDIgcmVzZXJ2ZWQtbmFtZSBhcmNoaXZlIHBheWxvYWQuClBLAQIeAwoAAAAAAB1vIV01wPefKwAAACsAAAAXABgAAAAAAAEAAACkgQAAAABBVVgtYXJjaGl2ZS1wYXlsb2FkLnR4dFVUBQADKmmWanV4CwABBPUBAAAEFAAAAFBLBQYAAAAAAQABAF0AAAB8AAAAAAA=";

function markedVideo(marker) {
  return Buffer.concat([Buffer.from(MP4_BASE64, "base64"), Buffer.from(`\nPOPO-${marker}\n`)]);
}

const FIXTURES = Object.freeze([
  { id: "reserved-con", name: "CON.txt", body: Buffer.from("POPO STEP 2 reserved fixture: CON.txt\n") },
  { id: "reserved-aux", name: "AUX.zip", body: Buffer.from(ZIP_BASE64, "base64") },
  { id: "reserved-com1", name: "COM1", body: Buffer.from("POPO STEP 2 reserved fixture: COM1\n") },
  { id: "collision-colon", name: "A:B.mp4", body: markedVideo("COLON") },
  { id: "collision-question", name: "A?B.mp4", body: markedVideo("QUESTION") },
  { id: "collision-star", name: "A*B.mp4", body: markedVideo("STAR") },
  { id: "normal-video", name: "正常视频.mp4", body: markedVideo("NORMAL") },
  { id: "normal-zip", name: "normal-file.zip", body: Buffer.from(ZIP_BASE64, "base64") },
  { id: "normal-psd", name: "设计源文件.psd", body: Buffer.from("POPO STEP 2 ordinary fixture: 设计源文件.psd\n") },
  { id: "normal-folder", name: "文件夹内容.txt", directoryPath: ["素材2026"], body: Buffer.from("POPO STEP 2 ordinary folder fixture\n") }
]);

function fixtureMimeType(name) {
  if (/\.mp4$/i.test(name)) return "video/mp4";
  if (/\.zip$/i.test(name)) return "application/zip";
  return "application/octet-stream";
}

export function buildSmokePlan(downloadDir = DEFAULT_DOWNLOAD_DIR) {
  const normalizedDownloadDir = normalizeDownloadDirectory(downloadDir);
  const settings = { downloadRoot: DOWNLOAD_ROOT, preserveStructure: true };
  return FIXTURES.map((fixture) => {
    const item = {
      id: fixture.id,
      name: fixture.name,
      directoryPath: fixture.directoryPath || []
    };
    const occupiedFilenames = FIXTURES
      .filter((candidate) => candidate.id !== fixture.id)
      .map((candidate) => buildDownloadFilename({
        id: candidate.id,
        name: candidate.name,
        directoryPath: candidate.directoryPath || []
      }, settings));
    const relativeFilename = buildCollisionSafeDownloadFilename(item, settings, occupiedFilenames);
    const target = splitDownloadTarget(normalizedDownloadDir, relativeFilename);
    return {
      ...fixture,
      relativeFilename,
      target,
      sha256: createHash("sha256").update(fixture.body).digest("hex")
    };
  });
}

function publicPlan(plan) {
  return plan.map(({ id, name, directoryPath = [], relativeFilename, target, sha256 }) => ({
    id,
    sourceName: name,
    sourceDirectory: directoryPath.join("/"),
    relativeFilename,
    targetPath: target.path,
    targetName: target.name,
    sha256
  }));
}

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length
  });
  response.end(body);
}

function htmlPage(token, plan, downloadDir) {
  const serializedPlan = JSON.stringify(publicPlan(plan)).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>POPO STEP 2 文件名验收站</title>
<style>
body{font-family:system-ui,"Microsoft YaHei",sans-serif;margin:0;background:#0b1220;color:#e8eefb}main{max-width:1080px;margin:40px auto;padding:0 20px}.card{background:#111c2f;border:1px solid #29405f;border-radius:16px;padding:22px;margin:16px 0}h1{margin:0 0 8px}.muted{color:#9eb0c9}button{background:#2f7cf6;color:white;border:0;border-radius:10px;padding:12px 18px;font-weight:700;cursor:pointer}button:disabled{opacity:.5;cursor:wait}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:10px;border-bottom:1px solid #253650;vertical-align:top}code{color:#9ed0ff;word-break:break-all}.ok{color:#70db9b}.bad{color:#ff8f8f}.pending{color:#ffd479}
</style></head><body><main>
<h1>POPO STEP 2 文件名验收站</h1>
<p class="muted">专门验证 Windows 保留名、非法字符碰撞和普通名称不变。页面复用当前产品的 core.js 计算路径，并把任务交给本机 Gopeed。</p>
<div class="card"><div>保存根目录：<code>${downloadDir}</code></div><p class="muted">不会修改 Stable，也不会删除已有文件。重复运行会复用同一测试身份，避免重复建任务。</p><button id="run">开始 STEP 2 下载验收</button> <span id="summary" class="pending">尚未开始</span></div>
<div class="card"><table><thead><tr><th>原名称</th><th>期望相对路径</th><th>状态</th></tr></thead><tbody id="rows"></tbody></table></div>
<div class="card muted">验收范围：文件名算法 + Gopeed + Windows 文件系统。POPO 真页扫描、签名 URL、查重、暂停继续和失败重试仍属于最终 Smoke Test。</div>
<script>
const token=${JSON.stringify(token)};const plan=${serializedPlan};const rows=document.querySelector('#rows');const run=document.querySelector('#run');const summary=document.querySelector('#summary');
function render(states={}){rows.innerHTML=plan.map(x=>{const s=states[x.id]||{};const cls=s.fileExists?'ok':s.status==='failed'?'bad':'pending';const label=s.fileExists?'文件已落盘':(s.status||'等待');return '<tr><td><code>'+escapeHtml(x.sourceName)+'</code></td><td><code>'+escapeHtml(x.relativeFilename)+'</code></td><td class="'+cls+'">'+escapeHtml(label)+'</td></tr>'}).join('')}
function escapeHtml(v){return String(v).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]))}
async function status(){const r=await fetch('/api/status',{cache:'no-store'});const data=await r.json();const map=Object.fromEntries((data.items||[]).map(x=>[x.id,x]));render(map);const done=(data.items||[]).filter(x=>x.fileExists).length;summary.textContent=done+'/'+plan.length+' 个文件已落盘';summary.className=done===plan.length?'ok':'pending';if(done<plan.length)setTimeout(status,1500)}
run.addEventListener('click',async()=>{run.disabled=true;summary.textContent='正在创建 Gopeed 任务…';try{const r=await fetch('/api/run',{method:'POST',headers:{'X-Smoke-Token':token}});const data=await r.json();if(!r.ok)throw new Error(data.error||'启动失败');await status()}catch(e){summary.textContent=e.message;summary.className='bad';run.disabled=false}});render();status().catch(()=>{});
</script></main></body></html>`;
}

async function taskStates(plan, gopeedSettings) {
  let tasks = [];
  try { tasks = await listTasks(gopeedSettings, { timeoutMs: 4000 }); } catch {}
  return plan.map((item) => {
    const labels = buildTaskIdentityLabels({ jobId: JOB_ID, taskIdentity: item.id });
    const selected = selectTaskByIdentity(tasks, labels);
    const diskPath = path.join(item.target.path, item.target.name);
    return {
      id: item.id,
      status: selected.task ? classifyTaskStatus(selected.task.status) : "not_started",
      taskId: selected.task?.id || "",
      fileExists: process.platform === "win32" && existsSync(diskPath),
      diskPath
    };
  });
}

export async function startFilenameSmokeServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = Number(options.port ?? DEFAULT_PORT);
  const downloadDir = normalizeDownloadDirectory(options.downloadDir || process.env.POPO_FILENAME_SMOKE_ROOT || DEFAULT_DOWNLOAD_DIR);
  const gopeedSettings = {
    gopeedEndpoint: options.gopeedEndpoint || process.env.GOPEED_ENDPOINT || "http://127.0.0.1:9999",
    gopeedToken: options.gopeedToken ?? process.env.GOPEED_API_TOKEN ?? ""
  };
  const plan = buildSmokePlan(downloadDir);
  const token = randomBytes(24).toString("hex");
  let origin = "";

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", origin || `http://${host}:${port || DEFAULT_PORT}`);
      if (request.method === "GET" && url.pathname === "/") {
        const body = Buffer.from(htmlPage(token, plan, downloadDir));
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length });
        response.end(body);
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/files/")) {
        const id = decodeURIComponent(url.pathname.slice("/files/".length));
        const fixture = plan.find((item) => item.id === id);
        if (!fixture) return json(response, 404, { error: "测试文件不存在" });
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": fixtureMimeType(fixture.name),
          "Content-Length": fixture.body.length
        });
        response.end(fixture.body);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        return json(response, 200, { items: await taskStates(plan, gopeedSettings) });
      }
      if (request.method === "POST" && url.pathname === "/api/run") {
        if (request.headers["x-smoke-token"] !== token) return json(response, 403, { error: "验收令牌无效" });
        await getConfig(gopeedSettings, { timeoutMs: 5000 });
        const existingTasks = await listTasks(gopeedSettings, { timeoutMs: 5000 });
        const results = [];
        for (const item of plan) {
          const labels = buildTaskIdentityLabels({ jobId: JOB_ID, taskIdentity: item.id });
          const selected = selectTaskByIdentity(existingTasks, labels);
          if (selected.task && ["success", "active", "paused"].includes(classifyTaskStatus(selected.task.status))) {
            results.push({ id: item.id, taskId: selected.task.id, reused: true });
            continue;
          }
          const started = await startOrReplaceTask(gopeedSettings, selected.task?.id || "", {
            url: `${origin}/files/${encodeURIComponent(item.id)}`,
            name: item.target.name,
            path: item.target.path,
            labels
          }, { timeoutMs: 8000 });
          results.push({ id: item.id, taskId: started.taskId, reused: false });
        }
        return json(response, 200, { ok: true, results });
      }
      json(response, 404, { error: "页面不存在" });
    } catch (error) {
      json(response, 500, { error: error?.message || String(error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  origin = `http://${host}:${address.port}`;
  return { server, origin, downloadDir, plan: publicPlan(plan) };
}

const isMain = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "");
if (isMain) {
  const smoke = await startFilenameSmokeServer();
  console.log(`POPO_FILENAME_SMOKE_URL=${smoke.origin}`);
  console.log(`POPO_FILENAME_SMOKE_ROOT=${smoke.downloadDir}`);
  console.log("按 Ctrl+C 停止验收站；已创建的 Gopeed 任务和下载文件会保留用于核对。");
}
