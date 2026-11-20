import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { getAgyUsage } from "./usage.mjs";
import * as zlib from "node:zlib";
import {
  agyModelId,
  buildCodexCatalog,
  discoverAgyModels,
  groupAgyModels,
  isAntigravityModel,
  isLegacyBridgeModel,
  routeId,
} from "./models.mjs";
import { buildAgyPrompt, currentVisualInput, encodeCompactionSummary, hasImageInput, imageCacheDir, itemText, latestUserMessage, scrubBridgeArtifactsForNative } from "./prompt.mjs";
import { AgyError, runAgyTurn } from "./agy.mjs";
import { codexTools, HOST_RESPONSE_SCHEMA, parseHostResponse } from "./host-tools.mjs";
import { createWorkspacePolicy } from "./workspace.mjs";
import { BridgeLifecycle } from "./lifecycle.mjs";
import { fetchNative, nativeWebSocketHeaders, nativeWebSocketUrl, pipeNativeResponse } from "./native.mjs";

const MAX_ENCODED_BODY_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_BODY_BYTES = 128 * 1024 * 1024;

function isLocalRequest(req) {
  const host = req.headers.host?.toLowerCase() || "";
  return /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)
    && !["cross-site", "same-site"].includes(req.headers["sec-fetch-site"])
    && (!req.headers.origin || req.headers.origin === `http://${host}`);
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function errorPayload(message, type = "invalid_request_error", code) {
  return { error: { type, message, ...(code ? { code } : {}) } };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_ENCODED_BODY_BYTES) throw new AgyError("Request body is too large", "BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  const encoded = Buffer.concat(chunks);
  const encoding = String(req.headers["content-encoding"] || "identity").trim().toLowerCase();
  let decoded;
  try {
    if (!encoding || encoding === "identity") decoded = encoded;
    else if (encoding === "zstd" && typeof zlib.zstdDecompressSync === "function") decoded = zlib.zstdDecompressSync(encoded);
    else if (encoding === "gzip") decoded = zlib.gunzipSync(encoded);
    else if (encoding === "deflate") decoded = zlib.inflateSync(encoded);
    else if (encoding === "br") decoded = zlib.brotliDecompressSync(encoded);
    else throw new AgyError(`Unsupported Content-Encoding: ${encoding}`, "UNSUPPORTED_ENCODING");
  } catch (error) {
    if (error instanceof AgyError) throw error;
    throw new AgyError(`Could not decompress request body (${encoding}): ${error.message}`, "INVALID_ENCODING");
  }
  if (decoded.byteLength > MAX_DECODED_BODY_BYTES) throw new AgyError("Decoded request body is too large", "BODY_TOO_LARGE");
  try {
    return JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new AgyError("Request body must be valid JSON", "INVALID_JSON");
  }
}

function usage(result) {
  const input = result?.usage?.input_tokens ?? 0;
  const output = result?.usage?.output_tokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: result?.usage?.total_tokens ?? input + output,
    ...(result?.usage?.cache_read_tokens !== undefined
      ? { input_tokens_details: { cached_tokens: result.usage.cache_read_tokens } }
      : {}),
    ...(result?.usage?.thinking_tokens !== undefined
      ? { output_tokens_details: { reasoning_tokens: result.usage.thinking_tokens } }
      : {}),
  };
}

function responseBody({ id, model, text, status = "completed", result }) {
  const itemId = `msg_${randomUUID().replaceAll("-", "")}`;
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: [{
      id: itemId,
      type: "message",
      status: status === "completed" ? "completed" : status,
      role: "assistant",
      content: [{ type: "output_text", text: text || "", annotations: [] }],
    }],
    output_text: text || "",
    usage: result ? usage(result) : null,
  };
}

function sse(res, event, sequence, data) {
  if (res.destroyed || res.writableEnded) return false;
  const payload = responseEvent(event, sequence, data);
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  return true;
}

function responseEvent(event, sequence, data) {
  return { type: event, sequence_number: sequence.value++, ...data };
}

function inputItems(input) {
  if (input === undefined) return [];
  if (typeof input === "string") return [{ role: "user", content: input }];
  return Array.isArray(input) ? input : [input];
}

export function expandPreviousResponse(payload, responseStates, { native = false, conversations } = {}) {
  const previousId = typeof payload?.previous_response_id === "string"
    ? payload.previous_response_id
    : undefined;
  if (!previousId) return payload;

  const isPreviousAgy = conversations?.has(previousId);
  const isWarmup = previousId.startsWith("resp_agy_warmup_");
  // If target is native and previous was also native -> OpenAI upstream already has the session state
  if (native && !isPreviousAgy && !isWarmup) return payload;
  const state = responseStates.get(previousId);
  if (!state) return payload;
  const expanded = {
    ...payload,
    input: [...state.items, ...inputItems(payload.input)],
  };
  delete expanded.previous_response_id;
  return expanded;
}

function rememberResponse(responseStates, payload, response) {
  if (!response || typeof response !== "object" || typeof response.id !== "string" || !Array.isArray(response.output)) return;
  responseStates.set(response.id, {
    items: [
      ...(payload?.previous_response_id ? responseStates.get(payload.previous_response_id)?.items || [] : []),
      ...inputItems(payload?.input), ...structuredClone(response.output),
    ],
  });
  while (responseStates.size > 1_000) responseStates.delete(responseStates.keys().next().value);
}

