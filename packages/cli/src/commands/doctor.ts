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
import { basename, join, relative } from "node:path";
import {
  computeRepositoryDrift,
  readProjectManifest,
  resolveActiveManifestRepositories,
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
import {
  dim,
  formatBytes,
  joinParts,
  marks,
  plural,
  printEnd,
  printLine,
  printRows,
  printSection,
  printTitle,
  shortenPaths,
  strong,
} from "./cli-style.js";
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
    ? resolveActiveManifestRepositories(config.projectRoot, manifest)
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
  let integrityOk: boolean | null = null;
  if (db && dbOk) {
    integrityOk = false;
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
  const platformResults: Array<{
    name: string;
    valid: boolean;
    checks: Array<{ name: string; ok: boolean; detail: string; advisory?: boolean }>;
  }> = [];

  for (const adapter of implementedAdapters) {
    const result = await adapter.validateInstallation(config.projectRoot);
    platformResults.push({ name: adapter.displayName, valid: result.valid, checks: result.checks });
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
  let databaseBytes: number | null = null;
  try {
    const stat = statSync(config.dataDir);
    if (stat.isDirectory()) {
      // Simple check: if adit.sqlite > 100MB, warn
      const dbStat = statSync(config.dbPath);
      databaseBytes = dbStat.size;
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
  const fixes: string[] = [];
  if (opts?.fix) {
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

  // The text view regroups the same facts: one row per repository concern,
  // one per database, and one per connected platform instead of a single
  // "Hooks config" line.
  type Kind = "ok" | "warn" | "fail";
  const view: Array<{ kind: Kind; label: string; value: string }> = [];
  const root = config.projectRoot;
  const inProject = (text: string) => shortenPaths(text, root);
  const relativePath = (path: string) => {
    const relativeValue = relative(root, path);
    return relativeValue && !relativeValue.startsWith("..") ? relativeValue : path;
  };

  view.push({ kind: "ok", label: "Project manifest", value: inProject(checks[0]?.detail ?? "") });

  const repositoryProblems = [
    missingRepos.length > 0 ? `missing: ${missingRepos.join(", ")} · run ${strong("adit init")} to update the list` : null,
    reposWithoutOrigin.length > 0 ? `no origin: ${reposWithoutOrigin.join(", ")} · add one with ${strong("git remote add origin <url>")}` : null,
  ];
  view.push(
    repositoryProblems.some(Boolean)
      ? { kind: "fail", label: "Repositories", value: joinParts(repositoryProblems) }
      : { kind: "ok", label: "Repositories", value: `${registeredRepositories.length} registered, all present, all have an origin` },
  );

  const unregisteredCheck = checks.find((check) => check.name === "Unregistered repositories");
  if (unregisteredCheck) {
    view.push(
      unregisteredCheck.ok
        ? { kind: "ok", label: "Unregistered", value: "none" }
        : { kind: "warn", label: "Unregistered", value: `${unregisteredCheck.detail.replace(/ — run 'adit init' to add them$/u, "")} · run ${strong("adit init")} to add them` },
    );
  }

  view.push(
    dataDirOk
      ? { kind: "ok", label: "Data directory", value: relativePath(config.dataDir) }
      : { kind: "fail", label: "Data directory", value: `missing · run ${strong("adit init")} first` },
  );

  if (!dbOk) {
    view.push({ kind: "fail", label: "Database", value: `cannot open ${relativePath(config.dbPath)}` });
  } else {
    view.push({
      kind: integrityOk === false ? "fail" : diskOk ? "ok" : "warn",
      label: "Database",
      value: joinParts([
        relativePath(config.dbPath),
        databaseBytes !== null ? `${formatBytes(databaseBytes)}${diskOk ? "" : " (large)"}` : null,
        integrityOk === false ? "integrity check failed" : "integrity ok",
      ]),
    });
  }

  const binaryLocation = binaryCheck.detail.replace(/^Available via /u, "").replace(/^node "(.+)"$/u, "$1");
  view.push(
    binaryCheck.ok
      ? { kind: "ok", label: "Hook binary", value: inProject(binaryLocation) }
      : { kind: "fail", label: "Hook binary", value: binaryCheck.detail },
  );

  view.push({
    kind: implementedAdapters.length > 0 ? "ok" : "fail",
    label: "Platforms",
    value: implementedAdapters.length > 0
      ? implementedAdapters.map((adapter) => adapter.displayName).join(", ")
      : `none connected · run ${strong("adit init")} to connect your AI tools`,
  });

  for (const platform of platformResults) {
    const warnings = platform.checks.filter((check) => check.advisory && !check.ok);
    const failures = platform.checks.filter((check) => !check.ok && !check.advisory);
    const label = `${platform.name} hooks`;
    if (!platform.valid) {
      view.push({
        kind: "fail",
        label,
        value: `${joinParts(failures.map((check) => inProject(check.detail)))} ${dim("(fix: adit doctor --fix)")}`,
      });
    } else if (warnings.length > 0) {
      view.push({ kind: "warn", label, value: joinParts(warnings.map((check) => inProject(check.detail))) });
    } else {
      const configuration = platform.checks.find((check) => check.name === "Hook configuration");
      const detail = configuration ? inProject(configuration.detail) : "registered";
      view.push({ kind: "ok", label, value: detail.charAt(0).toLowerCase() + detail.slice(1) });
    }
  }

  printTitle("Health check", basename(root));
  printRows(view.map((row) => ({ mark: marks[row.kind], label: row.label, value: row.value })));

  if (fixes.length > 0) {
    printSection("Fixes");
    for (const fix of fixes) printLine(`${marks.change} ${fix}`);
  }

  const failed = view.filter((row) => row.kind === "fail").length;
  const warned = view.filter((row) => row.kind === "warn").length;
  const passed = view.filter((row) => row.kind === "ok").length;
  if (fixes.length > 0) {
    printEnd(`${marks.change} ${plural(fixes.length, "fix", "fixes")} applied · run ${strong("adit doctor")} again to confirm`);
  } else if (failed > 0) {
    const fixable = checks.some((check) => !check.ok && check.fixable);
    printEnd(`${marks.fail} ${plural(failed, "check")} failed${fixable ? ` · run ${strong("adit doctor --fix")} to repair` : ""}`);
  } else if (warned > 0) {
    printEnd(`${marks.warn} ${plural(warned, "warning")}, ${plural(passed, "check")} passed`);
  } else {
    printEnd(`${marks.ok} All ${plural(passed, "check")} passed`);
  }
}

function isImplementedAdapter(adapter: PlatformAdapter): boolean {
  return adapter.hookMappings.length > 0;
}
