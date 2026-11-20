import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const fast = { intervalMs: 80, timeoutMs: 160, tcpTimeoutMs: 80, ipcTimeoutMs: 80,
  failureThreshold: 3, startupGraceMs: 50, cooldownMs: 50, unhealthyAfterMs: 200,
  activeUnresponsiveAfterMs: 600, drainMs: 1_500, forceKillAfterMs: 100,
  restartBaseMs: 60, restartMaxMs: 300 };
async function until(check, timeout = 12_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await new Promise(r => setTimeout(r, 25)); }
  throw new Error('Timed out waiting for isolated watchdog');
}
async function fixture(extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bridge-watchdog-test-'));
  mkdirSync(join(home, 'src'));
  for (const file of ['supervisor.mjs', 'config.mjs', 'native.mjs']) copyFileSync(new URL('../src/' + file, import.meta.url), join(home, 'src', file));
  copyFileSync(new URL('./fixtures/watchdog-worker.mjs', import.meta.url), join(home, 'src/cli.mjs'));
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(r => reservation.close(r));
  assert.notEqual(port, 17842);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ host: '127.0.0.1', port, cwd: home, agyPath: 'no-agy-in-fixture',
    fixtureServerModule: new URL('../src/server.mjs', import.meta.url).href, ...extra, watchdog: { ...fast, ...extra.watchdog } }));
  const start = () => spawn(process.execPath, [join(home, 'src/supervisor.mjs')], {
    env: { ...process.env, CODEX_ANTIGRAVITY_HOME: home }, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const supervisor = start();
  const events = () => existsSync(join(home, 'logs/supervisor.log')) ? readFileSync(join(home, 'logs/supervisor.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const pid = () => Number(readFileSync(join(home, 'worker.pid')));
  await until(() => existsSync(join(home, 'worker.pid')));
  const first = pid();
  return { home, port, supervisor, events, pid, first, start, base: `http://127.0.0.1:${port}`,
    async cleanup() {
      if (supervisor.exitCode === null) {
        supervisor.send({ type: 'watchdog.shutdown' });
        await Promise.race([once(supervisor, 'close'), new Promise(r => setTimeout(r, 5_000))]);
        if (supervisor.exitCode === null) { supervisor.kill(); throw new Error('Isolated supervisor did not stop'); }
      }
      assert.equal(dirname(home), tmpdir());
      rmSync(home, { recursive: true, force: true });
    } };
}

test('health delay 1s and 3s does not restart the worker', { timeout: 20_000 }, async () => {
  const f = await fixture({ fixtureDelays: [1_000, 3_000], watchdog: { timeoutMs: 5_000 } });
  try {
    await until(() => f.events().filter(e => e.event === 'health_check').length >= 3);
    assert.equal(f.pid(), f.first);
    const durations = f.events().filter(e => e.event === 'health_check').map(e => e.duration_ms);
    assert.ok(durations.some(n => n >= 900)); assert.ok(durations.some(n => n >= 2_900));
    assert.equal(f.events().filter(e => e.event === 'recovery_requested').length, 0);
  } finally { await f.cleanup(); }
});

test('one timeout and two consecutive failures recover without restarting or overlapping checks', async () => {
  const f = await fixture({ fixtureDelays: [700, 0, 700, 700, 0] });
  try {
    await until(() => f.events().filter(e => e.event === 'health_check').length >= 6);
    assert.equal(f.pid(), f.first);
    assert.ok(f.events().some(e => e.event === 'state_changed' && e.state === 'SUSPECT'));
    assert.ok(f.events().some(e => e.event === 'health_check' && e.consecutive_failures === 2));
    assert.equal(f.events().filter(e => e.event === 'recovery_requested').length, 0);
    const checks = f.events().filter(e => e.event === 'health_check');
    for (let i = 1; i < checks.length; i++) {
      assert.ok(Date.parse(checks[i].started_at) >= Date.parse(checks[i - 1].completed_at), 'the next probe must start after the preceding probe completes');
    }
  } finally { await f.cleanup(); }
});

test('persistent HTTP failure uses TCP and IPC confirmation then graceful recovery', async () => {
  const f = await fixture({ fixtureHangHealth: true });
  try {
    await until(() => f.pid() !== f.first);
    await until(() => f.events().some(e => e.event === 'startup_confirmed' && e.worker_pid === f.pid()));
    const recovery = f.events().find(e => e.event === 'recovery_requested');
    assert.equal(recovery.tcp_listening, true); assert.equal(recovery.ipc_responsive, true);
    assert.ok(f.events().some(e => e.event === 'worker_exited' && e.origin === 'watchdog' && e.exit_code === 0));
    assert.equal(f.events().some(e => e.event === 'forced_termination'), false);
  } finally { await f.cleanup(); }
});

for (const mode of ['exit', 'external-kill', 'stop-listening', 'permanent-freeze']) {
  test(`${mode} is recovered in an isolated instance`, { timeout: 12_000 }, async () => {
    const f = await fixture({ watchdog: { drainMs: 180, forceKillAfterMs: 80 } });
    try {
      await until(() => f.events().some(e => e.event === 'startup_confirmed'));
      if (mode === 'external-kill') process.kill(f.first, 'SIGKILL');
      else await fetch(f.base + '/__test/' + (mode === 'permanent-freeze' ? 'freeze' : mode));
      await until(() => f.pid() !== f.first);
      await until(() => f.events().some(e => e.event === 'startup_confirmed' && e.worker_pid === f.pid()));
      if (mode === 'permanent-freeze') assert.ok(f.events().some(e => e.event === 'forced_termination'));
      if (mode === 'stop-listening') assert.ok(f.events().some(e => e.event === 'recovery_requested' && e.tcp_listening === false));
      if (mode === 'exit' || mode === 'external-kill') assert.ok(f.events().some(e => e.event === 'worker_exited' && e.origin === 'unexpected_exit'));
      await until(async () => {
        try { return (await (await fetch(f.base + '/healthz', { headers: { connection: 'close' } })).json()).pid === f.pid(); }
        catch { return false; }
      });
    } finally { await f.cleanup(); }
  });
}

test('3.5s CPU block does not kill a working bridge', { timeout: 15_000 }, async () => {
  const f = await fixture({ watchdog: { timeoutMs: 5_000 } });
  try {
    await until(() => f.events().some(e => e.event === 'startup_confirmed'));
    await fetch(f.base + '/__test/block?ms=3500');
    await until(() => f.events().some(e => e.event === 'health_check' && e.duration_ms >= 3_000));
    assert.equal(f.pid(), f.first);
    assert.equal(f.events().filter(e => e.event === 'recovery_requested').length, 0);
  } finally { await f.cleanup(); }
});

test('a duplicate watchdog exits without spawning another worker', async () => {
  const f = await fixture();
  try {
    const duplicate = f.start();
    const [code] = await once(duplicate, 'close');
    assert.equal(code, 0); assert.equal(f.pid(), f.first);
    assert.equal(Number(readFileSync(join(f.home, 'generation'))), 1);
    assert.ok(f.events().some(e => e.event === 'singleton_refused'));
  } finally { await f.cleanup(); }
});

async function upstream(streamMs = 1_200) {
  const sockets = new Set();
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let n = 0;
    const timer = setInterval(() => res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: String(++n) })}\n\n`), 35);
    const end = setTimeout(() => { clearInterval(timer); res.end('data: [DONE]\n\n'); }, streamMs);
    res.once('close', () => { clearInterval(timer); clearTimeout(end); });
  });
  const frame = value => {
    const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(body.length < 126 ? 2 : 4);
    header[0] = 0x81; header[1] = body.length < 126 ? body.length : 126;
    if (body.length >= 126) header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  };
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.once('data', () => {
      const response = { id: 'response_native_fixture', output: [], status: 'in_progress' };
      socket.write(frame({ type: 'response.created', response }));
      const timer = setInterval(() => socket.write(frame({ type: 'response.output_text.delta', delta: '測' })), 35);
      const end = setTimeout(() => { clearInterval(timer); socket.write(frame({ type: 'response.completed', response: { ...response, status: 'completed' } })); }, streamMs);
      socket.once('close', () => { clearInterval(timer); clearTimeout(end); });
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1`, async close() { for (const socket of sockets) socket.destroy(); await new Promise(r => server.close(r)); } };
}

