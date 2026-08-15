/*
 * test-hedge.js — проверка хеджирования и пре-коммита против фейкового шлюза.
 * Запуск: node test-hedge.js   (свой прокси на 8790, живой на 8787 не трогает)
 *
 * A: шлюз молчит на первой попытке -> дубль выигрывает за ~HEDGE_MS, а не за таймаут.
 * B: транзиентный 500 «无可用渠道» -> следующая попытка проходит.
 * C: постоянная ошибка (нет прав) -> отдаём клиенту как есть, без повторов.
 * D: шлюз тупит дольше пре-коммита -> клиент получает keepalive'ы И живой SSE,
 *    а шлюз при этом обязан увидеть accept-encoding: identity.
 * E: шлюз всё же сжал тело -> клиент получает честную ошибку в потоке,
 *    а НЕ gzip-мусор под видом текста (это ломало прод 15.08.2026).
 */

'use strict';

const assert = require('assert');
const http = require('http');
const zlib = require('zlib');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const UP_PORT = 8791;
const PX_PORT = 8790;
const HEDGE_MS = 1000;
const PRE_COMMIT_MS = 1500;
const SLOW_MS = 3000; // дольше пре-коммита: заставляем его сработать
const HEAD_TIMEOUT_MS = 30000; // намеренно больше, чем ждём: победить должен хедж
// Свой конфиг: иначе тестовый прокси прочитает и перепишет живой config.json.
const TEST_CFG = path.join(os.tmpdir(), 'warp-proxy-test-config.json');

const SSE_BODY = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

let mode = 'hang';
let seen = 0;
let lastAcceptEncoding = null;
const held = []; // сокеты, которые держим молча — иначе node их закроет

const upstream = http.createServer((req, res) => {
  seen += 1;
  const n = seen;
  lastAcceptEncoding = req.headers['accept-encoding'];
  req.resume();
  req.on('end', () => {
    const sse = () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(SSE_BODY);
    };
    if (mode === 'hang') {
      if (n === 1) { held.push(res); return; } // молчим навсегда
      return sse();
    }
    if (mode === 'transient') {
      if (n === 1) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"分组 tokenrouter 下模型 claude-opus-5 无可用渠道（distributor）"}}');
        return;
      }
      return sse();
    }
    if (mode === 'permanent') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"该令牌无权访问模型 claude-opus-5"}}');
      return;
    }
    if (mode === 'slow') { setTimeout(sse, SLOW_MS); return; }
    if (mode === 'gzip') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync(SSE_BODY)); // шлюз проигнорировал identity
      }, SLOW_MS);
      return;
    }
    sse();
  });
});

