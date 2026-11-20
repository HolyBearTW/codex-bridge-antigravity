import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { parseAgyLine } from "../src/agy.mjs";
import {
  buildAgyPrompt,
  decodeCompactionSummary,
  encodeCompactionSummary,
  scrubBridgeArtifactsForNative,
} from "../src/prompt.mjs";
import { buildCodexCatalog, isAllowedAgyModel, parseAgyModels } from "../src/models.mjs";
import { createBridgeServer, expandPreviousResponse, listenBridge } from "../src/server.mjs";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function serverFrame(value) {
  const payload = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  if (payload.length <= 125) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function attachNativeFrames(socket, onMessage) {
  let buffer = Buffer.alloc(0);
  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let headerLength = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        headerLength = 4;
      }
      const total = headerLength + (masked ? 4 : 0) + length;
      if (buffer.length < total) return;
      const mask = masked ? buffer.subarray(headerLength, headerLength + 4) : undefined;
      const payload = Buffer.from(buffer.subarray(headerLength + (masked ? 4 : 0), total));
      buffer = buffer.subarray(total);
      if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      if ((first & 0x0f) === 0x1) onMessage(payload.toString("utf8"));
      if ((first & 0x0f) === 0x8) {
        socket.write(Buffer.from([0x88, 0]));
        socket.end();
        return;
      }
    }
  });
}

function waitFor(predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const value = predicate();
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error("Timed out waiting for test condition"));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise(resolve => server.close(resolve));
}

test("parses AGY stream-json events", () => {
  assert.equal(parseAgyLine('{"event":"step_update","step_update":{"text_delta":"ok"}}').kind, "step");
  assert.equal(parseAgyLine('{"event":"result","result":{"status":"SUCCESS"}}').kind, "result");
  assert.equal(parseAgyLine("not json").kind, "unknown");
});

test("parses the live agy models table shape", () => {
  const models = parseAgyModels("gemini-3.8-flash-low    Gemini 3.8 Flash (Low)\nclaude-sonnet-4-6  Claude Sonnet 4.6 (Thinking)");
  assert.deepEqual(models.map(model => model.id), ["gemini-3.8-flash-low", "claude-sonnet-4-6"]);
});

test("uses available Gemini and Claude models without a version allowlist", () => {
  assert.equal(isAllowedAgyModel("gemini-3.8-flash-high"), true);
  assert.equal(isAllowedAgyModel("gemini-3.8-flash-medium"), true);
  assert.equal(isAllowedAgyModel("gemini-3.8-flash-low"), true);
  assert.equal(isAllowedAgyModel("gemini-3.9-flash-high"), true);
  assert.equal(isAllowedAgyModel("gemini-4.0-flash"), true);
  assert.equal(isAllowedAgyModel("antigravity/gemini-3.8-flash-high"), true);
  assert.equal(isAllowedAgyModel({ id: "antigravity/gemini-3.8-flash-low" }), true);

  assert.equal(isAllowedAgyModel("gemini-4-argon-high"), true);
  assert.equal(isAllowedAgyModel("gemini-4-hydrogen-xhigh"), true);
  assert.equal(isAllowedAgyModel("gemini-5-new-family-medium"), true);
  assert.equal(isAllowedAgyModel("gemini-3.1-pro-high"), true);
  assert.equal(isAllowedAgyModel("claude-sonnet-4-6"), true);
  assert.equal(isAllowedAgyModel("gpt-oss-120b-medium"), false);
});

test("builds a prompt from Responses input", () => {
  const prompt = buildAgyPrompt({
    instructions: "Be concise.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Reply AGY_OK" }] }],
  });
  assert.match(prompt, /System instructions/);
  assert.match(prompt, /Reply AGY_OK/);
});

test("round-trips bridge compaction summaries into the next prompt", () => {
  const encoded = encodeCompactionSummary("keep the router change");
  assert.equal(decodeCompactionSummary(encoded), "keep the router change");
  assert.match(buildAgyPrompt({ input: [{ type: "compaction", encrypted_content: encoded }] }), /router change/);
});

