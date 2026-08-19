# POPO 更新代理阶段一实施决策

本文是《POPO 更新链路重构：目标架构与安全迁移方案》的阶段一实施基线。阶段一只建立桥接与影子运行能力，现有扩展定时器、Native Messaging 更新命令和事务安装器仍是正式更新主链路。

## 已定稿决策

### 1. 启动方式与单实例

- `PopoAgent.exe` 固定安装在 `<安装目录>\Agent\PopoAgent.exe`。
- 安装器为当前用户创建“登录时”计划任务，不安装 Windows 服务，不写入 HKLM。
- 安装完成后立即启动 Agent；计划任务和直接启动最终都受同一个“安装目录级”命名互斥体约束。
- 同一安装目录只允许一个 Agent；不同隔离安装目录互不抢占，便于验收和回滚。
- 安装器替换 Agent 前先通过安装目录级退出事件请求旧 Agent 正常退出；切换失败时恢复旧 Agent 目录并重新启动旧 Agent。

### 2. 动态端口与令牌引导

- Agent 只在 `127.0.0.1` 上选择随机高位端口，不监听 `localhost`、IPv6、局域网或所有地址。
- 高强度随机令牌由 Agent 首次启动时生成，以当前 Windows 用户的 DPAPI 加密后保存；令牌不写入端点文件、URL、状态和日志。
- `endpoint.json` 只包含端口、进程、协议和启动时间。
- 扩展通过现有、已限制固定扩展 ID 的 Native Messaging 请求 `agent_connection`；本机助手解密令牌并返回给扩展。
- 本机助手在返回连接信息前同时核对固定 Agent 可执行文件路径、进程 PID、该进程实际监听端口以及协议版本交集；不能只信任端点文件的自述。
- 本机 HTTP 同时要求固定扩展的可信浏览器来源和 `X-Popo-Agent-Token`，包括只读 GET。Chromium 特权扩展请求未发送 `Origin` 时，改用网页脚本不能伪造的 `Sec-Fetch-Site: none`、`Mode: cors`、`Dest: empty` 组合识别；带普通网页 `Origin` 的请求一律拒绝。
- 本机 HTTP 只接受三个固定路径和 `GET`/预检，不提供路径、命令、文件、URL 或更新写操作；损坏令牌会被原子替换，始终由当前用户 DPAPI 加密，并在文件系统允许时额外收紧到当前用户 ACL。

### 3. 更新状态统一

- 不引入独立的 `installed` 状态。程序文件切换完成、等待扩展确认时统一使用 `waiting_for_extension`。
- 阶段一 Agent 只使用 `idle`、`checking`、`available` 和 `failed`；其他状态保留给后续主链路。
- Agent、安装器和扩展沿用同一个事务 ID 字段；阶段一影子检查使用 `shadow-` 前缀，明确它不会触发安装。

### 4. 扩展失败后的真实回滚边界

- Agent 和安装器可以恢复磁盘上的旧 Extension、Agent/NativeHost 和安装状态，但桌面程序不强制关闭、操控或重启 Chrome。
- 如果新扩展未启动或未确认，事务保留回滚快照并进入明确的等待、回滚或修复状态。
- 恢复旧文件后，Chrome 是否立即重新加载取决于浏览器生命周期；系统只承诺“下次 Chrome/扩展启动时恢复”，不承诺桌面程序强制即时生效。
- 阶段一不改变现有扩展重载行为，只记录该边界供阶段二事务确认使用。

### 5. Gopeed 活动状态来源

- Agent 直接定位捆绑的 Gopeed 进程和本机监听端口，并读取 `/api/v1/tasks`；不把扩展报告作为唯一依据。
- `ready`、`wait`、`downloading`、`pause` 等非终态视为忙碌；无法鉴权或无法可靠判断时记为 `unknown`，后续主链路必须按“不可安装”处理。
- 阶段一只观察并写入状态/日志，不暂停、继续、取消或创建 Gopeed 任务。

## 阶段一交付范围

