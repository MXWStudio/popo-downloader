"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "publish-stable.yml"), "utf8");
const buildScript = fs.readFileSync(path.join(root, "scripts", "build-test-package.ps1"), "utf8");
const cosPublisher = fs.readFileSync(path.join(root, "scripts", "publish-cos-object.py"), "utf8");

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
});

test("release package signing supports GitHub Actions without removing local DPAPI support", () => {
  assert.match(buildScript, /POPO_RELEASE_SIGNING_KEY_BASE64/);
  assert.match(buildScript, /FromBase64String/);
  assert.match(buildScript, /ProtectedData/);
  assert.match(buildScript, /ReleaseNotesPath/);
  assert.match(buildScript, /Remove-Item Env:POPO_RELEASE_SIGNING_KEY_BASE64/);
  assert.match(buildScript, /SkipRuntimeBuild/);
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