test("scrubs bridge compaction items before native passthrough", () => {
  const encoded = encodeCompactionSummary("switch back to GPT");
  const payload = { previous_response_id: "resp_bridge", input: [{ type: "compaction", encrypted_content: encoded }] };
  const scrubbed = scrubBridgeArtifactsForNative(payload);
  assert.equal(scrubbed.previous_response_id, undefined);
  assert.deepEqual(scrubbed.input[0], {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Compaction summary:\nswitch back to GPT" }],
  });
});

test("adds Antigravity routes to a Codex catalog", () => {
  const catalog = buildCodexCatalog([{ id: "gemini-3.8-flash-low", displayName: "Gemini 3.8 Flash (Low)" }]);
  const model = catalog.models.find(model => model.slug === "antigravity/gemini-3.8-flash");
  assert.ok(model);
  assert.equal(model.display_name, "Gemini 3.8 Flash");
  assert.deepEqual(model.supported_reasoning_levels.map(level => level.effort), ["low"]);
  assert.equal(catalog.models.find(model => model.slug === "antigravity/gemini-3.8-flash-low").visibility, "hide");
  assert.equal(model.use_responses_lite, false);
  assert.deepEqual(model.input_modalities, ["text", "image"]);
  assert.equal(model.context_window, 1_048_576);
  assert.equal(model.max_context_window, 1_048_576);
  assert.equal(model.auto_compact_token_limit, 838_860);
});

test("groups GPT then Gemini then Claude and uses the correct remaining quota", () => {
  const source={models:[{slug:"gpt-a",priority:0,supported_reasoning_levels:[]},{slug:"gpt-b",priority:3,supported_reasoning_levels:[]}]};
  const usage={fetchedAt:"2026-11-13T13:00:00Z",groups:[
    {name:"Gemini Models",buckets:[{id:"gemini-weekly",window:"weekly",name:"Weekly",remainingFraction:.91}]},
    {name:"Claude and GPT models",buckets:[{id:"3p-weekly",window:"weekly",name:"Weekly",remainingFraction:.46}]},
    {name:"Gemini 4 Argon",buckets:[{id:"gemini-argon-wtu-weekly",window:"weekly",name:"Weekly",remainingFraction:.0025}]},
  ]};
  const catalog=buildCodexCatalog([
    {id:"claude-sonnet-5-5-low",displayName:"Claude Sonnet 5.5 (Low)"},
    {id:"gemini-4-hydrogen-low",displayName:"Gemini 4 Hydrogen (Low)"},
    {id:"gemini-4-argon-high",displayName:"Gemini 4 Argon (High)"},
  ],source,usage).models.filter(model => model.visibility !== "hide").toSorted((a,b)=>a.priority-b.priority);
  assert.deepEqual(catalog.map(m=>m.slug),["gpt-a","gpt-b","antigravity/gemini-4-hydrogen","antigravity/gemini-4-argon","antigravity/claude-sonnet-5-5"]);
  assert.match(catalog[2].display_name,/91%/);
  assert.match(catalog[3].display_name,/0\.3%/);
  assert.match(catalog[4].display_name,/46%/);
});

test("preserves native reasoning accounting and context limits from the upstream catalog", () => {
  const source = { models: [
    { slug: "gpt-inclusive", priority: 2, use_responses_lite: true, context_window: 500_000, max_context_window: 872_000, auto_compact_token_limit: null, supported_reasoning_levels: [] },
    { slug: "gpt-compatibility", priority: 4, use_responses_lite: false, context_window: 272_000, supported_reasoning_levels: [] },
    { slug: "gpt-unspecified", priority: 6, supported_reasoning_levels: [] },
  ] };
  const catalog = buildCodexCatalog([
    { id: "gemini-4-hydrogen-low", displayName: "Gemini 4 Hydrogen (Low)" },
    { id: "claude-sonnet-5-5-low", displayName: "Claude Sonnet 5.5 (Low)" },
  ], source);
  assert.deepEqual(catalog.models.slice(0, source.models.length), source.models.map((model, priority) => ({ ...model, priority })));
  for (const model of catalog.models.filter(model => model.slug.startsWith("antigravity/"))) assert.equal(model.use_responses_lite, false);
  assert.equal(source.models[0].use_responses_lite, true);
});

