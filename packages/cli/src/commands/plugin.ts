/**
 * `adit hook` — Platform hook management commands.
 *
 * Install, uninstall, list, and validate ADIT integrations
 * for different AI platforms. All commands auto-detect which
 * platforms are present in the project (by checking for config
 * directories like .claude/ and .opencode/) when no explicit
 * platform argument is given.
 */

import { existsSync, rmSync } from "node:fs";
import { findGitRoot, type AditConfig } from "@varveai/adit-core";
import {
  getAdapter,
  listAdapters,
  detectPlatforms,
  detectInstalledPlatforms,
  resolveAditHookBinary,
  type PlatformAdapter,
} from "@varveai/adit-hooks/adapters";
import type { Platform } from "@varveai/adit-core";
import {
  addConnectedPlatforms,
  removeConnectedPlatform,
  writeConnectedPlatforms,
} from "./connected-platforms.js";
import { basename } from "node:path";
import pc from "picocolors";
import {
  dim,
  marks,
  plural,
  printEnd,
  printRows,
  printSection,
  printTable,
  printTitle,
  rowLabelWidth,
  shortenPaths,
  stateWord,
  strong,
} from "./cli-style.js";
import { loadInitializedProjectConfig } from "./project-initialization.js";

export interface UninstallHooksResult {
  uninstalled: string[];
  errors: string[];
}

/**
 * Resolve the project root from config, preferring git root for
 * directory-based platform detection.
 */
function resolveProjectRoot(config: AditConfig): string {
  return findGitRoot(config.projectRoot) ?? config.projectRoot;
}

/** adit hook install [platform] */
export async function pluginInstallCommand(
  platformArg?: string,
  opts?: { json?: boolean },
): Promise<void> {
  const config = loadInitializedProjectConfig("adit hook install");
  if (!config) return;
  const aditBinaryPath = resolveAditHookBinary();

  // If explicit platform, install just that one
  if (platformArg) {
    const platform = platformArg as Platform;
    const adapter = getAdapterSafe(platform);
    if (!adapter) return;
    await installSinglePlatform(adapter, config.projectRoot, aditBinaryPath, opts);
    return;
  }

  // Auto-detect AI CLIs installed on this machine
  const platforms = detectInstalledPlatforms();

  if (platforms.length === 0) {
    if (opts?.json) {
      console.log(JSON.stringify({
        ok: false,
        action: "install",
        error: "No AI CLIs found on PATH",
        platforms: [],
      }));
    } else {
      console.log();
      console.log("  No AI CLIs found on PATH.");
      console.log("  Supported CLIs: claude, codex, gemini, opencode");
      console.log();
      console.log("  To install for a specific platform:");
      console.log("    adit hook install claude-code");
      console.log("    adit hook install codex");
      console.log("    Cursor uses the claude-code hooks above.");
      console.log();
    }
    return;
  }

  // Install for all detected platforms
  const installed: string[] = [];
  const installedPlatforms: Platform[] = [];
  const errors: string[] = [];

  if (!opts?.json) {
    console.log();
    console.log(`  Installing ADIT hooks (${platforms.length} platform${platforms.length > 1 ? "s" : ""} detected)`);
    console.log();
  }

  for (const platform of platforms) {
    const adapter = getAdapterSafe(platform);
    if (!adapter) continue;

    if (adapter.hookMappings.length === 0) {
      if (!opts?.json) {
        console.log(pc.dim(`  ${marks.skip} ${adapter.displayName} — detected but not yet supported`));
      }
      continue;
    }

    try {
      await adapter.installHooks(config.projectRoot, aditBinaryPath);
      installed.push(adapter.displayName);
      installedPlatforms.push(adapter.platform);

      if (!opts?.json) {
        console.log(`  ${marks.ok} ${adapter.displayName} ${pc.dim(`— ${adapter.hookMappings.length} hook events`)}`);

        // Show validation checks
        const result = await adapter.validateInstallation(config.projectRoot);
        for (const check of result.checks) {
          if (check.ok) {
            console.log(`      ${marks.ok} ${pc.dim(check.name)}`);
          } else if (check.advisory) {
            console.log(`      ${marks.warn} ${check.name}: ${check.detail}`);
          } else {
            console.log(`      ${marks.fail} ${check.name}`);
          }
        }
      }
    } catch (err) {
      errors.push(`${adapter.displayName}: ${(err as Error).message}`);
      if (!opts?.json) {
        console.log(`  ${marks.fail} ${adapter.displayName} — ${(err as Error).message}`);
      }
    }
  }

  if (installedPlatforms.length > 0) {
    await addConnectedPlatforms(config.projectRoot, installedPlatforms);
  }

  if (opts?.json) {
    console.log(JSON.stringify({
      ok: errors.length === 0 && installed.length > 0,
      action: "install",
      installed,
      errors: errors.length > 0 ? errors : undefined,
    }));
  } else {
    console.log();
    if (installed.length > 0) {
      console.log(`  ${pc.bold(pc.green("Done!"))} Installed for: ${installed.join(", ")}`);
    } else {
      console.log("  No hooks were installed.");
    }
    if (errors.length > 0) {
      for (const err of errors) {
        console.log(`  ${marks.fail} ${err}`);
      }
    }
    console.log();
  }
}

