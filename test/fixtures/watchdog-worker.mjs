import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.CODEX_ANTIGRAVITY_HOME;
const config = JSON.parse(readFileSync(join(home, 'config.json')));
const { createBridgeServer, listenBridge } = await import(config.fixtureServerModule);
let generation = 1;
try { generation = Number(readFileSync(join(home, 'generation'))) + 1; } catch {}
writeFileSync(join(home, 'generation'), String(generation));
const server = createBridgeServer(config, []);
const original = server.listeners('request')[0];
server.removeListener('request', original);
let healthNumber = 0;
let pendingHealth = 0;
let maxPendingHealth = 0;
server.on('request', (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__test/exit') { res.end('exiting'); setTimeout(() => process.exit(7), 10); return; }
  if (url.pathname === '/__test/freeze') { res.end('freezing'); setTimeout(() => { for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }, 30); return; }
  if (url.pathname === '/__test/block') {
    res.end('blocking');
    setTimeout(() => { const until = Date.now() + Number(url.searchParams.get('ms')); while (Date.now() < until) Math.sqrt(Date.now()); }, 20);
    return;
  }
  if (url.pathname === '/__test/stop-listening') { res.end('stopping listener'); server.close(); return; }
  if (url.pathname === '/healthz') {
    pendingHealth++;
    maxPendingHealth = Math.max(maxPendingHealth, pendingHealth);
    writeFileSync(join(home, 'health-concurrency'), String(maxPendingHealth));
    res.once('close', () => pendingHealth--);
    const delay = generation === 1 ? config.fixtureDelays?.[healthNumber++] ?? (config.fixtureHangHealth ? -1 : 0) : 0;
    if (delay < 0) return;
    const timer = setTimeout(() => { if (!res.destroyed) void original(req, res); }, delay);
    res.once('close', () => clearTimeout(timer));
    return;
  }
  void original(req, res);
});
await listenBridge(server, config);
writeFileSync(join(home, 'worker.pid'), String(process.pid));
process.on('message', message => {
  if (message.type === 'watchdog.status' && process.connected) {
    process.send({ type: 'watchdog.status', id: message.id, pid: process.pid, lifecycle: server.bridgeLifecycle.snapshot() });
  }
  if (message.type === 'watchdog.shutdown') {
    void server.shutdown(message.timeoutMs).then(result => {
      writeFileSync(join(home, 'shutdown-result'), JSON.stringify(result));
      process.exit(0);
    });
  }
});