test("lists a model once with its available reasoning levels and keeps old IDs hidden", () => {
  const catalog = buildCodexCatalog([
    { id: "gemini-4-hydrogen-high", displayName: "Gemini 4 Hydrogen (High)" },
    { id: "gemini-4-hydrogen-xhigh", displayName: "Gemini 4 Hydrogen (XHigh)" },
    { id: "gemini-4-hydrogen-low", displayName: "Gemini 4 Hydrogen (Low)" },
    { id: "gemini-4-hydrogen-medium", displayName: "Gemini 4 Hydrogen (Medium)" },
    { id: "gemini-5-new-family-max", displayName: "Gemini 5 New Family (Max)" },
    { id: "gemini-5-new-family-low", displayName: "Gemini 5 New Family (Low)" },
  ], { models: [] });
  const visible = catalog.models.filter(model => model.visibility === "list");
  assert.deepEqual(visible.map(model => model.slug), ["antigravity/gemini-4-hydrogen", "antigravity/gemini-5-new-family"]);
  assert.deepEqual(visible[0].supported_reasoning_levels.map(level => level.effort), ["low", "medium", "high", "xhigh"]);
  assert.equal(visible[0].default_reasoning_level, "medium");
  assert.deepEqual(visible[1].supported_reasoning_levels.map(level => level.effort), ["low", "max"]);
  assert.equal(visible[1].default_reasoning_level, "low");
  const previous = catalog.models.find(model => model.slug === "antigravity/gemini-4-hydrogen-xhigh");
  assert.equal(previous.visibility, "hide");
  assert.equal(previous.default_reasoning_level, "xhigh");
  assert.deepEqual(previous.supported_reasoning_levels, visible[0].supported_reasoning_levels);
});

test("extracts image paths and metadata in buildAgyPrompt", () => {
  const prompt = buildAgyPrompt({
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Look at this screenshot:" },
          { type: "input_image", file_path: "/path/to/screenshot.png", name: "screenshot.png" },
          { type: "image_url", image_url: { url: "https://example.com/remote.png" } },
          { type: "image", image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" },
        ],
      },
    ],
  });
  assert.match(prompt, /System instructions:[\s\S]*MANDATORY IMAGE PREFLIGHT/);
  assert.match(prompt, /\[Image attachment: \/path\/to\/screenshot\.png \(screenshot\.png\)\]/);
  assert.match(prompt, /MUST call the view_file tool/);
  assert.match(prompt, /\[Image URL: https:\/\/example\.com\/remote\.png\]/);
  assert.match(prompt, /\[Image attachment: .*[\\/]cache[\\/]images[\\/][a-f0-9]+\.png\]/);
});

test("formats custom_tool_call and custom_tool_call_output in buildAgyPrompt", () => {
  const prompt = buildAgyPrompt({
    input: [
      {
        role: "assistant",
        content: [
          { type: "custom_tool_call", name: "exec", call_id: "call_abc123", arguments: '{"cmd":"git status"}' },
        ],
      },
      {
        role: "user",
        content: [
          { type: "custom_tool_call_output", call_id: "call_abc123", output: "On branch main\nnothing to commit" },
        ],
      },
    ],
  });
  assert.match(prompt, /Tool call \(exec\):\n\{"cmd":"git status"\}/);
  assert.match(prompt, /Tool output \(call_abc123\):\nOn branch main/);
});

test("expandPreviousResponse preserves previous_response_id for native-to-native continuations", () => {
  const conversations = new Map();
  const responseStates = new Map();
  responseStates.set("resp_native_prev", {
    items: [{ role: "assistant", content: [{ type: "custom_tool_call", call_id: "call_test" }] }],
  });

  // Native -> Native: previous_response_id MUST be preserved
  const nativePayload = {
    model: "gpt-5.6-luna",
    previous_response_id: "resp_native_prev",
    input: [{ type: "custom_tool_call_output", call_id: "call_test", output: "ok" }],
  };
  const expandedNative = expandPreviousResponse(nativePayload, responseStates, { native: true, conversations });
  assert.equal(expandedNative.previous_response_id, "resp_native_prev");
  assert.equal(expandedNative.input.length, 1);

  // Antigravity -> Native: previous_response_id MUST be deleted and history expanded
  conversations.set("resp_agy_prev", "conv_agy_123");
  responseStates.set("resp_agy_prev", {
    items: [{ role: "assistant", content: [{ type: "output_text", text: "agy answer" }] }],
  });
  const switchedToNative = {
    model: "gpt-5.6-luna",
    previous_response_id: "resp_agy_prev",
    input: [{ role: "user", content: "hello again" }],
  };
  const expandedSwitched = expandPreviousResponse(switchedToNative, responseStates, { native: true, conversations });
  assert.equal(expandedSwitched.previous_response_id, undefined);
  assert.equal(expandedSwitched.input.length, 2);
  assert.equal(expandedSwitched.input[0].content[0].text, "agy answer");
});

