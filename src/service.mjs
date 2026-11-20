import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appHome } from "./config.mjs";

export const SERVICE_LABEL = "io.github.codex-bridge-antigravity.daemon";
const WINDOWS_TASK = "CodexAntigravityBridge";
const windowsLauncher = fileURLToPath(new URL("../bin/bridge-service.exe", import.meta.url));

function launchAgentsDir() {
  return join(homedir(), "Library", "LaunchAgents");
}

export function servicePlistPath() {
  return join(launchAgentsDir(), `${SERVICE_LABEL}.plist`);
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistString(value) {
  return `<string>${xml(value)}</string>`;
}

function uid() {
  return typeof process.getuid === "function" ? String(process.getuid()) : undefined;
}

function serviceTarget() {
  const user = uid();
  return user ? `gui/${user}/${SERVICE_LABEL}` : undefined;
}

function launchctl(args) {
  return spawnSync("launchctl", args, { encoding: "utf8" });
}

export function buildServicePlist(config) {
  const cliPath = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const logDir = join(appHome(), "logs");
  const programArguments = [
    process.execPath,
    cliPath,
    "serve",
    "--cwd", config.cwd,
    "--port", String(config.port),
    "--mode", config.mode,
    "--agy-path", config.agyPath,
  ];
  const argumentXml = programArguments.map(plistString).join("\n        ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${plistString(SERVICE_LABEL)}
  <key>ProgramArguments</key>
  <array>
        ${argumentXml}
  </array>
  <key>WorkingDirectory</key>
  ${plistString(config.cwd)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    ${plistString(homedir())}
    <key>PATH</key>
    ${plistString(`${dirname(process.execPath)}:/usr/local/bin:/opt/homebrew/bin:${homedir()}/.local/bin:/usr/bin:/bin`)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  ${plistString(join(logDir, "service.log"))}
  <key>StandardErrorPath</key>
  ${plistString(join(logDir, "service.error.log"))}
</dict>
</plist>
`;
}

export function installService(config) {
  if (process.platform === "win32") {
    const logDir = join(appHome(), "logs");
    mkdirSync(logDir, { recursive: true });
    const ps = value => `'${String(value).replaceAll("'", "''")}'`;
    const supervisorPath = fileURLToPath(new URL("./supervisor.mjs", import.meta.url));
    const installDirectory = fileURLToPath(new URL("../", import.meta.url));
    if (!existsSync(windowsLauncher)) throw new Error("Install the Windows launcher with scripts/install-windows.ps1 or build it with scripts/build-windows-launcher.ps1");
    const install = `$ErrorActionPreference = 'Stop'
$task = '${WINDOWS_TASK}'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute ${ps(windowsLauncher)} -Argument ${ps(`"${process.execPath}" "${supervisorPath}" "${appHome()}"`)} -WorkingDirectory ${ps(installDirectory)}
$existing = Get-ScheduledTask -TaskName $task -TaskPath '\\' -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.Actions.Count -ne 1 -or $existing.Actions[0].Execute -ne $action.Execute -or $existing.Actions[0].Arguments -ne $action.Arguments) {
        throw "The existing $task belongs to another installation. Disconnect it from its original checkout first."
    }
} else {
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $task -TaskPath '\\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Codex Antigravity Bridge' | Out-Null
}
try {
    if (!$existing -or $existing.State -ne 'Running') { Start-ScheduledTask -TaskName $task -TaskPath '\\' }
} catch {
    if (!$existing) { Unregister-ScheduledTask -TaskName $task -TaskPath '\\' -Confirm:$false }
    throw
}
if (!$existing) { 'registered' }
`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(install, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(`Cannot register Windows startup task: ${result.error?.message || result.stderr || result.stdout}`);
    return { installed: true, taskName: WINDOWS_TASK, installDirectory, newlyRegistered: result.stdout.trim() === "registered" };
  }
  if (process.platform !== "darwin") return { installed: false, reason: "macOS only" };
  const plistPath = servicePlistPath();
  const logDir = join(appHome(), "logs");
  mkdirSync(dirname(plistPath), { recursive: true, mode: 0o700 });
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  writeFileSync(plistPath, buildServicePlist(config), { mode: 0o600 });
  chmodSync(plistPath, 0o600);
  const user = uid();
  if (!user) throw new Error("Cannot determine the macOS user id for launchd");
  launchctl(["bootout", `gui/${user}/${SERVICE_LABEL}`]);
  const loaded = launchctl(["bootstrap", `gui/${user}`, plistPath]);
  if (loaded.status !== 0) {
    throw new Error(`launchctl bootstrap failed: ${(loaded.stderr || loaded.stdout || "unknown error").trim()}`);
  }
  return { installed: true, plistPath, target: serviceTarget() };
}

export function uninstallService() {
  if (process.platform === "win32") {
    const remove = `$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName '${WINDOWS_TASK}' -TaskPath '\\' -ErrorAction SilentlyContinue
if ($task -and $task.Actions.Count -eq 1 -and $task.Actions[0].Execute -eq '${windowsLauncher.replaceAll("'", "''")}') {
    Stop-ScheduledTask -InputObject $task
    Unregister-ScheduledTask -InputObject $task -Confirm:$false
}
`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(remove, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(`Cannot remove Windows startup task: ${result.error?.message || result.stderr || result.stdout}`);
    return { removed: true, taskName: WINDOWS_TASK };
  }
  if (process.platform !== "darwin") return { removed: false, reason: "macOS only" };
  const user = uid();
  if (user) launchctl(["bootout", `gui/${user}/${SERVICE_LABEL}`]);
  const plistPath = servicePlistPath();
  if (existsSync(plistPath)) unlinkSync(plistPath);
  return { removed: true, plistPath };
}
