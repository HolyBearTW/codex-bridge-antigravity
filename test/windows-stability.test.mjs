import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBridgeServer, listenBridge } from "../src/server.mjs";

async function waitFor(check, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the bridge lifecycle");
}

test("AGY start/exit failures leave native responses, catalog, and health available", { timeout: 10_000 }, async () => {
  const native = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url.startsWith("/v1/models")
      ? { models: [{ slug: "gpt-native", display_name: "Native", supported_reasoning_levels: [{ effort: "low" }] }] }
      : { id: "resp_native", model: "gpt-native", status: "completed", output: [], output_text: "NATIVE_OK" }));
  });
  native.listen(0, "127.0.0.1");
  await once(native, "listening");
  const config = { host: "127.0.0.1", port: 0, cwd: process.cwd(), mode: "plan", requestTimeoutSec: 2,
    agyPath: "agy-executable-does-not-exist", nativeBaseUrl: `http://127.0.0.1:${native.address().port}/v1` };
  const bridge = createBridgeServer(config, [{ id: "gemini-test-low", displayName: "Gemini Test (Low)" }]);
  await listenBridge(bridge, config);
  const url = `http://127.0.0.1:${bridge.address().port}`;
  const headers = { authorization: "Bearer local-test", "content-type": "application/json" };
  try {
    for (const [agyPath, expected] of [["agy-executable-does-not-exist", "AGY_PROCESS"], [process.execPath, "AGY_EXIT"]]) {
      config.agyPath = agyPath;
      const failed = await fetch(`${url}/v1/responses`, { method: "POST", headers,
        body: JSON.stringify({ model: "antigravity/gemini-test", input: "test", reasoning: { effort: "low" } }) });
      assert.equal(failed.status, 502);
      assert.equal((await failed.json()).error.code, expected);
      const response = await fetch(`${url}/v1/responses`, { method: "POST", headers,
        body: JSON.stringify({ model: "gpt-native", input: "test" }) });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).output_text, "NATIVE_OK");
      assert.equal((await fetch(`${url}/healthz`)).status, 200);
    }
    config.agyPath = "agy-executable-does-not-exist";
    const catalog = await fetch(`${url}/v1/models`, { headers });
    assert.equal(catalog.status, 200);
    assert.ok((await catalog.json()).models.some(model => model.slug === "gpt-native"));
  } finally {
    await new Promise(resolve => bridge.close(resolve));
    await new Promise(resolve => native.close(resolve));
  }
});

test("serve starts without a working AGY or a cached model list", { timeout: 10_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-bridge-startup-"));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  writeFileSync(join(home, "config.json"), JSON.stringify({ host: "127.0.0.1", port, models: [], cwd: home, agyPath: "agy-executable-does-not-exist" }));
  const worker = spawn(process.execPath, [fileURLToPath(new URL("../src/cli.mjs", import.meta.url)), "serve"], {
    env: { ...process.env, CODEX_ANTIGRAVITY_HOME: home }, windowsHide: true, stdio: "ignore",
  });
  try {
    await waitFor(async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { return false; }
    });
    assert.equal(worker.exitCode, null);
  } finally {
    worker.kill();
    await once(worker, "close");
    rmSync(home, { recursive: true, force: true });
  }
});

test("supervisor recovers an exited worker and a live worker that stopped listening", { timeout: 65_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-bridge-supervisor-"));
  mkdirSync(join(home, "src"));
  for (const file of ["supervisor.mjs", "config.mjs", "native.mjs"]) copyFileSync(new URL(`../src/${file}`, import.meta.url), join(home, "src", file));
  writeFileSync(join(home, "src", "cli.mjs"), `
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.CODEX_ANTIGRAVITY_HOME;
const config = JSON.parse(readFileSync(join(home, 'config.json')));
const server = createServer((req, res) => res.end(JSON.stringify({service:'codex-bridge-antigravity',pid:process.pid,lifecycle:{active_model_requests:0,active_http_requests:0,last_progress_at:Date.now()}})));
process.on('message', message => {
  if(message.type==='watchdog.status') process.send({type:'watchdog.status',id:message.id,pid:process.pid,lifecycle:{active_model_requests:0,active_http_requests:0,last_progress_at:Date.now()}});
  if(message.type==='watchdog.shutdown') server.close(()=>process.exit(0));
});
server.listen(config.port, '127.0.0.1', () => writeFileSync(join(home,'worker.pid'), String(process.pid)));
setInterval(() => {
  const actionPath = join(home,'action');
  if (!existsSync(actionPath)) return;
  const action = readFileSync(actionPath,'utf8');
  unlinkSync(actionPath);
  if (action === 'exit') process.exit(7);
  if (action === 'stop-listening') server.close();
},100);
`);
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  writeFileSync(join(home, "config.json"), JSON.stringify({ host: "127.0.0.1", port, cwd: home,
    watchdog: { intervalMs:100,timeoutMs:200,tcpTimeoutMs:100,ipcTimeoutMs:100,startupGraceMs:100,cooldownMs:100,
      unhealthyAfterMs:200,drainMs:200,forceKillAfterMs:100,restartBaseMs:50,restartMaxMs:100 } }));
  const supervisor = spawn(process.execPath, [join(home, "src", "supervisor.mjs")], {
    env: { ...process.env, CODEX_ANTIGRAVITY_HOME: home }, windowsHide: true, stdio: "ignore",
  });
  const pidPath = join(home, "worker.pid");
  try {
    const first = await waitFor(() => existsSync(pidPath) && readFileSync(pidPath, "utf8"));
    writeFileSync(join(home, "action"), "exit");
    const second = await waitFor(() => readFileSync(pidPath, "utf8") !== first && readFileSync(pidPath, "utf8"));
    writeFileSync(join(home, "action"), "stop-listening");
    await waitFor(() => readFileSync(pidPath, "utf8") !== second, 45_000);
    const log = readFileSync(join(home, "logs", "supervisor.log"), "utf8");
    assert.match(log, /"exit_code":7/);
    assert.match(log, /persistent_service_failure/);
  } finally {
    if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(supervisor.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else supervisor.kill("SIGTERM");
    await once(supervisor, "close");
    rmSync(home, { recursive: true, force: true });
  }
});
