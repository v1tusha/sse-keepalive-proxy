/*
 * proxy.js — CLI proxy. SSE keepalive proxy между CLI-клиентом (Anthropic
 * Messages API) и Anthropic-совместимым шлюзом (agentrouter.org / New API).
 *
 * База — sse-keepalive-proxy. Добавлено под проблему haiku + консольный пультик:
 *
 *   1. Ремап модели. Клиент сам дёргает claude-haiku-4-5-* под фоновые задачи,
 *      а токен эту модель не пускает -> шлюз отдаёт 403 «该令牌无权访问模型».
 *      Прокси переписывает model, содержащий cfg.remapMatch ("haiku"), на рабочую
 *      cfg.remapModel (дефолт claude-opus-4-8) и правит content-length.
 *      remapModel="off" — выключить ремап.
 *   2. Fail-fast. В классификатор ретраев добавлены китайские паттерны
 *      постоянных ошибок New API (无权/权限/无效/过期/余额/额度/欠费/不存在/认证).
 *   3. Пультик. Консольная панель (pult.ps1) на лету меняет цель ремапа и
 *      показывает статистику через служебные пути /__state и /__config —
 *      без перезапуска. Выбор ремапа дублируется в config.json рядом со скриптом.
 *
 * Остальное как в базовом прокси: keepalive-инжект в тишине шлюза + тихий
 * ретрай транзиентных ошибок. Заголовки релеются без изменений (шлюз
 * фингерпринтит клиента), переписывается только Host. Токен не логируется.
 *
 * Апстрим и матч читаются из env один раз при старте (UPSTREAM, HAIKU_MATCH).
 * На лету меняется только цель ремапа — этого хватает «нажал и поехал».
 *
 * Запуск:
 *   node proxy.js
 *   node proxy.js selftest        # прогнать самопроверку и выйти
 *
 * Клиент -> прокси: укажи baseURL http://127.0.0.1:8787
 * Пультик: pult.bat (консольная панель).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { PassThrough } = require('stream');

const PORT = Number(process.env.PORT || 8787);
const IDLE_MS = Number(process.env.IDLE_MS || 5000);
const LOG_FILE = process.env.LOG_FILE || '';
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 1500);
// Сколько ждём ЗАГОЛОВКИ ответа от шлюза, прежде чем оборвать и ретраить.
// 0 = ждать вечно. Дефолт высокий НАМЕРЕННО: при перегрузе agentrouter первый
// байт приходит за 30–48с, и низкий порог (12–20с) РУБИЛ живые запросы —
// каждый обрыв жёг попытку, а исчерпав их, прокси отдавал клиенту 502
// («waiting for API response» + бэкофф). Лучше медленный 200, чем быстрый 502.
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 90000);
// Пре-коммит живёт в runtime-конфиге (cfg.preCommitMs) — крутится без рестарта.
// История: первая версия ломала ответы («API returned an empty or malformed
// response (HTTP 200)»), потому что мы отдавали СВОИ заголовки и теряли
// content-encoding шлюза — клиент получал gzip под видом текста. Лечится тем,
// что стримовым запросам принудительно ставим accept-encoding: identity, и
// сжатого тела не может быть в принципе (см. makeUpstream).
// --- Хеджирование ---
// Отказ шлюза — лотерея на каждый запрос: один и тот же запрос к той же модели
// то отвечает за 5с, то молчит 90с, то отдаёт 500 «无可用渠道». Ждать полный
// таймаут перед повтором = самим себе добавлять 90с. Поэтому через cfg.hedgeMs
// тишины пускаем ДУБЛИРУЮЩУЮ попытку параллельно и берём того, кто ответил
// первым, остальных рвём.
// Порог и потолок попыток лежат в runtime-конфиге (cfg) — их видно в /__state и
// можно менять через POST /__config БЕЗ рестарта: подбирать такое на живом
// трафике рестартами больно, каждый рестарт роняет пул сокетов у клиента.
// CONFIG_FILE переопределяем ради тестов: иначе тестовый прокси читает и
// перезаписывает живой config.json рядом со скриптом.
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, 'config.json');

// Апстрим фиксируется на старте (смену эндпоинта убрали — не нужна пока).
const UPSTREAM = process.env.UPSTREAM || 'https://agentrouter.org';
const upstream = new URL(UPSTREAM);
const upRequester = upstream.protocol === 'https:' ? https.request : http.request;
const upBase = upstream.pathname.replace(/\/+$/, '');

// --- Runtime-конфиг. Меняется панелью/curl на лету, пишется в config.json. ---
const cfg = {
  remapModel: process.env.HAIKU_MODEL || 'claude-opus-4-8', // 'off' = выкл
  remapMatch: (process.env.HAIKU_MATCH || 'haiku').toLowerCase(),
  // 20с и всего 2 попытки — ИЗМЕРЕНО на живом трафике 15.08.2026. Соблазн
  // «дублей побольше» проверен и опровергнут: hedgeMs=5000 + maxAttempts=5 дали
  // ~3x нагрузки на шлюз, и ответы выросли с 8с до 15–30с (сам себе устроил
  // очередь: у agentrouter не хватает каналов, дубли её только удлиняют).
  // Сброс до 20с/2 вернул 6.6–8.6с при нуле хеджей. Хедж здесь — страховка от
  // висяка, а не ускоритель: пускать дубль имеет смысл, только когда ответа
  // реально нет. 0 = выключить.
  hedgeMs: Number(process.env.HEDGE_MS || 20000),
  // Всего попыток на запрос, включая первую (и параллельные, и повторы).
  maxAttempts: Number(process.env.MAX_ATTEMPTS || 2),
  // Пре-коммит: через сколько тишины шлюза отдать клиенту SSE-заголовки и
  // держать поток keepalive'ами. ИЗМЕРЕНО 15.08.2026: клиент сдаётся сам,
  // получив 0 байт за ~18с («КЛИЕНТ ЗАКРЫЛ соединение на 0b через 17833ms»),
  // а шлюз в плохие минуты отдаёт первый байт за 10–30с. Поэтому 10с — с
  // запасом до дедлайна клиента. 0 = выключить.
  preCommitMs: Number(process.env.PRE_COMMIT_MS || 10000),
};

// Числовая ручка из патча: молча игнорируем мусор и зажимаем в разумные рамки,
// иначе опечатка в панели (hedgeMs: 5) устроит шлюзу лавину дублей.
function patchNum(v, min, max, allowZero) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (allowZero && n === 0) return 0;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function loadConfig() {
  let raw;
  try { raw = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch (e) { return; } // нет файла — идём на дефолтах
  let c;
  try { c = JSON.parse(raw); } catch (e) { log(`config.json битый, игнорирую: ${e.message}`); return; }
  if (typeof c.remapModel === 'string' && c.remapModel.trim()) cfg.remapModel = c.remapModel.trim();
  if (typeof c.remapMatch === 'string' && c.remapMatch.trim()) cfg.remapMatch = c.remapMatch.trim().toLowerCase();
  const h = patchNum(c.hedgeMs, 1000, 120000, true);
  if (h !== null) cfg.hedgeMs = h;
  const a = patchNum(c.maxAttempts, 1, 10, false);
  if (a !== null) cfg.maxAttempts = a;
  const pc = patchNum(c.preCommitMs, 2000, 120000, true);
  if (pc !== null) cfg.preCommitMs = pc;
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log(`config save error: ${e.message}`);
  }
}

function remapOn() {
  return cfg.remapModel.toLowerCase() !== 'off';
}

// --- Статистика (в памяти, с момента старта процесса) ---
const stats = {
  startedAt: Date.now(),
  requests: 0,
  remaps: 0,
  retries: 0,
  hedges: 0,
  errors: 0,
  keepalives: 0,
  byStatus: {},
  byModel: {},
};

const KEEPALIVE = ': keepalive\n\n';
const KEEPALIVE_COMMENT = ': keepalive\n';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(line);
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, line);
    } catch (e) {
      /* ignore */
    }
  }
}

