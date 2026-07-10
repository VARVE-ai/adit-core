import { existsSync } from "node:fs";
import { join, resolve, win32 } from "node:path";
import {
  findGitRoot,
  loadConfig,
  readWorkspaceManifest,
  type AditConfig,
} from "@varveai/adit-core";

export interface AditProjectInitializationPaths {
  dataDir: string;
  dbPath: string;
}

export interface AditProjectInitializationStatus extends AditProjectInitializationPaths {
  dataDirExists: boolean;
  dbExists: boolean;
  initialized: boolean;
}

export function getAditProjectInitializationPaths(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): AditProjectInitializationPaths {
  const dataDir = env.ADIT_DATA_DIR ?? join(projectRoot, ".adit");
  return {
    dataDir,
    dbPath: env.ADIT_DB_PATH ?? join(dataDir, "adit.sqlite"),
  };
}

export function getAditProjectInitializationStatus(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): AditProjectInitializationStatus {
  const paths = getAditProjectInitializationPaths(projectRoot, env);
  const dataDirExists = existsSync(paths.dataDir);
  const dbExists = existsSync(paths.dbPath);
  return {
    ...paths,
    dataDirExists,
    dbExists,
    initialized: dataDirExists && dbExists,
  };
}

export function isAditProjectInitialized(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return getAditProjectInitializationStatus(projectRoot, env).initialized;
}

export function formatAditProjectNotInitializedMessage(command: string): string {
  return [
    "ADIT is not initialized in this project.",
    "",
    "Run:",
    "  adit init",
    "",
    "Then retry:",
    `  ${command}`,
  ].join("\n");
}

export function resolveGitOrWorkspaceProjectRoot(cwd?: string): string | null {
  const gitRoot = findGitRoot(cwd);
  if (gitRoot) return gitRoot;

  const projectRoot = resolveProjectRootPath(cwd);
  return readWorkspaceManifest(projectRoot) ? projectRoot : null;
}

function resolveProjectRootPath(cwd?: string): string {
  const candidate = cwd ?? process.cwd();
  if (isWindowsAbsolutePath(candidate)) return win32.resolve(candidate);
  return resolve(candidate);
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\[^\\]/u.test(path);
}

export function formatGitOrWorkspaceProjectRequiredMessage(): string {
  return "Not inside a git project or ADIT workspace. Run this from the project you want to connect.";
}

export function requireAditProjectInitialized(
  projectRoot: string,
  command: string,
): boolean {
  if (isAditProjectInitialized(projectRoot)) return true;
  console.error(formatAditProjectNotInitializedMessage(command));
  return false;
}

export function loadInitializedGitOrWorkspaceProjectConfig(
  command: string,
  cwd?: string,
): AditConfig | null {
  const projectRoot = resolveGitOrWorkspaceProjectRoot(cwd);
  if (!projectRoot) {
    console.error(formatGitOrWorkspaceProjectRequiredMessage());
    process.exitCode = 1;
    return null;
  }

  if (!requireAditProjectInitialized(projectRoot, command)) {
    process.exitCode = 1;
    return null;
  }

  return loadConfig(projectRoot);
}

export function loadInitializedProjectConfig(
  command: string,
  cwd?: string,
): AditConfig | null {
  const config = loadConfig(cwd);
  if (existsSync(config.dbPath)) return config;

  console.error(formatAditProjectNotInitializedMessage(command));
  process.exitCode = 1;
  return null;
}
