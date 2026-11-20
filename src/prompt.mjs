import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appHome } from "./config.mjs";

export const COMPACTION_PREFIX = "codex-bridge-antigravity:compaction:v1:";

export function encodeCompactionSummary(summary) {
  return `${COMPACTION_PREFIX}${Buffer.from(String(summary || ""), "utf8").toString("base64url")}`;
}

export function decodeCompactionSummary(value) {
  if (typeof value !== "string" || !value.startsWith(COMPACTION_PREFIX)) return null;
  try {
    return Buffer.from(value.slice(COMPACTION_PREFIX.length), "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBridgeCompactionItem(value) {
  return isObject(value)
    && value.type === "compaction"
    && typeof value.encrypted_content === "string"
    && value.encrypted_content.startsWith(COMPACTION_PREFIX);
}

/**
 * Bridge-owned compaction envelopes are readable by routed models, but the official native
 * backend cannot decrypt them. Convert them to plain input text before a model switch crosses
 * from Antigravity back to a native GPT response.
 */
export function scrubBridgeArtifactsForNative(payload) {
  if (!isObject(payload) || !Array.isArray(payload.input)) return payload;
  let changed = false;
  const input = payload.input.flatMap(item => {
    if (!isBridgeCompactionItem(item)) return [item];
    const summary = decodeCompactionSummary(item.encrypted_content);
    if (summary === null) throw new Error("Invalid Antigravity compaction checkpoint");
    changed = true;
    return [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `Compaction summary:\n${summary}` }],
    }];
  });
  if (!changed) return payload;
  const clean = { ...payload, input };
  delete clean.previous_response_id;
  return clean;
}

export function imageCacheDir() {
  try {
    return join(appHome(), "cache", "images");
  } catch {
    return join(homedir(), ".codex-bridge-antigravity", "cache", "images");
  }
}

function mimeToExtension(mime) {
  if (/jpeg|jpg/i.test(mime)) return "jpg";
  if (/webp/i.test(mime)) return "webp";
  if (/gif/i.test(mime)) return "gif";
  if (/svg/i.test(mime)) return "svg";
  if (/avif/i.test(mime)) return "avif";
  if (/bmp/i.test(mime)) return "bmp";
  if (/tiff?/i.test(mime)) return "tiff";
  return "png";
}

function saveImageBuffer(buffer, mimeType = "image/png") {
  try {
    const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
    const ext = mimeToExtension(mimeType);
    const dir = imageCacheDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, `${hash}.${ext}`);
    if (!existsSync(target)) {
      writeFileSync(target, buffer, { mode: 0o600 });
    }
    return target;
  } catch {
    return null;
  }
}

function saveBase64Image(base64Payload, mimeType = "image/png") {
  try {
    return saveImageBuffer(Buffer.from(base64Payload, "base64"), mimeType);
  } catch {
    return null;
  }
}

function mimeFromPath(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".avif") return "image/avif";
  if (extension === ".bmp") return "image/bmp";
  if (extension === ".tif" || extension === ".tiff") return "image/tiff";
  return "image/png";
}

function stageImageFile(filePath) {
  try {
    const source = resolve(filePath);
    const stats = statSync(source);
    if (!stats.isFile()) return null;
    return saveImageBuffer(readFileSync(source), mimeFromPath(source));
  } catch {
    return null;
  }
}