test("handles Antigravity warmup without starting a model and retains its input", { timeout: 8_000 }, async () => {
  const config = { host: "127.0.0.1", port: 0, agyPath: "must-not-start", cwd: process.cwd() };
  const bridge = createBridgeServer(config, [{ id: "gemini-4-hydrogen-xhigh", displayName: "Gemini 4 Hydrogen (XHigh)" }]);
  await listenBridge(bridge, config);
  const client = new WebSocket(`ws://127.0.0.1:${bridge.address().port}/v1/responses`);
  const events = [];
  client.addEventListener("message", event => events.push(JSON.parse(event.data)));
  await once(client, "open");
  try {
    client.send(JSON.stringify({ type: "response.create", model: "antigravity/gemini-4-hydrogen-xhigh", generate: false, input: "remember this" }));
    const completed = await waitFor(() => events.find(event => event.type === "response.completed"));
    assert.match(completed.response.id, /^resp_agy_warmup_/);
    assert.deepEqual(completed.response.output, []);
    assert.equal(completed.response.usage.total_tokens, 0);
    const states = new Map([[completed.response.id, { items: [{ role: "user", content: "remember this" }] }]]);
    for (const native of [false, true]) {
      const expanded = expandPreviousResponse({ previous_response_id: completed.response.id, input: "continue" }, states, { native });
      assert.equal(expanded.previous_response_id, undefined);
      assert.equal(expanded.input[0].content, "remember this");
    }
  } finally {
    client.close();
    await once(client, "close");
    await closeServer(bridge);
  }
});

for (const [status, message] of [[400, "Unknown model"], [401, "Unauthorized"], [429, "Quota exceeded"]]) {
  test(`preserves unrelated native WebSocket errors (${status})`, { timeout: 8_000 }, async () => {
    const upstreamSockets = new Set();
    const upstream = createServer();
    const error = { type: "error", status, error: { type: "invalid_request_error", message } };
    upstream.on("upgrade", (req, socket) => {
      upstreamSockets.add(socket);
      const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}${WS_GUID}`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      attachNativeFrames(socket, () => socket.write(serverFrame(error)));
    });
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const config = { host: "127.0.0.1", port: 0, cwd: process.cwd(), nativeBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1` };
    const bridge = createBridgeServer(config, []); await listenBridge(bridge, config);
    const client = new WebSocket(`ws://127.0.0.1:${bridge.address().port}/v1/responses`, { headers: { authorization: "Bearer fixture" } });
    const events = [], closed = once(client, "close");
    client.addEventListener("message", event => events.push(JSON.parse(event.data)));
    await once(client, "open");
    try {
      client.send(JSON.stringify({ type: "response.create", model: "gpt-native", input: "check error forwarding" }));
      const received = await waitFor(() => events.find(event => event.type === "error"));
      assert.deepEqual(received, error);
      assert.equal(client.readyState, WebSocket.OPEN);
    } finally {
      client.close(); await closed;
      for (const socket of upstreamSockets) socket.destroy();
      await closeServer(bridge); await closeServer(upstream);
    }
  });
}