function imagePreflightPrompt(prompt) {
  const references = [...new Set(String(prompt).split(/\r?\n/)
    .filter(line => /^\[Image (?:attachment|URL):/.test(line)))];
  return [
    "MANDATORY IMAGE PREFLIGHT. Do not answer the user's request yet.",
    "First call view_file for every exact [Image attachment: ...] path below, and use the browser/image reading tool for every [Image URL: ...]. Inspect all visual attachments, wait for the tool results, then reply with a concise factual visual description prefixed IMAGE_CONTEXT:.",
    references.join("\n"),
  ].filter(Boolean).join("\n\n");
}

async function runAgyPrompt({ config, workspace, selected, payload, prompt, signal, onEvent, inspectImages = true, hostTools, jsonSchema, completionInstruction, requestWorkspace = workspace.resolve(payload), conversationId }) {
  const { cwd } = requestWorkspace;
  const attachmentDir = imageCacheDir();
  const addDirs = [];
  const onSpawn = scope => {
    workspace.lastRequest = { ...scope, ...requestWorkspace, cwd: scope.cwd, startedAt: new Date().toISOString(), model: selected.agy, effort: selected.effort, effortSource: selected.effortSource };
    console.log(`AGY request scope: ${JSON.stringify(workspace.lastRequest)}`);
  };
  // A continuation is supplied only after matching the authoritative Codex input and workspace.
  let imageContext = "";
  if (inspectImages && hasImageInput(payload)) {
    const imagePrompt = imagePreflightPrompt(buildAgyPrompt({ input: currentVisualInput(payload) }));
    workspace.imageContexts ||= new Map();
    imageContext = workspace.imageContexts.get(imagePrompt) || "";
    if (!imageContext) {
      const preflight = await runAgyTurn({
        agyPath: config.agyPath,
        cwd: attachmentDir,
        model: selected.agy,
        prompt: imagePrompt,
        mode: "default",
        effort: selected.effort,
        timeoutMs: config.requestTimeoutSec * 1000,
        signal,
        onSpawn,
        onEvent,
      });
      imageContext = String(preflight.response || "").trim();
      workspace.imageContexts.set(imagePrompt, imageContext);
    }
  }
  const result = await runAgyTurn({
    agyPath: config.agyPath,
    cwd,
    model: selected.agy,
    prompt: imageContext ? buildAgyPrompt(payload, { imageContext, hostTools }) : prompt,
    // Codex supplies the collaboration mode and enforces all operations itself.
    // AGY plan mode would prepend /plan and introduce a second approval workflow.
    mode: "default",
    effort: selected.effort,
    conversationId,
    addDirs,
    hostTools: true,
    jsonSchema,
    completionInstruction,
    latestRequest: hostTools ? itemText(latestUserMessage(payload), false) : undefined,
    timeoutMs: config.requestTimeoutSec * 1000,
    signal,
    onEvent: event => {
      if (event.kind === "init") {
        workspace.lastRequest.actualCwd = event.raw.init?.cwd;
        workspace.lastRequest.permissionMode = event.raw.init?.permission_mode;
        console.log(`AGY initialized scope: ${JSON.stringify(workspace.lastRequest)}`);
      }
      onEvent?.(event);
    },
    onSpawn,
  });
  return result;
}

function resolveModel(payload, models, responseStates) {
  if (typeof payload.model !== "string" || !payload.model.trim()) throw new AgyError("model is required", "MODEL_REQUIRED");
  const requested = payload.model.trim();
  if (isLegacyBridgeModel(requested)) {
    throw new AgyError(`Legacy bridge model is not supported: ${requested}`, "MODEL_PROVIDER");
  }
  if (!isAntigravityModel(requested)) return { kind: "native", route: requested, native: requested };
  const id = agyModelId(requested);
  const group = groupAgyModels(models).find(group => group.id === id || group.variants.some(variant => variant.id === id));
  if (!group) {
    throw new AgyError(`Unknown Antigravity model: ${requested}`, "MODEL_NOT_FOUND");
  }
  // Native Codex keeps its base effort and appends durable slider updates to input.
  // The latest update, including one carried by previous_response_id, takes precedence.
  const inputs = [
    ...(payload.previous_response_id ? responseStates.get(payload.previous_response_id)?.items || [] : []),
    ...inputItems(payload.input),
  ];
  const configuredEffort = inputs.findLast(item => item?.type === "configuration_update"
    && item.reasoning?.effort !== undefined)?.reasoning.effort;
  const effort = configuredEffort ?? payload.reasoning?.effort ?? group.variants.find(variant => variant.id === id)?.effort ?? group.defaultEffort;
  const variant = group.variants.find(variant => variant.effort === effort);
  if (!variant) {
    throw new AgyError(`Unsupported reasoning effort '${effort}' for ${requested}; available: ${group.variants.map(variant => variant.effort).join(", ")}`, "UNSUPPORTED_REASONING_EFFORT");
  }
  return { kind: "antigravity", route: routeId(id), agy: variant.id, effort,
    effortSource: configuredEffort != null ? "configuration_update" : payload.reasoning?.effort != null ? "request" : "model_default" };
}

async function runAgyResponse({ config, workspace, selected, payload, conversations, responseStates, announcedTurns, signal, emit }) {
  const effectivePayload = expandPreviousResponse(payload, responseStates, { conversations });
  const tools = codexTools([
    ...(payload.tools || []),
    ...inputItems(effectivePayload.input).flatMap(item => item.type === "tool_search_output" ? item.tools || [] : []),
  ]);
  const requestWorkspace = workspace.resolve(effectivePayload);
  const turnId = payload.client_metadata?.turn_id;
  const threadId = payload.client_metadata?.thread_id;
  const inputs = inputItems(effectivePayload.input);
  const inputKeys = inputs.map(item => createHash("sha256").update(JSON.stringify([
    item.type || "message", item.role || "", item.call_id || "", item.name || "", item.namespace || "", itemText(item, false),
  ])).digest("hex"));
  const scope = createHash("sha256").update(JSON.stringify([
    config.agyPath, selected.agy, selected.effort, requestWorkspace, effectivePayload.instructions, tools,
  ])).digest("hex");
  workspace.agyContinuations ||= new Map();
  const previous = threadId && workspace.agyContinuations.get(threadId);
  const added = previous ? inputs.slice(previous.inputKeys.length) : [];
  const canResume = previous && turnId && previous.turnId === turnId && previous.scope === scope
    && inputKeys.length > previous.inputKeys.length
    && previous.inputKeys.every((key, index) => inputKeys[index] === key)
    && previous.pendingCalls.every(id => added.some(item => item.call_id === id
      && ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(item.type)));
  // Failed/cancelled requests must not leave a resumable branch behind.
  if (threadId) workspace.agyContinuations.delete(threadId);
  const current = latestUserMessage(effectivePayload);
  const promptPayload = canResume ? { ...effectivePayload, input: [
    ...(current !== undefined && !added.includes(current) ? [current] : []), ...added,
  ] } : effectivePayload;
  const prompt = buildAgyPrompt(promptPayload, { hostTools: tools });
  if (!prompt) throw new AgyError("input is required", "INPUT_REQUIRED");
  console.log(JSON.stringify({ time: new Date().toISOString(), event: "agy_context_mode", thread_id: threadId,
    mode: canResume ? "resume" : "fresh", input_items: inputs.length,
    added_items: canResume ? added.length : inputs.length, prompt_bytes: Buffer.byteLength(prompt),
    model: selected.agy, effort: selected.effort, effort_source: selected.effortSource,
    request_effort: payload.reasoning?.effort ?? null }));

  const responseId = `resp_${randomUUID().replaceAll("-", "")}`;
  const sequence = { value: 0 };
  const initial = responseBody({ id: responseId, model: selected.route, text: "", status: "in_progress" });
  initial.output = [];
  emit("response.created", { response: initial }, sequence);

  const output = [];
  const emitMessage = (text, phase) => {
    const item = { id: `msg_${randomUUID().replaceAll("-", "")}`, type: "message", role: "assistant", phase, status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    const output_index = output.length;
    output.push(item);
    emit("response.output_item.added", { output_index, item: { ...item, status: "in_progress", content: [] } }, sequence);
    emit("response.content_part.added", { item_id: item.id, output_index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }, sequence);
    emit("response.output_text.delta", { item_id: item.id, output_index, content_index: 0, delta: text }, sequence);
    emit("response.output_text.done", { item_id: item.id, output_index, content_index: 0, text }, sequence);
    emit("response.content_part.done", { item_id: item.id, output_index, content_index: 0, part: item.content[0] }, sequence);
    emit("response.output_item.done", { output_index, item }, sequence);
  };
  if (!turnId || announcedTurns.get(threadId) !== turnId) {
    emitMessage("我收到這次的要求了，會依這則訊息處理，並在過程中回報進度。", "commentary");
    if (turnId) announcedTurns.set(threadId, turnId);
  }
  const startedAt = Date.now();
  let lastUpdate = startedAt;
  let usingTools = false;
  let contextProgress;
  const progressTimer = setInterval(() => {
    if (Date.now() - lastUpdate < 60_000) return;
    emitMessage(contextProgress && contextProgress.loaded < contextProgress.total
      ? `正在載入對話資料（已完成 ${contextProgress.loaded}/${contextProgress.total} 段）；載入完成後才會繼續判斷下一步。`
      : usingTools
      ? "目前仍在處理本回合所需的操作，還沒有新的結果；完成這個階段後會回報。"
      : `模型仍在處理這則訊息，目前尚未回傳答案（已等待 ${Math.floor((Date.now() - startedAt) / 1000)} 秒）。`, "commentary");
    lastUpdate = Date.now();
  }, 60_000);
  const result = await runAgyPrompt({
    config,
    workspace,
    selected,
    payload: promptPayload,
    prompt,
    requestWorkspace,
    conversationId: canResume ? previous.conversationId : undefined,
    hostTools: tools,
    jsonSchema: HOST_RESPONSE_SCHEMA,
    signal,
    onEvent: event => {
      if (event.kind === "context") contextProgress = event;
      if (event.kind !== "step") return;
      const step = event.step;
      if (step.step_type === "tool") usingTools = !["DONE", "ERROR"].includes(step.state);
      else if (step.step_type === "agent_response") usingTools = false;
    },
  }).finally(() => clearInterval(progressTimer));
  if (result.conversation_id) conversations.set(responseId, result.conversation_id);
  const answer = parseHostResponse(result, tools);
  const finalText = answer.calls.length ? "" : answer.message;
  if (answer.message) emitMessage(answer.message, answer.calls.length ? "commentary" : "final_answer");
  for (const item of answer.calls) {
    const output_index = output.length;
    output.push(item);
    const argumentField = item.type === "custom_tool_call" ? "input" : "arguments";
    emit("response.output_item.added", { output_index, item: { ...item, status: "in_progress" } }, sequence);
    if (item.type !== "tool_search_call") {
      emit(item.type === "custom_tool_call" ? "response.custom_tool_call_input.done" : "response.function_call_arguments.done", { item_id: item.id, output_index, [argumentField]: item[argumentField] }, sequence);
    }
    emit("response.output_item.done", { output_index, item }, sequence);
  }
  const completed = responseBody({ id: responseId, model: selected.route, text: finalText, result });
  completed.output = output;
  emit("response.completed", { response: completed }, sequence);
  rememberResponse(responseStates, effectivePayload, completed);
  if (threadId && turnId && result.conversation_id && answer.calls.length) {
    workspace.agyContinuations.set(threadId, {
      turnId, scope, inputKeys, conversationId: result.conversation_id,
      pendingCalls: answer.calls.map(call => call.call_id),
    });
    while (workspace.agyContinuations.size > 1_000) workspace.agyContinuations.delete(workspace.agyContinuations.keys().next().value);
  }
  return { responseId, response: completed, result };
}

async function runAgyCompaction({ config, workspace, selected, payload, conversations, responseStates, signal }) {
  const effectivePayload = expandPreviousResponse(payload, responseStates, { conversations });
  const source = buildAgyPrompt(effectivePayload);
  if (!source) throw new AgyError("input is required for compaction", "INPUT_REQUIRED");
  const compactionTask = "Summarize the preceding coding conversation for a later continuation. Preserve the user's goals, relevant decisions, file paths, commands, errors, and unfinished work. Be concise and do not invent facts.";
  const prompt = `${source}\n\n${compactionTask}`;
  const result = await runAgyPrompt({
    config,
    workspace,
    selected,
    payload: effectivePayload,
    prompt,
    completionInstruction: compactionTask,
    inspectImages: false,
    signal,
  });
  const responseId = `resp_${randomUUID().replaceAll("-", "")}`;
  if (result.conversation_id) conversations.set(responseId, result.conversation_id);
  const summary = String(result.response || "").trim() || "(no summary available)";
  const item = {
    id: `cmp_${randomUUID().replaceAll("-", "")}`,
    type: "compaction",
    encrypted_content: encodeCompactionSummary(summary),
  };
  const response = {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model: selected.route,
      output: [item],
      output_text: "",
      usage: usage(result),
  };
  rememberResponse(responseStates, effectivePayload, response);
  return { response };
}

function emitCompactionEvents(emit, response) {
  const sequence = { value: 0 };
  const inProgress = { ...response, status: "in_progress", output: [] };
  const item = response.output[0];
  emit("response.created", { response: inProgress }, sequence);
  emit("response.output_item.added", { output_index: 0, item }, sequence);
  emit("response.output_item.done", { output_index: 0, item }, sequence);
  emit("response.completed", { response }, sequence);
}

function isCompactionPayload(payload) {
  return Array.isArray(payload?.input)
    && payload.input.some(item => item && typeof item === "object" && item.type === "compaction_trigger");
}

const MAX_WEBSOCKET_MESSAGE_BYTES = 64 * 1024 * 1024;

function websocketAccept(key) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function writeWebSocketFrame(socket, opcode, value = Buffer.alloc(0)) {
  if (socket.destroyed) return;
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let header;
  if (payload.length <= 125) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length <= 65_535) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function attachWebSocket(socket, onMessage, onClose) {
  let buffer = Buffer.alloc(0);
  let fragmentOpcode = 0;
  const fragments = [];
  let closed = false;

  const close = (code = 1000, reason = "") => {
    if (closed) return;
    closed = true;
    const reasonBytes = Buffer.from(reason).subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    writeWebSocketFrame(socket, 0x8, payload);
    socket.destroySoon();
    onClose?.();
  };

  const parse = () => {
    while (!closed && buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let headerLength = 2;
      if (rsv || !masked) {
        close(1002, "Invalid WebSocket frame");
        return;
      }
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        headerLength = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const longLength = buffer.readBigUInt64BE(2);
        if (longLength > BigInt(MAX_WEBSOCKET_MESSAGE_BYTES)) {
          close(1009, "Message too large");
          return;
        }
        length = Number(longLength);
        headerLength = 10;
      }
      if (length > MAX_WEBSOCKET_MESSAGE_BYTES) {
        close(1009, "Message too large");
        return;
      }
      const total = headerLength + 4 + length;
      if (buffer.length < total) return;
      const mask = buffer.subarray(headerLength, headerLength + 4);
      const payload = Buffer.from(buffer.subarray(headerLength + 4, total));
      buffer = buffer.subarray(total);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];

      if (opcode >= 0x8) {
        if (!fin || length > 125) {
          close(1002, "Invalid control frame");
          return;
        }
        if (opcode === 0x8) {
          if (!closed) writeWebSocketFrame(socket, 0x8, payload);
          closed = true;
          socket.destroySoon();
          onClose?.();
          return;
        }
        if (opcode === 0x9) writeWebSocketFrame(socket, 0xA, payload);
        continue;
      }

      if (opcode === 0x0) {
        if (!fragmentOpcode) {
          close(1002, "Unexpected continuation");
          return;
        }
        fragments.push(payload);
        if (!fin) continue;
        const complete = Buffer.concat(fragments);
        const completeOpcode = fragmentOpcode;
        fragmentOpcode = 0;
        fragments.length = 0;
        if (completeOpcode === 0x1) void onMessage(complete.toString("utf8"));
        continue;
      }
      if (fragmentOpcode || (opcode !== 0x1 && opcode !== 0x2)) {
        close(1002, "Invalid data frame");
        return;
      }
      if (!fin) {
        fragmentOpcode = opcode;
        fragments.push(payload);
      } else if (opcode === 0x1) {
        void onMessage(payload.toString("utf8"));
      }
    }
  };

  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    parse();
  });
  socket.on("close", () => {
    if (!closed) {
      closed = true;
      onClose?.();
    }
  });
  socket.on("end", () => close());
  socket.on("error", () => {
    if (!closed) {
      closed = true;
      onClose?.();
    }
  });
  return {
    sendJson(value) {
      writeWebSocketFrame(socket, 0x1, JSON.stringify(value));
    },
    sendText(value) {
      writeWebSocketFrame(socket, 0x1, value);
    },
    close,
    feed(chunk) {
      if (chunk?.length) {
        buffer = Buffer.concat([buffer, chunk]);
        parse();
      }
    },
    get isClosed() { return closed || socket.destroyed; },
  };
}