- 固定路径 Agent 与当前用户登录计划任务。
- 启动即检查、每 6 小时影子检查；只读取和验证腾讯云 `stable/latest.json`。
- 复用现有 HTTPS、固定域名与路径、包大小、RSA-SHA256 签名和防降级规则。
- `GET /health`、`GET /version`、`GET /update-status` 三个最小鉴权接口。
- `/version` 从随 Agent 安装且经过安装器一致性校验的组件发布清单读取版本与协议，不把全局安装状态当作 Agent 自身版本。
- `<安装目录>\Updates\state.json`、`<安装目录>\Logs\update.log`、统一事务 ID、原子状态写入和日志轮换/脱敏。
- Native Messaging 的 `agent_connection` 引导能力。
- 安装器将 Agent 纳入候选验证、原子切换和自动回滚；Gopeed 数据保护逻辑保持不变。

## 明确不做

- Agent 不下载 ZIP、不运行安装器、不切换正式目录。
- 不删除或降级旧 `check_update`、`apply_update`、`update_status` 能力。
- 不发布版本、不创建标签、不切换腾讯云稳定通道。
- 不增加托盘程序、Electron、任意文件/命令/URL 接口。

## 阶段一验收门槛

- Agent 只能绑定 `127.0.0.1`，无正确来源或令牌的请求全部拒绝。
- 计划任务、单实例、协议 2/最低协议 1、影子检查、日志脱敏和中断状态恢复有自动测试。
- Agent 不可用、协议不兼容或状态响应不一致时，扩展只记录影子链路不可用并继续使用旧签名更新链路。
- 旧安装能够由新安装器安全加入 Agent；候选切换失败时 Extension、NativeHost、Agent、安装状态和 Gopeed 数据一起恢复。
- `npm run check:full` 通过，并在隔离安装根完成 Agent 启动、状态读取和退出验收。

### 验收命令

- 默认全量验收：`npm run check:full`。
- 安全预检：`npm run test:agent-startup:preflight`。该命令只检查 Windows、Node、任务计划程序、编译器和测试文件是否可用，不创建、修改或删除计划任务。
- 真实登录计划任务验收：`npm run test:agent-startup`。只有这个显式命令才会打开验收门控；不自动提权，也不接受任意命令或路径参数。
- 真实验收要求当前 Windows 会话允许为当前用户创建 `ONLOGON` 任务；测试只使用随机隔离安装目录，回读任务和 Agent 端点，并在 `finally` 中删除测试任务与隔离目录。
- 预检通过只表示环境依赖齐全，不代表登录自启动已经验收；必须由真实验收命令通过，才能关闭这一门槛。

### 跨注销或重启验收

- 查看状态：`npm run test:agent-reboot:status`。该命令只读取固定验收根、任务是否存在和端点时间，不修改系统状态。
- 准备验收：`npm run test:agent-reboot:prepare`。它在当前用户 `%LOCALAPPDATA%\POPO\Acceptance\AgentRebootV1` 创建生产参数编译的隔离 Agent、当前用户最低权限 `ONLOGON` 任务和初始启动证据；不接受外部路径或命令，不自动提权。
- 准备成功后注销并重新登录，或重启 Windows；回到仓库运行 `npm run test:agent-reboot:verify`。
- 验证要求新端点的启动时间晚于准备时间、PID 与准备阶段不同、任务定义仍严格匹配固定 Agent，并重新通过三个令牌鉴权只读接口和日志脱敏检查。
- 验证成功后自动停止 Agent、删除计划任务和整个固定验收根；验证失败时保留证据供重试。若决定取消验收，显式运行 `npm run test:agent-reboot:cleanup`。
- 准备、验证和清理都会修改当前用户计划任务，必须由用户显式执行；`status` 和默认预检不会修改任务。

## 影子诊断与启动定义校验

