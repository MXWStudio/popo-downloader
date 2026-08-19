# POPO 更新 Agent 人工验收手册

本手册只覆盖自动化无法代替人的验收：当前用户登录自启动、真实注销或重启、SmartScreen、第三方安全软件，以及一次完整正式发布周期的影子对比。它不会授权创建标签、Release、腾讯云发布或切换正式更新主链路；这些动作仍需单独明确授权。

## 共同安全边界

- 阶段一仍以扩展定时器和 Native Messaging 更新器为正式主链路；Agent 只做影子检查。
- 不关闭 Windows 安全功能，不全局放宽 Task Scheduler 权限，不添加杀毒软件排除项，不把任务改成 `SYSTEM` 或最高权限。
- 只使用仓库固定的命令、任务名和验收目录。不要把任意程序、路径、参数或 URL 填进验收命令。
- 每次记录候选文件的 SHA-256、测试机器和系统版本、当前 Windows 用户、测试时间、结果及截图。截图和日志对外分享前应遮住用户名和绝对路径。
- 失败时保持旧更新链路继续可用，不推进到阶段二，也不把“可绕过”当作通过。

## A. 当前用户 ONLOGON 与真实重启

### A1. 先做只读诊断

在实际使用 POPO 的 Windows 用户会话中打开普通 PowerShell：

```powershell
Set-Location -LiteralPath 'D:\Popo下载'
npm run test:agent-startup:diagnose
npm run test:agent-reboot:status
```

诊断不会创建或修改计划任务。只有 `RecommendedAction` 为 `ready_for_acceptance` 时，才直接进入 A3。

### A2. `administrator_policy_change_required` 的处理

当前已观察到的机器状态是：实际 POPO 用户不是本机 Administrators 组成员，当前会话为中等完整性，Task Scheduler 服务正常，但创建当前用户任务被系统策略拒绝。此时必须由机器管理员处理策略，不能由程序偷偷提权。

管理员应遵守以下最小权限要求：

1. 确认任务所属账户就是实际使用 POPO 的 Windows 用户及其 SID，不要用管理员自己的账户代替。
2. 只允许该用户创建、读取、启动和删除自己的 POPO 验收任务；不要放宽整个 Task Scheduler 服务或任务目录 ACL。
3. 任务必须只有一个当前用户 `LogonTrigger` 和一个 `Exec` 动作，运行级别为 `LeastPrivilege`，不能使用 `SYSTEM`、`HighestAvailable` 或存储密码的批处理账户。
4. 动作只能是：
   - 程序：`%LOCALAPPDATA%\POPO\Acceptance\AgentRebootV1\Agent\PopoAgent.exe`
   - 参数：`--product-root "%LOCALAPPDATA%\POPO\Acceptance\AgentRebootV1"`
5. 不要用 `.cmd`、PowerShell 包装器、任意命令行或网络路径代替固定 Agent。
6. 策略处理完毕后，退出管理员账户，回到同一个实际 POPO 用户的普通会话重新运行 A1。任务最终定义仍由仓库验收程序读取 Task Scheduler XML 并严格校验，人工创建一个“看起来相似”的任务不算通过。

如果管理员无法授予上述最小权限，保留现有旧链路，并把该环境记录为 `ONLOGON policy blocked`。

### A3. 准备固定验收环境

```powershell
npm run test:agent-reboot:prepare
```

必须看到成功 JSON，并确认任务定义、三个本机只读接口、日志脱敏和初始 Agent 进程均通过。该命令只使用 `%LOCALAPPDATA%\POPO\Acceptance\AgentRebootV1`，不接受外部路径或任意命令参数。

若准备失败，不要注销或重启。保存完整控制台输出后运行：

```powershell
npm run test:agent-reboot:cleanup
```

### A4. 人工注销或重启

准备成功后，由人执行以下二选一动作：

- 注销当前 Windows 用户，再用同一用户登录；或
- 正常重启 Windows，再用同一用户登录。

不要让自动化强制关闭应用或重启系统。登录后等待桌面完成加载，在同一用户的普通 PowerShell 中运行：

```powershell
Set-Location -LiteralPath 'D:\Popo下载'
npm run test:agent-reboot:verify
```

通过条件：新 Agent 的 PID 与准备阶段不同、启动时间晚于准备时间、任务 XML 仍精确匹配固定定义、三个令牌鉴权只读接口通过、日志无令牌和隐私路径泄露。验证成功会自动停止验收 Agent、删除测试任务并删除固定验收目录。

验证失败时会保留证据以便重试。保存输出；决定放弃本次验收后再显式清理：

```powershell
npm run test:agent-reboot:cleanup
```

最后确认：

```powershell
npm run test:agent-reboot:status
```

预期任务、进程、端点和固定验收目录均不存在。

## B. SmartScreen 下载信誉验收

本地编译文件不能验证真实下载信誉。该项只能在获得一个经明确授权、从正式 HTTPS 域名下载的不可变候选包后执行；未经发布授权时保持待验收。

