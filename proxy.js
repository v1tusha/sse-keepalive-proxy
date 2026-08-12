/*
 * proxy.js — SSE keepalive proxy between Claude Code and Anthropic-совместимый
 * шлюз (agentrouter.org / New API), который НЕ пересылает `event: ping` во время
 * длинных thinking-пауз, из-за чего watchdog Claude Code (~20с без байт) рвёт
 * поток и ретраит запрос до бесконечности.
 *
 * Дополнительно: автоматический ретрай транзиентных ошибок шлюза (401/403/429/5xx,
 * например "unauthorized client detected") — прокси тихо повторяет запрос с
 * паузой, и Claude Code вообще не видит ошибку (нет "API error" и циклов
 * "Waiting for API response · will retry").
 *
 * Запуск:
 *   node proxy.js
 *   PORT=9000 UPSTREAM=https://some-gateway.example IDLE_MS=3000 node proxy.js
 *   MAX_RETRIES=3 RETRY_DELAY_MS=1500 node proxy.js
 *
 * Переключение Claude Code (редактируем ~/.claude/settings.json, на Windows:
 * C:\Users\<you>\.claude\settings.json):
 *   "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787"
 * ANTHROPIC_AUTH_TOKEN и ANTHROPIC_MODEL оставить как есть. Рестарт Claude Code.
 *
 * Заголовки запроса релеятся БЕЗ изменений (шлюз фингерпринтит клиента:
 * user-agent, x-app, x-stainless-*, anthropic-version, anthropic-beta,
 * authorization), переписывается только Host на хост апстрима.
 * Значение authorization нигде не логируется.
 */

'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const { PassThrough } = require('stream');

const PORT = Number(process.env.PORT || 8787);
const UPSTREAM = process.env.UPSTREAM || 'https://agentrouter.org';
const IDLE_MS = Number(process.env.IDLE_MS || 5000);
const LOG_FILE = process.env.LOG_FILE || '';
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 1500);

const upstream = new URL(UPSTREAM);
const upRequester = upstream.protocol === 'https:' ? https.request : http.request;
const upBase = upstream.pathname.replace(/\/+$/, '');
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
const RETRY_OK = /unauthorized client detected|overloaded|too many|rate limit|internal|upstream|temporar|busy|unavailable/i;

function isTransientBody(status, buf) {
  const s = buf.toString('utf8');
  if (!s.trim()) return true;
  if (RETRY_NO.test(s)) return false;
  if (RETRY_OK.test(s)) return true;
  return status >= 500 || status === 429 || status === 401 || status === 403;
}

const server = http.createServer((req, res) => {
  const reqPath = req.url;
  const started = Date.now();
  let active = null;
  let sseTimer = null;
  let keepalives = 0;
  let aborted = false;

  log(`>> ${req.method} ${reqPath} start`);

  const stopTimer = () => {
    if (sseTimer !== null) {
      clearTimeout(sseTimer);
      sseTimer = null;
    }
  };

  const forward = (status, headers, stream) => {
    const isSSE = /text\/event-stream/i.test(String(headers['content-type'] || ''));
    log(`${req.method} ${reqPath} -> ${status}${isSSE ? ' (SSE)' : ''} ${Date.now() - started}ms`);

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

    let tail = Buffer.alloc(0);

    const tick = () => {
      sseTimer = null;
      const t = tail.toString('utf8');
      if (t.length === 0 || t.endsWith('\n\n')) {
        res.write(KEEPALIVE);
        tail = Buffer.concat([tail, Buffer.from(KEEPALIVE)]).slice(-4);
        keepalives += 1;
        log(`${req.method} ${reqPath} keepalive #${keepalives}`);
      } else if (t.endsWith('\n')) {
        res.write(KEEPALIVE_COMMENT);
        tail = Buffer.concat([tail, Buffer.from(KEEPALIVE_COMMENT)]).slice(-4);
        keepalives += 1;
        log(`${req.method} ${reqPath} keepalive mid-event #${keepalives}`);
      }
      sseTimer = setTimeout(tick, IDLE_MS);
    };
    sseTimer = setTimeout(tick, IDLE_MS);

    stream.on('data', (chunk) => {
      res.write(chunk);
      tail = Buffer.concat([
        tail,
        chunk.length > 4 ? chunk.subarray(chunk.length - 4) : chunk,
      ]).slice(-4);
      if (sseTimer !== null) clearTimeout(sseTimer);
      sseTimer = setTimeout(tick, IDLE_MS);
    });
    stream.on('end', () => {
      stopTimer();
      res.end();
    });
    stream.on('error', (err) => {
      stopTimer();
      log(`${req.method} ${reqPath} upstream stream error: ${err.message}`);
      if (!res.writableEnded && !res.destroyed) res.destroy(err);
    });
  };

  const makeUpstream = (attempt, body) => {
    const upReq = upRequester({
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: upBase + reqPath,
      headers: Object.assign({}, req.headers, { host: upstream.host }),
    }, (upRes) => {
      const status = upRes.statusCode;
      const headers = upRes.headers;
      const transient = shouldRetryStatus(status) && attempt < MAX_RETRIES;

      if (transient) {
        const chunks = [];
        let size = 0;
        let drained = false;
        const drain = (onEnd) => {
          upRes.on('data', (c) => {
            chunks.push(c);
            size += c.length;
          });
          upRes.on('end', onEnd);
          upRes.on('error', () => onEnd());
        };
        drain(() => {
          if (aborted) return;
          const buf = Buffer.concat(chunks, size);
          if (isTransientBody(status, buf)) {
            const snippet = buf.toString('utf8')
              .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '?')
              .slice(0, 100);
            log(`${req.method} ${reqPath} retry ${attempt}/${MAX_RETRIES} after ${status}: ${snippet}`);
            setTimeout(() => makeUpstream(attempt + 1, body), RETRY_DELAY_MS * attempt);
          } else {
            const pt = new PassThrough();
            pt.end(buf);
            forward(status, headers, pt);
          }
        });
        return;
      }

      forward(status, headers, upRes);
    });

    active = upReq;
    upReq.on('error', (err) => {
      if (res.destroyed || aborted) return;
      log(`${req.method} ${reqPath} upstream error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`Bad Gateway: ${err.message}\n`);
      } else if (!res.writableEnded) {
        res.destroy(err);
      }
    });
    upReq.end(body);
  };

  const bodyChunks = [];
  let bodySize = 0;
  req.on('data', (c) => {
    bodyChunks.push(c);
    bodySize += c.length;
  });
  req.on('end', () => {
    const body = Buffer.concat(bodyChunks, bodySize);
    makeUpstream(1, body);
  });

  req.on('error', () => { aborted = true; if (active) active.destroy(); });
  res.on('error', () => { aborted = true; if (active) active.destroy(); });
  res.on('close', () => {
    if (!res.writableEnded) {
      aborted = true;
      stopTimer();
      if (active) active.destroy();
    }
  });
  req.on('close', () => {
    if (!req.complete) {
      aborted = true;
      if (active) active.destroy();
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT} -> ${UPSTREAM} (idle ${IDLE_MS}ms, retries ${MAX_RETRIES} x ${RETRY_DELAY_MS}ms)`);
});