/** Install hooks for a single explicit platform */
async function installSinglePlatform(
  adapter: PlatformAdapter,
  projectRoot: string,
  aditBinaryPath: string,
  opts?: { json?: boolean },
): Promise<void> {
  try {
    await adapter.installHooks(projectRoot, aditBinaryPath);
    await addConnectedPlatforms(projectRoot, [adapter.platform]);

    if (opts?.json) {
      console.log(JSON.stringify({
        ok: true,
        platform: adapter.platform,
        action: "install",
      }));
    } else {
      console.log();
      console.log(`  ${marks.ok} Installed ADIT hooks for ${adapter.displayName}`);
      console.log();

      // Validate after install
      const result = await adapter.validateInstallation(projectRoot);
      for (const check of result.checks) {
        const mark = check.ok ? marks.ok : check.advisory ? marks.warn : marks.fail;
        console.log(`      ${mark} ${check.name}: ${check.ok ? pc.dim(check.detail) : check.detail}`);
      }
      console.log();
    }
  } catch (err) {
    if (opts?.json) {
      console.log(JSON.stringify({
        ok: false,
        platform: adapter.platform,
        action: "install",
        error: (err as Error).message,
      }));
    } else {
      console.error(`  ${marks.fail} Failed to install hooks for ${adapter.displayName}: ${(err as Error).message}`);
    }
    process.exit(1);
  }
}

/** adit hook uninstall [platform] */
export async function pluginUninstallCommand(
  platformArg?: string,
  opts?: { json?: boolean; all?: boolean; clean?: boolean },
): Promise<void> {
  const config = loadInitializedProjectConfig("adit hook uninstall");
  if (!config) return;

  // --all: uninstall every installed platform (legacy behavior preserved)
  if (opts?.all) {
    const result = await uninstallAll(config.projectRoot, config.dataDir, opts);
    printUninstallResult(result, config.dataDir, result.dataRemoved, opts);
    return;
  }

  // Explicit platform: uninstall just that one
  if (platformArg) {
    const platform = platformArg as Platform;
    const adapter = getAdapterSafe(platform);
    if (!adapter) return;
    await uninstallSinglePlatform(adapter, config.projectRoot, config.dataDir, opts);
    return;
  }

  const result = await uninstallInstalledPlatformHooks(config.projectRoot);
  writeConnectedPlatforms(config.projectRoot, []);
  const errors = [...result.errors];

  // Optionally remove .adit/ data directory
  let dataRemoved = false;
  if (opts?.clean && existsSync(config.dataDir)) {
    try {
      rmSync(config.dataDir, { recursive: true, force: true });
      dataRemoved = true;
    } catch (err) {
      errors.push(`Failed to remove data directory: ${(err as Error).message}`);
    }
  }

  printUninstallResult(
    { uninstalled: result.uninstalled, errors },
    config.dataDir,
    dataRemoved,
    opts,
  );
}