function websocketRequestBody(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (payload.type !== "response.create") return payload;
  const body = { ...payload };
  delete body.type;
  return body;
}

function websocketModel(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  if (typeof payload.model === "string") return payload.model;
  if (payload.response && typeof payload.response === "object" && typeof payload.response.model === "string") {
    return payload.response.model;
  }
  return undefined;
}

function openNativeWebSocket(config, req, peer, onEvent, onClose) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    try {
      socket = new WebSocket(nativeWebSocketUrl(config), { headers: nativeWebSocketHeaders(req) });
    } catch (error) {
      reject(error);
      return;
    }
    socket.addEventListener("open", () => {
      settled = true;
      resolve(socket);
    });
    socket.addEventListener("message", async event => {
      let value = event.data;
      if (typeof value !== "string") {
        if (value instanceof ArrayBuffer) value = Buffer.from(value).toString("utf8");
        else if (ArrayBuffer.isView(value)) value = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
        else if (value && typeof value.text === "function") value = await value.text();
      }
      if (typeof value === "string") {
        try { if (onEvent?.(JSON.parse(value)) === false) return; } catch { /* preserve non-JSON upstream frames */ }
        if (!peer.isClosed) peer.sendText(value);
      }
    });
    socket.addEventListener("error", () => {
      if (!settled) reject(new Error("Native Responses WebSocket connection failed"));
      else onClose?.();
    });
    socket.addEventListener("close", event => {
      if (!settled) reject(new Error(`Native Responses WebSocket closed before opening (${event.code})`));
      else onClose?.(event);
    });
  });
}

