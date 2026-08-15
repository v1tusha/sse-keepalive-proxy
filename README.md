**English** | [Русский](README.ru.md)

# sse-keepalive-proxy

A local HTTP proxy between Claude Code and Anthropic-compatible gateways
(e.g. agentrouter.org / New API) that do **not** forward `event: ping` during
long thinking pauses. Claude Code's stream-idle watchdog (~18s without a single
byte — measured) then kills the stream and retries in an endless loop
("Waiting for API response · will retry in ...").

The proxy fixes this four ways:

1. **Ping injection** — when the gateway is silent for longer than `IDLE_MS`, the
   proxy sends the client a real `event: ping`, the same event the upstream API
   emits during long pauses, so the client is built to accept it as a sign of
   life. A complete event may only be written at an event boundary: if the
   gateway stalled halfway through one, the proxy writes an SSE comment
   (`: keepalive`) instead — the only line that is legal inside an unfinished
   event, at the price of being a line the client is free to ignore.
2. **Auto-retry** — transient gateway errors (401/403/429/5xx, e.g.
   "unauthorized client detected") are silently retried by the proxy with a
   backoff, so Claude Code never sees the error at all.
3. **Pre-commit** — ping injection only works once the gateway has sent
   response headers. If it hasn't within `PRE_COMMIT_MS`, the proxy sends the SSE
   headers itself and starts injecting pings; retries continue behind them.
   Streaming requests go upstream with `accept-encoding: identity`, because the
   proxy's own headers declare no compression and a gzipped upstream body would
   reach the client as garbage.
4. **Hedging** — after `HEDGE_MS` of silence the proxy fires a duplicate request
   in parallel and forwards whichever attempt answers first, aborting the rest.
   The winner's real status and headers are passed through, so nothing is faked.

Request headers are relayed **verbatim** (gateways fingerprint the client via
`user-agent`, `x-app`, `x-stainless-*`, `anthropic-version`, `anthropic-beta`,
`authorization`); only `Host` is rewritten to the upstream host, plus
`accept-encoding` on streaming requests as described above.
The token is never logged.

### A note on hedging

Duplicates are billed and they add load. On a gateway that is short of upstream
channels they make things worse, which is easy to measure: with
`HEDGE_MS=5000` and `MAX_ATTEMPTS=5` against agentrouter the duplicate rate hit
2.4 per request and response times grew from 8s to 15–30s. Backing off to
20s / 2 attempts brought them back to 6–9s. The defaults are deliberately
conservative — hedging here is a hang guard, not an accelerator.

## Quick start

No npm dependencies, pure Node.js (built-in `http`/`https`/`stream`):

```
node proxy.js
node proxy.js selftest    # run the built-in checks and exit
node test-hedge.js        # hedging/pre-commit against a fake stalling gateway
```

On Windows you can also double-click `proxy.bat` (logs go to `proxy.log`).

## Console panel

`panel.bat` opens a TUI against the running proxy: live counters, the remap
target and the hedge knobs, all without a restart. It reads `GET /__state`,
writes `POST /__config`, and starts the proxy itself (hidden) if the port is dead.

![Control panel](panel.png)

| Key | Action |
|---|---|
| `↑` `↓` `ENTER` | pick and apply the remap target |
| `SPACE` | toggle `claude-opus-4-8` ⇄ `claude-opus-5` |
| `TAB` `←` `→` | pick a hedge knob and change it (applied immediately) |
| `R` | back to the default target |
| `P` | start / stop the proxy |
| `Q` | quit — the proxy keeps running |

The knobs step through preset values rather than free arithmetic, so a slip
can't set `hedgeMs` to something that floods the gateway.

PowerShell 5.1 needs `panel.ps1` stored as UTF-8 **with BOM**, otherwise the box
drawing and Cyrillic turn into mojibake. `panel.ps1 -SelfTest` checks the knob
steps and the frame invariant (every row is exactly the frame width, so a long
line can never wrap and make the frame scroll); `-Once` renders a single frame
and exits. `PANEL_COLS` / `PANEL_ROWS` render at a size other than your window's.

