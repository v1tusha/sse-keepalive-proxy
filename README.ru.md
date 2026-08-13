[English](README.md) | **Русский**

# sse-keepalive-proxy

Локальный HTTP-прокси между Claude Code и Anthropic-совместимыми шлюзами
(например, agentrouter.org / New API), которые **не пересылают** `event: ping`
во время длинных thinking-пауз. Из-за этого idle-watchdog Claude Code (~20с
без байт) рвёт поток и ретраит запрос до бесконечности
(«Waiting for API response · will retry in ...»).

Прокси решает это двумя способами:

1. **Keepalive-инжект** — если от шлюза нет байт дольше `IDLE_MS`, прокси пишет
   клиенту SSE-комментарии (`: keepalive`) — и между событиями, и внутри
   события, чтобы watchdog не срабатывал.
2. **Авто-ретрай** — транзиентные ошибки шлюза (401/403/429/5xx, например
   «unauthorized client detected» или ложный «Invalid token») прокси тихо
   повторяет сам с паузой, и Claude Code вообще не видит ошибку.

Плюс один endpoint прокси отвечает сам:

3. **Фолбэк `count_tokens`** — Claude Code проверяет модель запросом
   `POST /v1/messages/count_tokens` и читает из ответа `input_tokens`. Шлюзы,
   которые этот endpoint не реализуют, отдают `404` с телом ошибки — Claude Code
   читает поле у объекта ошибки и падает с
   `Unable to validate model: undefined is not an object (evaluating 'z.usage.input_tokens')`,
   после чего `/model <id>` молча перестаёт переключать модель. Прокси вместо
   этого отдаёт локальную оценку (~4 символа на токен). Если твой шлюз endpoint
   умеет и нужны его точные числа — `COUNT_TOKENS_FALLBACK=0`.

Заголовки запросов релеются **без изменений** (шлюз фингерпринтит клиента:
`user-agent`, `x-app`, `x-stainless-*`, `anthropic-version`, `anthropic-beta`,
`authorization`); переписывается только `Host` на хост апстрима.
Токен нигде не логируется.

## Быстрый старт

Без npm-зависимостей, чистый Node.js (встроенные `http`/`https`/`stream`):

```
node proxy.js
```

На Windows можно запускать двойным кликом по `proxy.bat` (лог пишется
в `proxy.log`).

## Переключение Claude Code

Отредактируй `~/.claude/settings.json` (Windows:
`C:\Users\<you>\.claude\settings.json`):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_MODEL": "claude-opus-4-8"
  }
}
```

Меняй только `ANTHROPIC_BASE_URL` на `http://127.0.0.1:8787`;
`ANTHROPIC_AUTH_TOKEN` и `ANTHROPIC_MODEL` оставь как были.
Полностью перезапусти Claude Code.

Десктопная версия Claude Code читает тот же `settings.json`, так что фикс
работает и там. Чат-приложение Claude Desktop использует собственный шлюз
в настройках — туда можно вписать `http://127.0.0.1:8787`, если хочешь гонять
и его через прокси.

## Конфигурация через env

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `8787` | Порт прокси |
| `UPSTREAM` | `https://agentrouter.org` | URL шлюза |
| `IDLE_MS` | `5000` | Порог молчания шлюза перед инжектом keepalive |
| `MAX_RETRIES` | `3` | Максимум попыток при транзиентных ошибках шлюза |
| `RETRY_DELAY_MS` | `1500` | Базовая пауза между ретраями |
| `COUNT_TOKENS_FALLBACK` | `1` | Отвечать на `count_tokens` локально; `0` = релеить в шлюз |
| `LOG_FILE` | (пусто) | Путь к файлу лога (stderr дублируется туда) |

Пример:

```
PORT=9000 UPSTREAM=https://other-gateway.example IDLE_MS=3000 node proxy.js
```

## Чтение лога

```
>> POST /v1/messages start            # запрос получен
POST /v1/messages -> 200 (SSE) 5s     # шлюз ответил
POST /v1/messages keepalive #2        # вставлен keepalive (тишина шлюза)
POST /v1/messages retry 1/3 after 401 # транзиентная ошибка, идёт ретрай
```

`count_tokens -> 404` — это норма: многие шлюзы не реализуют этот endpoint.

## Лицензия

MIT
