#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { agyVersion } from "./agy.mjs";
import { appHome, catalogPath, codexConfigPath, integrationStatePath, loadConfig, resolveAgyExecutable, resolveCwd, saveConfig } from "./config.mjs";
import { buildCodexCatalog, discoverAgyModels } from "./models.mjs";
import { createBridgeServer, listenBridge } from "./server.mjs";
import { installService, uninstallService } from "./service.mjs";
import { createWorkspacePolicy } from "./workspace.mjs";

function parseArgs(args) {
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [rawKey, inline] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inline !== undefined) options[key] = inline;
    else if (args[index + 1] && !args[index + 1].startsWith("--")) options[key] = args[++index];
    else options[key] = true;
  }
  return { options, positional };
}

function numberOption(value, fallback) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

async function freshConfig(options) {
  const existing = loadConfig();
  const config = {
    ...existing,
    ...(options.cwd ? { cwd: resolveCwd(options.cwd) } : {}),
    ...(options.port ? { port: numberOption(options.port, existing.port) } : {}),
    ...(options.mode && ["plan", "accept-edits"].includes(options.mode) ? { mode: options.mode } : {}),
    agyPath: resolveAgyExecutable(options.agyPath || existing.agyPath),
  };
  return config;
}

async function refreshModels(config) {
  try {
    const models = await discoverAgyModels(config.agyPath, config.cwd);
    const updated = { ...config, models, lastModelsRefresh: new Date().toISOString() };
    saveConfig(updated);
    return updated;
  } catch (error) {
    if (config.models?.length) return config;
    throw error;
  }
}

function topLevelEnd(lines) {
  const index = lines.findIndex(line => /^\s*\[/.test(line));
  return index < 0 ? lines.length : index;
}

function getTopLevelAssignment(text, key) {
  const lines = text.split(/\r?\n/);
  const end = topLevelEnd(lines);
  const pattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*=\\s*(.+?)\\s*$`);
  for (let index = 0; index < end; index += 1) {
    const match = lines[index].match(pattern);
    if (!match) continue;
    try { return JSON.parse(match[1]); } catch { return match[1].replace(/^['"]|['"]$/g, ""); }
  }
  return undefined;
}

function replaceTopLevelAssignment(text, key, value) {
  const lines = text.split(/\r?\n/);
  const end = topLevelEnd(lines);
  const pattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*=`);
  const rendered = `${key} = ${JSON.stringify(value)}`;
  for (let index = 0; index < end; index += 1) {
    if (pattern.test(lines[index])) {
      lines[index] = rendered;
      return lines.join("\n");
    }
  }
  lines.splice(end, 0, rendered);
  return lines.join("\n");
}

