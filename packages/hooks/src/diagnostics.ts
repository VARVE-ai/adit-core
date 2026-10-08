import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import type Database from "better-sqlite3";
import {
  computeRepositoryDrift,
  readProjectManifest,
  resolveActiveManifestRepositories,
  readAgentRuntimeVersions,
  type AditConfig,
} from "@varveai/adit-core";
import { getRemoteUrl } from "@varveai/adit-engine";
import type { RuntimeReport } from "@varveai/adit-cloud";
import { listAdapters } from "./adapters/index.js";

const require = createRequire(import.meta.url);
const hooksVersion = (require("../package.json") as { version: string })
  .version;

function installedCliVersion(): string | null {
  try {
    const entry = require.resolve("@varveai/adit-cli");
    return JSON.parse(
      readFileSync(join(dirname(entry), "..", "package.json"), "utf8"),
    ).version;
  } catch {
    return null;
  }
}

export async function collectRuntimeReport(
  config: AditConfig,
  db: Database.Database,
  source: "cli" | "hooks",
  cliVersion?: string,
): Promise<RuntimeReport> {
  const checks: RuntimeReport["checks"] = [];
  const check = async (
    name: string,
    action: () =>
      | { ok: boolean | null; detail: string }
      | Promise<{ ok: boolean | null; detail: string }>,
  ) => {
    try {
      checks.push({ name, ...(await action()) });
    } catch {
      checks.push({ name, ok: null, detail: "Unable to complete this check" });
    }
  };
  const manifest = readProjectManifest(config.projectRoot);
  const repositories = manifest
    ? resolveActiveManifestRepositories(config.projectRoot, manifest)
    : config.repositories;
  await check("Project manifest", () => ({
    ok: !!manifest,
    detail: `${repositories.length} registered repositories`,
  }));
  await check("Repositories", () => {
    const missing = repositories.filter(
      (repo) => !existsSync(join(repo.path, ".git")),
    );
    return {
      ok: !missing.length,
      detail: missing.length
        ? `${missing.length} registered repositories missing`
        : "All repositories present",
    };
  });
  await check("Git remotes", async () => {
    let missing = 0;
    for (const repo of repositories)
      if (!(await getRemoteUrl(repo.path))) missing++;
    return {
      ok: !missing,
      detail: missing
        ? `${missing} repositories have no origin`
        : "All repositories have an origin",
    };
  });
  if (
    manifest &&
    manifest.repositories.some((repo) => repo.relativePath !== ".")
  )
    await check("Unregistered repositories", () => {
      const count = computeRepositoryDrift(config.projectRoot, manifest)
        .unregistered.length;
      return { ok: count === 0, detail: `${count} unregistered repositories` };
    });
  await check("Data directory", () => ({
    ok: existsSync(config.dataDir),
    detail: existsSync(config.dataDir) ? "Accessible" : "Missing",
  }));
  await check("Database", () => {
    db.prepare("SELECT 1 FROM events LIMIT 1").get();
    return { ok: true, detail: "Accessible" };
  });
  // Bound automatic checks; full integrity_check remains available in doctor.
  await check("SQLite integrity", () => {
    if (statSync(config.dbPath).size > 32 * 1024 * 1024)
      return {
        ok: null,
        detail:
          "Full integrity check deferred to adit doctor for this large database",
      };
    const rows = db.pragma("quick_check(1)") as Array<{ quick_check: string }>;
    return {
      ok: rows.length === 1 && rows[0].quick_check === "ok",
      detail:
        rows[0]?.quick_check === "ok"
          ? "quick_check: ok"
          : "Integrity check failed",
    };
  });
  await check("adit-hook binary", () => ({
    ok: existsSync(
      join(dirname(require.resolve("./adapters/index.js")), "..", "index.js"),
    ),
    detail: `Installed hooks package ${hooksVersion}`,
  }));
  let connected: string[] | null = null;
  try {
    const parsed = JSON.parse(
      readFileSync(join(config.projectRoot, ".adit", "platforms.json"), "utf8"),
    );
    if (Array.isArray(parsed.connected))
      connected = parsed.connected.filter(
        (value: unknown) => typeof value === "string",
      );
  } catch {
    /* Legacy projects are detected without writing configuration. */
  }
  const platforms: string[] = [];
  for (const adapter of listAdapters()) {
    if (!adapter.hookMappings.length) continue;
    if (connected && !connected.includes(adapter.platform)) continue;
    if (!connected) {
      try {
        if (
          !(await (adapter.hasProjectHooks?.(config.projectRoot) ??
            adapter.hasHooks?.(config.projectRoot)))
        )
          continue;
      } catch {
        checks.push({
          name: `${adapter.displayName} settings`,
          ok: null,
          detail: "Unable to detect connected platform",
        });
        continue;
      }
    }
    platforms.push(adapter.platform);
    await check(`${adapter.displayName} settings`, async () => {
      const result = await adapter.validateInstallation(config.projectRoot);
      const failures = result.checks.filter((item) => !item.ok);
      return {
        ok: result.valid && failures.length === 0,
        detail: failures.length
          ? failures
              .map((item) => item.name)
              .join("; ")
              .slice(0, 1000)
          : "Hooks configured",
      };
    });
  }
  checks.push({
    name: "Connected platforms",
    ok: platforms.length > 0,
    detail: platforms.join(", ") || "No platforms connected",
  });
  await check("Disk usage", () => {
    const mb = statSync(config.dbPath).size / (1024 * 1024);
    return { ok: mb < 100, detail: `Database: ${mb.toFixed(1)} MB` };
  });
  const cli = cliVersion ?? installedCliVersion();
  if (source === "cli" && !cli) throw new Error("CLI version is required");
  const agents = readAgentRuntimeVersions(config.dataDir);
  const agent =
    agents.sort((a, b) => {
      const core = a
        .split(/[+-]/)[0]
        .localeCompare(b.split(/[+-]/)[0], undefined, { numeric: true });
      if (core) return core;
      const aPre = a.split("+")[0].includes("-");
      const bPre = b.split("+")[0].includes("-");
      return aPre !== bPre
        ? aPre
          ? -1
          : 1
        : a.localeCompare(b, undefined, { numeric: true });
    })[0] ?? null;
  return {
    schemaVersion: 1,
    source,
    version: source === "hooks" ? hooksVersion : cli!,
    checkedAt: new Date().toISOString(),
    projectId: config.projectId,
    platforms,
    checks,
    components: [
      {
        name: "cli",
        version: cli,
        evidence: cli
          ? source === "cli"
            ? "running"
            : "installed"
          : "unknown",
      },
      {
        name: "hooks",
        version: hooksVersion,
        evidence: source === "hooks" ? "running" : "installed",
      },
      {
        name: "agent",
        version: agent,
        evidence: agent ? "running" : "unknown",
      },
    ],
  };
}
