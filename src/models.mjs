import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export const MODEL_PREFIX = "antigravity/";
export const AGY_CONTEXT_WINDOW = 1_000_000;
export const AGY_AUTO_COMPACT_TOKEN_LIMIT = 800_000;

export function isAntigravityModel(value) {
  return typeof value === "string" && value.startsWith(MODEL_PREFIX);
}

export function isLegacyBridgeModel(value) {
  return typeof value === "string" && (value.startsWith("freebuff/") || value.startsWith("gemini-web/"));
}

function runAgyModels(agyPath, cwd, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(agyPath, ["models"], {
      cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      // AGY's detached updater launches its own visible console on Windows.
      env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`agy models timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cannot start ${agyPath}: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim().split("\n").slice(-3).join(" ");
        reject(new Error(`agy models failed (${code ?? signal ?? "signal"})${detail ? `: ${detail}` : ""}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export function parseAgyModels(text) {
  const models = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^model(s)?$/i.test(trimmed)) continue;
    const match = trimmed.match(/^(\S+)\s+(.+?)\s*$/);
    if (!match || !/^[A-Za-z0-9._-]+$/.test(match[1])) continue;
    models.push({ id: match[1], displayName: match[2] });
  }
  return dedupeModels(models);
}

function dedupeModels(models) {
  const seen = new Set();
  return models.filter(model => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

export function isAllowedAgyModel(modelOrId) {
  const rawId = typeof modelOrId === "string" ? modelOrId : modelOrId?.id;
  if (typeof rawId !== "string") return false;
  return /^(?:gemini|claude)-/.test(agyModelId(rawId));
}

export async function discoverAgyModels(agyPath, cwd) {
  const parsed = parseAgyModels(await runAgyModels(agyPath, cwd));
  return parsed.filter(isAllowedAgyModel);
}

export function routeId(modelId) {
  return modelId.startsWith(MODEL_PREFIX) ? modelId : `${MODEL_PREFIX}${modelId}`;
}

export function agyModelId(route) {
  return route.startsWith(MODEL_PREFIX) ? route.slice(MODEL_PREFIX.length) : route;
}

export function groupAgyModels(models) {
  const groups = new Map();
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  for (const model of models) {
    const suffix = model.id.match(/-(low|medium|high|xhigh|max)$/);
    const id = suffix ? model.id.slice(0, -suffix[0].length) : model.id;
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        displayName: model.displayName.replace(/\s*\((Low|Medium|High|XHigh|Max)\)$/i, ""),
        variants: [],
      });
    }
    groups.get(id).variants.push({ id: model.id, effort: suffix?.[1] || "high" });
  }
  return [...groups.values()].map(group => {
    const variants = group.variants.toSorted((a, b) => efforts.indexOf(a.effort) - efforts.indexOf(b.effort));
    return {
      ...group,
      variants,
      defaultEffort: (variants.find(variant => variant.effort === "medium")
        || variants.find(variant => variant.effort === "high") || variants[0]).effort,
    };
  });
}

function nativeCatalog() {
  const candidates = [
    process.env.CODEX_MODEL_CATALOG?.trim(),
    join(homedir(), ".codex", "opencodex-catalog.json"),
    join(homedir(), ".codex", "models_cache.json"),
    join(homedir(), ".codex-freebuff-web", "codex", "model-catalog.json"),
  ].filter(Boolean);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (value && Array.isArray(value.models)) return value;
    } catch {
      // A stale optional cache should not prevent the bridge from starting.
    }
  }
  return { models: [] };
}

function modelSlug(value) {
  return value && typeof value === "object" && !Array.isArray(value) && typeof value.slug === "string"
    ? value.slug
    : undefined;
}

function nativeTemplate(catalog) {
  return catalog.models.find(model => {
    const slug = modelSlug(model);
    return slug && !slug.startsWith(MODEL_PREFIX)
      && !slug.startsWith("freebuff/")
      && !slug.startsWith("gemini-web/")
      && Array.isArray(model.supported_reasoning_levels);
  });
}

function reasoningLevel(template, effort) {
  const levels = Array.isArray(template?.supported_reasoning_levels)
    ? template.supported_reasoning_levels
    : [];
  const source = levels.find(level => level?.effort === effort);
  return {
    ...(source && typeof source === "object" ? structuredClone(source) : {}),
    effort,
    description: `Antigravity ${effort} effort`,
  };
}

