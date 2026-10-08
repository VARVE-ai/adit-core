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
import { commandLabel, printError, strong } from "./cli-style.js";

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

/** The shared-format failure for a project that cannot run `command` yet. */
export function describeProjectGuardFailure(
  state: Exclude<AditProjectGuardState, "initialized">,
  command: string,
  detail?: string,
): { reason: string; hint: string } {
  const retry = `then retry ${strong(command)}`;
  switch (state) {
    case "needs-repair":
      return { reason: "this project's local database is missing", hint: `run ${strong("adit init")} to rebuild it (the project identity is kept), ${retry}` };
    case "legacy":
      return { reason: "this project needs a one-time migration; recording is paused until it runs", hint: `run ${strong("adit init")} (identity, cloud project and history are kept), ${retry}` };
    case "corrupt":
      return { reason: `ADIT project configuration is damaged: ${detail ?? "unreadable"}`, hint: `restore .adit/project.json from a backup, or run ${strong("adit init")} to rebuild it` };
    case "uninitialized":
      return { reason: "ADIT is not initialized in this project", hint: `run ${strong("adit init")}, ${retry}` };
  }
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
      const failure = describeProjectGuardFailure("corrupt", command, err.message);
      printError(commandLabel(command), failure.reason, failure.hint);
      process.exitCode = 1;
      return null;
    }
    throw err;
  }

  const state = classifyProjectGuardState(config);
  if (state === "initialized") return config;
  const failure = describeProjectGuardFailure(state, command);
  printError(commandLabel(command), failure.reason, failure.hint);
  process.exitCode = 1;
  return null;
}
