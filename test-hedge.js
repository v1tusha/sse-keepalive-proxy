/*
 * test-hedge.js — checks hedging and pre-commit against a fake gateway.
 * Run: node test-hedge.js   (own proxy on 8790, leaves the live one on 8787 alone)
 *
 * A: gateway silent on the first attempt -> the duplicate wins in ~HEDGE_MS, not at the timeout.
 * B: transient 500 "无可用渠道" -> the next attempt goes through.
 * C: permanent error (no access) -> passed to the client as-is, no retries.
 * D: gateway slower than pre-commit -> the client gets `event: ping` AND a live SSE,
 *    while the gateway must see accept-encoding: identity.
 * E: gateway compressed the body anyway -> the client gets an honest in-stream error,
 *    NOT gzip garbage disguised as text (this broke production on 2026-08-15).
 * F: gateway went quiet MID-event -> we insert a comment only, because a complete
 *    event would tear the other one apart; the stream stays parseable.
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
const IDLE_MS = 800;   // частый тик, чтобы ping/комментарий успели в тесте
const SLOW_MS = 3000;  // дольше пре-коммита: заставляем его сработать
const PARTIAL_MS = 2000; // пауза посреди события
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
    if (mode === 'partial') {
      // Событие оборвано на середине: после data: идёт ОДИН \n, пустой строки нет.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n');
      setTimeout(() => { res.end('\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'); }, PARTIAL_MS);
      return;
    }
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
  throw new Error('the proxy never came up');
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
      IDLE_MS: String(IDLE_MS),
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

    // --- A: gateway silent, the duplicate beats the timeout ---
    mode = 'hang'; seen = 0;
    const a = await ask();
    assert.strictEqual(a.status, 200, 'A: client must get 200 from the duplicate');
    assert.ok(a.body.includes('message_stop'), 'A: body must be the real SSE from the gateway');
    assert.ok(seen >= 2, `A: gateway must see the duplicate, saw ${seen}`);
    assert.ok(a.ms < HEAD_TIMEOUT_MS / 2, `A: must be settled by the hedge, not the timeout; was ${a.ms}ms`);
    assert.ok(/hedge/.test(plog), 'A: the log must mention the hedge');
    console.log(`A ok: ${a.ms}ms, attempts to the gateway ${seen}`);

    // --- B: transient 500 -> the next attempt goes through ---
    mode = 'transient'; seen = 0;
    const b = await ask();
    assert.strictEqual(b.status, 200, 'B: a retry must go through after a transient 500');
    assert.ok(b.body.includes('message_stop'), 'B: body of the real SSE');
    assert.ok(seen >= 2, `B: there must be a retry, attempts ${seen}`);
    console.log(`B ok: ${b.ms}ms, attempts to the gateway ${seen}`);

    // --- C: permanent error passed through as-is, no retries ---
    mode = 'permanent'; seen = 0;
    const c = await ask();
    assert.strictEqual(c.status, 403, 'C: a permanent error is passed to the client');
    assert.ok(c.body.includes('无权'), 'C: the error body arrives intact');
    assert.strictEqual(seen, 1, `C: a permanent error must not be retried, attempts ${seen}`);
    console.log(`C ok: ${c.ms}ms, attempts to the gateway ${seen}`);

    // --- D: pre-commit keeps the client alive with a ping and does not spoil the stream ---
    mode = 'slow'; seen = 0; lastAcceptEncoding = null;
    const d = await ask();
    assert.strictEqual(d.status, 200, 'D: client gets 200');
    assert.ok(d.body.includes('event: ping'), 'D: pre-commit should have sent event: ping');
    assert.ok(d.body.includes('data: {"type":"ping"}\n\n'), 'D: ping is a whole SSE event with a blank line at the end');
    assert.ok(d.body.indexOf('event: ping') < d.body.indexOf('message_start'), 'D: ping arrives BEFORE the gateway\'s first event');
    assert.ok(d.body.includes('message_stop'), 'D: and the real SSE on top of the ping');
    assert.ok(!d.body.includes('event: error'), 'D: there must be no error');
    assert.strictEqual(lastAcceptEncoding, 'identity',
      `D: the gateway must be denied compression, but got "${lastAcceptEncoding}"`);
    assert.ok(/pre-commit SSE/.test(plog), 'D: the log must mention the pre-commit');
    console.log(`D ok: ${d.ms}ms, ping+SSE, gateway received accept-encoding: identity`);

    // --- E: gateway compressed despite the ban -> honest error, not garbage ---
    mode = 'gzip'; seen = 0;
    const e = await ask();
    assert.strictEqual(e.status, 200, 'E: status was already sent by the pre-commit');
    assert.ok(e.body.includes('event: ping'), 'E: there was a ping');
    assert.ok(e.body.includes('event: error'), 'E: an error must arrive in the stream');
    assert.ok(/compressed the stream/.test(e.body), 'E: the error must name the cause (compression)');
    assert.ok(!e.body.includes('message_stop'), 'E: gzip garbage must not reach the stream');
    console.log(`E ok: ${e.ms}ms, compressed response rejected with an honest error`);

    // --- F: pause MID-event -> comment only, we don't tear the event ---
    mode = 'partial'; seen = 0;
    const f = await ask();
    assert.strictEqual(f.status, 200, 'F: client gets 200');
    assert.ok(f.body.includes('data: {"type":"message_start"}\n: keepalive\n'),
      'F: a comment is inserted mid-event, right after data:');
    assert.ok(!f.body.includes('event: ping'),
      'F: a complete event must not be inserted inside another one');
    assert.ok(f.body.includes('message_stop'), 'F: the event arrived intact');
    // Parsing through the client's eyes: every event block is separated by a blank
    // line and comments are ignored — message_start and message_stop must be found.
    const types = f.body.split('\n\n').flatMap(b => b.split('\n')
      .filter(l => l.startsWith('event: ')).map(l => l.slice(7)));
    assert.deepStrictEqual(types, ['message_start', 'message_stop'],
      `F: the stream must parse into two events, got ${JSON.stringify(types)}`);
    console.log(`F ok: ${f.ms}ms, comment mid-event, stream still parseable`);

    // --- G: /__config mutates live config, so it must refuse browser-driven calls ---
    const panel = (headers) => new Promise((resolve, reject) => {
      const body = '{"remapModel":"claude-opus-5"}';
      const r = http.request({ port: PX_PORT, method: 'POST', path: '/__config', headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      r.on('error', reject);
      r.end(body);
    });
    // text/plain + Origin is a CORS "simple request": a page can send it without a preflight.
    assert.strictEqual(await panel({ 'content-type': 'text/plain', origin: 'https://evil.example' }), 403,
      'G: a cross-origin POST to /__config must be refused');
    assert.strictEqual(await panel({ 'content-type': 'application/json' }), 200,
      'G: the panel itself (no Origin) must still be served');
    console.log('G ok: /__config refuses cross-origin, serves the panel');

    console.log('\ntest-hedge OK');
  } catch (err) {
    console.error(`\nFAILED: ${err.message}\n--- proxy log ---\n${plog}`);
    process.exitCode = 1;
  } finally {
    proxy.kill();
    for (const res of held) res.destroy();
    upstream.close();
    try { fs.unlinkSync(TEST_CFG); } catch (err) { /* мог не создаться */ }
  }
})();