- 扩展保存版本化的影子对比记录，区分 `matched`、`mismatch`、`shadow_unavailable`、`shadow_failed`、`legacy_failed`、`matched_failure`、`failure_mismatch` 和 `not_comparable`；同时保留原有目标版本和平铺字段，便于旧读取方兼容。
- 扩展额外保留最近 64 次紧凑影子对比历史，用于跨完整正式发布周期核对连续一致性；达到上限后只淘汰最早记录。
- 历史只保留结果类别、目标版本、错误类别、影子事务 ID 和时间，不保存端口、令牌、错误原文、完整路径或任意旧字段；读取旧历史时会重新白名单化并丢弃无效记录。
- 扩展弹窗提供“更新诊断”复制入口；后台只返回版本、状态、错误类别、事务 ID、汇总计数和最多 64 条再次白名单化的时间线，不返回消息原文、令牌、端点或路径。
- 诊断命令只读取本地扩展存储，不会发起影子检查、Native Messaging 调用、下载、安装或任何状态修改。
- 白名单同时约束字段和值：版本只接受数字版本段，状态和错误码只接受阶段一已声明枚举，错误类别由错误码重新推导，事务 ID 必须使用安全字符和 `shadow-` 前缀，时间必须可解析；旧存储把路径、URL、令牌或任意文本塞进合法字段时会被清空。
- `comparable` 与 `matches` 不再信任旧存储布尔值，而是从结果枚举重新推导，避免导出互相矛盾的诊断证据。
- Agent 与旧 Native Host 分别把网络、签名、清单和其他检查失败归入稳定错误码；扩展只按脱敏类别比较，不保存令牌、完整路径或底层异常细节。
- 旧 Native Messaging 在调用层直接断开时，也会先以 `transport` 类别落下本次影子证据，再沿用原有失败处理。
- 新旧目标版本不一致或任一影子诊断异常只形成证据，不改变旧 `check_update` 的正式判断，也不触发 Agent 下载或安装。
- 安装器创建登录任务后读取 Task Scheduler XML，要求唯一 `LogonTrigger`、唯一 `Exec`、`LeastPrivilege`、固定 `PopoAgent.exe` 路径和精确 `--product-root` 参数；仅存在同名任务不再视为注册成功。
- 任务 XML 校验有不修改系统任务的离线自动测试；真实登录自启动和重启验收仍必须在允许创建当前用户 `ONLOGON` 任务的 Windows 环境完成。

## Authenticode 决策

- 2026-08-14 决定不采购商业 Authenticode 证书；Windows 可执行文件正式签名不再作为阶段一、后续发布或更新链路完成的强制门槛。
- 继续强制使用 HTTPS、RSA-SHA256 更新清单签名、ZIP SHA-256、固定腾讯云域名与路径、包大小上限、版本防降级、统一组件清单、固定 Agent 路径、事务安装和自动回滚。
- 外层 RSA 签名用于证明正式发布来源，ZIP 哈希用于证明完整包内容未被替换；两者都不得因为跳过 Authenticode 而删除或降级。
- 已接受的剩余风险：Windows 可能显示“未知发布者”，也无法依靠发布者信誉降低安全软件误报。遇到拦截时只提供固定安装路径、版本、包哈希、重新下载和修复安装说明，不宣称 EXE 已由 Windows 验证发布者。
- 如果未来获得成本可接受的证书或可信签名服务，可把 Authenticode 作为额外纵深防护重新评估，但不得因此阻塞当前迁移阶段。

## 安全软件行为验收

- 查看状态：`npm run test:agent-security:status`。该命令只读取本机已注册的杀毒产品、Microsoft Defender 保护状态、固定验收 Agent 的 SHA-256、可选 Authenticode 状态和与该固定路径关联的检测数量；不会创建目录、执行扫描、修改 Defender 配置或添加排除项。
- 显式扫描：先用 `npm run test:agent-reboot:prepare` 准备固定验收 Agent，再运行 `npm run test:agent-security:scan`。扫描命令不接受路径参数，只会调用 Microsoft Defender 对 `%LOCALAPPDATA%\POPO\Acceptance\AgentRebootV1\Agent\PopoAgent.exe` 执行 `CustomScan`。
- 扫描前后核对固定文件是否存在、SHA-256 是否不变以及是否产生与该固定路径关联的新检测；输出只包含计数和稳定错误码，不输出 Defender 原始资源、用户目录或检测详情。
- 两个命令都不自动提权，不调用 `Set-MpPreference`、`Add-MpPreference`，不改变实时保护、云保护、扫描计划或排除项。Authenticode 只作为状态信息显示，`NotSigned` 不构成失败。
- 该自动入口只覆盖当前机器上的 Microsoft Defender 自定义文件扫描。SmartScreen 下载信誉、实际安装/启动时行为以及第三方安全软件仍需人工验收，不能由此命令宣称已通过。

## 剩余验收入口

- 当前用户计划任务策略只读诊断：`npm run test:agent-startup:diagnose`。
- 一次正式发布周期的本地只读证据核验：`npm run verify:agent-shadow-cycle -- --before <before.json> --after <after.json> --expected-version <x.y.z> --minimum-comparisons 2`。
- ONLOGON、注销/重启、SmartScreen、第三方安全软件和正式发布周期的详细人工步骤见 [POPO 更新 Agent 人工验收手册](UPDATE-AGENT-MANUAL-ACCEPTANCE.md)。
