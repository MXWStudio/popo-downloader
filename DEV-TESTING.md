# POPO Dev 绿色版

此包只用于开发、问题复现和真实 POPO 页面验收，不是正式发布包。

- 运行 `POPO-Dev-Setup.exe`，安装到独立的 `POPODevDownloader` 目录。
- 在 Chrome 扩展管理页加载安装目录内的 `Extension` 文件夹。
- Dev 扩展名称为“POPO Dev 下载助手”，扩展 ID 为 `folfhehnopknchpoaajfpboibbhnlanf`。
- Dev 使用独立 Native Messaging Host、更新 Agent、Gopeed 数据和安装状态，不覆盖正式绿色版。
- Dev 已停用腾讯云 stable 自动更新，也不会生成或切换 `stable/latest.json`。
- 日常开发和现场复测使用 Dev；只有正式候选发布和 stable 自动升级验收才使用正式绿色版。

构建命令：

```powershell
npm run build:dev-package
```

正式包必须使用：

```powershell
npm run build:release-package
```
