import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, writeSync } from 'node:fs';
import { get as getHttp } from 'node:http';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appHome, loadConfig } from './config.mjs';

const config = loadConfig();
const limits = {
  intervalMs: 5_000, timeoutMs: 5_000, tcpTimeoutMs: 1_000, ipcTimeoutMs: 1_000,
  failureThreshold: 3, startupGraceMs: 30_000, cooldownMs: 30_000,
  unhealthyAfterMs: 30_000, activeUnresponsiveAfterMs: 120_000,
  drainMs: 30_000, forceKillAfterMs: 5_000, restartBaseMs: 3_000, restartMaxMs: 30_000,
  ...config.watchdog,
};
for (const [name, value] of Object.entries(limits)) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid watchdog setting: ${name}`);
}
const directory = appHome();
const logDir = join(directory, 'logs');
mkdirSync(logDir, { recursive: true });
const events = openSync(join(logDir, 'supervisor.log'), 'a');
const stdout = openSync(join(logDir, 'service.log'), 'a');
const stderr = openSync(join(logDir, 'service.error.log'), 'a');
const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const installDirectory = fileURLToPath(new URL('../', import.meta.url));
const pipeId = createHash('sha256').update(`${config.host}:${config.port}`).digest('hex').slice(0, 20);
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\codex-agy-watchdog-${pipeId}` : join(directory, 'watchdog.sock');
let worker;
let state = 'COOLDOWN';
let stopping = false;
let startedAt = 0;
let failures = 0;
let failedSince = 0;
let restartStreak = 0;
let restartReason;
let monitorTimer;
let restartTimer;
let forceTimer;
let pendingPing;
let pingId = 0;
let lastSnapshot;
let lastCheck;
let startupConfirmed = false;

function log(event, details = {}) {
  writeSync(events, JSON.stringify({ time: new Date().toISOString(), event, watchdog_pid: process.pid,
    worker_pid: worker?.pid ?? null, state, ...details }) + '\n');
}

function transition(next, reason) {
  if (state === next) return;
  const previous = state;
  state = next;
  log('state_changed', { previous, reason });
}

