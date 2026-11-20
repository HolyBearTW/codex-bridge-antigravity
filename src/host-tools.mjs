import { randomUUID } from "node:crypto";
import { AgyError } from "./agy.mjs";

// Keep the native tool definitions and namespace; Codex remains the only executor.
export function codexTools(tools = [], namespace) {
  return tools.flatMap(tool => {
    if (tool.type === "namespace") return codexTools(tool.tools, tool.name);
    if (!["function", "custom", "tool_search"].includes(tool.type)) return [];
    if (tool.type === "tool_search" && tool.execution !== "client") return [];
    const name = tool.name || "tool_search";
    return [{ ...tool, name, ...(namespace ? { namespace } : {}), key: namespace ? `${namespace}.${name}` : name }];
  });
}

export const HOST_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string", description: "Public progress or final answer in Traditional Chinese (Taiwan). Use an empty string for routine tool continuations with no new finding or milestone." },
    tool_calls: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, arguments: { type: "string" } },
        required: ["name", "arguments"], additionalProperties: false,
      },
    },
  },
  required: ["message", "tool_calls"], additionalProperties: false,
};

export function parseHostResponse(result, tools) {
  let value = result.structured_output;
  if (value === undefined) {
    try { value = JSON.parse(String(result.response || "")); }
    catch { throw new AgyError("模型沒有回傳有效的 Codex 工具格式，這回合未執行任何操作。", "AGY_HOST_FORMAT"); }
  }
  if (!value || typeof value.message !== "string" || !Array.isArray(value.tool_calls)
    || (value.tool_calls.length === 0 && !value.message.trim())) {
    throw new AgyError("模型回傳的 Codex 工具格式不完整，這回合未執行任何操作。", "AGY_HOST_FORMAT");
  }
  const calls = value.tool_calls.map(call => {
    const tool = tools.find(tool => tool.key === call.name);
    if (!tool || typeof call.arguments !== "string") {
      throw new AgyError(`模型要求的工具不在本回合 Codex 提供的清單內：${String(call.name)}`, "AGY_HOST_TOOL");
    }
    const id = randomUUID().replaceAll("-", "");
    const base = { id: `fc_${id}`, call_id: `call_${id}`, status: "completed" };
    if (tool.type === "tool_search") {
      return { ...base, type: "tool_search_call", execution: "client", arguments: JSON.parse(call.arguments) };
    }
    return {
      ...base,
      type: tool.type === "custom" ? "custom_tool_call" : "function_call",
      name: tool.name,
      ...(tool.namespace ? { namespace: tool.namespace } : {}),
      ...(tool.type === "custom" ? { input: call.arguments } : { arguments: call.arguments }),
    };
  });
  return { message: value.message.trim(), calls };
}