function acceptWebSocket(config, workspace, models, conversations, responseStates, announcedTurns, lifecycle, req, socket, head) {
  if (!isLocalRequest(req)) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  if (lifecycle.draining) {
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    return;
  }
  const url = new URL(req.url || "/", `http://${config.host}:${config.port}`);
  if (url.pathname !== "/v1/responses") {
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
    "\r\n",
  ].join("\r\n"));

  let nativeSocket;
  let nativeWork;
  let localAbort;
  let closed = false;
  let messages = Promise.resolve();
  const nativePayloadQueue = [];
  const nativePayloads = new Map();
  const rememberNativeEvent = event => {
    const responseId = event?.response?.id;
    if (event?.type === "response.created" && typeof responseId === "string") {
      nativePayloads.set(responseId, nativePayloadQueue.shift());
      return;
    }
    if (event?.type === "response.completed" && event.response) {
      const payload = typeof responseId === "string" ? nativePayloads.get(responseId) : undefined;
      rememberResponse(responseStates, payload || nativePayloadQueue.shift(), event.response);
      if (typeof responseId === "string") nativePayloads.delete(responseId);
    }
  };
  const peer = attachWebSocket(socket, text => {
    let payload;
    try { payload = JSON.parse(text); } catch {
      peer.close(1007, "Request body must be valid JSON");
      return;
    }
    if (payload?.type === "response.cancel") {
      localAbort?.abort();
      if (nativeSocket?.readyState === WebSocket.OPEN) {
        try { nativeSocket.send(text); } catch { /* upstream is closing */ }
      }
      return;
    }
    if (lifecycle.draining) {
      peer.sendJson({ type: "error", error: { code: "BRIDGE_DRAINING", message: "Bridge 正在完成既有請求後重新啟動，請稍後重試。" } });
      return;
    }
    messages = messages.then(async () => {
      const requestBody = websocketRequestBody(payload);
      const model = websocketModel(requestBody);
      try {
        const selected = resolveModel(requestBody, models, responseStates);
        if (selected.kind === "native") {
          const done = requestBody.generate === false ? () => {} : lifecycle.beginModel(socket);
          try {
            const nativePayload = scrubBridgeArtifactsForNative(
              expandPreviousResponse(requestBody, responseStates, { native: true, conversations }),
            );
            // Native continuation IDs belong to the upstream socket. Let Codex replay
            // its own complete history after reconnecting, including completed tools.
            if (nativePayload.previous_response_id && nativeSocket?.readyState !== WebSocket.OPEN) {
              console.warn(JSON.stringify({ time: new Date().toISOString(), event: "native_response_replay_required", pid: process.pid, reason: "upstream_connection_closed" }));
              peer.close(1012, "Native session closed; reconnect with full history");
              done();
              return;
            }
            // A full history replay after a model switch needs a fresh upstream session.
            if (!nativePayload.previous_response_id && nativeSocket) {
              nativeSocket.close();
              nativeSocket = undefined;
              nativePayloadQueue.length = 0;
              nativePayloads.clear();
            }
            if (!nativeSocket || nativeSocket.readyState !== WebSocket.OPEN) {
              let openedSocket;
              const work = { queue: [], ids: new Map(), pending: new Set() };
              openedSocket = await openNativeWebSocket(config, req, peer, event => {
                lifecycle.lastProgressAt = Date.now();
                const id = event?.response?.id;
                if (event?.type === "response.created") work.ids.set(id, work.queue.shift());
                if (["response.completed", "response.failed", "response.incomplete"].includes(event?.type)) {
                  const done = work.ids.get(id) || work.queue.shift();
                  work.ids.delete(id);
                  if (done) { work.pending.delete(done); done(); }
                }
                if (event?.type === "error") {
                  for (const done of work.pending) done();
                  work.pending.clear(); work.queue.length = 0; work.ids.clear();
                  if (event.status === 400 && event.error?.message === "Invalid `previous_response_id`.") {
                    console.warn(JSON.stringify({ time: new Date().toISOString(), event: "native_response_replay_required", pid: process.pid, reason: "invalid_previous_response_id" }));
                    peer.close(1012, "Native response expired; reconnect with full history");
                    return false;
                  }
                }
                rememberNativeEvent(event);
              }, event => {
                for (const done of work.pending) done();
                work.pending.clear();
                if (nativeSocket === openedSocket) {
                  nativeSocket = undefined;
                  console.warn(JSON.stringify({ time: new Date().toISOString(), event: "native_upstream_closed", pid: process.pid, close_code: event?.code ?? null }));
                }
              });
              nativeSocket = openedSocket;
              nativeWork = work;
            }
            if (!peer.isClosed && nativeSocket.readyState === WebSocket.OPEN) {
              nativeWork.queue.push(done);
              nativeWork.pending.add(done);
              nativePayloadQueue.push(nativePayload);
              try {
                const outbound = payload?.type === "response.create"
                  ? { ...nativePayload, type: "response.create" }
                  : nativePayload;
                nativeSocket.send(JSON.stringify(outbound));
              } catch (error) {
                nativeWork.queue.pop();
                nativeWork.pending.delete(done);
                nativePayloadQueue.pop();
                throw error;
              }
            } else done();
          } catch (error) {
            done();
            throw error;
          }
          return;
        }

        if (requestBody.generate === false) {
          const response = responseBody({ id: `resp_agy_warmup_${randomUUID().replaceAll("-", "")}`, model: selected.route, text: "" });
          response.output = [];
          response.usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
          rememberResponse(responseStates, requestBody, response);
          const sequence = { value: 0 };
          peer.sendJson(responseEvent("response.created", sequence, { response: { ...response, status: "in_progress" } }));
          peer.sendJson(responseEvent("response.completed", sequence, { response }));
          return;
        }

        const abort = new AbortController();
        const done = lifecycle.beginModel(socket);
        localAbort = abort;
        const sequenceEmitter = (event, data, sequence) => {
          lifecycle.lastProgressAt = Date.now();
          if (!peer.isClosed) peer.sendJson(responseEvent(event, sequence, data));
        };
        try {
          if (isCompactionPayload(requestBody)) {
            const compacted = await runAgyCompaction({
              config,
              workspace,
              selected,
              payload: requestBody,
              conversations,
              responseStates,
              signal: abort.signal,
            });
            emitCompactionEvents(sequenceEmitter, compacted.response);
          } else {
            await runAgyResponse({
              config,
              workspace,
              selected,
              payload: requestBody,
              conversations,
              responseStates,
              announcedTurns,
              signal: abort.signal,
              emit: sequenceEmitter,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!peer.isClosed) {
            const sequence = { value: 0 };
            const failed = responseBody({ id: `resp_${randomUUID().replaceAll("-", "")}`, model: model || "antigravity", text: "", status: "failed" });
            failed.error = { type: "server_error", message, ...(error.code ? { code: error.code } : {}) };
            peer.sendJson(responseEvent("response.failed", sequence, { response: failed, error: failed.error }));
          }
        } finally {
          done();
          if (localAbort === abort) localAbort = undefined;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!peer.isClosed) peer.sendJson({ type: "error", error: { type: "invalid_request_error", message } });
      }
    }).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      if (!peer.isClosed) peer.sendJson({ type: "error", error: { type: "server_error", message } });
    });
  }, () => {
    if (closed) return;
    closed = true;
    localAbort?.abort();
    nativePayloadQueue.length = 0;
    nativePayloads.clear();
    if (nativeSocket && nativeSocket.readyState < WebSocket.CLOSING) nativeSocket.close();
  });
  lifecycle.trackWebSocket(socket, () => queueMicrotask(() => peer.close(1001, "Bridge restarting after drain")));
  peer.feed(head);
}