function tcpListening() {
  return new Promise(resolve => {
    const socket = createConnection({ host: config.host, port: config.port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.setTimeout(limits.tcpTimeoutMs, () => { socket.destroy(); resolve(false); });
  });
}

function ipcStatus(child) {
  return new Promise(resolve => {
    if (!child.connected) { resolve(null); return; }
    const id = ++pingId;
    const timer = setTimeout(() => { pendingPing = undefined; resolve(null); }, limits.ipcTimeoutMs);
    pendingPing = { id, resolve(value) { clearTimeout(timer); pendingPing = undefined; resolve(value); } };
    child.send({ type: 'watchdog.status', id }, error => { if (error && pendingPing?.id === id) pendingPing.resolve(null); });
  });
}

function recover(reason, details) {
  if (!worker || restartReason || stopping) return;
  restartReason = reason;
  transition('UNHEALTHY', reason);
  log('recovery_requested', { reason, ...details });
  transition('RESTARTING', 'graceful_shutdown');
  const target = worker;
  if (target.connected) target.send({ type: 'watchdog.shutdown', timeoutMs: limits.drainMs }, error => {
    if (error) log('graceful_shutdown_send_failed', { error: error.message });
  });
  forceTimer = setTimeout(() => {
    if (target.exitCode !== null || target.signalCode !== null) return;
    log('forced_termination', { reason, deadline_ms: limits.drainMs + limits.forceKillAfterMs });
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(target.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const deadline = setTimeout(() => { killer.kill(); target.kill('SIGKILL'); }, limits.forceKillAfterMs);
      killer.once('close', () => { clearTimeout(deadline); if (target.exitCode === null) target.kill('SIGKILL'); });
      killer.once('error', () => { clearTimeout(deadline); target.kill('SIGKILL'); });
    } else target.kill('SIGKILL');
  }, limits.drainMs + limits.forceKillAfterMs);
}

async function checkHealth() {
  const target = worker;
  if (!target || stopping || restartReason) return;
  const began = Date.now();
  let healthy = false;
  let error;
  let snapshot;
  const result = await new Promise(resolve => {
    let outcome;
    // A dedicated socket avoids stale pooled connections after a worker restart.
    const request = getHttp({ host: config.host, port: config.port, path: '/healthz', agent: false }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.once('end', () => {
        try { outcome = { status: response.statusCode, report: JSON.parse(body) }; }
        catch { outcome = { error: 'INVALID_HEALTH_JSON' }; }
        request.destroy();
      });
      response.once('error', failure => { outcome = { error: failure.code || failure.name }; request.destroy(); });
    });
    const deadline = setTimeout(() => { outcome = { error: 'HTTP_TIMEOUT' }; request.destroy(); }, limits.timeoutMs);
    request.once('error', failure => { outcome = { error: failure.code || failure.name }; });
    request.once('close', () => { clearTimeout(deadline); resolve(outcome || { error: 'HTTP_CLOSED' }); });
  });
  if (result.report) {
    const report = result.report;
    healthy = result.status === 200 && report.service === 'codex-bridge-antigravity' && report.pid === target.pid && !report.lifecycle?.draining;
    if (!healthy) error = `HTTP_${result.status}_IDENTITY_OR_STATUS`;
    snapshot = report.lifecycle;
  } else error = result.error;
  if (worker !== target || stopping || restartReason) return;
  let tcp = true;
  let ipc = true;
  if (!healthy) {
    tcp = await tcpListening();
    const reply = await ipcStatus(target);
    ipc = Boolean(reply);
    if (reply) snapshot = reply.lifecycle;
  }
  if (worker !== target || stopping || restartReason) return;
  if (snapshot) lastSnapshot = snapshot;
  const now = Date.now();
  const warming = now - startedAt < Math.max(limits.startupGraceMs, limits.cooldownMs);
  if (healthy) {
    failures = 0;
    failedSince = 0;
    if (!startupConfirmed) {
      startupConfirmed = true;
      log('startup_confirmed', { recovery_ms: now - startedAt });
    }
    transition(warming ? 'COOLDOWN' : 'HEALTHY', 'health_confirmed');
  } else if (!warming) {
    failures++;
    failedSince ||= now;
    transition(failures === 1 ? 'SUSPECT' : 'DEGRADED', error);
  }
  lastCheck = { started_at: new Date(began).toISOString(), completed_at: new Date(now).toISOString(), duration_ms: now - began,
    healthy, error: error ?? null, consecutive_failures: failures, tcp_listening: tcp,
    ipc_responsive: ipc, lifecycle: lastSnapshot ?? null };
  log('health_check', lastCheck);
  if (healthy || warming || failures < limits.failureThreshold || now - failedSince < limits.unhealthyAfterMs) return;
  const active = (lastSnapshot?.active_model_requests || 0) > 0 || (lastSnapshot?.active_http_requests || 0) > 0;
  const lastProgress = lastSnapshot?.last_progress_at ?? failedSince;
  // A working stream or responsive in-flight request takes precedence over a slow health endpoint.
  if (active && now - lastProgress < limits.activeUnresponsiveAfterMs) {
    log('recovery_deferred', { reason: 'active_requests', lifecycle: lastSnapshot });
    return;
  }
  recover('persistent_service_failure', { failed_for_ms: now - failedSince, tcp_listening: tcp, ipc_responsive: ipc, lifecycle: lastSnapshot });
}

async function startWorker() {
  if (stopping) return;
  if (await tcpListening()) {
    transition('DEGRADED', 'port_already_listening');
    log('start_refused', { reason: 'port_already_listening', port: config.port });
    restartTimer = setTimeout(startWorker, limits.restartMaxMs);
    return;
  }
  startedAt = Date.now();
  failures = 0;
  failedSince = 0;
  restartReason = undefined;
  startupConfirmed = false;
  lastSnapshot = undefined;
  transition('COOLDOWN', 'worker_start');
  const child = spawn(process.execPath, ['--use-system-ca', cliPath, 'serve'], {
    cwd: installDirectory, env: { ...process.env, CODEX_ANTIGRAVITY_HOME: directory },
    windowsHide: true, stdio: ['ignore', stdout, stderr, 'ipc'],
  });
  worker = child;
  log('worker_started', { cli: cliPath, install_directory: installDirectory, agy_cwd: config.cwd });
  child.on('message', message => {
    if (message?.type === 'watchdog.status' && message.pid === child.pid && pendingPing?.id === message.id) pendingPing.resolve(message);
  });
  child.once('error', failure => log('worker_start_failed', { error: failure.message }));
  child.once('close', (code, signal) => {
    clearTimeout(forceTimer);
    pendingPing?.resolve(null);
    log('worker_exited', { exit_code: code, signal, origin: restartReason ? 'watchdog' : 'unexpected_exit', reason: restartReason ?? 'not_requested_by_watchdog' });
    worker = undefined;
    if (stopping) { guard.close(() => process.exit(0)); return; }
    transition('RESTARTING', 'worker_exited');
    const delay = Math.min(limits.restartBaseMs * 2 ** restartStreak++, limits.restartMaxMs);
    log('restart_scheduled', { delay_ms: delay });
    restartTimer = setTimeout(startWorker, delay);
  });
}

const guard = createServer(socket => socket.end(JSON.stringify({ watchdog_pid: process.pid, worker_pid: worker?.pid ?? null, state, lastCheck }) + '\n'));
guard.once('error', failure => {
  log('singleton_refused', { error: failure.code, pipe });
  process.exit(failure.code === 'EADDRINUSE' ? 0 : 1);
});
guard.listen(pipe, () => {
  log('watchdog_started', { pipe, limits });
  void startWorker();
  monitorTimer = setTimeout(async function monitor() {
    try { await checkHealth(); } catch (failure) { log('monitor_error', { error: failure.message }); }
    if (state === 'HEALTHY') restartStreak = 0;
    if (!stopping) monitorTimer = setTimeout(monitor, limits.intervalMs);
  }, limits.intervalMs);
});

const shutdown = () => {
  if (stopping) return;
  clearTimeout(monitorTimer);
  clearTimeout(restartTimer);
  if (worker) recover('watchdog_stopping', {});
  stopping = true;
  if (!worker) guard.close(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.on('message', message => { if (message?.type === 'watchdog.shutdown') shutdown(); });
