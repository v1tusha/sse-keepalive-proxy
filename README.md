# sse-keepalive-proxy

Локальный HTTP-прокси между Claude Code и Anthropic-совместимыми шлюзами
(например, agentrouter.org / New API), которые не пересылают `event: ping`
во время длинных thinking-пауз. Из-за этого idle-watchdog Claude Code (~20с
без байт) рвёт поток и ретраит запрос до бесконечности
(«Waiting for API response · will retry in ...»).

Прокси решает это двумя способами:

1. **Keepalive-инжект** — если от шлюза нет байт дольше `IDLE_MS`, прокси пишет
   клиенту SSE-комментарии `: keepalive` (на границах событий и внутри события),
   чтобы watchdog не срабатывал.
2. **Авто-ретрай** — транзиентные ошибки шлюза (401/403/429/5xx, например
   «unauthorized client detected») прокси тихо повторяет сам, и Claude Code
   вообще не видит ошибку.

Заголовки запросов релеются без изменений (шлюз фингерпринтит клиента:
`user-agent`, `x-app`, `x-stainless-*`, `anthropic-version`, `anthropic-beta`,
`authorization`); переписывается только `Host` на хост апстрима.
Токен нигде не логируется.

## Запуск (Windows)

```
node proxy.js
```

Или двойным кликом по `proxy.bat` (лог пишется в `proxy.log` рядом).

## Переключение Claude Code

В `~/.claude/settings.json` (Windows: `C:\Users\<you>\.claude\settings.json`):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_MODEL": "claude-opus-4-8"
  }
}
```

`ANTHROPIC_BASE_URL` меняется на `http://127.0.0.1:8787`,
`ANTHROPIC_AUTH_TOKEN` и `ANTHROPIC_MODEL` остаются как были.
Полностью перезапустить Claude Code.

## Конфигурация через env

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `8787` | Порт прокси |
| `UPSTREAM` | `https://agentrouter.org` | URL шлюза |
| `IDLE_MS` | `5000` | Порог молчания шлюза перед инжектом keepalive |
| `MAX_RETRIES` | `3` | Максимум попыток при транзиентных ошибках шлюза |
| `RETRY_DELAY_MS` | `1500` | Базовая пауза между ретраями |
| `LOG_FILE` | (пусто) | Путь к файлу лога (stderr дублируется туда) |

Пример:

```
PORT=9000 UPSTREAM=https://other-gateway.example IDLE_MS=3000 node proxy.js
```
