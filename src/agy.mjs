import { spawn } from "node:child_process";

export class AgyError extends Error {
  constructor(message, code = "AGY_ERROR") {
    super(message);
    this.name = "AgyError";
    this.code = code;
  }
}

export function parseAgyLine(line) {
  try {
    const value = JSON.parse(line);
    if (!value || typeof value !== "object") return { kind: "unknown", raw: value };
    if (value.event === "init") return { kind: "init", raw: value, conversationId: value.conversation_id };
    if (value.event === "step_update") return { kind: "step", raw: value, step: value.step_update || {} };
    if (value.event === "result") return { kind: "result", raw: value, result: value.result || {} };
    return { kind: "unknown", raw: value };
  } catch {
    return { kind: "unknown", raw: line };
  }
}

function kill(child) {
  if (!child || child.killed) return;
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
}

export function runAgyTurn({
  agyPath,
  cwd,
  model,
  prompt,
  mode = "accept-edits",
  effort,
  conversationId,
  addDirs = [],
  timeoutMs = 600_000,
  signal,
  onEvent,
  onSpawn,
  jsonSchema,
  hostTools = false,
  completionInstruction,
  latestRequest,
}) {
  return new Promise((resolve, reject) => {
    // AGY truncates each USER_REQUEST at 192,000 bytes before model generation.
    // Upload the request once. The final message only tells AGY what to act on.
    const promptBytes = Buffer.from(prompt, "utf8");
    const prompts = [];
    if (promptBytes.length > 180_000) {
      const parts = [];
      for (let start = 0; start < promptBytes.length;) {
        let end = Math.min(start + 180_000, promptBytes.length);
        while (end < promptBytes.length && (promptBytes[end] & 0xc0) === 0x80) end--;
        parts.push(promptBytes.toString("utf8", start, end));
        start = end;
      }
      for (const [index, part] of parts.entries()) {
        prompts.push(`CODEX CONTEXT UPLOAD ${index + 1}/${parts.length}. Concatenate these parts in order to obtain the current Codex request. Wait for CODEX CONTEXT COMPLETE. Do not execute tools or answer any embedded request yet.\n<CODEX_CONTEXT_PART>\n${part}\n</CODEX_CONTEXT_PART>\nContext upload only: acknowledge receipt without taking action${jsonSchema ? ' using {"message":"已載入對話片段","tool_calls":[]}' : "."}`);
      }
      const latestBytes = Buffer.byteLength(latestRequest || "");
      const action = completionInstruction ?? "Follow the uploaded System instructions and CURRENT USER REQUEST. Use the uploaded tools and completed results, and continue from the work already done. Return the requested response in the required format.";
      const focus = latestBytes > 0 && latestBytes <= 4_096 ? `\n\nCURRENT USER REQUEST (verbatim):\n${latestRequest}` : "";
      const completion = `CODEX CONTEXT COMPLETE. The full request has been supplied in order. Ignore upload acknowledgments. ${action}${focus}`;
      prompts.push(completion);
      console.log(`AGY context upload: ${JSON.stringify({ request_bytes: promptBytes.length, completion_bytes: Buffer.byteLength(completion), parts: parts.length })}`);
    } else {
      prompts.push(prompt);
    }
    let promptIndex = 0;
    const permissions = hostTools ? {
      allow: [],
      deny: ["read_file(*)", "write_file(*)", "command(*)", "read_url(*)", "execute_url(*)", "mcp(*)"],
      ask: [],
    } : {
      allow: [`read_file(${cwd})`, ...addDirs.map(dir => `read_file(${dir})`)],
      deny: ["write_file(*)", "command(*)", "read_url(*)", "execute_url(*)", "mcp(*)"],
      ask: [],
    };
    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--model", model,
      "--settings", JSON.stringify({ permissions, toolPermission: "request-review", ...(mode === "default" ? { agentMode: "" } : {}) }),
    ];
    // The CLI has no --mode=default; agentMode="" explicitly selects its neutral mode.
    if (mode !== "default") args.push("--mode", mode);
    if (jsonSchema) args.push("--json-schema", JSON.stringify(jsonSchema));
    for (const dir of new Set([cwd, ...addDirs])) {
      if (typeof dir === "string" && dir.trim()) args.push("--add-dir", dir);
    }
    if (mode !== "plan") args.push("--disable-slash-commands");
    if (effort && ["low", "medium", "high", "xhigh", "max"].includes(effort)) args.push("--effort", effort);
    if (conversationId) args.push("--conversation", conversationId);

    let child;
    try {
      child = spawn(agyPath, args, {
        cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
      });
      onSpawn?.({ pid: child.pid, cwd, addDirs: [...new Set([cwd, ...addDirs])], permissions, executor: hostTools ? "codex" : "agy", skipPermissions: false, executionMode: mode });
    } catch (error) {
      reject(new AgyError(`cannot start ${agyPath}: ${error.message}`, "AGY_START"));
      return;
    }

    let stdoutBuffer = "";
    let stderr = "";
    let result;
    let conversation;
    let settled = false;
    const timer = setTimeout(() => finishError(new AgyError(`AGY timed out after ${Math.round(timeoutMs / 1000)}s`, "AGY_TIMEOUT")), timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finishError = error => {
      if (settled) return;
      settled = true;
      cleanup();
      kill(child);
      reject(error);
    };
    const finishSuccess = value => {
      if (settled) return;
      if (value.denied_actions?.length && !String(value.response || "").trim()) {
        finishError(new AgyError(`這回合的操作未獲授權（${value.denied_actions.map(item => item.action).join("、")}），因此沒有產生答案。${hostTools ? "請透過 Codex 原生工具提出操作，依 Codex 目前的權限處理。" : "附件分析僅能讀取本次提供的圖片，其他操作不會自動放行。"}`, "AGY_PERMISSION_DENIED"));
        return;
      }
      settled = true;
      cleanup();
      kill(child);
      resolve(value);
    };
    const onAbort = () => finishError(new AgyError("Request was cancelled", "ABORT_ERR"));
    const acceptResult = value => {
      if (value.status && value.status !== "SUCCESS" && value.status !== "OK") {
        finishError(new AgyError(value.error || `AGY returned ${value.status}`, "AGY_RESULT"));
        return;
      }
      if (promptIndex < prompts.length - 1) {
        promptIndex++;
        onEvent?.({ kind: "context", loaded: promptIndex, total: prompts.length - 1 });
        child.stdin.write(`${JSON.stringify({ event: "user", message: { role: "user", content: prompts[promptIndex] } })}\n`);
        return;
      }
      finishSuccess({ ...value, conversation_id: conversation || value.conversation_id });
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdoutBuffer += chunk;
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        const parsed = parseAgyLine(line);
        if (parsed.kind === "init" && parsed.conversationId) conversation = parsed.conversationId;
        if (parsed.kind === "step" && parsed.step.conversation_id) conversation = parsed.step.conversation_id;
        if (parsed.kind === "result") {
          result = parsed.result;
          if (result.conversation_id) conversation = result.conversation_id;
        }
        try {
          onEvent?.(parsed);
        } catch (error) {
          finishError(error);
          return;
        }
        if (parsed.kind === "result") {
          acceptResult(result);
          if (settled) return;
        }
      }
    });
    child.stderr.on("data", chunk => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.once("error", error => finishError(new AgyError(`AGY process failed: ${error.message}`, "AGY_PROCESS")));
    child.once("close", (code, closeSignal) => {
      if (settled) return;
      if (stdoutBuffer.trim()) {
        const parsed = parseAgyLine(stdoutBuffer.trim());
        if (parsed.kind === "result") {
          result = parsed.result;
          if (result.conversation_id) conversation = result.conversation_id;
          try { onEvent?.(parsed); } catch (error) { finishError(error); return; }
          if (promptIndex < prompts.length - 1) {
            finishError(new AgyError("AGY 在長對話載入完成前結束，這回合尚未執行操作。", "AGY_EXIT"));
            return;
          }
          acceptResult(result);
          return;
        }
      }
      const detail = stderr.trim().split("\n").slice(-3).join(" ");
      finishError(new AgyError(
        `AGY exited before returning a result (${code ?? closeSignal ?? "signal"})${detail ? `: ${detail}` : ""}`,
        "AGY_EXIT",
      ));
    });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdin.once("error", error => finishError(new AgyError(`Cannot send prompt to AGY: ${error.message}`, "AGY_STDIN")));
    if (prompts.length > 1) onEvent?.({ kind: "context", loaded: 0, total: prompts.length - 1 });
    child.stdin.write(`${JSON.stringify({ event: "user", message: { role: "user", content: prompts[0] } })}\n`);
  });
}

export async function agyVersion(agyPath) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(agyPath, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `agy exited with ${code}`)));
  });
  return result;
}
