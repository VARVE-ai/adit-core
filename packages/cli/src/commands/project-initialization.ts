import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type AditConfig } from "@varveai/adit-core";

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

export function requireAditProjectInitialized(
  projectRoot: string,
  command: string,
): boolean {
  if (isAditProjectInitialized(projectRoot)) return true;
  console.error(formatAditProjectNotInitializedMessage(command));
  return false;
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
