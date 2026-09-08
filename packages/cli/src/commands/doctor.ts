/**
 * `adit doctor` — Validate ADIT installation health.
 *
 * Checks: git repo, data dir, database, hooks, adit-hook binary,
 * SQLite integrity and disk usage.
 *
 * `adit doctor --fix` attempts automatic fixes.
 * `adit doctor --json` outputs results as JSON.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  computeRepositoryDrift,
  readProjectManifest,
  resolveManifestRepositories,
  openDatabase,
  closeDatabase,
  projectManifestPath,
  queryEvents,
} from "@varveai/adit-core";
import { getRemoteUrl } from "@varveai/adit-engine";
import {
  detectPlatform,
  getAdapter,
  resolveAditHookBinary,
  type PlatformAdapter,
} from "@varveai/adit-hooks/adapters";
import pc from "picocolors";
import { marks, sectionTitle } from "./cli-style.js";
import { ensureConnectedPlatformsRecorded } from "./connected-platforms.js";
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
  const manifest = readProjectManifest(config.projectRoot);
  const registeredRepositories = manifest
    ? resolveManifestRepositories(config.projectRoot, manifest)
    : config.repositories;
  checks.push({
    name: "Project manifest",
    ok: true,
    detail: `${registeredRepositories.length} ${registeredRepositories.length === 1 ? "repository" : "repositories"} · ${projectManifestPath(config.projectRoot)}`,
  });

  // 1b. Registered repositories exist and are Git repositories (soft check —
  //     doctor reports drift, only `adit init` may change the list).
  const missingRepos = registeredRepositories
    .filter((repo) => !existsSync(join(repo.path, ".git")))
    .map((repo) => repo.relativePath);
  checks.push({
    name: "Repositories",
    ok: missingRepos.length === 0,
    detail:
      missingRepos.length === 0
        ? `${registeredRepositories.length} registered, all present`
        : `missing: ${missingRepos.join(", ")} — run 'adit init' to update the list`,
  });

  // 1c. Every present repository has a git remote 'origin'.
  const reposWithoutOrigin: string[] = [];
  for (const repo of registeredRepositories) {
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

  // 1d. Drift for projects with member repositories: repositories on disk
  //     that are not registered.
  if (manifest && manifest.repositories.some((repo) => repo.relativePath !== ".")) {
    const unregistered = computeRepositoryDrift(config.projectRoot, manifest).unregistered;
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

  // 6. Hooks — validate the platforms the user connected to this project.
  //    Legacy projects are backfilled from existing hook configuration; a
  //    platform the user never connected is never validated or auto-installed.
  const connectedPlatforms = await ensureConnectedPlatformsRecorded(config.projectRoot);
  const implementedAdapters = connectedPlatforms
    .map((platform) => getAdapter(platform))
    .filter((a) => a.hookMappings.length > 0);

  checks.push({
    name: "Connected platforms",
    ok: true,
    detail: implementedAdapters.length > 0
      ? implementedAdapters.map((a) => a.displayName).join(", ")
      : "none — run 'adit init' to connect your AI tools",
  });

  let hooksOk = implementedAdapters.length > 0;
  const hooksDetails: string[] = [];
  const adaptersNeedingFix: typeof implementedAdapters = [];

  for (const adapter of implementedAdapters) {
    const result = await adapter.validateInstallation(config.projectRoot);
    if (result.valid) {
      // Advisory checks don't fail validation (reinstall can't fix them),
      // but the user still needs to see them.
      const warnings = result.checks
        .filter((c) => c.advisory && !c.ok)
        .map((c) => c.detail);
      hooksDetails.push(
        `${adapter.displayName}: OK${warnings.length > 0 ? ` — warning: ${warnings.join("; ")}` : ""}`,
      );
    } else {
      hooksOk = false;
      hooksDetails.push(`${adapter.displayName}: ${result.checks.filter((c) => !c.ok).map((c) => c.detail).join("; ")}`);
      adaptersNeedingFix.push(adapter);
    }
  }

  if (implementedAdapters.length === 0) {
    hooksDetails.push("No platforms connected — run 'adit init' to connect your AI tools");
  }

  checks.push({
    name: "Hooks config",
    ok: hooksOk,
    detail: hooksDetails.join("; "),
    fixable: !hooksOk && adaptersNeedingFix.length > 0,
  });

  // 7. Platform hook completeness — detailed per-adapter validation
  //    (check #6 above gives a summary; this gives per-check detail).
  //    Only shown for a connected platform: an unconnected tool's missing
  //    hooks are the user's explicit choice, not a health problem.
  const detectedPlatform = detectPlatform();
  const platformAdapter = getAdapter(detectedPlatform);
  if (isImplementedAdapter(platformAdapter) && connectedPlatforms.includes(detectedPlatform)) {
    const platformResult = await platformAdapter.validateInstallation(config.projectRoot);

    checks.push({
      name: `${platformAdapter.displayName} settings`,
      ok: platformResult.valid,
      detail: platformResult.checks.map((c) => `${c.name}: ${c.detail}`).join("; "),
      fixable: !platformResult.valid,
    });
  }

  // 8. Disk space
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
      console.log(`\n${pc.green("Fixes applied:")}`);
      for (const fix of fixes) {
        console.log(`  ${pc.green("[*]")} ${fix}`);
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

  console.log(sectionTitle("ADIT Health Check") + "\n");
  let allOk = true;
  for (const check of checks) {
    const mark = check.ok ? marks.ok : marks.fail;
    const fixTag = !check.ok && check.fixable ? pc.cyan(" (--fix)") : "";
    // Passing details are secondary; a failing check's detail is the payload.
    const detail = check.ok ? pc.dim(check.detail) : check.detail;
    console.log(`  ${mark} ${check.name}: ${detail}${fixTag}`);
    if (!check.ok) allOk = false;
  }

  console.log(
    allOk
      ? `\n${pc.bold(pc.green("All checks passed."))}`
      : `\n${pc.red("Some checks failed.")} Run ${pc.bold("'adit doctor --fix'")} to attempt repairs.`,
  );
}

function isImplementedAdapter(adapter: PlatformAdapter): boolean {
  return adapter.hookMappings.length > 0;
}
