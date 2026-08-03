# POPO 稳定下载助手

面向 `docs.popo.netease.com` 的 Manifest V3 Chrome 扩展。它在 POPO 文件夹行的“三个点”左边增加一个蓝色“稳定下载”按钮，让用户明确选择要下载的文件夹。

## 使用方式

1. 在 POPO 文件夹列表中找到要下载的素材包。
2. 点击该文件夹右侧的蓝色下载按钮。
3. 扩展只读取这个文件夹及其子文件夹。
4. 页面显示“发现 N 个文件，确认下载？”。
5. 用户确认后，扩展把单文件地址交给 Gopeed，以固定任务并发数 5 下载全部文件。

POPO 原来的“三个点 → 下载”保持不变，仍然可以用于服务器打包 ZIP。

## 绿色测试包安装

测试 ZIP 已包含官方 Gopeed v1.9.3 便携版、Windows 本机助手和绿色安装助手。测试者不需要单独安装 Gopeed，也不需要设置 TCP 端口：

1. 解压整个 ZIP。
2. 双击 `POPO-Setup.exe`（绿色版安装助手）。
3. 安装助手自动准备运行目录并打开 Chrome 扩展页和 `Extension` 文件夹。
4. 在 Chrome 点击“加载已解压的扩展程序”，选择该文件夹；添加后立即可用。

绿色安装助手使用固定扩展 ID `coocdgkmbpkacapjlmnmemebmmdahjaa`，安装在当前用户的 `%LOCALAPPDATA%\POPOStableDownloader`，不申请管理员权限、不修改 Chrome 企业策略。

扩展不会改动 Gopeed 的全局保存目录。点击扩展弹窗中的“选择文件夹”可以调用 Windows 系统文件夹选择窗口；路径不能手工输入。每个文件保存到：

`Gopeed默认下载目录/POPO稳定下载/所选文件夹名/原目录结构/文件名`

本机助手负责显示 Windows 文件夹选择窗口，以及启动并发现包内 Gopeed 的本地 API；它不读取 POPO 文件。`native-host\install.ps1` 只保留用于开发调试，普通测试者不需要运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\native-host\install.ps1 -BundledGopeedRoot .\Gopeed
```

## 测试版打包

```powershell
npm run build:test-package
```

输出位于 `dist`，包含测试 ZIP、SHA-256 校验文件和可上传到更新服务的 `latest-beta.json`。

## 稳定下载行为

- 不扫描用户没有选择的其他文件夹。
- 不调用 POPO 文件夹打包。
- 所有文件均通过单文件下载流程处理。
- 使用当前 POPO 页内部的屏幕外工作框架，不创建或显示新标签页。
- 不切换或打断用户当前页面。
- 下载前校验预览标题，避免虚拟列表错位导致下载错文件。
- 同名文件夹和同名文件按被点击行的编号区分。
- 扩展只负责扫描 POPO 并刷新临时下载地址，Gopeed 负责文件传输和真实任务状态。
- Chrome 不再直接建立批量下载，因此不会再出现“下载多个文件”的站点许可拦截。
- 临时地址失效后，扩展重新加载父目录获取新地址，再更新并继续原 Gopeed 任务。
- 每次重试前重新加载父目录并清理页面状态。
- 保留所选文件夹及其内部目录结构。
- 支持暂停、继续、取消、自动重试和失败重试。

## 本地重新加载

修改代码后打开 `chrome://extensions/`，找到“POPO 稳定下载助手”，点击重新加载。

## 验证命令

```powershell
npm test
npm run check
```

Playwright 仅用于自动化验收，不参与扩展运行。