function requestAbortSignal(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  return {
    signal: controller.signal,
    cleanup() {
      req.off("aborted", abort);
      res.off("close", abort);
    },
  };
}

async function proxyNative(config, req, res, endpoint, body, responseStates) {
  const request = requestAbortSignal(req, res);
  try {
    const upstream = await fetchNative({ config, req, endpoint, body, signal: request.signal });
    if (endpoint === "responses" && body && typeof body === "object") {
      const eventStream = (upstream.headers.get("content-type") || "").toLowerCase().includes("text/event-stream");
      if (eventStream) {
        res.bridgeMarkStream?.();
        await pipeNativeResponse(res, upstream, event => {
          if (event?.type === "response.completed" && event.response) rememberResponse(responseStates, body, event.response);
        });
        return;
      }
      try {
        const response = await upstream.clone().json();
        rememberResponse(responseStates, body, response);
      } catch {
        // Let the original upstream body reach Codex; only continuation caching is optional.
      }
    }
    await pipeNativeResponse(res, upstream);
  } catch (error) {
    if (request.signal.aborted) throw new AgyError("Request was cancelled", "ABORT_ERR");
    if (error?.code === "NATIVE_AUTH") throw new AgyError(error.message, "NATIVE_AUTH");
    throw new AgyError(
      `Native Codex upstream failed: ${error instanceof Error ? error.message : String(error)}`,
      "NATIVE_UPSTREAM",
    );
  } finally {
    request.cleanup();
  }
}