/**
 * Uninstall all installed ADIT platform hooks for a project.
 *
 * This intentionally does not remove `.adit/`; callers decide whether they
 * are doing hook-only cleanup or full project uninstall.
 */
export async function uninstallInstalledPlatformHooks(
  projectRoot: string,
): Promise<UninstallHooksResult> {
  const detectionRoot = findGitRoot(projectRoot) ?? projectRoot;

  // Auto-detect all detected/installed platforms. First check which platforms
  // are actually installed.
  const allAdapters = listAdapters().filter((a) => a.hookMappings.length > 0);

  // Combine: check detected platforms + any currently-installed platform
  const toCheck = new Map<string, PlatformAdapter>();
  for (const p of detectPlatforms(detectionRoot)) {
    const adapter = getAdapterSafe(p);
    if (adapter && adapter.hookMappings.length > 0) {
      toCheck.set(adapter.platform, adapter);
    }
  }
  for (const adapter of allAdapters) {
    if (!toCheck.has(adapter.platform)) {
      try {
        const result = await adapter.validateInstallation(projectRoot);
        if (result.valid) {
          toCheck.set(adapter.platform, adapter);
        }
      } catch {
        // ignore
      }
    }
  }

  if (toCheck.size === 0) {
    return { uninstalled: [], errors: [] };
  }

  const uninstalled: string[] = [];
  const errors: string[] = [];

  for (const adapter of toCheck.values()) {
    try {
      const installed = await hasInstalledHooks(adapter, projectRoot);
      if (installed) {
        await adapter.uninstallHooks(projectRoot);
        uninstalled.push(adapter.displayName);
      }
    } catch (err) {
      errors.push(`${adapter.displayName}: ${(err as Error).message}`);
    }
  }

  return { uninstalled, errors };
}

async function hasInstalledHooks(adapter: PlatformAdapter, projectRoot: string): Promise<boolean> {
  if (adapter.hasHooks) {
    return adapter.hasHooks(projectRoot);
  }

  const result = await adapter.validateInstallation(projectRoot);
  return result.valid;
}

/** Uninstall hooks for ALL installed platforms (--all flag) */
async function uninstallAll(
  projectRoot: string,
  dataDir: string,
  opts?: { json?: boolean; clean?: boolean },
): Promise<UninstallHooksResult & { dataRemoved: boolean }> {
  const uninstalled: string[] = [];
  const errors: string[] = [];

  for (const adapter of listAdapters()) {
    if (adapter.hookMappings.length === 0) continue;
    try {
      const installed = await hasInstalledHooks(adapter, projectRoot);
      if (installed) {
        await adapter.uninstallHooks(projectRoot);
        uninstalled.push(adapter.displayName);
      }
    } catch (err) {
      errors.push(`${adapter.platform}: ${(err as Error).message}`);
    }
  }
  writeConnectedPlatforms(projectRoot, []);

  // Optionally remove .adit/ data directory
  let dataRemoved = false;
  if (opts?.clean && existsSync(dataDir)) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      dataRemoved = true;
    } catch (err) {
      errors.push(`Failed to remove data directory: ${(err as Error).message}`);
    }
  }

  return { uninstalled, errors, dataRemoved };
}

