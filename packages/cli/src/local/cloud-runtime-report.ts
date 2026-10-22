import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { LocalStore, projectRepositories } from "@varveai/adit-core";
import { CloudClient, type RuntimeReport, type UpgradeNotice, type loadCredentials } from "@varveai/adit-cloud";
import { CLI_VERSION } from "../version.js";

/** Diagnose the local collector, using its own database and registration. */
export function collectLocalRuntimeReport(store: LocalStore, workspace: ReturnType<LocalStore["workspace"]>): RuntimeReport {
  const repositories = projectRepositories(store.db, workspace);
  const missing = repositories.filter(repository => !existsSync(join(repository.path, ".git"))).length;
  const checks: RuntimeReport["checks"] = [
    { name: "Local workspace", ok: existsSync(workspace.path), detail: `${repositories.length} registered repositories` },
    { name: "Repositories", ok: missing === 0, detail: missing ? `${missing} registered repositories missing` : "All registered repositories present" },
    { name: "Data directory", ok: existsSync(store.directory), detail: existsSync(store.directory) ? "Accessible" : "Missing" },
  ];
  store.db.prepare("SELECT 1 FROM adit_local_workspaces LIMIT 1").get();
  checks.push({ name: "Database", ok: true, detail: "Local history database accessible" });
  const size = statSync(store.dbPath).size;
  if (size <= 32 * 1024 * 1024) {
    const rows = store.db.pragma("quick_check(1)") as Array<{ quick_check: string }>;
    const ok = rows.length === 1 && rows[0].quick_check === "ok";
    checks.push({ name: "SQLite integrity", ok, detail: ok ? "quick_check: ok" : "Integrity check failed" });
  } else checks.push({ name: "SQLite integrity", ok: null, detail: "Full integrity check deferred for this large database" });
  checks.push({ name: "Disk usage", ok: size < 100 * 1024 * 1024, detail: `Database: ${(size / 1024 / 1024).toFixed(1)} MB` });
  return {
    schemaVersion: 1, source: "cli", version: CLI_VERSION, checkedAt: new Date().toISOString(), projectId: workspace.id,
    platforms: workspace.providers, components: [{ name: "cli", version: CLI_VERSION, evidence: "running" }], checks,
  };
}

/** Optional diagnostics never change a successful business-data upload into failure. */
export async function sendLocalRuntimeReport(
  store: LocalStore, workspace: ReturnType<LocalStore["workspace"]>, credentials: NonNullable<ReturnType<typeof loadCredentials>>,
  options: { client?: Pick<CloudClient, "post">; collect?: typeof collectLocalRuntimeReport } = {},
): Promise<{ upgrade?: UpgradeNotice; runtimeReportError?: string }> {
  try {
    const report = (options.collect ?? collectLocalRuntimeReport)(store, workspace);
    const client = options.client ?? new CloudClient(credentials.serverUrl, credentials, {
      credentialsDirectory: store.directory, timeoutMs: 1500, maxRetries: 0,
    });
    const response = await client.post<{ upgrade: UpgradeNotice }>("/api/sync/runtime", report);
    return response?.upgrade ? { upgrade: response.upgrade } : {};
  } catch {
    return { runtimeReportError: "Version and diagnostic report was not uploaded. It will retry on the next sync." };
  }
}