test('SSE stream survives repeated health failures and recovery waits until completion', async () => {
  const native = await upstream();
  const f = await fixture({ fixtureHangHealth: true, nativeBaseUrl: native.url });
  try {
    const response = await fetch(f.base + '/v1/responses', { method: 'POST', headers: { authorization: 'Bearer isolated-test', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-test', stream: true, input: 'test' }) });
    const text = await response.text();
    assert.match(text, /\[DONE\]/);
    const checks = f.events().filter(e => e.event === 'health_check');
    assert.ok(checks.some(e => e.lifecycle?.active_model_requests === 1 && e.lifecycle.active_sse_streams === 1));
    assert.ok(f.events().some(e => e.event === 'recovery_deferred'));
    await until(() => f.pid() !== f.first);
  } finally { await f.cleanup(); await native.close(); }
});

test('a permanently frozen worker with an active stream is recovered within a bounded time', async () => {
  const native = await upstream(15_000);
  const f = await fixture({ nativeBaseUrl: native.url, watchdog: { drainMs: 180, forceKillAfterMs: 80 } });
  try {
    const response = await fetch(f.base + '/v1/responses', { method: 'POST', headers: { authorization: 'Bearer isolated-test', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-test', stream: true, input: 'test' }) });
    const interrupted = response.text().then(() => false, () => true);
    await until(() => f.events().some(e => e.event === 'health_check' && e.lifecycle?.active_model_requests === 1));
    await fetch(f.base + '/__test/freeze');
    await until(() => f.pid() !== f.first);
    await until(() => f.events().some(e => e.event === 'startup_confirmed' && e.worker_pid === f.pid()));
    assert.equal(await interrupted, true);
    const recovery = f.events().find(e => e.event === 'recovery_requested');
    assert.equal(recovery.lifecycle.active_model_requests, 1);
    assert.equal(recovery.ipc_responsive, false);
    assert.ok(f.events().some(e => e.event === 'forced_termination'));
  } finally { await f.cleanup(); await native.close(); }
});

test('a pending native WebSocket handshake counts as an active model request', async () => {
  const { createBridgeServer, listenBridge } = await import('../src/server.mjs');
  let release;
  const native = createServer();
  const nativeSockets = new Set();
  native.on('connection', socket => { nativeSockets.add(socket); socket.once('close', () => nativeSockets.delete(socket)); });
  native.on('upgrade', (_req, socket) => { release = () => socket.destroy(); });
  native.listen(0, '127.0.0.1'); await once(native, 'listening');
  const bridge = createBridgeServer({ host: '127.0.0.1', port: 0, cwd: process.cwd(), nativeBaseUrl: `http://127.0.0.1:${native.address().port}/v1` }, []);
  await listenBridge(bridge, { host: '127.0.0.1', port: 0 });
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.address().port}/v1/responses`, { headers: { authorization: 'Bearer isolated-test' } });
  try {
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-test', input: 'test' }));
    await until(() => release);
    assert.equal(bridge.bridgeLifecycle.snapshot().active_model_requests, 1);
    release();
    await until(() => bridge.bridgeLifecycle.snapshot().active_model_requests === 0);
  } finally {
    ws.close(); await bridge.shutdown(100);
    for (const socket of nativeSockets) socket.destroy();
    await new Promise(r => native.close(r));
  }
});

test('WebSocket stream drains gracefully before the watchdog exits', async () => {
  const native = await upstream();
  const f = await fixture({ nativeBaseUrl: native.url });
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}/v1/responses`, { headers: { authorization: 'Bearer isolated-test' } });
  try {
    const messages = []; ws.addEventListener('message', e => messages.push(JSON.parse(e.data)));
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-test', input: 'test' }));
    await until(() => messages.some(e => e.type === 'response.output_text.delta'));
    const before = await (await fetch(f.base + '/healthz')).json();
    assert.equal(before.lifecycle.active_model_requests, 1); assert.equal(before.lifecycle.websocket_connections, 1);
    f.supervisor.send({ type: 'watchdog.shutdown' });
    await once(f.supervisor, 'close');
    assert.ok(messages.some(e => e.type === 'response.completed'));
    assert.equal(JSON.parse(readFileSync(join(f.home, 'shutdown-result'))).forced, false);
  } finally { ws.close(); await f.cleanup(); await native.close(); }
});