function printUninstallResult(
  result: UninstallHooksResult,
  dataDir: string,
  dataRemoved: boolean,
  opts?: { json?: boolean },
): void {
  if (opts?.json) {
    console.log(JSON.stringify({
      ok: result.errors.length === 0,
      action: "uninstall",
      uninstalled: result.uninstalled,
      dataRemoved,
      errors: result.errors.length > 0 ? result.errors : undefined,
    }));
  } else {
    console.log();
    if (result.uninstalled.length === 0) {
      console.log("  No ADIT hooks found to remove.");
    } else {
      for (const displayName of result.uninstalled) {
        console.log(`  ${marks.change} Removed ${displayName} hooks`);
      }
    }
    if (dataRemoved) {
      console.log(`  ${marks.change} Removed data directory: ${dataDir}`);
    }
    for (const err of result.errors) {
      console.error(`  ${marks.fail} ${err}`);
    }
    console.log();
  }
}

/** Uninstall hooks for a single explicit platform */
async function uninstallSinglePlatform(
  adapter: PlatformAdapter,
  projectRoot: string,
  dataDir: string,
  opts?: { json?: boolean; clean?: boolean },
): Promise<void> {
  try {
    await adapter.uninstallHooks(projectRoot);
    await removeConnectedPlatform(projectRoot, adapter.platform);

    // Optionally remove .adit/ data directory
    let dataRemoved = false;
    if (opts?.clean && existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true, force: true });
      dataRemoved = true;
    }

    if (opts?.json) {
      console.log(JSON.stringify({
        ok: true,
        platform: adapter.platform,
        action: "uninstall",
        dataRemoved,
      }));
    } else {
      console.log();
      console.log(`  ${marks.change} Removed ${adapter.displayName} hooks`);
      if (dataRemoved) {
        console.log(`  ${marks.change} Removed data directory: ${dataDir}`);
      }
      console.log();
    }
  } catch (err) {
    if (opts?.json) {
      console.log(JSON.stringify({
        ok: false,
        platform: adapter.platform,
        action: "uninstall",
        error: (err as Error).message,
      }));
    } else {
      console.error(`  ${marks.fail} Failed to remove hooks for ${adapter.displayName}: ${(err as Error).message}`);
    }
    process.exit(1);
  }
}