function providerSection(text, provider) {
  if (!provider || !/^[A-Za-z0-9_-]+$/.test(provider)) return undefined;
  const lines = text.split(/\r?\n/);
  const header = `[model_providers.${provider}]`;
  const start = lines.findIndex(line => line.trim() === header);
  if (start < 0) return undefined;
  const next = lines.slice(start + 1).findIndex(line => /^\s*\[/.test(line));
  return { lines, start, end: next < 0 ? lines.length : start + 1 + next };
}

function replaceProviderBaseUrl(text, provider, value) {
  const section = providerSection(text, provider);
  if (!section) return text;
  const pattern = /^\s*base_url\s*=/;
  const rendered = `base_url = ${JSON.stringify(value)}`;
  for (let index = section.start + 1; index < section.end; index += 1) {
    if (pattern.test(section.lines[index])) {
      section.lines[index] = rendered;
      return section.lines.join("\n");
    }
  }
  section.lines.splice(section.end, 0, rendered);
  return section.lines.join("\n");
}

function replaceProviderBoolean(text, provider, key, value) {
  const section = providerSection(text, provider);
  if (!section) return text;
  const pattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*=`);
  const rendered = `${key} = ${value ? "true" : "false"}`;
  for (let index = section.start + 1; index < section.end; index += 1) {
    if (pattern.test(section.lines[index])) {
      section.lines[index] = rendered;
      return section.lines.join("\n");
    }
  }
  section.lines.splice(section.end, 0, rendered);
  return section.lines.join("\n");
}

function ensureRouterProvider(text, provider, route) {
  const name = provider || "antigravity-router";
  let patched = provider ? text : replaceTopLevelAssignment(text, "model_provider", name);
  if (!providerSection(patched, name)) {
    const suffix = `\n[model_providers.${name}]\nname = "Antigravity router"\nrequires_openai_auth = true\nsupports_websockets = true\nwire_api = "responses"\nbase_url = ${JSON.stringify(route)}\n`;
    return `${patched.trimEnd()}${suffix}`;
  }
  patched = replaceProviderBaseUrl(patched, name, route);
  patched = replaceProviderBoolean(patched, name, "requires_openai_auth", true);
  patched = replaceProviderBoolean(patched, name, "supports_websockets", true);
  return patched;
}

function atomicWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, data, { mode: 0o600 });
  writeFileSync(path, readFileSync(temporary), { mode: 0o600 });
  unlinkSync(temporary);
}

async function setup(options) {
  const configPath = codexConfigPath();
  let config = { ...await freshConfig(options), codexHome: dirname(configPath) };
  if (options.cwd) config.allowedWorkspaceRoots = [config.cwd];
  createWorkspacePolicy(config);
  const route = `http://${config.host}:${config.port}/v1`;
  const configExists = existsSync(configPath);
  const currentText = configExists ? readFileSync(configPath, "utf8") : "";
  const currentRoute = getTopLevelAssignment(currentText, "openai_base_url");
  const provider = getTopLevelAssignment(currentText, "model_provider");
  const providerRoute = providerSection(currentText, provider)?.lines
    .slice(providerSection(currentText, provider).start + 1, providerSection(currentText, provider).end)
    .find(line => /^\s*base_url\s*=/.test(line))?.split("=", 2)[1]?.trim().replace(/^['"]|['"]$/g, "");
  const statePath = integrationStatePath();
  const existingState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : undefined;
  const routeInUse = currentRoute || providerRoute;
  if (routeInUse && routeInUse !== route && options.replaceCodexRoute !== true) {
    throw new Error(`Codex already routes through ${routeInUse}. Use --replace-codex-route to switch it reversibly.`);
  }

  config = await refreshModels(config);
  if (!config.models.length) throw new Error("No supported models returned by agy models. Check your Antigravity login.");

  const backupPath = existingState?.backupPath || join(appHome(), "codex", "config.toml.before-antigravity");
  const hadConfig = existingState?.hadConfig ?? configExists;
  if (!existingState && configExists) {
    mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
    copyFileSync(configPath, backupPath);
    chmodSync(backupPath, 0o600);
  }
  const managedCatalog = buildCodexCatalog(config.models);
  const managedCatalogPath = catalogPath();
  atomicWrite(managedCatalogPath, `${JSON.stringify(managedCatalog, null, 2)}\n`);
  let patched = replaceTopLevelAssignment(currentText, "openai_base_url", route);
  const patchedLines = patched.split(/\r?\n/);
  const topLevelLimit = topLevelEnd(patchedLines);
  patched = patchedLines.filter((line, index) => index >= topLevelLimit || !/^\s*model_catalog_json\s*=/.test(line)).join("\n");
  // Codex chooses the Responses transport per provider, not per catalog row. The local router
  // therefore accepts WebSocket requests and decides by model: native GPT frames are forwarded
  // to ChatGPT, while antigravity/* frames are translated to AGY CLI turns.
  if (provider && provider !== "openai") patched = ensureRouterProvider(patched, provider, route);

  const service = installService(config);
  if (process.platform === "win32") {
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      try {
        const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: AbortSignal.timeout(1000) });
        const health = await response.json();
        ready = response.ok && health.service === "codex-bridge-antigravity"
          && health.agy_workspace_ok && health.model_count > 0 && health.cwd === config.cwd;
      } catch { /* The scheduled task may still be starting. */ }
      if (!ready) await delay(250);
    }
    if (!ready) {
      if (service.newlyRegistered) uninstallService();
      throw new Error(`Windows bridge did not become healthy. Inspect ${join(appHome(), "logs")}.`);
    }
  }
  const state = {
    version: 1,
    configPath,
    route,
    catalogPath: managedCatalogPath,
    hadConfig,
    backupPath: hadConfig && existsSync(backupPath) ? backupPath : null,
    installedAt: new Date().toISOString(),
  };
  atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
  atomicWrite(configPath, patched);
  console.log(`Codex route installed: ${route}`);
  console.log(`Models installed: ${config.models.length}`);
  if (service.installed) console.log(`Background service installed: ${service.plistPath || service.taskName}`);
  console.log(`Codex restart required. To restore the previous route: codex-bridge-antigravity disconnect`);
}