1. 使用干净的 Windows 虚拟机或可恢复快照，启用最新 Windows Update、Microsoft Defender 和 SmartScreen。
2. 从批准的固定正式域名下载 `latest.json` 和对应 ZIP/安装包。不要先复制到本地共享目录，不要点击“解除锁定”，不要移除 Mark-of-the-Web。
3. 用仓库校验脚本核对 RSA 清单签名、ZIP SHA-256、大小、版本和包内清单；任何一项不一致立即停止：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-release-package.ps1 `
     -ManifestPath 'C:\验收下载\latest.json' `
     -PackagePath 'C:\验收下载\POPO-<版本>.zip'
   ```
4. 在文件属性中确认文件来自互联网区域，然后启动候选安装程序，记录实际结果：无提示、未知发布者警告、SmartScreen 阻止或安全软件隔离。
5. 因本项目明确跳过 Authenticode，“未知发布者”属于已接受的展示风险，但仍必须保证 RSA 和 ZIP 哈希校验通过。“仍要运行”只允许在隔离测试机、哈希已核对且来源域名正确时由人工选择；不得全局关闭 SmartScreen。
6. 完成安装、启动、影子检查、修复安装和失败回滚验证。确认旧正式更新链路仍可用，Gopeed 数据未修改或丢失。
7. 恢复虚拟机快照，不把测试包当成正式发布留给普通用户。

建议证据至少包含：下载 URL、下载时间、`latest.json` SHA-256、ZIP SHA-256、程序 SHA-256、Windows 版本、SmartScreen 提示截图、用户选择和最终回滚结果。

## C. 第三方安全软件兼容验收

每种安全软件使用独立干净快照，先更新引擎和病毒库，全程不加排除项。

1. 记录产品名、产品版本、病毒库版本和 Windows 版本。
2. 分别扫描发布 ZIP、解压后的 `PopoAgent.exe`、Native Host 和安装程序。
3. 正常安装并启动 Agent，等待至少两次影子检查；执行一次修复安装和一次故意失败的候选切换，确认事务回滚。
4. 观察是否发生阻止、隔离、删除、网络拦截或异常 CPU/磁盘占用，并记录发生阶段和候选文件 SHA-256。
5. 若出现检测，立即停止该产品上的验收，不要关闭防护或盲目恢复。保留检测名称和哈希，向该厂商提交误报样本；在厂商解除或项目作出明确风险决定前继续保留旧主链路。
6. 每个产品结束后恢复快照。至少覆盖实际用户环境中占比最高的产品；未测试产品不能写成“兼容”。

通过条件是：无隔离或阻断、文件哈希保持不变、Agent 只监听 `127.0.0.1`、影子检查不触发安装、修复和回滚后旧链路仍正常。

## D. 一次完整正式发布周期的影子证据

该项必须等待下一次被单独授权的正式发布。当前开发不能为了验收而创建标签、Release 或上传腾讯云。

### D1. 发布前证据

在扩展弹窗点击“更新诊断”，复制 JSON 原文，保存为只读的 `before.json`。记录当前扩展版本、旧链路目标版本和 Agent 协议。不要手工编辑 JSON。

### D2. 发布后证据

完成一次经授权的正式发布后，让正常扩展定时器和 Agent 影子检查自然运行。至少形成两条新的对比记录，并覆盖一次关闭再打开 Chrome 和一次普通下载使用场景。再次复制“更新诊断”JSON，保存为 `after.json`。

### D3. 本地只读核验

```powershell
npm run verify:agent-shadow-cycle -- `
  --before 'C:\验收证据\before.json' `
  --after 'C:\验收证据\after.json' `
  --expected-version '0.7.3' `
  --minimum-comparisons 2
```

把 `0.7.3` 换成该次真实发布版本。校验器只读取两个不超过 1 MiB 的 JSON 文件，不联网、不写文件、不修改扩展或 Agent 状态；输出只包含结果、计数和两份证据的 SHA-256。

通过条件：发布后产品版本和 Agent 协议符合阶段一合同，发布前后时间顺序正确，新周期至少有指定数量记录，且新记录全部为 `matched`，新旧目标版本都等于期望版本，事务 ID 和更新时间完整。出现 `mismatch`、任一失败、不可用、旧目标版本或证据摘要不一致都必须停止迁移并调查，不能把旧记录手工删掉后重试。

## 验收记录模板

```text
验收项目：
日期和时区：
测试人员：
机器/虚拟机：
Windows 版本：
实际 POPO 用户：
候选版本：
候选 SHA-256：
安全软件及病毒库版本：
执行命令或人工动作：
预期结果：
实际结果：
截图/日志位置：
清理或快照恢复结果：
结论：通过 / 失败 / 被策略阻止 / 尚未具备发布条件
后续负责人和动作：
```

## 当前仍必须人工完成的项目

- 管理员按最小权限解决实际 POPO 用户创建自身 ONLOGON 任务的策略限制，然后由该用户完成真实注销或重启验收。
- 获得下一次正式候选包和下载 URL 的单独发布授权后，执行 SmartScreen 验收。
- 在实际用户采用的第三方安全软件环境中执行兼容验收。
- 在一次完整、单独授权的正式发布周期结束后，收集发布前后诊断证据并运行影子周期核验器。

以上四项之外，阶段一可自动实现和验证的开发内容均应由仓库测试覆盖；任何人工项未通过都不影响旧主链路继续工作，但会阻止切换到后续阶段。
