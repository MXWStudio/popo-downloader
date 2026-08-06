# POPO 稳定下载助手

面向 `docs.popo.netease.com` 的 Manifest V3 Chrome 扩展。它在 POPO 文件夹行的“三个点”左边增加一个蓝色“稳定下载”按钮，让用户明确选择要下载的文件夹。

## 使用方式

1. 在 POPO 文件夹列表中找到要下载的素材包。
2. 可以连续点击 2–3 个母文件夹右侧的蓝色下载按钮。
3. 扩展按点击顺序排队，只读取被选择的文件夹及其子文件夹。
4. 每个文件夹页会在“按照目录顺序”左侧显示当前目录第一层的项目总数（文件 + 文件夹）。
5. 点击下载后直接加入队列，不再弹出数量确认；递归扫描完成后以固定任务并发数 5 把单文件地址交给 Gopeed。

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
- 支持多个母文件夹排队，同一文件夹重复点击不会创建重复任务。
- 每个任务都能取消未开始文件；已经开始的 Gopeed 文件保留并继续完成。
- 页面左下角和扩展弹窗同步显示任务、项目数量和处理进度。
- 页面项目数使用 POPO 虚拟列表的行号和占位信息计算，不滚动或打断用户正在看的列表。
- 不调用 POPO 文件夹打包。
- 所选文件夹及其子文件夹中的全部用户文件，不区分扩展名或关键词，均通过单文件下载流程处理；仅忽略系统自动生成的元数据文件。
- 使用当前 POPO 页内部的屏幕外工作框架，不创建或显示新标签页。
- 不切换或打断用户当前页面。
- 下载前校验预览标题，避免虚拟列表错位导致下载错文件。
- 同名文件夹和同名文件按被点击行的编号区分。
- 扩展只负责扫描 POPO 并刷新临时下载地址，Gopeed 负责文件传输和真实任务状态。
- 扩展会先把页面中的团队空间短码解析为下载接口要求的真实 ID；接口短暂未返回地址时自动重试。
- Chrome 不再直接建立批量下载，因此不会再出现“下载多个文件”的站点许可拦截。
- 临时地址失效后，扩展重新加载父目录获取新地址，再更新并继续原 Gopeed 任务。
- 如果原 Gopeed 任务已被删除，扩展会自动新建任务接续下载。
- 每次重试前重新加载父目录并清理页面状态。
- 保留所选文件夹及其内部目录结构。
- 支持暂停、继续、取消未开始文件、自动重试和失败重试。

## 本地重新加载

首次检出代码或依赖发生变化后，先生成扩展运行文件：

```powershell
npm ci
npm run build:runtime
```

修改代码后打开 `chrome://extensions/`，找到“POPO 稳定下载助手”，点击重新加载。

## 验证命令

```powershell
npm test
npm run check
npm run test:e2e
npm run check:full
```

`check:full` 会依次执行 TypeScript/Zod/XState/Gopeed SDK 契约测试、IndexedDB 万级任务测试、MSW 断网恢复测试、安装器回滚测试和 Playwright 临时浏览器恢复测试。Playwright 与 MSW 仅用于自动化验收，不参与扩展运行。

## 稳定性基础设施

- P0：使用 Gopeed 官方 SDK 处理任务接口，Zod 校验命令和返回数据，XState 约束扫描、下载、暂停、恢复和结束状态迁移。
- P1：使用 IndexedDB + idb 保存大任务文件明细；Playwright + MSW 验证刷新、浏览器重启和 Gopeed 断网恢复；绿色安装器采用 Velopack 的候选版本校验与失败回滚模式。
- 用户可见界面统一由 React + TypeScript 渲染：右上弹窗负责完整管理，左下任务条只保留持续摘要，右下仅提示完成、失败和服务断开等一次性事件。
- POPO 是 Chrome 扩展而不是常驻桌面应用，因此没有直接嵌入 Velopack 运行库；安装器保留固定的 `Extension` 路径，并实现相同的“完整候选目录 → 校验 → 切换 → 失败恢复旧目录”事务语义。