function shouldRetryStatus(status) {
  return status === 401 || status === 403 || status === 429 || (status >= 500 && status <= 599);
}

const RETRY_NO = /authentication|api[ _-]?key|expired|billing|quota|permission|denied|bad request|missing|required|incorrect|not supported/i;
// Постоянные ошибки New API на китайском (не ретраить): нет прав, неверный/
// просроченный токен, недостаточно средств/квоты, модель/канал не существует.
const RETRY_NO_ZH = /无权|权限|无效|过期|余额|额度|欠费|不存在|认证|封禁|禁用/;
const RETRY_OK = /unauthorized client detected|overloaded|too many|rate limit|internal|upstream|temporar|busy|unavailable/i;

function isTransientBody(status, buf) {
  const s = buf.toString('utf8');
  if (!s.trim()) return true;
  if (RETRY_NO.test(s) || RETRY_NO_ZH.test(s)) return false;
  if (RETRY_OK.test(s)) return true;
  return status >= 500 || status === 429 || status === 401 || status === 403;
}

// Переписать model в JSON-теле, если он матчит cfg.remapMatch. Возвращает исходный
// буфер без изменений, если ремап выключен, тело не JSON или model не подошёл.
function remapModel(body) {
  if (!remapOn() || !body || body.length === 0) return body;
  let obj;
  try {
    obj = JSON.parse(body.toString('utf8'));
  } catch (e) {
    return body;
  }
  if (!obj || typeof obj !== 'object' || typeof obj.model !== 'string') return body;
  if (!obj.model.toLowerCase().includes(cfg.remapMatch)) return body;
  const from = obj.model;
  obj.model = cfg.remapModel;
  stats.remaps += 1;
  log(`model remap ${from} -> ${cfg.remapModel}`);
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

// Учесть итоговую модель запроса в статистике (после возможного ремапа).
function bumpModel(body) {
  if (!body || body.length === 0) return;
  let obj;
  try {
    obj = JSON.parse(body.toString('utf8'));
  } catch (e) {
    return;
  }
  if (obj && typeof obj.model === 'string') {
    stats.byModel[obj.model] = (stats.byModel[obj.model] || 0) + 1;
  }
}

// Клиент ждёт SSE-поток? Только для таких запросов имеет смысл пре-коммит:
// не-стримовый ответ подделать нельзя (нужно целое JSON-тело).
function wantsStream(headers, body) {
  if (/text\/event-stream/i.test(String((headers && headers.accept) || ''))) return true;
  if (!body || body.length === 0) return false;
  try {
    return JSON.parse(body.toString('utf8')).stream === true;
  } catch (e) {
    return false;
  }
}

// ---------------------- Пультик (служебные пути /__*) ----------------------

function publicState() {
  return {
    cfg: Object.assign({}, cfg),
    upstream: UPSTREAM,
    stats: Object.assign({ uptimeMs: Date.now() - stats.startedAt }, stats),
  };
}

// Применить патч конфига от панели. Меняется только цель/матч ремапа.
function applyPatch(p) {
  if (typeof p.remapModel === 'string' && p.remapModel.trim()) cfg.remapModel = p.remapModel.trim();
  if (typeof p.remapMatch === 'string' && p.remapMatch.trim()) cfg.remapMatch = p.remapMatch.trim().toLowerCase();
  if ('hedgeMs' in p) {
    const h = patchNum(p.hedgeMs, 1000, 120000, true); // 0 = выключить хедж
    if (h !== null) cfg.hedgeMs = h;
  }
  if ('maxAttempts' in p) {
    const a = patchNum(p.maxAttempts, 1, 10, false);
    if (a !== null) cfg.maxAttempts = a;
  }
  if ('preCommitMs' in p) {
    const pc = patchNum(p.preCommitMs, 2000, 120000, true); // 0 = выключить
    if (pc !== null) cfg.preCommitMs = pc;
  }
  saveConfig();
  log(`config updated: remap ${remapOn() ? `*${cfg.remapMatch}* -> ${cfg.remapModel}` : 'off'}, хедж ${cfg.hedgeMs ? `${cfg.hedgeMs}ms` : 'off'} x${cfg.maxAttempts}, пре-коммит ${cfg.preCommitMs ? `${cfg.preCommitMs}ms` : 'off'}`);
}

function handlePanel(req, res, reqPath) {
  if (req.method === 'GET' && reqPath === '/__state') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(publicState()));
    return;
  }
  if (req.method === 'POST' && reqPath === '/__config') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const patch = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        applyPatch(patch);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(publicState()));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    req.on('error', () => {});
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found\n');
}

