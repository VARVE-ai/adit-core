# Token 用量采集与独立对账

本目录提供只保存 usage 的 HTTPS 代理扩展、云端导出脚本和独立对账脚本。生产采集通过 ADIT Hook 读取会话日志，不要求长期运行代理。

## 当前能力与边界

| 来源 | 行为 |
| --- | --- |
| Claude 主会话日志的 `message.id` / `message.usage` | 按响应标识记录和修订用量 |
| Codex 日志的 `token_usage_record` | 按 `payload.response_id` 记录 `payload.usage` |
| Codex 旧版 `token_count` | 仅作为非累加观察值，不当作独立请求、不计入请求合计 |
| 未提供 usage、日志损坏或边界不完整 | 保留未知或缺口，不填零、不估算 |
| 独立子代理日志、客户端不可见的服务端重试 | 不承诺完整覆盖；应在真实客户端验收时单独核对 |

Codex 协议结构已对照官方源码中的 `RolloutItemWire::TokenUsageRecord` 和 `TokenUsageRecord` 核对，但不能据此推断所有已安装版本都输出该记录。字段存在不等于已完成真实账号准确性验收。

只从本版本第一次用户提问建立的读取位置向后采集。首次只遇到 Stop 的已有会话不会导入历史。新记录及修订通过 `token_usage` 类型的内部事件复用现有同步游标；Cloud 将其写入独立明细表，不显示为普通聊天事件。

日志按事件发生时间归属日期；日志没有时间时使用采集时间。不把这个时间冒充网络请求开始时间。缺口记录保持保守审计标记，即使后续收到迟到的数据，也不自动证明之前没有漏采。

## 部署顺序

1. 先部署配套 Cloud：迁移数据库、生成 Prisma Client、构建并重启服务。
2. 再发布或安装本分支构建的 Core CLI，确认 Hook 使用的是新版本。
3. 从新一轮提问开始检查用量；不回填旧会话。

```powershell
pnpm build
```

仅在工作区执行构建不会自动更新机器上已安装的 `adit` 或 `adit-hook`，也不会切换其他工作区的 CLI。

## 安装校验工具

以下命令在 Core 仓库根目录执行。测试环境为 Python 3.14、mitmproxy 12.2.3。

```powershell
python -m venv tools/token-usage/.venv
tools/token-usage/.venv/Scripts/python.exe -m pip install -r tools/token-usage/requirements.txt
New-Item -ItemType Directory -Force tools/token-usage/output
```

Linux/macOS 使用虚拟环境下的 `bin/python` 和 `bin/mitmdump`。

## 启动校验代理

将示例主机名替换为实际模型 API 主机。使用精确主机白名单，不匹配所有流量。

```powershell
tools/token-usage/.venv/Scripts/mitmdump.exe `
  --listen-host 127.0.0.1 --listen-port 18080 `
  -s tools/token-usage/capture.py `
  --set "confdir=tools/token-usage/output/proxy-config" `
  --set "usage_hosts=api.openai.com,api.anthropic.com" `
  --set "usage_output=tools/token-usage/output/capture.jsonl" `
  --set flow_detail=0 --set termlog_verbosity=error
```

- 仅为测试客户端配置代理及对应 CA 信任，不配置系统全局代理，不关闭 TLS 验证。
- 实际客户端对代理、证书及传输协议的支持需要确认。不支持时停止测试并记录限制，不绕过安全校验。
- 扩展支持 POST `/responses` 和 `/messages` 路径后缀的 JSON / SSE 响应；不宣称支持 WebSocket、其他接口或任意中转自定义协议。
- 为便于逐帧校验，匹配请求的 `Accept-Encoding` 被设为 `identity`；服务端仍返回压缩编码时标记不可完整核验。
- 不使用 mitmproxy 的完整流量转储选项。扩展不持久化请求正文、响应正文、Authorization、Cookie 或密钥。
- 代理运行过程中仍能接触解密内容，限本机使用；请求/响应标识也属于应保护的元数据。
- 证据文件包含 `scope`、`started` 和 `finished` 记录。启动记录保留主机白名单；只有开始、没有结束的请求会在对账时列为不完整。
- 不要合并不同测试窗口的文件。测试结束后恢复客户端代理/信任配置，按需清理 `output` 内证据及测试证书。

## 导出 Cloud 用量

先停止产生新调用并等待 ADIT 同步完成，再导出同一会话和时间范围。访问令牌只通过环境变量读取，不放进命令参数、URL 或文档。

```powershell
tools/token-usage/.venv/Scripts/python.exe tools/token-usage/export_cloud.py `
  --server https://your-adit-server.example `
  --session YOUR_CLOUD_SESSION_ID `
  --date-from 2026-09-15 --date-to 2026-09-15 --time-zone Asia/Shanghai `
  --output tools/token-usage/output/adit.json
```

运行前在当前进程环境中安全提供 `ADIT_ACCESS_TOKEN`。脚本不跟随重定向，除回环测试地址外只允许 HTTPS，并自动获取所有分页。

服务端接口为 `GET /api/sessions/{sessionId}/token-usage`，支持 `dateFrom`、`dateTo`、`timeZone`、`turnId`、`cursor`。网页登录沿用现有会话访问权限；Bearer 导出只允许用户自己的会话。时间参数也可使用精确 ISO 时间戳，确保导出范围与抓包范围一致。

## 运行对账

```powershell
tools/token-usage/.venv/Scripts/python.exe tools/token-usage/reconcile.py `
  --capture tools/token-usage/output/capture.jsonl `
  --adit tools/token-usage/output/adit.json `
  --report tools/token-usage/output/report.json
```

- 退出码 0：提供范围内的可核验调用逐字段一致，且没有未解释的请求级记录。
- 退出码 1：存在缺失、重复、身份不明、字段差异、不完整记录或导出汇总不一致。
- 空数据不算通过，不能用时间接近或 token 相同强行匹配。
- 非累加观察值单独统计为 `nonAdditiveObservations`，不当作调用匹配，也不叠加到总量。
- 报告会列出两侧未匹配记录；未返回最终 usage 或代理中断时不判为零消耗。
- 抓包侧没有 ADIT 轮次身份，报告不独立证明轮次归属；需结合轮次场景测试检查。
- 第三方中转返回的 usage 只能作为该中转的报告值，不等同于原厂账单证据。

## 测试

```powershell
pnpm exec vitest run packages/core/src/usage.test.ts packages/hooks/src/common/token-usage.test.ts
python -m unittest discover -s tools/token-usage -p "test_*.py" -v

$env:MITMDUMP = (Resolve-Path tools/token-usage/.venv/Scripts/mitmdump.exe).Path
tools/token-usage/.venv/Scripts/python.exe -m unittest discover -s tools/token-usage -p "test_*.py" -v
```

没有 `MITMDUMP` 时跳过真实代理测试；设置后会启动本机 HTTPS 模拟服务与独立代理，生成仅供该测试使用的 CA，验证 TLS、SSE 原样转发及白名单证据，不修改系统证书库、不访问真实模型账号。

真实 Codex / Claude 账号、登录入口、子代理和中转方式的最终验收，仍需按方案中的场景清单进行。本地模拟通过不能冒充真实账单已验证。
