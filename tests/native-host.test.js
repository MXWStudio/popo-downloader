"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("本机助手只提供系统文件夹选择并使用 Native Messaging 二进制协议", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "native-host", "FolderPickerHost.cs"),
    "utf8"
  );
  assert.match(source, /FolderBrowserDialog/);
  assert.match(source, /String\.Equals\(action, "ping"/);
  assert.match(source, /String\.Equals\(action, "ensure_gopeed"/);
  assert.match(source, /String\.Equals\(action, "agent_connection"/);
  assert.match(source, /String\.Equals\(action, "check_update"/);
  assert.match(source, /String\.Equals\(action, "apply_update"/);
  assert.match(source, /String\.Equals\(action, "update_status"/);
  assert.match(source, /UpdateSigningPublicKeyBase64/);
  assert.match(source, /VerifyData/);
  assert.match(source, /ClassifyUpdateCheckError/);
  assert.match(source, /LEGACY_NETWORK_ERROR/);
  assert.match(source, /LEGACY_SIGNATURE_INVALID/);
  assert.match(source, /LEGACY_MANIFEST_INVALID/);
  assert.match(source, /SHA-256/);
  assert.match(source, /ProtectedData\.Unprotect/);
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /AgentProtocolVersion < minimumProtocol/);
  assert.match(source, /FindListeningPorts\(processId\)\.Contains\(port\)/);
  assert.match(source, /ZipArchive/);
  assert.match(source, /--apply-update/);
  assert.match(source, /Process\.Start/);
  assert.match(source, /FindListeningPorts/);
  assert.match(source, /\/api\/v1\/config/);
  assert.match(source, /Console\.OpenStandardInput/);
  assert.match(source, /BitConverter\.ToInt32/);
  assert.match(source, /BitConverter\.GetBytes/);
  assert.doesNotMatch(source, /HttpClient|WebClient/);
});

test("安装脚本把当前扩展 ID 写入允许来源并注册到当前用户", () => {
  const installer = fs.readFileSync(
    path.join(__dirname, "..", "native-host", "install.ps1"),
    "utf8"
  );
  assert.match(installer, /allowed_origins/);
  assert.match(installer, /chrome-extension:\/\/\$ExtensionId\//);
  assert.match(installer, /Chrome extension ID was not found/);
  assert.match(installer, /Secure Preferences/);
  assert.match(installer, /BundledGopeedRoot/);
  assert.match(installer, /Join-Path \$InstallRoot 'Gopeed'/);
  assert.match(installer, /HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts/);
  assert.doesNotMatch(installer, /HKEY_LOCAL_MACHINE|HKLM:/);
});
