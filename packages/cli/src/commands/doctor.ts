/**
 * `adit doctor` — Validate ADIT installation health.
 *
 * Checks: git repo, data dir, database, hooks, adit-hook binary,
 * SQLite integrity, stale sessions, and disk usage.
 *
 * `adit doctor --fix` attempts automatic fixes.
 * `adit doctor --json` outputs results as JSON.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  discoverWorkspaceRepositories,
  openDatabase,
  closeDatabase,
  projectManifestPath,
  queryEvents,
  listSessions,
  endSession,
} from "@varveai/adit-core";
import { getRemoteUrl } from "@varveai/adit-engine";
import {
  detectPlatform,
  detectPlatforms,
  getAdapter,
  resolveAditHookBinary,
  type PlatformAdapter,
} from "@varveai/adit-hooks/adapters";
import { checkAditHookBinary } from "./doctor-hooks.js";
import { loadInitializedProjectConfig } from "./project-initialization.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fixable?: boolean;
}

export async function doctorCommand(
  opts?: { fix?: boolean; json?: boolean },
): Promise<void> {
  const checks: Check[] = [];
  const config = loadInitializedProjectConfig("adit doctor");
  if (!config) return;

  // 1. Project manifest — the single authority on identity and members.
  const typeLabel = config.projectType === "workspace" ? "multi-repo" : "single-repo";
  checks.push({
    name: "Project manifest",
    ok: true,
    detail: `${typeLabel} · ${config.repositories.length} repositories · ${projectManifestPath(config.projectRoot)}`,
  });

  // 1b. Registered repositories exist and are Git repositories (soft check —
  //     doctor reports drift, only `adit init` may change the list).
  const missingRepos = config.repositories
    .filter((repo) => !existsSync(join(repo.path, ".git")))
    .map((repo) => repo.relativePath);
  checks.push({
    name: "Repositories",
    ok: missingRepos.length === 0,
    detail:
      missingRepos.length === 0
        ? `${config.repositories.length} registered, all present`
        : `missing: ${missingRepos.join(", ")} — run 'adit init' to update the list`,
  });

  // 1c. Every present repository has a git remote 'origin'.
  const reposWithoutOrigin: string[] = [];
  for (const repo of config.repositories) {
    if (missingRepos.includes(repo.relativePath)) continue;
    const remoteUrl = await getRemoteUrl(repo.path).catch(() => null);
    if (!remoteUrl) reposWithoutOrigin.push(repo.relativePath === "." ? repo.displayName : repo.relativePath);
  }
  checks.push({
    name: "Git remotes",
    ok: reposWithoutOrigin.length === 0,
    detail:
      reposWithoutOrigin.length === 0
        ? "all repositories have an origin"
        : `no origin: ${reposWithoutOrigin.join(", ")} — add one with 'git remote add origin <url>'`,
  });

  // 1d. Multi-repo drift: repositories on disk that are not registered.
  if (config.projectType === "workspace") {
    const registered = config.repositories.map((repo) => repo.relativePath);
    const unregistered = discoverWorkspaceRepositories(config.projectRoot)
      .map((repo) => repo.relativePath)
      .filter((path) => !registered.includes(path));
    checks.push({
      name: "Unregistered repositories",
      ok: unregistered.length === 0,
      detail:
        unregistered.length === 0
          ? "none"
          : `${unregistered.join(", ")} — run 'adit init' to add them`,
    });
  }

  // 2. Data directory
  const dataDirOk = existsSync(config.dataDir);
  checks.push({
    name: "Data directory",
    ok: dataDirOk,
    detail: dataDirOk ? config.dataDir : "Run 'adit init' first",
  });

  // 3. Database
  let dbOk = false;
  let db: ReturnType<typeof openDatabase> | null = null;
  try {
    db = openDatabase(config.dbPath);
    queryEvents(db, { limit: 1 });
    dbOk = true;
  } catch {
    // DB failed
  }
  checks.push({
    name: "Database",
    ok: dbOk,
    detail: dbOk ? `${config.dbPath} (accessible)` : "Cannot open database",
  });

  // 4. SQLite integrity
  if (db && dbOk) {
    let integrityOk = false;
    try {
      const result = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
      integrityOk = result.length === 1 && result[0].integrity_check === "ok";
    } catch {
      // ignore
    }
    checks.push({
      name: "SQLite integrity",
      ok: integrityOk,
      detail: integrityOk ? "PRAGMA integrity_check: ok" : "Database integrity check failed",
    });
  }

  // 5. adit-hook binary
  const aditHookBinary = resolveAditHookBinary();
  const binaryCheck = checkAditHookBinary(aditHookBinary);
  checks.push({
    name: "adit-hook binary",
    ok: binaryCheck.ok,
    detail: binaryCheck.detail,
  });

  // 6. Hooks — validate adapters detected in the current project root.
  const detectedPlatforms = detectPlatforms(config.projectRoot);
  const implementedAdapters = detectedPlatforms
    .map((platform) => getAdapter(platform))
    .filter((a) => a.hookMappings.length > 0);
  let hooksOk = false;
  const hooksDetails: string[] = [];
  const adaptersNeedingFix: typeof implementedAdapters = [];

  for (const adapter of implementedAdapters) {
    const result = await adapter.validateInstallation(config.projectRoot);
    if (result.valid) {
      hooksOk = true;
      // Advisory checks don't fail validation (reinstall can't fix them),
      // but the user still needs to see them.
      const warnings = result.checks
        .filter((c) => c.advisory && !c.ok)
        .map((c) => c.detail);
      hooksDetails.push(
        `${adapter.displayName}: OK${warnings.length > 0 ? ` — warning: ${warnings.join("; ")}` : ""}`,
      );
    } else if (result.checks.some((c) => !c.advisory && c.ok)) {
      // Platform directory exists but hooks incomplete
      hooksDetails.push(`${adapter.displayName}: ${result.checks.filter((c) => !c.ok).map((c) => c.detail).join("; ")}`);
      adaptersNeedingFix.push(adapter);
    }
  }

  if (hooksDetails.length === 0) {
    const detected = detectPlatform();
    const detectedAdapter = getAdapter(detected);
    hooksDetails.push(
      detected === "other"
        ? "No platform hooks found"
        : `No platform hooks found (detected: ${detectedAdapter.displayName})`,
    );
    if (isImplementedAdapter(detectedAdapter)) {
      adaptersNeedingFix.push(detectedAdapter);
    }
  }

  checks.push({
    name: "Hooks config",
    ok: hooksOk,
    detail: hooksDetails.join("; "),
    fixable: !hooksOk && adaptersNeedingFix.length > 0,
  });

  // 7. Platform hook completeness — detailed per-adapter validation
  //    (check #6 above gives a summary; this gives per-check detail)
  const detectedPlatform = detectPlatform();
  const platformAdapter = getAdapter(detectedPlatform);
  if (isImplementedAdapter(platformAdapter)) {
    const platformResult = await platformAdapter.validateInstallation(config.projectRoot);

    checks.push({
      name: `${platformAdapter.displayName} settings`,
      ok: platformResult.valid,
      detail: platformResult.checks.map((c) => `${c.name}: ${c.detail}`).join("; "),
      fixable: !platformResult.valid,
    });
  }

  // 8. Stale sessions
  let staleCount = 0;
  const staleSessions: string[] = [];
  if (db && dbOk) {
    const sessions = listSessions(db, config.projectId);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    for (const s of sessions) {
      if (s.status === "active" && s.startedAt < dayAgo) {
        staleCount++;
        staleSessions.push(s.id);
      }
    }
  }
  checks.push({
    name: "Stale sessions",
    ok: staleCount === 0,
    detail: staleCount > 0 ? `${staleCount} sessions active >24h` : "No stale sessions",
    fixable: staleCount > 0,
  });

  // 9. Disk space
  let diskOk = true;
  let diskDetail = "OK";
  try {
    const stat = statSync(config.dataDir);
    if (stat.isDirectory()) {
      // Simple check: if adit.sqlite > 100MB, warn
      const dbStat = statSync(config.dbPath);
      const sizeMB = dbStat.size / (1024 * 1024);
      diskOk = sizeMB < 100;
      diskDetail = `Database: ${sizeMB.toFixed(1)}MB${sizeMB >= 100 ? " (large)" : ""}`;
    }
  } catch {
    diskDetail = "Cannot check disk usage";
  }
  checks.push({
    name: "Disk usage",
    ok: diskOk,
    detail: diskDetail,
  });

  // Attempt fixes if --fix
  if (opts?.fix) {
    const fixes: string[] = [];

    // Fix stale sessions
    if (staleCount > 0 && db) {
      for (const sid of staleSessions) {
        try {
          endSession(db, sid, "completed");
          fixes.push(`Closed stale session: ${sid.substring(0, 10)}`);
        } catch {
          // ignore
        }
      }
    }

    // Fix missing platform hooks.
    if (!hooksOk) {
      for (const adapter of adaptersNeedingFix) {
        try {
          await adapter.installHooks(config.projectRoot, aditHookBinary);
          fixes.push(`Installed ADIT hooks for ${adapter.displayName}`);
        } catch {
          // ignore
        }
      }
    }

    if (fixes.length > 0 && !opts.json) {
      console.log("\nFixes applied:");
      for (const fix of fixes) {
        console.log(`  [*] ${fix}`);
      }
    }
  }

  if (db) closeDatabase(db);

  // Output
  if (opts?.json) {
    console.log(JSON.stringify({
      checks: checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
      allPassed: checks.every((c) => c.ok),
    }, null, 2));
    return;
  }

  console.log("ADIT Health Check\n");
  let allOk = true;
  for (const check of checks) {
    const symbol = check.ok ? "+" : "x";
    const fixTag = !check.ok && check.fixable ? " (--fix)" : "";
    console.log(`  [${symbol}] ${check.name}: ${check.detail}${fixTag}`);
    if (!check.ok) allOk = false;
  }

  console.log(
    allOk
      ? "\nAll checks passed."
      : "\nSome checks failed. Run 'adit doctor --fix' to attempt repairs.",
  );
}

function isImplementedAdapter(adapter: PlatformAdapter): boolean {
  return adapter.hookMappings.length > 0;
}