test("routes each WebSocket request by model and keeps the client connection alive", async t => {
  const agyDir = mkdtempSync(join(tmpdir(), "codex-bridge-agy-"));
  const agyPath = join(agyDir, "agy.cjs");
  writeFileSync(agyPath, `if (process.argv[2] === "models") {
  console.log("gemini-3.8-flash-low Gemini 3.8 Flash (Low)");
  return;
}
const index = process.argv.indexOf("--model");
const model = index >= 0 ? process.argv[index + 1] : "unknown";
process.stdin.once("data", () => {
  const conversationId = "conversation-" + model;
  const lines = [
    { event: "init", conversation_id: conversationId },
    { event: "step_update", step_update: { conversation_id: conversationId, text_delta: "AGY:" + model } },
    { event: "result", result: { status: "SUCCESS", response: JSON.stringify({ message: "AGY:" + model, tool_calls: [] }), conversation_id: conversationId, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  process.stdout.write(lines.map(line => JSON.stringify(line)).join("\\n") + "\\n", () => process.exit(0));
});
`);
  const realSpawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (exe, args, options) =>
    exe === agyPath ? realSpawn(process.execPath, [agyPath, ...args], options) : realSpawn(exe, args, options));
  syncBuiltinESMExports();

  const nativeRequests = [];
  const nativeSockets = new Set();
  let nativeResponseNumber = 0;
  const nativeServer = createServer((req, res) => {
    if (req.url?.startsWith("/v1/models")) {
      const body = JSON.stringify({ models: [{ slug: "gpt-native", supported_reasoning_levels: [{ effort: "high" }] }] });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  nativeServer.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"));
    nativeSockets.add(socket);
    attachNativeFrames(socket, text => {
      const payload = JSON.parse(text);
      if (payload.type !== "response.create") return;
      nativeRequests.push(payload);
      const id = `native_${++nativeResponseNumber}`;
      const response = {
        id,
        object: "response",
        status: "completed",
        model: payload.model,
        output: [],
        output_text: "native",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
      socket.write(serverFrame({ type: "response.created", response: { ...response, status: "in_progress" } }));
      socket.write(serverFrame({ type: "response.completed", response }));
    });
  });
  nativeServer.listen(0, "127.0.0.1");
  await once(nativeServer, "listening");
  const nativePort = nativeServer.address().port;

  const config = {
    host: "127.0.0.1",
    port: 0,
    agyPath,
    cwd: process.cwd(),
    mode: "accept-edits",
    requestTimeoutSec: 5,
    nativeBaseUrl: `http://127.0.0.1:${nativePort}/v1`,
  };
  const bridge = createBridgeServer(config, [{ id: "gemini-3.8-flash-low", displayName: "Gemini 3.8 Flash (Low)" }]);
  await listenBridge(bridge, config);
  const bridgePort = bridge.address().port;
  let client;
  const events = [];
  try {
    const catalogResponse = await fetch(`http://127.0.0.1:${bridgePort}/v1/models`, {
      headers: { authorization: "Bearer test" },
    });
    const catalog = await catalogResponse.json();
    const agyModel = catalog.models.find(model => model.slug === "antigravity/gemini-3.8-flash-low");
    assert.equal(agyModel.context_window, 1_048_576);
    assert.equal(agyModel.max_context_window, 1_048_576);
    assert.equal(agyModel.auto_compact_token_limit, 838_860);

    client = new WebSocket(`ws://127.0.0.1:${bridgePort}/v1/responses`, {
      headers: { authorization: "Bearer test" },
    });
    client.addEventListener("message", event => events.push(JSON.parse(event.data)));
    await new Promise((resolve, reject) => {
      client.addEventListener("open", resolve, { once: true });
      client.addEventListener("error", reject, { once: true });
    });

    client.send(JSON.stringify({ type: "response.create", model: "gpt-native", input: "native one" }));
    await waitFor(() => nativeRequests.length === 1 && events.some(event => event.type === "response.completed" && event.response?.model === "gpt-native"));

    client.send(JSON.stringify({ type: "response.create", model: "antigravity/gemini-3.8-flash-low", input: "agy one" }));
    await waitFor(() => events.some(event => event.type === "response.completed" && event.response?.model === "antigravity/gemini-3.8-flash-low"));
    assert.equal(client.readyState, WebSocket.OPEN);

    client.send(JSON.stringify({ type: "response.create", model: "gpt-native", input: "native two" }));
    await waitFor(() => nativeRequests.length === 2 && events.filter(event => event.type === "response.completed" && event.response?.model === "gpt-native").length === 2);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (client && client.readyState < WebSocket.CLOSING) client.close();
    for (const socket of nativeSockets) socket.destroy();
    await closeServer(bridge);
    await closeServer(nativeServer);
    rmSync(agyDir, { recursive: true, force: true });
  }
});
