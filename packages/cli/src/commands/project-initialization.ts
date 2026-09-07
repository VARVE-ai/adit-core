/**
 * Initialization guards shared by every command except `adit init`.
 *
 * "Initialized" has exactly one authority: a valid `.adit/project.json` at
 * the resolved project root. Legacy traces (old workspace.json or a local
 * database without a manifest) mean "needs migration"; a manifest without a
 * database means "needs repair". Both point the user at `adit init`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ProjectManifestError,
  loadConfig,
  type AditConfig,
} from "@varveai/adit-core";

export interface AditProjectInitializationPaths {
  dataDir: string;
  dbPath: string;
}

export type AditProjectGuardState =
  | "initialized"
  | "needs-repair"
  | "legacy"
  | "uninitialized"
  | "corrupt";

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

export function formatAditProjectLegacyMessage(command: string): string {
  return [
    "ADIT has been upgraded and this project needs a one-time migration.",
    "Recording is paused until the migration runs.",
    "",
    "Run:",
    "  adit init",
    "",
    "Your project identity, cloud project and history are preserved.",
    "",
    "Then retry:",
    `  ${command}`,
  ].join("\n");
}

export function formatAditProjectNeedsRepairMessage(command: string): string {
  return [
    "This project's local database is missing.",
    "",
    "Run:",
    "  adit init",
    "",
    "to rebuild it (the project identity is kept). Then retry:",
    `  ${command}`,
  ].join("\n");
}

export function formatAditProjectCorruptMessage(reason: string): string {
  return [
    `ADIT project configuration is damaged: ${reason}`,
    "",
    "Restore .adit/project.json from a backup, or run 'adit init' to rebuild it —",
    "the project identity is recovered from local data when possible.",
  ].join("\n");
}

export function classifyProjectGuardState(config: AditConfig): AditProjectGuardState {
  if (config.initialization === "initialized") {
    return existsSync(config.dbPath) ? "initialized" : "needs-repair";
  }
  return config.initialization;
}

/**
 * Load the config for a command that requires an initialized project.
 *
 * Prints the appropriate guidance and sets a non-zero exit code when the
 * project is uninitialized, awaiting migration, damaged, or missing its
 * database. Returns null in those cases.
 */
export function loadInitializedProjectConfig(
  command: string,
  cwd?: string,
): AditConfig | null {
  let config: AditConfig;
  try {
    config = loadConfig(cwd);
  } catch (err) {
    if (err instanceof ProjectManifestError) {
      console.error(formatAditProjectCorruptMessage(err.message));
      process.exitCode = 1;
      return null;
    }
    throw err;
  }

  switch (classifyProjectGuardState(config)) {
    case "initialized":
      return config;
    case "needs-repair":
      console.error(formatAditProjectNeedsRepairMessage(command));
      break;
    case "legacy":
      console.error(formatAditProjectLegacyMessage(command));
      break;
    case "uninitialized":
      console.error(formatAditProjectNotInitializedMessage(command));
      break;
    case "corrupt":
      break; // unreachable — corruption throws from loadConfig
  }
  process.exitCode = 1;
  return null;
}