function disconnect() {
  const statePath = integrationStatePath();
  if (!existsSync(statePath)) throw new Error("Antigravity Codex integration is not installed");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const current = existsSync(state.configPath) ? readFileSync(state.configPath, "utf8") : "";
  const currentRoute = getTopLevelAssignment(current, "openai_base_url");
  if (currentRoute && currentRoute !== state.route) throw new Error("Codex route changed after setup; refusing to overwrite it");
  if (state.hadConfig) {
    if (!state.backupPath || !existsSync(state.backupPath)) throw new Error(`Backup not found: ${state.backupPath || "(none)"}`);
    copyFileSync(state.backupPath, state.configPath);
    console.log(`Restored Codex config from ${state.backupPath}`);
  } else if (existsSync(state.configPath)) {
    unlinkSync(state.configPath);
    console.log("Removed the Codex config created by Antigravity setup");
  }
  uninstallService();
  unlinkSync(statePath);
}

async function doctor(options) {
  const config = await freshConfig(options);
  let version;
  let models;
  try {
    version = await agyVersion(config.agyPath);
    models = await discoverAgyModels(config.agyPath, config.cwd);
  } catch (error) {
    console.log(`✗ AGY CLI: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ AGY CLI: ${version}`);
  console.log(`✓ AGY login/models response: ${models.length} models`);
  console.log(`✓ Working directory: ${config.cwd}`);
  console.log(`✓ Native GPT route: ${config.nativeBaseUrl}`);
  console.log("✓ Model router: native models passthrough; antigravity/* via WebSocket → AGY");
  try {
    const response = await fetch(`http://${config.host}:${config.port}/healthz`);
    console.log(response.ok ? `✓ Responses proxy: http://${config.host}:${config.port}` : `✗ Responses proxy: HTTP ${response.status}`);
  } catch {
    console.log(`! Responses proxy is not running: start with codex-bridge-antigravity serve`);
  }
}

async function refreshCatalog(options) {
  let config = await freshConfig(options);
  config = await refreshModels(config);
  const managedCatalog = buildCodexCatalog(config.models);
  const managedCatalogPath = catalogPath();
  atomicWrite(managedCatalogPath, `${JSON.stringify(managedCatalog, null, 2)}\n`);
  console.log(`Updated model catalog: ${managedCatalogPath}`);
  console.log(`Models in catalog: ${config.models.length}`);
}

async function serve(options) {
  const config = await freshConfig(options);
  try {
    const managedCatalog = buildCodexCatalog(config.models);
    atomicWrite(catalogPath(), `${JSON.stringify(managedCatalog, null, 2)}\n`);
  } catch (err) {
    console.error(`Warning: failed to update catalog cache: ${err.message}`);
  }
  const server = createBridgeServer(config, config.models);
  await listenBridge(server, config);
  console.log(`codex-bridge-antigravity listening on http://${config.host}:${config.port}/v1`);
  console.log(`AGY: ${config.agyPath} | cwd: ${config.cwd} | mode: ${config.mode}`);
  // Bind before contacting AGY: a failed login/model discovery must not disable GPT.
  void discoverAgyModels(config.agyPath, config.cwd).then(models => {
    config.models.splice(0, config.models.length, ...models);
    saveConfig({ ...config, lastModelsRefresh: new Date().toISOString() });
    atomicWrite(catalogPath(), `${JSON.stringify(buildCodexCatalog(models), null, 2)}\n`);
  }).catch(error => console.error(`Antigravity model refresh failed; native routing remains available: ${error.message}`));
  const shutdown = async (timeoutMs = 30_000) => {
    const result = await server.shutdown(timeoutMs);
    console.log(JSON.stringify({ event: "graceful_shutdown_complete", pid: process.pid, ...result }));
    process.exit(0);
  };
  process.on("message", message => {
    if (message?.type === "watchdog.status" && process.connected) {
      process.send({ type: "watchdog.status", id: message.id, pid: process.pid, lifecycle: server.bridgeLifecycle.snapshot() });
    } else if (message?.type === "watchdog.shutdown") {
      void shutdown(message.timeoutMs);
    }
  });
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const command = positional[0] || "doctor";
  if (command === "version") {
    const { name, version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(`${name} ${version}`);
    return;
  }
  if (command === "models") {
    const config = await freshConfig(options);
    const models = await discoverAgyModels(config.agyPath, config.cwd);
    for (const model of models) console.log(`${model.id}\t${model.displayName}`);
    return;
  }
  if (command === "doctor") return doctor(options);
  if (command === "serve") return serve(options);
  if (command === "service-install") {
    const service = installService(await freshConfig(options));
    console.log(JSON.stringify(service));
    return;
  }
  if (command === "setup") return setup(options);
  if (command === "refresh-catalog") return refreshCatalog(options);
  if (command === "disconnect") return disconnect();
  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  console.error(`codex-bridge-antigravity: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