function ask() {
  const body = JSON.stringify({ model: 'claude-opus-5', stream: true, messages: [] });
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const r = http.request({
      port: PX_PORT, method: 'POST', path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'accept-encoding': 'gzip, deflate', // как настоящий клиент
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf, ms: Date.now() - t0 }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitProxy() {
  for (let i = 0; i < 60; i += 1) {
    try {
      await new Promise((resolve, reject) => {
        const r = http.get({ port: PX_PORT, path: '/__state' }, (res) => { res.resume(); res.on('end', resolve); });
        r.on('error', reject);
      });
      return;
    } catch (e) { await wait(200); }
  }
  throw new Error('прокси не поднялся');
}

(async () => {
  await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));

  const proxy = spawn(process.execPath, ['proxy.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      PORT: String(PX_PORT),
      UPSTREAM: `http://127.0.0.1:${UP_PORT}`,
      HEDGE_MS: String(HEDGE_MS),
      PRE_COMMIT_MS: String(PRE_COMMIT_MS),
      UPSTREAM_TIMEOUT_MS: String(HEAD_TIMEOUT_MS),
      MAX_ATTEMPTS: '3',
      RETRY_DELAY_MS: '100',
      HAIKU_MODEL: 'off',
      CONFIG_FILE: TEST_CFG,
      LOG_FILE: '',
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let plog = '';
  proxy.stderr.on('data', (c) => { plog += c; });

  try {
    await waitProxy();

    // --- A: молчание шлюза, дубль обгоняет таймаут ---
    mode = 'hang'; seen = 0;
    const a = await ask();
    assert.strictEqual(a.status, 200, 'A: клиент должен получить 200 от дубля');
    assert.ok(a.body.includes('message_stop'), 'A: тело должно быть настоящим SSE от шлюза');
    assert.ok(seen >= 2, `A: шлюз должен увидеть дубль, увидел ${seen}`);
    assert.ok(a.ms < HEAD_TIMEOUT_MS / 2, `A: должно решиться хеджем, а не таймаутом; было ${a.ms}ms`);
    assert.ok(/хедж/.test(plog), 'A: в логе должен быть хедж');
    console.log(`A ok: ${a.ms}ms, попыток к шлюзу ${seen}`);

    // --- B: транзиентный 500 -> следующая попытка проходит ---
    mode = 'transient'; seen = 0;
    const b = await ask();
    assert.strictEqual(b.status, 200, 'B: после транзиентного 500 должен пройти повтор');
    assert.ok(b.body.includes('message_stop'), 'B: тело настоящего SSE');
    assert.ok(seen >= 2, `B: должен быть повтор, попыток ${seen}`);
    console.log(`B ok: ${b.ms}ms, попыток к шлюзу ${seen}`);

    // --- C: постоянная ошибка отдаётся как есть, без повторов ---
    mode = 'permanent'; seen = 0;
    const c = await ask();
    assert.strictEqual(c.status, 403, 'C: постоянную ошибку отдаём клиенту');
    assert.ok(c.body.includes('无权'), 'C: тело ошибки доходит целиком');
    assert.strictEqual(seen, 1, `C: повторять постоянную ошибку нельзя, попыток ${seen}`);
    console.log(`C ok: ${c.ms}ms, попыток к шлюзу ${seen}`);

    // --- D: пре-коммит держит клиента живым и не портит поток ---
    mode = 'slow'; seen = 0; lastAcceptEncoding = null;
    const d = await ask();
    assert.strictEqual(d.status, 200, 'D: клиент получает 200');
    assert.ok(d.body.includes(': keepalive'), 'D: пре-коммит должен был капнуть keepalive');
    assert.ok(d.body.includes('message_stop'), 'D: и настоящий SSE поверх keepalive');
    assert.ok(!d.body.includes('event: error'), 'D: ошибки быть не должно');
    assert.strictEqual(lastAcceptEncoding, 'identity',
      `D: шлюзу обязаны запретить сжатие, а пришло "${lastAcceptEncoding}"`);
    assert.ok(/pre-commit SSE/.test(plog), 'D: в логе должен быть пре-коммит');
    console.log(`D ok: ${d.ms}ms, keepalive+SSE, шлюзу ушло accept-encoding: identity`);

    // --- E: шлюз сжал вопреки запрету -> честная ошибка, а не мусор ---
    mode = 'gzip'; seen = 0;
    const e = await ask();
    assert.strictEqual(e.status, 200, 'E: статус уже отдан пре-коммитом');
    assert.ok(e.body.includes(': keepalive'), 'E: keepalive был');
    assert.ok(e.body.includes('event: error'), 'E: должна прийти ошибка в потоке');
    assert.ok(/сжал поток/.test(e.body), 'E: ошибка должна называть причину (сжатие)');
    assert.ok(!e.body.includes('message_stop'), 'E: gzip-мусор в поток попасть не должен');
    console.log(`E ok: ${e.ms}ms, сжатый ответ отбит честной ошибкой`);

    console.log('\ntest-hedge OK');
  } catch (err) {
    console.error(`\nПРОВАЛ: ${err.message}\n--- лог прокси ---\n${plog}`);
    process.exitCode = 1;
  } finally {
    proxy.kill();
    for (const res of held) res.destroy();
    upstream.close();
    try { fs.unlinkSync(TEST_CFG); } catch (err) { /* мог не создаться */ }
  }
})();
