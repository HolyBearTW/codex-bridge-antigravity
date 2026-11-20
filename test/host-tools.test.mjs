import assert from "node:assert/strict";
import test from "node:test";
import { codexTools, parseHostResponse } from "../src/host-tools.mjs";
import { buildAgyPrompt, hasImageInput } from "../src/prompt.mjs";

test("preserves native function, custom grammar, namespace and client tool-search calls", () => {
  const tools = codexTools([
    { type: "function", name: "exec_command", parameters: {} },
    { type: "custom", name: "apply_patch", format: { type: "grammar" } },
    { type: "namespace", name: "clock", tools: [{ type: "function", name: "curr_time", parameters: {} }] },
    { type: "tool_search", execution: "client", parameters: {} },
    { type: "web_search" },
  ]);
  const result = parseHostResponse({ structured_output: { message: "我會先查目前目錄。", tool_calls: [
    { name: "exec_command", arguments: '{"cmd":"Get-Location"}' },
    { name: "apply_patch", arguments: "*** Begin Patch\n*** End Patch" },
    { name: "clock.curr_time", arguments: "{}" },
    { name: "tool_search", arguments: '{"query":"web search"}' },
  ] } }, tools);
  assert.deepEqual(result.calls.map(call => call.type), ["function_call", "custom_tool_call", "function_call", "tool_search_call"]);
  assert.equal(result.calls[1].input, "*** Begin Patch\n*** End Patch");
  assert.equal(result.calls[2].namespace, "clock");
  assert.equal(result.calls[2].name, "curr_time");
  assert.equal(result.calls[3].execution, "client");
  assert.equal(new Set(result.calls.map(call => call.call_id)).size, 4);
  assert.throws(() => parseHostResponse({ structured_output: { message: "準備執行。", tool_calls: [{ name: "unadvertised", arguments: "{}" }] } }, tools), { code: "AGY_HOST_TOOL" });
  const quietContinuation = parseHostResponse({ structured_output: { message: "", tool_calls: [{ name: "exec_command", arguments: "{}" }] } }, tools);
  assert.equal(quietContinuation.message, "");
  assert.equal(quietContinuation.calls[0].name, "exec_command");
  assert.throws(() => parseHostResponse({ structured_output: { message: "", tool_calls: [] } }, tools), { code: "AGY_HOST_FORMAT" });
});

test("native tool results stay in chronological order with the latest request last", () => {
  const prompt = buildAgyPrompt({ instructions: "KEEP_CURRENT_RULES", input: [
    { role: "user", content: "OLD_TASK_DO_NOT_REPEAT" },
    { role: "user", content: "查看目前工作目錄。" },
    { type: "function_call", name: "exec_command", call_id: "c1", arguments: '{"cmd":"Get-Location"}' },
    { type: "function_call_output", call_id: "c1", output: "C:\\allowed\\workspace" },
    { type: "function_call", name: "exec_command", call_id: "c2", arguments: '{"cmd":"git status --short"}' },
    { type: "function_call_output", call_id: "c2", output: "STATUS_RESULT" },
  ] }, { hostTools: [{ key: "exec_command" }] });
  assert.match(prompt, /NEVER call Antigravity's own tools/);
  const ordered = ["KEEP_CURRENT_RULES", "OLD_TASK_DO_NOT_REPEAT", "Get-Location", "C:\\allowed\\workspace", "git status --short", "STATUS_RESULT", "查看目前工作目錄。"];
  for (const marker of ordered) assert.equal(prompt.split(marker).length - 1, 1);
  assert.deepEqual(ordered.toSorted((a, b) => prompt.indexOf(a) - prompt.indexOf(b)), ordered);
});

test("inspects the current native screenshot output and excludes screenshots before a newer user message", () => {
  const input = [
    { role: "user", content: "目前是什麼視窗？" },
    { type: "function_call", name: "screenshot", call_id: "screen1", arguments: "{}" },
    { type: "function_call_output", call_id: "screen1", output: [{ type: "input_image", file_path: "screen.png" }] },
  ];
  assert.equal(hasImageInput({ input }), true);
  assert.equal(hasImageInput({ input: [...input, { role: "user", content: "新的問題：7+8？" }] }), false);
});