export function formatImagePart(part, inspect = true) {
  if (!part || typeof part !== "object") return "[Image attachment]";
  const name = part.name || part.filename || part.fileName;
  let filePath = part.file_path || part.path || part.image_path || part.filePath;

  let url = typeof part.image_url === "string"
    ? part.image_url
    : (part.image_url?.url || part.url || part.source?.url);

  if (url && typeof url === "string") {
    if (url.startsWith("file://")) {
      try {
        filePath = fileURLToPath(url);
      } catch {
        filePath = decodeURIComponent(url.replace(/^file:\/\//, ""));
      }
    } else if (url.startsWith("data:")) {
      const match = url.match(/^data:([^;]+);base64,(.+)$/s);
      if (match) {
        const saved = saveBase64Image(match[2], match[1]);
        if (saved) filePath = saved;
      }
    }
  }

  if (!filePath && part.source && part.source.type === "base64" && part.source.data) {
    const saved = saveBase64Image(part.source.data, part.source.media_type || "image/png");
    if (saved) filePath = saved;
  }

  if (filePath) {
    const stagedPath = stageImageFile(filePath);
    if (stagedPath) filePath = stagedPath;
    const label = name && name !== filePath ? ` (${name})` : "";
    if (!inspect) return `[Historical image attachment: ${filePath}${label}]`;
    return `[Image attachment: ${filePath}${label}]\nBefore answering, you MUST call the view_file tool for this exact path and inspect the image. Treat this as a visual attachment, not just a text path.`;
  }

  if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
    const label = name ? ` (${name})` : "";
    if (!inspect) return `[Historical image URL: ${url}${label}]`;
    return `[Image URL: ${url}${label}]\nBefore answering, you MUST use your browser/image reading tool to inspect this exact image URL. Treat this as a visual attachment, not just a text URL.`;
  }

  return name ? `[Image attachment: ${name}]` : "[Image attachment]";
}

function formatToolPart(part, inspectImages = true) {
  if (part.type === "custom_tool_call_output" || part.type === "function_call_output") {
    const output = typeof part.output === "string" ? part.output : contentText(part.output, inspectImages) || JSON.stringify(part.output || "");
    return `Tool output (${part.name || part.call_id || "tool"}):\n${output}`;
  }
  if (part.type === "custom_tool_call" || part.type === "function_call") {
    const args = typeof part.arguments === "string" ? part.arguments : (part.input !== undefined ? JSON.stringify(part.input) : "");
    return `Tool call (${part.name || part.call_id || "tool"}):\n${args}`;
  }
  return JSON.stringify(part);
}

function contentText(content, inspectImages = true) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    if (typeof part.text === "string") return part.text;
    if (typeof part.input_text === "string") return part.input_text;
    if (typeof part.output_text === "string") return part.output_text;
    if (part.type === "input_image" || part.type === "image" || part.type === "image_url") {
      return formatImagePart(part, inspectImages);
    }
    if (part.type === "function_call" || part.type === "function_call_output" || part.type === "custom_tool_call" || part.type === "custom_tool_call_output") {
      return formatToolPart(part, inspectImages);
    }
    return "";
  }).filter(Boolean).join("\n");
}

function hasImagePart(value) {
  if (Array.isArray(value)) return value.some(hasImagePart);
  if (!value || typeof value !== "object") return false;
  if (["input_image", "image", "image_url"].includes(value.type)) return true;
  return ["content", "input", "summary", "output"].some(key => hasImagePart(value[key]));
}

export function latestUserMessage(payload) {
  if (typeof payload.input === "string") return payload.input;
  return Array.isArray(payload.input) ? payload.input.findLast(item => item?.role === "user") : undefined;
}

export function hasImageInput(payload) {
  return hasImagePart(currentVisualInput(payload));
}

export function currentVisualInput(payload) {
  const current = latestUserMessage(payload);
  const input = Array.isArray(payload.input) ? payload.input : [];
  const lastCall = input.findLastIndex(item => ["function_call", "custom_tool_call", "tool_search_call"].includes(item.type));
  return [current, ...input.slice(Math.max(lastCall, input.lastIndexOf(current)) + 1)
    .filter(item => ["function_call_output", "custom_tool_call_output"].includes(item.type))].filter(Boolean);
}

export function itemText(item, inspectImages = true) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  if (typeof item.text === "string") return item.text;
  if (item.type === "compaction") {
    const summary = decodeCompactionSummary(item.encrypted_content);
    return summary === null ? "" : `Compaction summary:\n${summary}`;
  }
  if (item.type === "reasoning") return contentText(item.summary) || contentText(item.content);
  if (item.type === "message") return contentText(item.content, inspectImages);
  if (item.type === "input_text") return item.text || "";
  if (item.type === "input_image" || item.type === "image" || item.type === "image_url") {
    return formatImagePart(item, inspectImages);
  }
  if (item.type === "custom_tool_call_output" || item.type === "function_call_output" || item.type === "custom_tool_call" || item.type === "function_call") {
    return formatToolPart(item, inspectImages);
  }
  if (["tool_search_call", "tool_search_output", "additional_tools"].includes(item.type)) return JSON.stringify(item);
  return contentText(item.content, inspectImages);
}

