**English** | [Русский](README.ru.md)

# sse-keepalive-proxy

A local HTTP proxy between Claude Code and Anthropic-compatible gateways
(e.g. agentrouter.org / New API) that do **not** forward `event: ping` during
long thinking pauses. Claude Code's stream-idle watchdog (~20s without bytes)
then kills the stream and retries in an endless loop
("Waiting for API response · will retry in ...").

The proxy fixes this two ways:

1. **Keepalive injection** — when the gateway is silent for longer than `IDLE_MS`,
   the proxy writes SSE comment lines (`: keepalive`) to the client, both between
   events and mid-event, so the watchdog never fires.
2. **Auto-retry** — transient gateway errors (401/403/429/5xx, e.g.
   "unauthorized client detected") are silently retried by the proxy with a
   backoff, so Claude Code never sees the error at all.

Request headers are relayed **verbatim** (gateways fingerprint the client via
`user-agent`, `x-app`, `x-stainless-*`, `anthropic-version`, `anthropic-beta`,
`authorization`); only `Host` is rewritten to the upstream host.
The token is never logged.

## Quick start

No npm dependencies, pure Node.js (built-in `http`/`https`/`stream`):

```
node proxy.js
```

On Windows you can also double-click `proxy.bat` (logs go to `proxy.log`).

## Point Claude Code at it

Edit `~/.claude/settings.json` (Windows: `C:\Users\<you>\.claude\settings.json`):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_MODEL": "claude-opus-4-8"
  }
}
```

Change only `ANTHROPIC_BASE_URL` to `http://127.0.0.1:8787`;
keep `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_MODEL` as they were.
Fully restart Claude Code.

The desktop Claude Code app reads the same `settings.json`, so the fix applies
there too. The Claude Desktop chat app uses its own gateway setting in the UI —
point it at `http://127.0.0.1:8787` if you want to route it through the proxy.

## Environment configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | Proxy listen port |
| `UPSTREAM` | `https://agentrouter.org` | Gateway URL |
| `IDLE_MS` | `5000` | Gateway silence threshold before keepalive injection |
| `MAX_RETRIES` | `3` | Max attempts on transient gateway errors |
| `RETRY_DELAY_MS` | `1500` | Base delay between retries |
| `LOG_FILE` | (empty) | Path to a log file (stderr is also mirrored there) |

Example:

```
PORT=9000 UPSTREAM=https://other-gateway.example IDLE_MS=3000 node proxy.js
```

## Reading the log

```
>> POST /v1/messages start            # request received
POST /v1/messages -> 200 (SSE) 5s     # upstream responded
POST /v1/messages keepalive #2        # keepalive injected (idle gap)
POST /v1/messages retry 1/3 after 401 # transient error, retrying
```

`count_tokens -> 404` is normal — many gateways don't implement that endpoint.

## License

MIT
