import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildAgyPrompt, hasImageInput } from "../src/prompt.mjs";
import { createBridgeServer, expandPreviousResponse, listenBridge } from "../src/server.mjs";
import { createWorkspacePolicy } from "../src/workspace.mjs";
import { buildCodexCatalog } from "../src/models.mjs";

test("workspace boundary accepts a real child and rejects home, siblings and junction escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-scope-"));
  const workspace = join(root, "workspace");
  const child = join(workspace, "child");
  const sibling = join(root, "workspace-other");
  mkdirSync(child, { recursive: true });
  mkdirSync(sibling);
  symlinkSync(sibling, join(workspace, "outside"), process.platform === "win32" ? "junction" : "dir");
  const payload = cwd => ({ input: [{ role: "user", content: `<environment_context><cwd>${cwd}</cwd></environment_context>` }] });
  try {
    const policy = createWorkspacePolicy({ cwd: workspace, allowedWorkspaceRoots: [workspace] });
    assert.equal(policy.resolve(payload(child)).cwd, realpathSync.native(child));
    assert.equal(policy.resolve({ input: [
      { role: "assistant", content: `<environment_context><cwd>${homedir()}</cwd></environment_context>` },
      { type: "function_call_output", output: `<environment_context><cwd>${homedir()}</cwd></environment_context>` },
    ] }).cwd, realpathSync.native(workspace));
    for (const path of [homedir(), sibling, join(workspace, "outside")]) {
      assert.throws(() => policy.resolve(payload(path)), { code: "WORKSPACE_NOT_ALLOWED" });
    }
    for (const path of [homedir(), dirname(homedir())]) {
      assert.throws(() => createWorkspacePolicy({ cwd: workspace, allowedWorkspaceRoots: [path] }), { code: "WORKSPACE_NOT_ALLOWED" });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("follows each Codex chat's recorded workspace, including chats added after Bridge startup", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-codex-workspaces-"));
  const original = join(root, "new-chat");
  const second = join(root, "new-chat-2");
  const child = join(second, "work");
  mkdirSync(original);
  mkdirSync(child, { recursive: true });
  const databasePath = join(root, "state_5.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL)");
  database.prepare("INSERT INTO threads VALUES (?, ?)").run("first-chat", original);
  const policy = createWorkspacePolicy({ cwd: original, allowedWorkspaceRoots: [original], codexStatePath: databasePath });
  const payload = (threadId, cwd) => ({ client_metadata: { thread_id: threadId }, input: cwd ? [{ role: "user", content: `<environment_context><cwd>${cwd}</cwd></environment_context>` }] : [] });
  try {
    assert.throws(() => policy.resolve(payload("second-chat", second)), { code: "WORKSPACE_NOT_ALLOWED" });
    database.prepare("INSERT INTO threads VALUES (?, ?)").run("second-chat", second);
    assert.deepEqual(policy.resolve(payload("second-chat", second)), {
      cwd: realpathSync.native(second), workspaceRoot: realpathSync.native(second), workspaceSource: "codex-thread", codexThreadId: "second-chat",
    });
    assert.equal(policy.resolve(payload("second-chat")).cwd, realpathSync.native(second));
    assert.equal(policy.resolve(payload("second-chat", child)).cwd, realpathSync.native(child));
    assert.throws(() => policy.resolve(payload("first-chat", second)), { code: "WORKSPACE_NOT_ALLOWED" });
    assert.throws(() => policy.resolve(payload("second-chat", original)), { code: "WORKSPACE_NOT_ALLOWED" });
    assert.throws(() => policy.resolve(payload(undefined, second)), { code: "WORKSPACE_NOT_ALLOWED" });
    assert.equal(policy.resolve(payload(undefined)).workspaceSource, "configured");
    assert.deepEqual(policy.roots, [realpathSync.native(original)], "chat-specific access must not widen the fallback roots");
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Codex chat record cannot turn the user profile or its parent into the AGY workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-codex-profile-"));
  const databasePath = join(root, "state_5.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL)");
  const policy = createWorkspacePolicy({ cwd: root, allowedWorkspaceRoots: [root], codexStatePath: databasePath });
  try {
    for (const path of [homedir(), dirname(homedir())]) {
      database.prepare("INSERT OR REPLACE INTO threads VALUES (?, ?)").run("profile-chat", path);
      assert.throws(() => policy.resolve({ client_metadata: { thread_id: "profile-chat" }, input: [] }), { code: "WORKSPACE_NOT_ALLOWED" });
    }
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("latest question stays last and historical screenshots no longer trigger preflight", () => {
  const payload = { input: [
    { role: "user", content: [{ type: "input_text", text: "修復舊斷線問題" }, { type: "input_image", path: "old-error.png" }] },
    { role: "assistant", content: "舊問題已修復" },
    { role: "user", content: "那你的上下文緩存真的只有1000k嗎？" },
  ] };
  assert.equal(hasImageInput(payload), false);
  const prompt = buildAgyPrompt(payload);
  assert.doesNotMatch(prompt, /MANDATORY IMAGE PREFLIGHT|MUST call the view_file/);
  assert.match(prompt, /Historical image attachment/);
  assert.ok(prompt.endsWith("CURRENT USER REQUEST — answer this turn:\n那你的上下文緩存真的只有1000k嗎？"));
  const currentImage = { input: [{ role: "user", content: [{ type: "input_text", text: "看本回合圖片" }, { type: "input_image", path: "current.png" }] }] };
  assert.equal(hasImageInput(currentImage), true);
  const withObservations = buildAgyPrompt(currentImage, { imageContext: "本回合畫面" });
  assert.ok(withObservations.indexOf("本回合畫面") < withObservations.indexOf("CURRENT USER REQUEST" + " —"));
});

test("AGY continuations expand canonical bridge history instead of resuming an old CLI session", () => {
  const states = new Map([["resp_agy", { items: [{ role: "user", content: "first" }, { role: "assistant", content: "answer" }] }]]);
  const expanded = expandPreviousResponse({ previous_response_id: "resp_agy", input: "LATEST" }, states, { conversations: new Map([["resp_agy", "old-cli"]]) });
  assert.equal(expanded.previous_response_id, undefined);
  assert.deepEqual(expanded.input.map(x => x.content), ["first", "answer", "LATEST"]);
});

test("catalog publishes confirmed Gemini and Claude context sizes without altering native limits", () => {
  const catalog = buildCodexCatalog([
    { id: "gemini-4-hydrogen-low", displayName: "Gemini 4 Hydrogen (Low)" },
    { id: "claude-5.5-opus-high", displayName: "Claude 5.5 Opus (High)" },
  ], { models: [{ slug: "gpt-native", context_window: 400_000, supported_reasoning_levels: [] }] });
  assert.equal(catalog.models[0].context_window, 400_000);
  assert.equal(catalog.models[1].context_window, 1_048_576);
  assert.equal(catalog.models[1].auto_compact_token_limit, 838_860);
  assert.equal(catalog.models[2].context_window, 1_000_000);
});

test("invalid AGY workspace rejects AGY while native routing and health stay available", async () => {
  const native = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "native-ok", output: [], output_text: "NATIVE_OK" }));
  });
  native.listen(0, "127.0.0.1");
  await once(native, "listening");
  const config = { host: "127.0.0.1", port: 0, cwd: homedir(), allowedWorkspaceRoots: [homedir()], agyPath: "must-not-start", nativeBaseUrl: `http://127.0.0.1:${native.address().port}/v1` };
  const bridge = createBridgeServer(config, [{ id: "gemini-test-low", displayName: "Gemini Test (Low)" }]);
  await listenBridge(bridge, config);
  const url = `http://127.0.0.1:${bridge.address().port}`;
  const send = model => fetch(`${url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer local-test" }, body: JSON.stringify({ model, input: "test" }) });
  try {
    const rejected = await send("antigravity/gemini-test");
    assert.equal((await rejected.json()).error.code, "WORKSPACE_NOT_ALLOWED");
    assert.equal((await (await send("gpt-native")).json()).output_text, "NATIVE_OK");
    const health = await (await fetch(`${url}/healthz`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.agy_workspace_ok, false);
  } finally {
    await new Promise(resolve => bridge.close(resolve));
    await new Promise(resolve => native.close(resolve));
  }
});

test("stream sends a public zh-TW reply before AGY, reports waits, scopes spawn, and retains consecutive turns", { timeout: 8_000 }, async t => {
  const requests = [];
  let finishFirst;
  const realSpawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (exe, args, options) => {
    if (exe !== "fixture-agy") return realSpawn(exe, args, options);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 789;
    child.kill = () => { child.killed = true; return true; };
    child.stdin = new Writable({ write(data, encoding, callback) {
      requests.push({ exe, args, cwd: options.cwd, prompt: JSON.parse(data.toString()).message.content });
      const denied = requests.at(-1).prompt.endsWith("\nDENIED");
      const finish = () => child.stdout.write(JSON.stringify({ event: "result", result: {
        status: "SUCCESS", conversation_id: `conv-${requests.length}`, response: JSON.stringify({ message: `ANSWER-${requests.length}`, tool_calls: [] }),
        ...(denied ? { response: "", denied_actions: [{ action: "read_file" }] } : {}),
      } }) + "\n");
      if (requests.length === 1) finishFirst = finish;
      else queueMicrotask(finish);
      callback();
    } });
    return child;
  });
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  const cwd = realpathSync.native(process.cwd());
  const config = { host: "127.0.0.1", port: 0, cwd, allowedWorkspaceRoots: [cwd], agyPath: "fixture-agy", requestTimeoutSec: 60, mode: "accept-edits" };
  const server = createBridgeServer(config, [{ id: "gemini-test-low", displayName: "Gemini Test (Low)" }]);
  await listenBridge(server, config);
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/responses`);
  const events = [];
  client.addEventListener("message", event => events.push(JSON.parse(event.data)));
  await once(client, "open");
  const wait = async predicate => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("fixture event did not arrive");
  };
  try {
    client.send(JSON.stringify({ type: "response.create", model: "antigravity/gemini-test", input: "FIRST", reasoning: { effort: "low" } }));
    await wait(() => finishFirst && events.some(e => e.type === "response.output_text.delta"));
    assert.match(events.find(e => e.type === "response.output_text.delta").delta, /我收到這次的要求/);
    assert.ok(!events.some(e => e.type === "response.completed"));
    t.mock.timers.tick(60_000);
    await wait(() => events.some(e => e.delta?.includes("已等待 60 秒")));
    finishFirst();
    await wait(() => events.some(e => e.type === "response.completed"));
    const first = events.find(e => e.type === "response.completed").response;
    client.send(JSON.stringify({ type: "response.create", model: "antigravity/gemini-test", previous_response_id: first.id, input: "LATEST", reasoning: { effort: "low" } }));
    await wait(() => events.filter(e => e.type === "response.completed").length === 2);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.cwd, cwd);
      assert.ok(!request.args.includes("--dangerously-skip-permissions"));
      assert.ok(!request.args.includes("--conversation"));
      assert.deepEqual(request.args.flatMap((x, i) => x === "--add-dir" ? [request.args[i + 1]] : []), [cwd]);
      const settings = JSON.parse(request.args[request.args.indexOf("--settings") + 1]);
      assert.deepEqual(settings.permissions.allow, []);
      assert.ok(settings.permissions.deny.includes("command(*)"));
      assert.ok(settings.permissions.deny.includes("write_file(*)"));
      assert.equal(settings.toolPermission, "request-review");
    }
    assert.match(requests[1].prompt, /FIRST[\s\S]*ANSWER-1/);
    assert.ok(requests[1].prompt.endsWith("CURRENT USER REQUEST — answer this turn:\nLATEST"));
    const health = await (await fetch(`http://127.0.0.1:${server.address().port}/healthz`)).json();
    assert.equal(health.last_agy_request.cwd, cwd);
    assert.equal(health.last_agy_request.skipPermissions, false);
    client.send(JSON.stringify({ type: "response.create", model: "antigravity/gemini-test", input: [{ role: "user", content: `<environment_context><cwd>${homedir()}</cwd></environment_context>` }], reasoning: { effort: "low" } }));
    await wait(() => events.some(e => e.type === "response.failed"));
    assert.equal(requests.length, 2, "out-of-scope cwd must never start AGY");
    client.send(JSON.stringify({ type: "response.create", model: "antigravity/gemini-test", input: "DENIED", reasoning: { effort: "low" } }));
    await wait(() => events.filter(e => e.type === "response.failed").length === 2);
    const denied = events.filter(e => e.type === "response.failed").at(-1);
    assert.equal(denied.response.error.code, "AGY_PERMISSION_DENIED");
    assert.match(denied.response.error.message, /操作未獲授權/);
  } finally {
    client.close();
    await once(client, "close");
    await new Promise(resolve => server.close(resolve));
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
