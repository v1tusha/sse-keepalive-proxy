# sse-keepalive-proxy

用于 Claude Code 与 Anthropic 兼容网关（例如 agentrouter.org / New API）之间的本地 HTTP 代理。这类网关在长时间 thinking 停顿期间**不会**转发 `event: ping`，导致 Claude Code 的流空闲看门狗（约 20 秒无数据）判定流已死、反复重试，陷入死循环（界面一直显示 "Waiting for API response · will retry in ..."）。

本代理通过两种方式解决：

1. **Keepalive 注入** — 当网关静默超过 `IDLE_MS` 时，代理向客户端写入 SSE 注释行（`: keepalive`），既在事件边界注入、也在事件中途注入，看门狗因此永远不会触发。
2. **自动重试** — 网关的瞬时错误（401/403/429/5xx，例如 "unauthorized client detected"）由代理静默重试（带退避），Claude Code 完全感知不到错误。

请求头**原样转发**（网关通过 `user-agent`、`x-app`、`x-stainless-*`、`anthropic-version`、`anthropic-beta`、`authorization` 识别客户端指纹）；仅将 `Host` 改写为上游主机。令牌永远不会被记录到日志。

## 快速开始

零 npm 依赖，纯 Node.js（内置 `http`/`https`/`stream`）：

```
node proxy.js
```

Windows 上也可以双击 `proxy.bat`（日志写入 `proxy.log`）。

## 让 Claude Code 指向代理

编辑 `~/.claude/settings.json`（Windows：`C:\Users\<you>\.claude\settings.json`）：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_MODEL": "claude-opus-4-8"
  }
}
```

只改 `ANTHROPIC_BASE_URL` 为 `http://127.0.0.1:8787`；`ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_MODEL` 保持原样。然后完全重启 Claude Code。

Claude Code 桌面版读取同一个 `settings.json`，因此同样适用。Claude Desktop 聊天应用则使用界面中独立的网关设置 — 若想走代理，把网关地址填为 `http://127.0.0.1:8787` 即可。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 代理监听端口 |
| `UPSTREAM` | `https://agentrouter.org` | 网关地址 |
| `IDLE_MS` | `5000` | 网关静默阈值，超过后注入 keepalive |
| `MAX_RETRIES` | `3` | 网关瞬时错误时的最大尝试次数 |
| `RETRY_DELAY_MS` | `1500` | 重试之间的基础延迟 |
| `LOG_FILE` | （空） | 日志文件路径（stderr 同时写入） |

示例：

```
PORT=9000 UPSTREAM=https://other-gateway.example IDLE_MS=3000 node proxy.js
```

## 日志解读

```
>> POST /v1/messages start            # 收到请求
POST /v1/messages -> 200 (SSE) 5s     # 上游已响应
POST /v1/messages keepalive #2        # 已注入 keepalive（空闲间隙）
POST /v1/messages retry 1/3 after 401 # 瞬时错误，正在重试
```

`count_tokens -> 404` 属正常现象 — 许多网关未实现该端点。

## 许可证

MIT
