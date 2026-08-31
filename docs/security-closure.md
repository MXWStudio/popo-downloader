# POPO 安全整改收口

本轮安全整改只包含以下三项，完成验收后不继续扩展新的加固范围。

1. Gopeed 与本机代理边界
   - 随包 Gopeed 1.9.3 不提供可验证的 REST Token 服务端能力，因此不写入“有 Token”这种虚假结论。
   - 本机助手只识别随包 `gopeed.exe` 的真实进程，只接受 `127.0.0.1` 或 `::1` 回环监听；其他 Gopeed 进程、全网卡监听和伪装的本机代理一律拒绝。
2. 下载 URL 白名单与页面来源检查
   - 下载地址只接受 HTTPS 的 `*.s3v2.nie.netease.com`，拒绝账号信息、非 443 自定义端口和其他域名。
   - 发起文件夹、页面下载和工作 Frame 注册的命令必须来自 `https://docs.popo.netease.com` 页面，并且来源页面与命令必须属于同一团队空间。
3. 正式发布 Runner 隔离
   - Build Runner 完成完整测试、签名构建和包校验，只持有签名密钥。
   - Publish Runner 只接收已校验的候选 Artifact，再次校验后发布，只持有 GitHub/COS 发布权限，不运行源码测试或签名构建。

收口验收：自动化测试全部通过，Windows Remote 验证通过，Dev 同步完成后执行固定浏览器 Smoke。Stable 在日常 Dev 验证中保持只读。
