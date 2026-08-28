# POPO macOS 开发接手说明

## 接手基线

- 工作分支：`main`。
- 写入本文档前的源码基线：`4e3c229bd60dd46b82e760586f8c3d1abfe4d552`。
- 最终接手提交是包含本文档的 `main` 提交；Mac 拉取后以 `git rev-parse HEAD` 为准，并与 Windows 迁移报告中的 `SOURCE_COMMIT` 完全一致。
- Windows 收口时没有待提交的生产源码、测试或脚本改动；本次新增内容仅为这份迁移接手说明。当前基线已经包含下载文件扩展名保留修复，以及安装候选路径长度约束修复。

## 依赖与环境

- 依赖锁文件：`package-lock.json`，使用 `npm ci` 安装。
- Windows 收口验证环境：Node.js `v24.18.0`、npm `11.16.0`、pnpm `11.18.0`、Windows PowerShell `5.1.22621.4391`。
- 项目实际依赖管理使用 npm；pnpm 不是本仓库安装或验证的必要条件。
- CI 的正式发布工作流使用 Node.js 24。Mac 应使用 Node.js 24，并保留 `package-lock.json` 的锁定结果。

Mac 首次接手建议依次运行：

```bash
npm ci
npm run check
npm test
npm run test:e2e
```

`npm run check:full` 等价于依次执行检查、Node 测试和 Playwright 测试，也可用于一次性基础验收。平台限定测试在非 Windows 环境应按测试自身条件跳过；若出现非预期失败，停止并保留完整输出，不要为了通过测试替换 Windows 工具链。

Windows 收口验证结果（2026-08-28）：`npm run check:full` 通过。其中 Node 测试共 215 项，214 项通过；1 项需要显式启用的真实登录计划任务验收按预期跳过。Playwright 7 项全部通过。此次迁移没有构建 Dev/Stable 安装包，也没有启动发布流程。

## Windows 专属工作

以下工作继续在 Windows 机器完成，不迁到 Mac：

- Native Host、Agent、安装器、Bootstrapper 和 Dev/Stable 安装包的编译、构建与验证。
- 安装、覆盖升级、修复、迁移、回滚、计划任务、注册表和 Native Messaging 注册验收。
- 包内 Gopeed 联动、真实 POPO 页面下载、真实 Windows 文件夹选择器和 Windows 路径边界验收。
- `npm run dev:extension:sync`；该命令固定同步到 Windows Dev 测试目录。
- `npm run build:dev-package`、发布候选安装验收及正式发布相关命令。

普通 Extension JavaScript、CSS 或 HTML 修改不需要重建安装器。修改后先在仓库运行相关测试，再由 Windows 执行 `npm run dev:extension:sync`，确认 Dev manifest 和扩展身份，然后在 Chrome 重新加载“POPO Dev 下载助手”并刷新 POPO 页面。

## 当前边界与停止条件

- 当前没有已知的跨平台源码迁移阻断。
- 安装候选路径过长问题已在当前基线修复并补充回归测试，不再作为当前阻断。
- Native Host/Agent/安装器当前仍依赖 Windows 自带的 .NET Framework 编译器。先前评估的固定 `Microsoft.Net.Compilers.Toolset 5.9.0` 候选没有通过官方 Native Host 的 PE/IL 一致性 Gate F，因此不是获准替代工具链；Mac 不应自行替换编译器或绕过该 Gate。
- 本轮迁移不执行发布、不打 Tag、不修改腾讯云文件，也不删除或清理 Windows 仓库、正式安装和测试环境。
- Mac 如果存在未提交改动、出现 detached HEAD、冲突或与远端发生不明分叉，应立即停止；不要自动 stash、强制重置或删除内容。
- Windows 专属现场验收不是 Mac 基础接手的通过条件，但相关改动在交付前仍必须回到 Windows 完成对应验证。

## Windows 现场测试说明

- Extension 源码以 Git 工作树为唯一来源。
- Dev 扩展和 Stable 扩展必须保持隔离；不得把 Dev 内容覆盖到 Stable 安装目录。
- 真实页面验收前，先完成相关自动测试和 Dev 同步，再由用户在 Chrome 手动重新加载 Dev 扩展并刷新 POPO 页面。
- Native Host、Agent、安装器或注册配置发生变化时才重建 Dev 包；最终发布验收前才执行 Stable 发布流程。