async function proxyNativeModels(config, req, res, models) {
  const request = requestAbortSignal(req, res);
  try {
    const [nativeResult, modelResult, usageResult] = await Promise.allSettled([
      fetchNative({ config, req, endpoint: "models", signal: request.signal }),
      discoverAgyModels(config.agyPath, config.cwd),
      getAgyUsage(config.agyPath, false, config.cwd),
    ]);
    if (nativeResult.status === "rejected") throw nativeResult.reason;
    const upstream = nativeResult.value;
    if (!upstream.ok || !upstream.body) {
      await pipeNativeResponse(res, upstream);
      return;
    }
    let catalog;
    try {
      catalog = await upstream.json();
    } catch (error) {
      throw new AgyError(
        `Native model catalog was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        "NATIVE_CATALOG",
      );
    }
    if (!catalog || typeof catalog !== "object" || Array.isArray(catalog) || !Array.isArray(catalog.models)) {
      throw new AgyError("Native model catalog did not contain a models array", "NATIVE_CATALOG");
    }
    if (modelResult.status === "fulfilled") models.splice(0, models.length, ...modelResult.value);
    else console.error(`Antigravity model refresh failed; keeping the last catalog: ${modelResult.reason.message}`);
    const usage = usageResult.status === "fulfilled" ? usageResult.value : undefined;
    if (!usage) console.error(`Quota refresh failed: ${usageResult.reason.message}`);
    json(res, upstream.status, buildCodexCatalog(models, catalog, usage));
  } catch (error) {
    if (request.signal.aborted) throw new AgyError("Request was cancelled", "ABORT_ERR");
    if (error instanceof AgyError) throw error;
    if (error?.code === "NATIVE_AUTH") throw new AgyError(error.message, "NATIVE_AUTH");
    throw new AgyError(
      `Native model catalog request failed: ${error instanceof Error ? error.message : String(error)}`,
      "NATIVE_UPSTREAM",
    );
  } finally {
    request.cleanup();
  }
}

export function createBridgeServer(config, models) {
  const lifecycle = new BridgeLifecycle();
  let workspace;
  try {
    workspace = createWorkspacePolicy(config);
  } catch (error) {
    // An invalid AGY workspace disables AGY only; native routing must remain available.
    workspace = { roots: config.allowedWorkspaceRoots || [], lastRequest: null, error, resolve() { throw error; } };
  }
  const conversations = new Map();
  const responseStates = new Map();
  const announcedTurns = new Map();
  const server = createServer(async (req, res) => {
    if (!isLocalRequest(req)) {
      json(res, 403, errorPayload("The bridge accepts requests from the local Codex client and its local dashboard.", "forbidden"));
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url || "/", `http://${config.host}:${config.port}`);
    if (url.pathname !== "/healthz") {
      if (lifecycle.draining) {
        json(res, 503, errorPayload("Bridge 正在排空既有請求，請稍後重試。", "server_error", "BRIDGE_DRAINING"));
        return;
      }
      lifecycle.trackHttp(req, res, req.method === "POST" && url.pathname.startsWith("/v1/responses"));
    }
    try {
      if (req.method === "GET" && ["/usage", "/usage/"].includes(url.pathname)) {
        const page = readFileSync(new URL("./usage.html", import.meta.url));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(page);
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/usage") {
        try { json(res, 200, await getAgyUsage(config.agyPath, url.searchParams.get("refresh") === "true", config.cwd)); }
        catch { json(res, 503, { error: "暫時無法取得 Antigravity 額度，請重新整理。" }); }
        return;
      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        json(res, 200, {
          ok: true,
          pid: process.pid,
          lifecycle: lifecycle.snapshot(),
          service: "codex-bridge-antigravity",
          agy_path: config.agyPath,
          cwd: config.cwd,
          allowed_workspace_roots: workspace.roots,
          workspace_policy: "codex-thread-with-configured-fallback",
          agy_workspace_ok: !workspace.error,
          ...(workspace.error ? { agy_workspace_error: workspace.error.message } : {}),
          skip_permissions: false,
          tool_executor: "codex",
          last_agy_request: workspace.lastRequest,
          model_count: models.length,
          native_base_url: config.nativeBaseUrl,
          websocket: true,
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        await proxyNativeModels(config, req, res, models);
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/alpha/search") {
        const payload = await readJson(req);
        await proxyNative(config, req, res, "alpha/search", payload, responseStates);
        return;
      }
      if (req.method !== "POST" || !["/v1/responses", "/v1/responses/compact"].includes(url.pathname)) {
        json(res, 404, errorPayload("Not found", "not_found"));
        return;
      }

      const payload = await readJson(req);
      if (payload.stream === true) res.bridgeMarkStream?.();
      const selected = resolveModel(payload, models, responseStates);
      if (selected.kind === "native") {
        const nativePayload = scrubBridgeArtifactsForNative(
          expandPreviousResponse(payload, responseStates, { native: true, conversations }),
        );
        await proxyNative(config, req, res, url.pathname.endsWith("/compact") ? "responses/compact" : "responses", nativePayload, responseStates);
        return;
      }
      if (url.pathname.endsWith("/compact")) {
        const request = requestAbortSignal(req, res);
        try {
          const compacted = await runAgyCompaction({
            config,
            workspace,
            selected,
            payload,
            conversations,
            responseStates,
            signal: request.signal,
          });
          json(res, 200, compacted.response);
        } finally {
          request.cleanup();
        }
        return;
      }
      const abort = new AbortController();
      const cancel = () => {
        if (!res.writableEnded && !abort.signal.aborted) abort.abort();
      };
      req.once("aborted", cancel);
      res.once("close", cancel);
      const stream = payload.stream === true;
      if (isCompactionPayload(payload)) {
        if (stream) {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
          });
          try {
            const compacted = await runAgyCompaction({
              config,
              workspace,
              selected,
              payload,
              conversations,
              responseStates,
              signal: abort.signal,
            });
            emitCompactionEvents((event, data, sequence) => sse(res, event, sequence, data), compacted.response);
            if (!res.writableEnded) res.end("data: [DONE]\n\n");
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const failedSequence = { value: 0 };
            const failed = responseBody({ id: `resp_${randomUUID().replaceAll("-", "")}`, model: selected.route, text: "", status: "failed" });
            failed.error = { type: "server_error", message, ...(error.code ? { code: error.code } : {}) };
            sse(res, "response.failed", failedSequence, { response: failed, error: failed.error });
            if (!res.writableEnded) res.end("data: [DONE]\n\n");
          }
          return;
        }
        const compacted = await runAgyCompaction({
          config,
          workspace,
          selected,
          payload,
          conversations,
          responseStates,
          signal: abort.signal,
        });
        json(res, 200, compacted.response);
        return;
      }
      if (stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        try {
          await runAgyResponse({
            config,
            workspace,
            selected,
            payload,
            conversations,
            responseStates,
            announcedTurns,
            signal: abort.signal,
            emit: (event, data, sequence) => sse(res, event, sequence, data),
          });
          if (!res.writableEnded) res.end("data: [DONE]\n\n");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failedSequence = { value: 0 };
          const failed = responseBody({ id: `resp_${randomUUID().replaceAll("-", "")}`, model: selected.route, text: "", status: "failed" });
          failed.error = { type: "server_error", message, ...(error.code ? { code: error.code } : {}) };
          sse(res, "response.failed", failedSequence, { response: failed, error: failed.error });
          if (!res.writableEnded) res.end("data: [DONE]\n\n");
        }
        return;
      }

      const result = await runAgyResponse({
        config,
        workspace,
        selected,
        payload,
        conversations,
        responseStates,
        announcedTurns,
        signal: abort.signal,
        emit: () => {},
      });
      json(res, 200, result.response);
    } catch (error) {
      const status = error?.code === "MODEL_NOT_FOUND" ? 404
        : error?.code === "BODY_TOO_LARGE" ? 413
          : error?.code === "UNSUPPORTED_ENCODING" || error?.code === "INVALID_ENCODING" ? 415
          : error?.code === "ABORT_ERR" ? 499
            : error?.code === "NATIVE_AUTH" ? 401
              : error?.code === "NATIVE_UPSTREAM" || error?.code === "NATIVE_CATALOG"
                || ["AGY_RESULT", "AGY_EXIT", "AGY_COMPACT", "AGY_START", "AGY_PROCESS", "AGY_STDIN", "AGY_TIMEOUT"].includes(error?.code) ? 502
                : 400;
      if (!res.headersSent) json(res, status, errorPayload(error instanceof Error ? error.message : String(error), error?.code === "AGY_PROCESS" ? "server_error" : "invalid_request_error", error?.code));
      else if (!res.writableEnded) res.end();
    }
  });
  server.bridgeLifecycle = lifecycle;
  server.shutdown = timeoutMs => lifecycle.shutdown(server, timeoutMs);
  server.on("connection", socket => {
    lifecycle.sockets.add(socket);
    socket.once("close", () => lifecycle.sockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => acceptWebSocket(config, workspace, models, conversations, responseStates, announcedTurns, lifecycle, req, socket, head));
  return server;
}

export function listenBridge(server, config) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