const server = http.createServer((req, res) => {
  const reqPath = req.url;

  // Служебные пути пультика перехватываем до проксирования (клиент ходит на /v1/*).
  if (reqPath.startsWith('/__')) {
    handlePanel(req, res, reqPath);
    return;
  }

  const started = Date.now();
  stats.requests += 1;
  let active = null;
  let sseTimer = null;
  let keepalives = 0;
  let aborted = false;
  let committed = false;      // отдали клиенту 200+SSE, не дождавшись шлюза
  let preTimer = null;        // таймер пре-коммита
  let tail = Buffer.alloc(0); // хвост потока (4 байта) — чтобы не резать событие
  const inflight = new Set(); // попытки, летящие к шлюзу прямо сейчас
  let launched = 0;           // сколько попыток запущено всего
  let settled = false;        // победитель найден (или сдались) — новых не пускаем
  let hedgeTimer = null;
  let reqBody = null;
  let bytesOut = 0;           // отдано клиенту — чтобы видеть, где обрезался поток
  let streaming = false;      // клиент просил SSE-поток

  log(`>> ${req.method} ${reqPath} start`);

  const stopTimer = () => {
    if (sseTimer !== null) {
      clearTimeout(sseTimer);
      sseTimer = null;
    }
    if (preTimer !== null) {
      clearTimeout(preTimer);
      preTimer = null;
    }
  };

  // Инжект keepalive в тишину. Событие пополам не режем: если хвост не кончается
  // пустой строкой, шлём комментарий без разделителя.
  const tick = () => {
    sseTimer = null;
    if (res.writableEnded || res.destroyed) return;
    const t = tail.toString('utf8');
    if (t.length === 0 || t.endsWith('\n\n')) {
      res.write(KEEPALIVE);
      tail = Buffer.concat([tail, Buffer.from(KEEPALIVE)]).slice(-4);
      keepalives += 1;
      stats.keepalives += 1;
      log(`${req.method} ${reqPath} keepalive #${keepalives}`);
    } else if (t.endsWith('\n')) {
      res.write(KEEPALIVE_COMMENT);
      tail = Buffer.concat([tail, Buffer.from(KEEPALIVE_COMMENT)]).slice(-4);
      keepalives += 1;
      stats.keepalives += 1;
      log(`${req.method} ${reqPath} keepalive mid-event #${keepalives}`);
    }
    sseTimer = setTimeout(tick, IDLE_MS);
  };

  // Пре-коммит. Шлюз молчит дольше PRE_COMMIT_MS, а клиент рвёт соединение по
  // тишине («Waiting for API response ... check your network»). Отдаём
  // SSE-заголовки заранее и держим поток keepalive'ами, ретраи идут за кулисами.
  // Цена: статус уже 200 — реальный код ошибки послать нельзя, при провале
  // сообщаем причину событием error внутри потока (endWithSSEError).
  const commitSSE = () => {
    preTimer = null;
    if (committed || res.headersSent || res.writableEnded || aborted) return;
    committed = true;
    log(`${req.method} ${reqPath} pre-commit SSE (шлюз молчит ${Date.now() - started}ms)`);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    if (res.socket) res.socket.setNoDelay(true);
    res.flushHeaders();
    tick(); // первый keepalive сразу + завод таймера
  };

  // Оборвать поток после пре-коммита: статус уже отдан, поэтому причину
  // сообщаем событием error — иначе клиент видит молча обрезанный стрим.
  const endWithSSEError = (msg) => {
    stopTimer();
    if (res.writableEnded || res.destroyed) return;
    const payload = JSON.stringify({ type: 'error', error: { type: 'api_error', message: msg } });
    try {
      res.write(`event: error\ndata: ${payload}\n\n`);
    } catch (e) {
      /* сокет уже мёртв */
    }
    res.end();
  };

  const pipeSSE = (stream) => {
    stream.on('data', (chunk) => {
      res.write(chunk);
      bytesOut += chunk.length;
      tail = Buffer.concat([
        tail,
        chunk.length > 4 ? chunk.subarray(chunk.length - 4) : chunk,
      ]).slice(-4);
      if (sseTimer !== null) clearTimeout(sseTimer);
      sseTimer = setTimeout(tick, IDLE_MS);
    });
    stream.on('end', () => {
      stopTimer();
      log(`${req.method} ${reqPath} поток закрыт нормально: ${bytesOut}b за ${Date.now() - started}ms`);
      res.end();
    });
    stream.on('error', (err) => {
      stopTimer();
      // Кто оборвал — принципиально: aborted=true значит ушёл клиент, а поток к
      // шлюзу оборвали мы сами. Иначе поток обрезал ШЛЮЗ на полпути.
      if (aborted) {
        log(`${req.method} ${reqPath} поток к шлюзу оборван нами (клиент ушёл): ${bytesOut}b за ${Date.now() - started}ms`);
      } else {
        log(`${req.method} ${reqPath} ШЛЮЗ ОБРЕЗАЛ поток на ${bytesOut}b через ${Date.now() - started}ms: ${err.message}`);
      }
      if (committed) {
        endWithSSEError(`upstream stream error: ${err.message}`);
        return;
      }
      if (!res.writableEnded && !res.destroyed) res.destroy(err);
    });
  };

  const forward = (status, headers, stream) => {
    stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
    const isSSE = /text\/event-stream/i.test(String(headers['content-type'] || ''));
    log(`${req.method} ${reqPath} -> ${status}${isSSE ? ' (SSE)' : ''} ${Date.now() - started}ms${committed ? ' [pre-committed]' : ''}`);

    // Пре-коммит уже случился: статус и заголовки менять нельзя, только поток.
    if (committed) {
      // Мы отдали свои заголовки БЕЗ content-encoding. Если шлюз всё-таки сжал
      // тело (проигнорировав identity), пустить его в поток нельзя — клиент
      // получит мусор и скажет «malformed response». Лучше честная ошибка.
      const enc = String(headers['content-encoding'] || '').toLowerCase();
      const compressed = enc !== '' && enc !== 'identity';
      if (status < 200 || status >= 300 || !isSSE || compressed) {
        stream.resume(); // тело шлюза уже не пригодится
        endWithSSEError(compressed
          ? `шлюз сжал поток (${enc}) вопреки accept-encoding: identity`
          : `upstream ${status} после пре-коммита потока`);
        return;
      }
      pipeSSE(stream);
      return;
    }

    if (preTimer !== null) { clearTimeout(preTimer); preTimer = null; } // успели раньше

    res.writeHead(status, headers);

    if (!isSSE) {
      stream.on('error', (err) => {
        log(`${req.method} ${reqPath} upstream stream error: ${err.message}`);
        if (!res.writableEnded && !res.destroyed) res.destroy(err);
      });
      stream.pipe(res);
      return;
    }

    if (res.socket) res.socket.setNoDelay(true);
    res.flushHeaders();
    sseTimer = setTimeout(tick, IDLE_MS);
    pipeSSE(stream);
  };

  // Победитель найден: гасим таймер хеджа и рвём проигравшие дубли.
  const settle = (winner) => {
    settled = true;
    if (hedgeTimer !== null) { clearTimeout(hedgeTimer); hedgeTimer = null; }
    let killed = 0;
    for (const r of inflight) {
      if (r !== winner) { r.destroy(); killed += 1; }
    }
    inflight.clear();
    active = winner || null; // держим победителя, чтобы оборвать при уходе клиента
    if (killed > 0) log(`${req.method} ${reqPath} дублей оборвано: ${killed}`);
  };

  const giveUp = (why) => {
    if (settled) return;
    settled = true;
    if (hedgeTimer !== null) { clearTimeout(hedgeTimer); hedgeTimer = null; }
    stats.errors += 1;
    log(`${req.method} ${reqPath} все ${launched} попыток мимо: ${why}`);
    if (committed) {
      endWithSSEError(`upstream: ${why}`);
    } else if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Bad Gateway: ${why}\n`);
    } else if (!res.writableEnded) {
      res.destroy(new Error(why));
    }
  };

  // Попытка выбыла (таймаут, обрыв, транзиентный 5xx). Пускаем следующую, если
  // не исчерпали потолок; если пускать нечего и в полёте никого — сдаёмся.
  const attemptDone = (r, why, delayMs) => {
    inflight.delete(r);
    if (settled || aborted) return;
    if (launched < cfg.maxAttempts) {
      stats.retries += 1;
      setTimeout(makeUpstream, delayMs);
      return;
    }
    if (inflight.size === 0) giveUp(why);
  };

  // Шлюз молчит -> пускаем дубль параллельно, не убивая текущую попытку.
  const scheduleHedge = () => {
    if (cfg.hedgeMs <= 0 || settled || aborted || hedgeTimer !== null) return;
    if (launched >= cfg.maxAttempts) return;
    hedgeTimer = setTimeout(() => {
      hedgeTimer = null;
      if (settled || aborted) return;
      stats.hedges += 1;
      log(`${req.method} ${reqPath} хедж: тишина ${Date.now() - started}ms, пускаю дубль #${launched + 1}`);
      makeUpstream();
      scheduleHedge(); // и следующий, если и этот промолчит
    }, cfg.hedgeMs);
  };

  function makeUpstream() {
    if (settled || aborted) return;
    if (launched >= cfg.maxAttempts) {
      if (inflight.size === 0) giveUp('попытки исчерпаны');
      return;
    }
    launched += 1;
    const n = launched;
    const headers = Object.assign({}, req.headers, { host: upstream.host });
    let headTimer = null; // ждём заголовки шлюза не дольше UPSTREAM_TIMEOUT_MS
    let timedOut = false;

    const upReq = upRequester({
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: upBase + reqPath,
      headers,
    }, (upRes) => {
      if (headTimer) { clearTimeout(headTimer); headTimer = null; } // заголовки пришли
      if (settled || aborted) { upRes.resume(); return; } // гонку уже проиграли
      const status = upRes.statusCode;
      const upHeaders = upRes.headers;

      // Возможно транзиент: дочитываем тело и решаем — повторять или отдать.
      if (shouldRetryStatus(status)) {
        const chunks = [];
        let size = 0;
        const decide = () => {
          if (settled || aborted) return;
          const buf = Buffer.concat(chunks, size);
          const snippet = buf.toString('utf8').replace(/[\x00-\x1f]/g, '?').slice(0, 100);
          if (!isTransientBody(status, buf)) {
            // Постоянная ошибка (нет прав, кончился баланс) — повторять бессмысленно.
            settle(upReq);
            const pt = new PassThrough();
            pt.end(buf);
            forward(status, upHeaders, pt);
            return;
          }
          log(`${req.method} ${reqPath} попытка #${n} отбита ${status}: ${snippet}`);
          attemptDone(upReq, `${status}`, RETRY_DELAY_MS);
        };
        upRes.on('data', (c) => { chunks.push(c); size += c.length; });
        upRes.on('end', decide);
        upRes.on('error', decide);
        return;
      }

      settle(upReq);
      forward(status, upHeaders, upRes);
    });

    // Шлюз временами молчит минуты. Рвём попытку по UPSTREAM_TIMEOUT_MS —
    // но благодаря хеджу дубль к этому времени уже давно в полёте.
    if (UPSTREAM_TIMEOUT_MS > 0) {
      headTimer = setTimeout(() => {
        timedOut = true;
        log(`${req.method} ${reqPath} попытка #${n}: тишина ${UPSTREAM_TIMEOUT_MS}ms, рву`);
        upReq.destroy(new Error('upstream head timeout'));
      }, UPSTREAM_TIMEOUT_MS);
    }

    inflight.add(upReq);
    upReq.on('error', (err) => {
      if (headTimer) { clearTimeout(headTimer); headTimer = null; }
      if (settled || aborted || res.destroyed) { inflight.delete(upReq); return; }
      log(`${req.method} ${reqPath} попытка #${n} упала: ${err.message}${timedOut ? ' (таймаут)' : ''}`);
      attemptDone(upReq, err.message, 0);
    });
    upReq.end(reqBody);
  }

  const bodyChunks = [];
  let bodySize = 0;
  req.on('data', (c) => {
    bodyChunks.push(c);
    bodySize += c.length;
  });
  req.on('end', () => {
    let body = Buffer.concat(bodyChunks, bodySize);
    const remapped = remapModel(body);
    if (remapped !== body) {
      body = remapped;
      // тело изменилось — синхронизируем длину, иначе шлюз обрежет/зависнет
      req.headers['content-length'] = String(body.length);
      delete req.headers['transfer-encoding'];
    }
    bumpModel(body);
    reqBody = body;
    streaming = wantsStream(req.headers, body);
    // Пре-коммит возможен только для стримовых запросов, и он требует, чтобы
    // шлюз НЕ сжимал тело: свои заголовки мы отдаём без content-encoding, и
    // сжатый поток превратился бы в мусор («malformed response»). SSE тут
    // мелкий (1–8КБ), так что отказ от сжатия почти ничего не стоит.
    if (streaming && cfg.preCommitMs > 0) {
      req.headers['accept-encoding'] = 'identity';
      preTimer = setTimeout(commitSSE, cfg.preCommitMs);
    }
    makeUpstream();
    scheduleHedge(); // молчит дольше cfg.hedgeMs -> пустим дубль параллельно
  });

  // Клиент ушёл — рвём всё, что летит к шлюзу (включая дубли).
  const abortAll = () => {
    aborted = true;
    stopTimer();
    if (hedgeTimer !== null) { clearTimeout(hedgeTimer); hedgeTimer = null; }
    if (active) active.destroy();
    for (const r of inflight) r.destroy();
    inflight.clear();
  };

  req.on('error', abortAll);
  res.on('error', abortAll);
  res.on('close', () => {
    if (!res.writableEnded) {
      log(`${req.method} ${reqPath} КЛИЕНТ ЗАКРЫЛ соединение на ${bytesOut}b через ${Date.now() - started}ms`);
      abortAll();
    }
  });
  req.on('close', () => {
    if (!req.complete) abortAll();
  });
});