/** adit hook list */
export async function pluginListCommand(
  opts?: { json?: boolean },
): Promise<void> {
  const config = loadInitializedProjectConfig("adit hook list");
  if (!config) return;
  const adapters = listAdapters();
  const projectRoot = resolveProjectRoot(config);

  if (opts?.json) {
    const results = [];
    for (const a of adapters) {
      const isImplemented = a.hookMappings.length > 0;
      let isInstalled = false;
      if (isImplemented) {
        try {
          const result = await a.validateInstallation(projectRoot);
          isInstalled = result.valid;
        } catch {
          // ignore
        }
      }
      results.push({
        platform: a.platform,
        displayName: a.displayName,
        implemented: isImplemented,
        installed: isInstalled,
        hooks: a.hookMappings.map((m) => m.platformEvent),
      });
    }
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const statusRank = { installed: 0, available: 1, "not supported": 2 } as const;
  const entries: Array<{ adapter: PlatformAdapter; status: keyof typeof statusRank }> = [];
  for (const adapter of adapters) {
    let status: keyof typeof statusRank = "not supported";
    if (adapter.hookMappings.length > 0) {
      try {
        const result = await adapter.validateInstallation(projectRoot);
        status = result.valid ? "installed" : "available";
      } catch {
        status = "available";
      }
    }
    entries.push({ adapter, status });
  }
  entries.sort((a, b) => statusRank[a.status] - statusRank[b.status]);
  const installedCount = entries.filter((entry) => entry.status === "installed").length;

  printTitle("Platforms", `${installedCount} installed`);
  printTable(
    [{ header: "platform" }, { header: "id" }, { header: "status" }, { header: "hooks" }],
    entries.map(({ adapter, status }) => [
      adapter.displayName,
      adapter.platform,
      stateWord(status),
      adapter.hookMappings.length > 0 ? String(adapter.hookMappings.length) : "-",
    ]),
  );
  printEnd(dim(`install: ${strong("adit hook install <id>")}`));
}

/** adit hook validate [platform] */
export async function pluginValidateCommand(
  platformArg?: string,
  opts?: { json?: boolean },
): Promise<void> {
  const config = loadInitializedProjectConfig("adit hook validate");
  if (!config) return;
  const projectRoot = resolveProjectRoot(config);

  // If explicit platform, validate just that one
  if (platformArg) {
    const platform = platformArg as Platform;
    const adapter = getAdapterSafe(platform);
    if (!adapter) return;
    await validateSinglePlatform(adapter, config.projectRoot, opts);
    return;
  }

  // Auto-detect and validate all detected platforms
  const platforms = detectPlatforms(projectRoot);
  if (platforms.length === 0) {
    if (opts?.json) {
      console.log(JSON.stringify({ platforms: [], valid: false }));
    } else {
      printTitle("Hook check", basename(config.projectRoot));
      printEnd(`${marks.skip} No AI platforms detected · run ${strong("adit hook validate <platform>")} for a specific one`);
    }
    return;
  }

  const results: Array<{
    platform: string;
    displayName: string;
    valid: boolean;
    checks: Array<{ name: string; ok: boolean; detail: string; advisory?: boolean }>;
  }> = [];

  for (const platform of platforms) {
    const adapter = getAdapterSafe(platform);
    if (!adapter) continue;
    if (adapter.hookMappings.length === 0) continue;

    const result = await adapter.validateInstallation(config.projectRoot);
    results.push({
      platform: adapter.platform,
      displayName: adapter.displayName,
      valid: result.valid,
      checks: result.checks,
    });
  }

  if (opts?.json) {
    const allValid = results.every((r) => r.valid);
    console.log(JSON.stringify({ platforms: results, valid: allValid }, null, 2));
    return;
  }

  printHookChecks(basename(config.projectRoot), results, config.projectRoot);
}

/** Validate a single platform */
async function validateSinglePlatform(
  adapter: PlatformAdapter,
  projectRoot: string,
  opts?: { json?: boolean },
): Promise<void> {
  const result = await adapter.validateInstallation(projectRoot);

  if (opts?.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printHookChecks(
    adapter.displayName,
    [{ displayName: adapter.displayName, checks: result.checks }],
    projectRoot,
  );
}

/** One section per platform, one row per check, and a closing count. */
function printHookChecks(
  scope: string,
  results: Array<{
    displayName: string;
    checks: Array<{ name: string; ok: boolean; detail: string; advisory?: boolean }>;
  }>,
  projectRoot: string,
): void {
  const kind = (check: { ok: boolean; advisory?: boolean }) =>
    check.ok ? "ok" as const : check.advisory ? "warn" as const : "fail" as const;
  const labelWidth = rowLabelWidth(results.flatMap((result) => result.checks.map((check) => ({ label: check.name }))));
  const describe = (detail: string) => {
    const text = shortenPaths(detail, projectRoot);
    return text.charAt(0).toLowerCase() + text.slice(1);
  };

  printTitle("Hook check", scope);
  for (const result of results) {
    printSection(result.displayName);
    printRows(
      result.checks.map((check) => ({ mark: marks[kind(check)], label: check.name, value: describe(check.detail) })),
      labelWidth,
    );
  }

  const all = results.flatMap((result) => result.checks);
  const failed = all.filter((check) => kind(check) === "fail").length;
  const warned = all.filter((check) => kind(check) === "warn").length;
  const passed = all.filter((check) => kind(check) === "ok").length;
  if (failed > 0) {
    printEnd(`${marks.fail} ${plural(failed, "check")} failed · run ${strong("adit doctor --fix")} to repair`);
  } else if (warned > 0) {
    printEnd(`${marks.warn} ${plural(warned, "warning")}, ${plural(passed, "check")} passed`);
  } else {
    printEnd(`${marks.ok} All ${plural(passed, "check")} passed`);
  }
}

function getAdapterSafe(platform: Platform): PlatformAdapter | null {
  try {
    return getAdapter(platform);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