export function buildAgyPrompt(payload, { imageContext = "", hostTools } = {}) {
  const sections = [];
  const input = payload.input;
  const current = latestUserMessage(payload);
  const systemInstructions = [];
  if (!hostTools && hasImageInput(payload)) {
    systemInstructions.push("MANDATORY IMAGE PREFLIGHT: this request includes visual attachment(s). Before answering the user's request, you MUST inspect every [Image attachment: ...] by calling the view_file tool with its exact path, and every [Image URL: ...] with the browser/image reading tool. Wait for those tool results before composing the answer. Do not say an image could not be read until you have performed the corresponding tool call.");
  }
  if (payload.instructions) systemInstructions.push(itemText(payload.instructions));
  systemInstructions.push(
    "CODEX WORKFLOW AUTHORITY: Follow the current Codex developer instructions, collaboration mode and explicit user constraints. Do not impose Antigravity's /plan, implementation_plan.md Artifact, UserFacing/RequestFeedback or walkthrough approval workflow. References to those in historical summaries do not establish a current user requirement. In Codex Default mode, carry out the authorized task; in Codex Plan mode or an explicitly read-only task, present the requested analysis or plan without making unauthorized edits. Preserve all actual user approval requirements.",
    "Codex 對話語言：開始前的說明、中途進度、最後回覆，一律使用繁體中文及台灣慣用語（zh-TW），採用『檔案、資料夾、套件、軟體、程式、資訊、資料、滑桿、推播、重新整理』等台灣寫法。程式碼、檔名、API 名稱與使用者指定的逐字內容保留原樣。",
    "CURRENT USER REQUEST is the active request. Completed tool transcripts are evidence for this work. Answer directly when the available evidence is sufficient.",
    "Before the first tool call for a new user request, explain in one short public zh-TW message what you will do and why. During longer work, report concrete findings, decisions or blockers and the next action at meaningful stages. Keep the user informed about once a minute while work continues. Give a separate concise final answer.",
    "Tool transcripts in the supplied conversation are prior history; use the tools available in this session rather than trying to recreate the host's internal tool interfaces through shell commands.",
    "Continue from completed checks in tool results and summaries. Gather only evidence needed for the next decision, using targeted searches or file ranges. Recheck only when relevant data changed, a necessary range is missing, or a status change affects what you can do next. Check a pending CI job when its result is needed; avoid repeating the status query in unrelated tool batches. Once evidence supports the next authorized change or the answer, take that step.",
  );
  if (hostTools) {
    systemInstructions.push(
      "CODEX NATIVE TOOL EXECUTION: You are the reasoning model inside Codex. NEVER call Antigravity's own tools, shell, browser, subagents, or filesystem tools. They are disabled. All operations MUST be requested through the Codex tool list below so Codex enforces the user's current permissions, sandbox, approval reviewer and custom rules.",
      "Return a JSON object with message (public zh-TW text) and tool_calls (array of {name, arguments}). On routine continuations with no new finding or milestone, set message to an empty string and issue only the tools needed for the current step. arguments is a JSON string for function tools; for custom tools it is the exact raw input required by their grammar. Use the exact tool key, including its namespace. Use tool_search to discover connected tools when needed. For a final answer, put the answer in message and use an empty tool_calls array. Do not print this protocol to the user.",
      "Public message style: use one or two natural zh-TW sentences about the purpose, findings and next action. Avoid tool names, commands, long paths and internal implementation details unless the user needs them. For native tool calls, use Codex's current working directory by default; do not substitute the Bridge installation directory or the user's home directory.",
      `Codex tools for this request:\n${JSON.stringify(hostTools)}`,
    );
  }
  if (systemInstructions.length) sections.push(`System instructions:\n${systemInstructions.join("\n\n")}`);
  if (Array.isArray(input)) {
    sections.push("Conversation history:");
    const visualInput = hostTools ? [] : currentVisualInput(payload);
    const currentIndex = hostTools ? input.lastIndexOf(current) : -1;
    for (const [index, item] of input.entries()) {
      // Put the latest user request at the end. Keep calls and results in their original order.
      if (index === currentIndex) {
        if (index < input.length - 1) sections.push("CURRENT TURN ACTIVITY — continue from completed tool results:");
        continue;
      }
      const text = itemText(item, visualInput.includes(item));
      if (!text) continue;
      const role = item?.role || (item?.type === "message" ? "user" : "context");
      sections.push(`${String(role).replace(/^./, char => char.toUpperCase())}:\n${text}`);
    }
  } else if (input !== undefined && typeof input !== "string") {
    sections.push(`User:\n${JSON.stringify(input)}`);
  }
  if (imageContext) sections.push(`Current attachment observations (reference only):\n${imageContext}`);
  if (current !== undefined) sections.push(`CURRENT USER REQUEST — answer this turn:\n${itemText(current, !hostTools)}`);
  return sections.join("\n\n").trim();
}