// Самопроверка нетривиальной логики: `node proxy.js selftest`
if (process.argv[2] === 'selftest') {
  const assert = require('assert');
  const parse = (b) => JSON.parse(b.toString('utf8'));
  // applyPatch ниже пишет в config.json. Запомним живой конфиг и вернём как было —
  // иначе прогон selftest затирает настройку, выставленную панелью.
  let savedCfg = null;
  try { savedCfg = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch (e) { /* файла нет */ }

  // ремап: haiku -> cfg.remapModel
  const h = remapModel(Buffer.from(JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [] })));
  assert.strictEqual(parse(h).model, cfg.remapModel, 'haiku должен ремапиться в cfg.remapModel');
  // ремап: не-haiku не трогаем
  const o = Buffer.from(JSON.stringify({ model: 'claude-opus-4-8' }));
  assert.strictEqual(remapModel(o).toString(), o.toString(), 'не-haiku без изменений');
  // ремап: не-JSON не трогаем (возвращаем тот же буфер)
  const raw = Buffer.from('not json');
  assert.strictEqual(remapModel(raw), raw, 'не-JSON без изменений');
  // ремап off: даже haiku не трогаем
  cfg.remapModel = 'off';
  const off = Buffer.from(JSON.stringify({ model: 'claude-haiku-4-5' }));
  assert.strictEqual(remapModel(off).toString(), off.toString(), 'off = не трогаем');
  cfg.remapModel = 'claude-opus-4-8';
  // классификатор: китайский «нет доступа» — постоянная ошибка, НЕ ретраить
  assert.strictEqual(
    isTransientBody(403, Buffer.from('{"error":{"message":"该令牌无权访问模型 claude-haiku-4-5"}}')),
    false, 'zh 无权访问 = постоянная');
  // классификатор: транзиентное всё ещё ретраим
  assert.strictEqual(isTransientBody(403, Buffer.from('unauthorized client detected')), true, 'транзиентное ретраим');
  assert.strictEqual(isTransientBody(429, Buffer.from('')), true, 'пустое тело ретраим');

  // publicState отдаёт цель ремапа и апстрим, без сюрпризов
  const pub = publicState();
  assert.strictEqual(pub.cfg.remapModel, 'claude-opus-4-8', 'publicState отдаёт remapModel');
  assert.strictEqual(pub.upstream, UPSTREAM, 'publicState отдаёт upstream');

  // applyPatch меняет цель ремапа и переживает round-trip через config.json
  applyPatch({ remapModel: 'claude-opus-5' });
  assert.strictEqual(cfg.remapModel, 'claude-opus-5', 'applyPatch сменил remapModel');
  cfg.remapModel = 'claude-opus-4-8';
  loadConfig(); // поднимаем то, что applyPatch записал в config.json
  assert.strictEqual(cfg.remapModel, 'claude-opus-5', 'config.json пережил round-trip');
  // applyPatch off
  applyPatch({ remapModel: 'off' });
  assert.strictEqual(remapOn(), false, 'off выключает ремап');

  // wantsStream: пре-коммит заголовков имеет смысл только для стримовых запросов
  assert.strictEqual(wantsStream({}, Buffer.from('{"model":"x","stream":true}')), true, 'stream:true = поток');
  assert.strictEqual(wantsStream({}, Buffer.from('{"model":"x"}')), false, 'без stream = не поток');
  assert.strictEqual(wantsStream({ accept: 'text/event-stream' }, Buffer.alloc(0)), true, 'accept SSE = поток');
  assert.strictEqual(wantsStream({}, Buffer.from('not json')), false, 'не-JSON = не поток');
  assert.strictEqual(wantsStream({}, Buffer.alloc(0)), false, 'пустое тело = не поток');

  // Ручки хеджа на лету: применяются, мусор игнорируется, дурь зажимается.
  applyPatch({ hedgeMs: 7000, maxAttempts: 4 });
  assert.strictEqual(cfg.hedgeMs, 7000, 'hedgeMs применился');
  assert.strictEqual(cfg.maxAttempts, 4, 'maxAttempts применился');
  applyPatch({ hedgeMs: 5, maxAttempts: 999 }); // опечатка -> лавина дублей, зажимаем
  assert.strictEqual(cfg.hedgeMs, 1000, 'hedgeMs зажат по нижней границе');
  assert.strictEqual(cfg.maxAttempts, 10, 'maxAttempts зажат по верхней границе');
  applyPatch({ hedgeMs: 'нет' });
  assert.strictEqual(cfg.hedgeMs, 1000, 'мусор в hedgeMs игнорируется');
  applyPatch({ hedgeMs: 0 });
  assert.strictEqual(cfg.hedgeMs, 0, '0 выключает хедж');

  // ВОССТАНОВЛЕНИЕ — строго последним: любой applyPatch выше пишет в config.json,
  // и если восстановить раньше, прогон затрёт живую настройку панели.
  if (savedCfg === null) {
    try { fs.unlinkSync(CONFIG_FILE); } catch (e) { /* selftest создал config.json — уберём */ }
  } else {
    fs.writeFileSync(CONFIG_FILE, savedCfg); // вернули то, что было до прогона
  }

  console.log('selftest OK');
  process.exit(0);
}

