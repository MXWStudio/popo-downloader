# 正式版自动发布

> 本文只适用于 Stable 正式发布。日常开发和现场验收请使用 `npm run build:dev-package`；Dev 包不会生成或更改腾讯云 `stable/latest.json`。

`.github/workflows/publish-stable.yml` 负责正式版本发布。它仅接受 `vX.Y.Z` 格式的稳定版标签，也可以通过 GitHub Actions 的 `workflow_dispatch` 对已有标签执行恢复发布。

## 首次启用

在 GitHub 仓库的 Actions secrets 中配置：

- `POPO_RELEASE_SIGNING_KEY_BASE64`：正式更新签名私钥 XML 原始字节的 Base64。它必须与 `native-host/FolderPickerHost.cs` 内置的公钥匹配。
- `TENCENT_COS_SECRET_ID`：只用于正式发布的腾讯云 CAM 身份。
- `TENCENT_COS_SECRET_KEY`：上述 CAM 身份的密钥。
- `TENCENT_COS_SESSION_TOKEN`：可选；使用临时凭据时填写。

在 GitHub 仓库的 Actions variables 中配置：

- `POPO_DIAGNOSTIC_DSN`：正式扩展用于自动回传脱敏诊断的官方 Sentry DSN。正式构建和成品验证会拒绝缺少或非官方地址。

腾讯云身份应只授予 `popo-updates-1461466196` 桶中 `stable/*` 对象所需的 `cos:PutObject`、`cos:GetObject` 和 `cos:PutObjectACL`，不要使用主账号永久密钥。带版本号的 `stable/POPO-Stable-Downloader-*.zip` 上传会携带 `x-cos-forbid-overwrite: true`，可只针对这类版本包在 CAM 策略中要求该条件，阻止同名正式包被覆盖；`stable/latest.json` 必须保留覆盖权限，才能切换稳定通道。

## 正常发布

1. 将 `manifest.json`、`package.json`、`package-lock.json` 和 `CHANGELOG.md` 更新为同一个正式版本。
2. 在本地运行 `npm run check:full`。
3. 先把版本提交推送到 `main`，再创建指向该提交的附注标签 `vX.Y.Z` 并推送。
4. 标签推送会自动触发发布流程。

流程会依次完成版本闸门、完整测试、签名打包、GitHub Release 草稿、腾讯云不可变版本包上传和公网回读。只有版本包哈希与大小验证通过后，才会公开 GitHub Release，并最后切换 `stable/latest.json`。

所有正式发布共用一个并发锁；线上版本高于目标版本时会拒绝发布，避免两个标签同时运行或手动恢复旧标签导致稳定通道倒退。

## 失败恢复

- 通过 Actions 页面手动运行 `Publish stable release`，输入原标签即可恢复。
- 已存在的 GitHub Release 资产会被下载并重新校验，不会重新生成另一份正式包。
- 腾讯云上的同名版本包不可覆盖；内容完全一致时直接复用，不一致时立即失败。
- GitHub Release 草稿缺少资产时可以补齐；已经公开的 Release 缺少资产时流程会停止，避免静默改变公开版本。

## 本地命令

```powershell
npm run release:check-version -- -Tag v0.7.2
npm run release:notes -- -Version 0.7.2 -OutputPath release-notes.md
npm run build:release-package -- -ReleaseNotesPath release-notes.md
npm run verify:release-package
```

本地打包默认继续使用 Windows DPAPI 私钥；只有 CI 使用 `POPO_RELEASE_SIGNING_KEY_BASE64`。