## Model remap

Claude Code calls `claude-haiku-4-5-*` for background tasks. If your token has
no access to that model, the gateway answers `403 该令牌无权访问模型` and the
session stalls. The proxy rewrites any model name containing `HAIKU_MATCH` to
`HAIKU_MODEL` and fixes `content-length`. `HAIKU_MODEL=off` disables it.

The retry classifier also knows the permanent New API errors in Chinese
(无权 / 过期 / 余额 / 额度 / 不存在 / 封禁 …) and does not waste attempts on them.

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

Note that restarting the proxy kills the client's pooled keep-alive sockets, so
the first request in every open window fails once with `ECONNRESET`
("check your network"). Press Esc and send again. That is why the settings that
matter are runtime-patchable — see below.

## Runtime config

| Endpoint | |
|---|---|
| `GET /__state` | config, upstream and counters as JSON |
| `POST /__config` | patch `remapModel`, `remapMatch`, `hedgeMs`, `maxAttempts`, `preCommitMs` |

Patched values are clamped to sane ranges and persisted to `config.json`, which
takes precedence over the environment on the next start.

```
curl -X POST http://127.0.0.1:8787/__config \
  -H 'content-type: application/json' -d '{"hedgeMs":20000,"maxAttempts":2}'
```

## Environment configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | Proxy listen port |
| `UPSTREAM` | `https://agentrouter.org` | Gateway URL |
| `IDLE_MS` | `5000` | Gateway silence threshold before a ping is injected |
| `UPSTREAM_TIMEOUT_MS` | `90000` | How long to wait for response headers before aborting an attempt (`0` = forever) |
| `PRE_COMMIT_MS` | `10000` | Silence before the proxy sends the SSE headers itself (`0` disables) |
| `HEDGE_MS` | `20000` | Silence before a parallel duplicate is fired (`0` disables) |
| `MAX_ATTEMPTS` | `2` | Total attempts per request — hedges and retries share this budget |
| `RETRY_DELAY_MS` | `1500` | Delay before a retry after a transient error |
| `HAIKU_MODEL` | `claude-opus-4-8` | Target of the model remap (`off` disables) |
| `HAIKU_MATCH` | `haiku` | Substring in the model name that triggers the remap |
| `CONFIG_FILE` | `config.json` | Runtime config file written by the panel |
| `LOG_FILE` | (empty) | Path to a log file (stderr is also mirrored there) |

Example:

```
PORT=9000 UPSTREAM=https://other-gateway.example IDLE_MS=3000 node proxy.js
```

## Reading the log

Log messages are in Russian; glosses below.

```
>> POST /v1/messages start                          request received
model remap claude-haiku-4-5-x -> claude-opus-5     remap applied
попытка #1 отбита 500: ...无可用渠道...             transient error, attempt dropped
хедж: тишина 20016ms, пускаю дубль #2               silence, duplicate fired
дублей оборвано: 1                                  winner found, losers aborted
POST /v1/messages -> 200 (SSE) 21967ms              upstream responded
pre-commit SSE (шлюз молчит 10016ms)                headers sent by the proxy
POST /v1/messages ping #2                           event: ping injected
keepalive mid-event #3                              comment: gateway stalled mid-event
поток закрыт нормально: 12446b за 13840ms           stream finished
КЛИЕНТ ЗАКРЫЛ соединение на 0b через 17833ms        client gave up before the first byte
ШЛЮЗ ОБРЕЗАЛ поток на 4096b через 45000ms          upstream truncated the stream
все 2 попыток мимо: ...                             every attempt failed, 502 to the client
client error: ECONNRESET                            connection-level failure
```

`count_tokens -> 404` is normal — many gateways don't implement that endpoint.

The last three lines are the ones worth watching: they are the only cases where
the client actually sees a failure.

## License

MIT
