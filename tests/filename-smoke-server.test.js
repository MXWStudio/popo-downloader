const assert = require("node:assert/strict");
const test = require("node:test");

async function loadSmokeModule() {
  return import("../scripts/filename-smoke-server.mjs");
}

test("STEP 2 验收站复用产品算法生成保留名与稳定碰撞路径", async () => {
  const { buildSmokePlan } = await loadSmokeModule();
  const plan = buildSmokePlan("D:\\POPO\\Validation\\FilenameSmoke");
  const bySource = new Map(plan.map((item) => [item.name, item]));

  assert.equal(bySource.get("CON.txt").target.name, "_CON.txt");
  assert.equal(bySource.get("AUX.zip").target.name, "_AUX.zip");
  assert.equal(bySource.get("COM1").target.name, "_COM1");
  assert.equal(bySource.get("正常视频.mp4").target.name, "正常视频.mp4");
  assert.equal(bySource.get("normal-file.zip").target.name, "normal-file.zip");
  assert.equal(bySource.get("设计源文件.psd").target.name, "设计源文件.psd");
  assert.match(bySource.get("文件夹内容.txt").target.path, /素材2026$/);

  const collisionNames = ["A:B.mp4", "A?B.mp4", "A*B.mp4"].map((name) => bySource.get(name).target.name);
  assert.equal(new Set(collisionNames.map((name) => name.toLowerCase())).size, 3);
  for (const name of collisionNames) assert.match(name, /^A_B~[0-9a-f]{8}\.mp4$/);

  assert.equal(new Set(plan.map((item) => item.relativeFilename.toLowerCase())).size, plan.length);
  assert.equal(new Set(plan.filter((item) => item.name.endsWith(".mp4")).map((item) => item.sha256)).size, 4);
});

test("STEP 2 验收站只监听本机并提供预置文件，不需要人工上传", async (t) => {
  const { startFilenameSmokeServer } = await loadSmokeModule();
  const smoke = await startFilenameSmokeServer({ port: 0 });
  t.after(() => new Promise((resolve) => smoke.server.close(resolve)));

  assert.match(smoke.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const page = await fetch(smoke.origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /POPO STEP 2 文件名验收站/);

  const fixture = await fetch(`${smoke.origin}/files/collision-colon`);
  assert.equal(fixture.status, 200);
  assert.equal(fixture.headers.get("content-type"), "video/mp4");
  assert.ok((await fixture.arrayBuffer()).byteLength > 2000);

  const missing = await fetch(`${smoke.origin}/files/not-found`);
  assert.equal(missing.status, 404);
});
