/**
 * `adit update` — Update ADIT to the latest version (aliases: upgrade, self-update).
 *
 * Two install flavours:
 * - Source install (git clone, developers): pull, reinstall deps, rebuild.
 * - Package-manager install (npm / pnpm / yarn / bun, users): look up the
 *   latest published version and run the matching global install command.
 */

import { execFileSync, execSync, type ExecSyncOptions } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { compareVersions, fetchLatestPublishedVersion } from "../update-check.js";
import { CLI_VERSION } from "../version.js";

export function completeUpgradedInstallation(expectedVersion?: string): boolean {
  try {
    const env = { ...process.env };
    delete env.ADIT_DEFER_INSTALL_SETUP;
    execFileSync(process.execPath, [resolve(dirname(realpathSync(process.argv[1])), "install-skills.js"),
      ...(expectedVersion ? ["--expected-version", expectedVersion] : [])], { stdio: "inherit", env });
    return true;
  } catch (error) {
    console.error("ADIT package update finished, but user setup is incomplete. Fix the reported error and run 'adit update' to retry.");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return false;
  }
}

const PACKAGE_NAME = "@varveai/adit-cli";

export type GlobalPackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * Guess which package manager owns the global install from where the CLI
 * entry script lives (each manager keeps globals under a recognizable path).
 * `ADIT_UPGRADE_COMMAND` in the environment overrides the guess entirely.
 */
export function detectGlobalPackageManager(scriptPath: string): GlobalPackageManager {
  const normalized = scriptPath.replace(/\\/gu, "/").toLowerCase();
  if (normalized.includes("/.bun/")) return "bun";
  if (normalized.includes("/pnpm/") || normalized.includes("/.pnpm/")) return "pnpm";
  if (normalized.includes("/yarn/") || normalized.includes("/.yarn/")) return "yarn";
  return "npm";
}

export function buildGlobalUpgradeCommand(
  packageManager: GlobalPackageManager,
  version: string = "latest",
): string {
  const spec = `${PACKAGE_NAME}@${version}`;
  switch (packageManager) {
    case "pnpm":
      return `pnpm add -g ${spec}`;
    case "yarn":
      return `yarn global add ${spec}`;
    case "bun":
      return `bun add -g ${spec}`;
    default:
      return `npm install -g ${spec}`;
  }
}

