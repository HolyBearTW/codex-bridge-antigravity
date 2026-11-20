import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
let cached;

export async function getAgyUsage(agyPath, refresh = false, cwd) {
  if (!refresh && cached && Date.now() - Date.parse(cached.fetchedAt) < 60_000) return cached;
  const { stdout } = await execute(agyPath, ["-p", "/usage", "--output-format", "json", "--print-timeout", "30s"], {
    windowsHide: true,
    cwd,
    timeout: 35_000,
    env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
  });
  const report = JSON.parse(stdout);
  if (report.status !== "SUCCESS" || report.command?.name !== "usage" || !Array.isArray(report.command.data?.groups)) {
    throw new Error("Antigravity did not return a usage command report");
  }
  const groups = report.command.data.groups.map(group => {
    if (typeof group.name !== "string" || !Array.isArray(group.buckets)) throw new Error("Invalid quota group");
    return {
      name: group.name,
      description: group.description || "",
      buckets: group.buckets.map(bucket => {
        if (typeof bucket.id !== "string" || typeof bucket.name !== "string") throw new Error("Invalid quota bucket");
        const remaining = bucket.remaining_fraction;
        if (remaining !== undefined && (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0 || remaining > 1)) {
          throw new Error("Invalid remaining quota fraction");
        }
        if (bucket.reset_time && !Number.isFinite(Date.parse(bucket.reset_time))) throw new Error("Invalid quota reset time");
        return {
          id: bucket.id, name: bucket.name, window: bucket.window || "",
          remainingFraction: remaining ?? null, resetTime: bucket.reset_time || null,
          description: bucket.description || "", disabled: bucket.disabled === true,
        };
      }),
    };
  });
  cached = { fetchedAt: new Date().toISOString(), groups };
  return cached;
}
