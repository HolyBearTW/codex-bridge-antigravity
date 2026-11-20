import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgyError } from "./agy.mjs";
import { codexConfigPath } from "./config.mjs";

// Validate workspace paths at the request boundary, before any AGY process starts.
export function createWorkspacePolicy(config) {
  const inside = (root, path) => {
    const part = relative(root, path);
    return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
  };
  const canonicalDirectory = value => {
    if (typeof value !== "string" || !isAbsolute(value)) {
      throw new AgyError("AGY 工作目錄必須是絕對路徑。", "WORKSPACE_NOT_ALLOWED");
    }
    let path;
    try {
      path = realpathSync.native(value);
      if (!statSync(path).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new AgyError(`AGY 工作目錄不存在或不是資料夾：${value}`, "WORKSPACE_NOT_ALLOWED");
    }
    return path;
  };
  const home = realpathSync.native(homedir());
  const roots = (config.allowedWorkspaceRoots || [config.cwd]).map(canonicalDirectory);
  if (!roots.length || roots.some(root => inside(root, home))) {
    throw new AgyError("不得將整個使用者目錄或其上層目錄授權給 AGY。", "WORKSPACE_NOT_ALLOWED");
  }
  const defaultCwd = canonicalDirectory(config.cwd);
  const codexHome = config.codexHome || dirname(codexConfigPath());
  if (!roots.some(root => inside(root, defaultCwd))) {
    throw new AgyError("AGY 預設工作目錄不在允許的工作區內。", "WORKSPACE_NOT_ALLOWED");
  }
  return {
    roots,
    defaultCwd,
    lastRequest: null,
    resolve(payload) {
      // Codex's local thread record binds a selected workspace to this chat.
      // Re-read it per request so newly created chats do not need a Bridge restart.
      const threadId = payload.client_metadata?.thread_id;
      let threadCwd;
      if (typeof threadId === "string" && threadId) {
        const stateFile = config.codexStatePath || (existsSync(codexHome)
          ? readdirSync(codexHome).filter(name => /^state_\d+\.sqlite$/.test(name))
            .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))
            .map(name => join(codexHome, name))[0] : undefined);
        if (stateFile && existsSync(stateFile)) {
          const state = new DatabaseSync(stateFile, { readOnly: true });
          try {
            const thread = state.prepare("SELECT cwd FROM threads WHERE id = ?").get(threadId);
            if (thread) threadCwd = canonicalDirectory(thread.cwd);
          } finally {
            state.close();
          }
          if (threadCwd && inside(threadCwd, home)) {
            throw new AgyError("不得將整個使用者目錄或其上層目錄設為 AGY 工作區。", "WORKSPACE_NOT_ALLOWED");
          }
        }
      }
      const permittedRoots = threadCwd ? [threadCwd] : roots;
      let requested;
      const input = Array.isArray(payload.input) ? payload.input : [];
      for (const item of input) {
        if (item?.role !== "user") continue;
        const parts = typeof item.content === "string" ? [item.content]
          : Array.isArray(item.content) ? item.content.map(part => part.text).filter(text => typeof text === "string") : [];
        for (const text of parts) {
          // Only Codex's standalone user environment block supplies cwd. Never scan tool/assistant text.
          const environment = text.trim().match(/^<environment_context>([\s\S]*?)<\/environment_context>$/);
          const cwd = environment?.[1].match(/<cwd>([^<]+)<\/cwd>/)?.[1];
          if (cwd) requested = cwd.trim();
        }
      }
      const cwd = requested ? canonicalDirectory(requested) : threadCwd || defaultCwd;
      const workspaceRoot = permittedRoots.find(root => inside(root, cwd));
      if (!workspaceRoot) {
        throw new AgyError(`AGY 拒絕執行：工作目錄不在明確允許的工作區內：${cwd}`, "WORKSPACE_NOT_ALLOWED");
      }
      return {
        cwd,
        workspaceRoot,
        workspaceSource: threadCwd ? "codex-thread" : "configured",
        ...(threadCwd ? { codexThreadId: threadId } : {}),
      };
    },
  };
}
