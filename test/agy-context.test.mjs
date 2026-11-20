import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { runAgyTurn } from "../src/agy.mjs";
import { buildAgyPrompt, encodeCompactionSummary } from "../src/prompt.mjs";

function captureAgyInputs(t) {
  const sent = [];
  t.mock.method(childProcess, "spawn", () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    child.stdin = new Writable({ write(chunk, _, callback) {
      const prompt = JSON.parse(chunk).message.content;
      sent.push(prompt); callback();
      queueMicrotask(() => child.stdout.write(JSON.stringify({ event: "result", result: {
        status: "SUCCESS", response: prompt.startsWith("CODEX CONTEXT COMPLETE") ? "FINAL_OK" : "UPLOAD_ONLY",
      } }) + "\n"));
    } });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return sent;
}

test("the AGY prompt contains the earlier summary and latest request and results once", () => {
  const payload = { input: [
    { role: "user", content: "OLD_HISTORY_ONLY" },
    { role: "assistant", content: "An older completed answer" },
    { type: "compaction", encrypted_content: encodeCompactionSummary("COMPLETED_CHECKS_SUMMARY") },
    { role: "user", content: "LATEST_REQUEST_ONLY" },
    { type: "function_call", call_id: "call_current", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "call_current", output: "CURRENT_RESULT_ONLY" },
  ] };
  const prompt = buildAgyPrompt(payload, { hostTools: [{ name: "read", key: "read", type: "function" }] });
  for (const marker of ["OLD_HISTORY_ONLY", "COMPLETED_CHECKS_SUMMARY", "LATEST_REQUEST_ONLY", "CURRENT_RESULT_ONLY", "Codex tools for this request"]) {
    assert.equal(prompt.split(marker).length - 1, 1);
  }
  assert.match(prompt, /CURRENT TURN ACTIVITY[\s\S]*Tool output \(call_current\):\nCURRENT_RESULT_ONLY/);
  assert.ok(prompt.endsWith("CURRENT USER REQUEST — answer this turn:\nLATEST_REQUEST_ONLY"));
});

for (const largeRequest of [false, true]) {
  test(`uploads oversized current-turn data without losing ${largeRequest ? "a large latest request" : "tools or tool results"}`, async t => {
    const sent = captureAgyInputs(t);
    const latestRequest = largeRequest ? "最新需求中文🙂".repeat(20_000) + "LATEST_TAIL" : "最新需求 LATEST_TAIL";
    const tools = [{ type: "function", key: "read", name: "read", description: "工具說明🙂".repeat(20_000) }];
    const payload = { input: [
      { role: "user", content: "OLD_HISTORY_ONLY" },
      { role: "user", content: latestRequest },
      { type: "function_call", call_id: "call_current", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "call_current", output: "檔案結果中文🙂".repeat(20_000) + "RESULT_TAIL" },
    ] };
    const prompt = buildAgyPrompt(payload, { hostTools: tools });
    assert.ok(Buffer.byteLength(prompt) > 192_000);
    const result = await runAgyTurn({ agyPath: "fixture", cwd: process.cwd(), model: "fixture", prompt, latestRequest, hostTools: true });
    assert.equal(result.response, "FINAL_OK");
    assert.ok(sent.every(message => Buffer.byteLength(message) < 192_000 && !message.includes("\ufffd")));
    const uploaded = sent.slice(0, -1).map(message =>
      message.split("<CODEX_CONTEXT_PART>\n")[1].split("\n</CODEX_CONTEXT_PART>")[0]).join("");
    assert.equal(uploaded, prompt, "preserve the complete prompt, including tools and results");
    const allInputs = sent.join("\n");
    for (const marker of ["RESULT_TAIL", "Codex tools for this request"]) {
      assert.equal(allInputs.split(marker).length - 1, 1);
    }
    const completion = sent.at(-1);
    assert.ok(completion.startsWith("CODEX CONTEXT COMPLETE"));
    if (largeRequest) assert.ok(!completion.includes("LATEST_TAIL"));
    else assert.ok(completion.endsWith(latestRequest), "keep short latest requests explicit in the final input");
  });
}

test("loads a long UTF-8 request without truncation and returns only the final result", async t => {
  const sent = [];
  t.mock.method(childProcess, "spawn", () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    child.stdin = new Writable({ write(chunk, _, callback) {
      const prompt = JSON.parse(chunk).message.content;
      sent.push(prompt);
      callback();
      queueMicrotask(() => child.stdout.write(JSON.stringify({ event: "result", result: {
        status: "SUCCESS", conversation_id: "fresh-context", response: prompt.startsWith("CODEX CONTEXT COMPLETE") ? "LATEST_OK" : "UPLOAD_ONLY",
      } }) + "\n"));
    } });
    return child;
  });
  syncBuiltinESMExports();
  const prompt = `System instructions:\n${"中文🙂 old history.\n".repeat(35_000)}\nCURRENT USER REQUEST: LATEST`;
  const progress = [];
  try {
    const result = await runAgyTurn({ agyPath: "fixture", cwd: process.cwd(), model: "fixture", prompt, completionInstruction: "Summarize for continuation.", hostTools: true, onEvent: e => { if (e.kind === "context") progress.push(e); } });
    assert.equal(result.response, "LATEST_OK");
    assert.equal(result.conversation_id, "fresh-context");
    const parts = sent.slice(0, -1).map(message => {
      assert.ok(Buffer.byteLength(message) < 192_000, "each AGY user input must fit below its observed truncation limit");
      assert.ok(!message.includes("\ufffd"), "UTF-8 boundaries must preserve Chinese and emoji");
      return message.split("<CODEX_CONTEXT_PART>\n")[1].split("\n</CODEX_CONTEXT_PART>")[0];
    });
    assert.equal(parts.join(""), prompt);
    assert.ok(sent.at(-1).startsWith("CODEX CONTEXT COMPLETE"));
    assert.ok(sent.at(-1).endsWith("Summarize for continuation."));
    assert.equal(progress.at(-1).loaded, parts.length);
    assert.equal(progress.at(-1).total, parts.length);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