loadConfig();

// Кто закрывает простойный keep-alive сокет — тот и создаёт гонку: если прокси
// закроет сокет в тот момент, когда клиент уже пишет в него запрос, клиент
// получит ECONNRESET («check your network»), а мы в логе не увидим НИЧЕГО —
// запрос до обработчика не доехал. Поэтому не закрываем простойные сокеты сами
// (0 = без таймаута), пусть это делает клиент. Один локальный клиент — утечки
// сокетов не будет. headersTimeout остаётся: он про медленную отправку заголовков.
server.keepAliveTimeout = 0;
server.headersTimeout = 65000;

// Обрывы на уровне соединения (мёртвый сокет после рестарта, ECONNRESET, мусор
// в запросе) иначе не видны вообще. Логируем, но соединение не спасаем.
server.on('clientError', (err, socket) => {
  log(`client error: ${err.code || err.message}`);
  if (socket.writable && !socket.destroyed) socket.destroy();
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT} -> ${UPSTREAM} (idle ${IDLE_MS}ms, таймаут заголовков ${UPSTREAM_TIMEOUT_MS}ms)`);
  log(`хедж: ${cfg.hedgeMs ? `дубль каждые ${cfg.hedgeMs}ms тишины` : 'выключен'}, попыток на запрос ${cfg.maxAttempts}`);
  log(`remap: ${remapOn() ? `*${cfg.remapMatch}* -> ${cfg.remapModel}` : 'off'}`);
  log(`пультик: запусти pult.bat`);
});