/** Upgrade path for npm / pnpm / yarn / bun global installs. */
async function upgradePackageInstall(opts?: { check?: boolean }): Promise<void> {
  const packageManager = detectGlobalPackageManager(process.argv[1] ?? "");
  console.log(`Checking npm for the latest ${PACKAGE_NAME} ...`);
  const latest = await fetchLatestPublishedVersion();

  if (latest && compareVersions(CLI_VERSION, latest) >= 0) {
    if (!opts?.check && !completeUpgradedInstallation()) return;
    console.log(`Already up to date (v${CLI_VERSION}).`);
    return;
  }
  if (!latest) {
    console.log("Could not reach the npm registry to compare versions.");
    if (opts?.check) {
      process.exitCode = 1;
      return;
    }
  } else {
    console.log(`Update available: v${CLI_VERSION} -> v${latest}`);
    if (opts?.check) return;
  }

  const command =
    process.env.ADIT_UPGRADE_COMMAND?.trim() ||
    buildGlobalUpgradeCommand(packageManager, latest ?? "latest");
  console.log();
  console.log(`Running: ${command}`);
  console.log();
  try {
    execSync(command, { stdio: "inherit", env: { ...process.env, ADIT_DEFER_INSTALL_SETUP: "1" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error();
    console.error("Upgrade failed.");
    if (/EACCES|permission denied/iu.test(message)) {
      console.error("The global install directory is not writable by your user.");
    }
    console.error(`Run it yourself to see the full output:\n  ${command}`);
    process.exitCode = 1;
    return;
  }
  if (!completeUpgradedInstallation(latest ?? undefined)) return;
  console.log();
  console.log(
    `Updated successfully: v${CLI_VERSION} -> v${latest ?? "latest"}. Run \`adit --version\` to confirm.`,
  );
}

/** Default install location used by install.sh */
const DEFAULT_INSTALL_DIR = resolve(
  process.env.ADIT_INSTALL_DIR ?? `${process.env.HOME ?? "~"}/.adit-core`,
);

/**
 * Resolve the adit-core install directory by walking up from the
 * running CLI entry point to find the monorepo root.
 */
function resolveInstallDir(): string | null {
  // Method 1: Walk up from the running script to find the monorepo root
  // The CLI runs from <root>/packages/cli/dist/index.js
  try {
    const cliDist = dirname(process.argv[1] ?? "");
    const candidate = resolve(cliDist, "../../..");
    if (
      existsSync(resolve(candidate, "package.json")) &&
      existsSync(resolve(candidate, ".git"))
    ) {
      return candidate;
    }
  } catch {
    /* best-effort */
  }

  // Method 2: Use the default install directory
  if (
    existsSync(resolve(DEFAULT_INSTALL_DIR, "package.json")) &&
    existsSync(resolve(DEFAULT_INSTALL_DIR, ".git"))
  ) {
    return DEFAULT_INSTALL_DIR;
  }

  return null;
}

/**
 * Read the version from a package.json file.
 */
function readVersionFromPackageJson(rootDir: string): string | null {
  try {
    const pkgPath = resolve(rootDir, "packages/cli/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version?: string;
    };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export async function selfUpdateCommand(opts?: {
  check?: boolean;
}): Promise<void> {
  const installDir = resolveInstallDir();

  if (!installDir) {
    await upgradePackageInstall(opts);
    return;
  }

  const execOpts: ExecSyncOptions = {
    cwd: installDir,
    stdio: "pipe",
    encoding: "utf8" as const,
  };

  // Pull latest changes
  console.log(`Checking for updates in ${installDir} ...`);

  try {
    execSync("git fetch origin", { ...execOpts, stdio: "pipe" });
  } catch (e) {
    console.error("Failed to fetch from remote:", (e as Error).message);
    process.exitCode = 1;
    return;
  }

  // Check if there are upstream changes
  let behind = 0;
  try {
    const behindStr = execSync(
      "git rev-list --count HEAD..origin/main",
      execOpts,
    ) as unknown as string;
    behind = parseInt(String(behindStr).trim(), 10) || 0;
  } catch {
    // If we can't determine, proceed with update
    behind = -1;
  }

  if (behind === 0) {
    // Check version in case local changes were made
    const latestVer = readVersionFromPackageJson(installDir);
    if (latestVer === CLI_VERSION) {
      if (!opts?.check && !completeUpgradedInstallation()) return;
      console.log(`Already up to date (v${CLI_VERSION}).`);
      return;
    }
  }

  if (opts?.check) {
    if (behind > 0) {
      const latestVer = readVersionFromPackageJson(installDir);
      console.log(
        `Update available: v${CLI_VERSION} -> v${latestVer ?? "unknown"} (${behind} commit${behind === 1 ? "" : "s"} behind)`,
      );
    } else if (behind === 0) {
      console.log(`Already up to date (v${CLI_VERSION}).`);
    }
    return;
  }

  // Perform the update
  const showExecOpts: ExecSyncOptions = {
    ...execOpts,
    stdio: "inherit",
  };

  console.log(`Updating from v${CLI_VERSION} ...`);
  console.log();

  // Step 1: Pull
  try {
    console.log("Pulling latest changes ...");
    execSync("git pull --ff-only origin main", showExecOpts);
  } catch {
    console.error(
      "Failed to pull latest changes. You may have local modifications.",
    );
    console.error("Try: git -C " + installDir + " stash && adit update");
    process.exitCode = 1;
    return;
  }

  // Step 2: Install dependencies
  try {
    console.log();
    console.log("Installing dependencies ...");
    execSync("pnpm install --frozen-lockfile", {
      ...showExecOpts,
      env: { ...process.env, COREPACK_ENABLE_STRICT: "0", ADIT_DEFER_INSTALL_SETUP: "1" },
    });
  } catch {
    // Retry without frozen lockfile
    try {
      execSync("pnpm install", {
        ...showExecOpts,
        env: { ...process.env, COREPACK_ENABLE_STRICT: "0", ADIT_DEFER_INSTALL_SETUP: "1" },
      });
    } catch {
      console.error("Failed to install dependencies.");
      process.exitCode = 1;
      return;
    }
  }

  // Step 3: Build
  try {
    console.log();
    console.log("Building ...");
    execSync("pnpm build", showExecOpts);
  } catch {
    console.error("Build failed.");
    process.exitCode = 1;
    return;
  }

  if (!completeUpgradedInstallation()) return;

  // Step 4: Report
  const newVer = readVersionFromPackageJson(installDir);
  console.log();
  console.log(
    `Updated successfully: v${CLI_VERSION} -> v${newVer ?? "unknown"}`,
  );
  console.log("Run `adit doctor` to verify your installation.");
}