function buildModel(template, model, usage) {
  const base = template && typeof template === "object" ? structuredClone(template) : {};
  // Google publishes 1,048,576 for these Gemini families; Claude 5.5 publishes 1M.
  // Keep future/unknown models at the existing fallback until their limits are confirmed.
  const contextWindow = /^gemini-(?:4-(?:argon|hydrogen)|3\.8-flash)(?:-|$)/.test(model.id)
    ? 1_048_576 : AGY_CONTEXT_WINDOW;
  const result = {
    ...base,
    slug: routeId(model.id),
    display_name: model.displayName.startsWith("Orchestrator") ? "Gemini Argon Orch" : model.displayName,
    description: `Official Antigravity CLI model: ${model.displayName}`,
    visibility: "list",
    supported_in_api: true,
    input_modalities: ["text", "image"],
    tool_mode: null,
    multi_agent_version: "disabled",
    upgrade: null,
    default_reasoning_level: model.defaultEffort,
    supported_reasoning_levels: model.variants.map(variant => reasoningLevel(template, variant.effort)),
    context_window: contextWindow,
    max_context_window: contextWindow,
    effective_context_window_percent: 100,
    auto_compact_token_limit: Math.floor(contextWindow * .8),
    use_responses_lite: false,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
  };
  delete result.comp_hash;
  delete result.availability_nux;
  const family = model.id.startsWith("claude-") ? "claude" : "gemini";
  let group = usage?.groups.find(group => group.buckets.some(bucket => bucket.id === (family === "claude" ? "3p-weekly" : "gemini-weekly")));
  if (family === "gemini" && /argon/i.test(model.id + model.displayName)) {
    group = usage?.groups.find(group => group.buckets.some(bucket => bucket.id.includes("argon"))) || group;
  }
  if (group) {
    const percentage = new Intl.NumberFormat("zh-TW", { style: "percent", maximumFractionDigits: 1 });
    const known = group.buckets.filter(bucket => !bucket.disabled && bucket.remainingFraction !== null)
      .toSorted((a, b) => Number(b.window === "5h") - Number(a.window === "5h"));
    const labels = known.map(bucket => `${bucket.window === "5h" ? "5h" : bucket.window === "weekly" ? "週" : bucket.name}${new Intl.NumberFormat("zh-TW", { style: "percent", maximumFractionDigits: bucket.remainingFraction > 0 && bucket.remainingFraction < .01 ? 1 : 0 }).format(bucket.remainingFraction)}`);
    if (labels.length) result.display_name += ` · ${labels.join(" ")}`;
    result.description += `\nAntigravity ${group.name} 剩餘額度（${usage.fetchedAt}）：\n` + group.buckets.map(bucket =>
      `${bucket.name}: ${bucket.disabled ? "未啟用" : bucket.remainingFraction === null ? "未知" : percentage.format(bucket.remainingFraction)}${bucket.resetTime ? `；重置 ${bucket.resetTime}` : ""}`).join("\n");
  }
  return result;
}

export function buildCodexCatalog(models, source = nativeCatalog(), usage) {
  const template = nativeTemplate(source);
  const preserved = source.models.filter(model => {
    const slug = modelSlug(model);
    return slug && !slug.startsWith(MODEL_PREFIX)
      && !slug.startsWith("freebuff/")
      && !slug.startsWith("gemini-web/");
  }).toSorted((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    // Native protocol flags also control token accounting; keep the upstream contract.
    .map((model, priority) => ({ ...model, priority }));
  const groups = groupAgyModels(models);
  const ordered = [...groups.filter(model => model.id.startsWith("gemini-")), ...groups.filter(model => model.id.startsWith("claude-"))];
  const visible = ordered.map((model, index) => ({ ...buildModel(template, model, usage), priority: preserved.length + index }));
  // Keep existing chats using a suffixed ID working without listing each effort as a model.
  const aliases = ordered.flatMap((group, index) => group.variants.filter(variant => variant.id !== group.id).map(variant => ({
    ...visible[index],
    slug: routeId(variant.id),
    visibility: "hide",
    default_reasoning_level: variant.effort,
  })));
  return {
    ...structuredClone(source),
    models: [...preserved, ...visible, ...aliases],
  };
}
