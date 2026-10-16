/**
 * `adit project` — Project-level lifecycle commands.
 *
 * These commands manage ADIT's local footprint for the current git project,
 * above the lower-level per-platform hooks.
 */

import { existsSync, rmSync } from "node:fs";
import { deleteCheckpointRef, listCheckpointRefs } from "@varveai/adit-engine";
import { uninstallInstalledPlatformHooks } from "./plugin.js";
import { loadInitializedProjectConfig } from "./project-initialization.js";
import { marks } from "./cli-style.js";

export interface ProjectUninstallResult {
  ok: boolean;
  action: "project-uninstall";
  projectRoot: string;
  dataDir: string;
  uninstalled: string[];
  dataRemoved: boolean;
  checkpointRefsRemoved: number;
  errors?: string[];
}

export async function projectUninstallCommand(opts?: {
  yes?: boolean;
  json?: boolean;
}): Promise<void> {
  const config = loadInitializedProjectConfig("adit project uninstall");
  if (!config) return;

  if (!opts?.yes) {
    if (opts?.json) {
      console.log(JSON.stringify({
        ok: false,
        action: "project-uninstall",
        error: "--yes is required",
        projectRoot: config.projectRoot,
        dataDir: config.dataDir,
      }));
    } else {
      console.log();
      console.log("  This will uninstall ADIT from the current project.");
      console.log();
      console.log(`  Project:        ${config.projectRoot}`);
      console.log(`  Data directory: ${config.dataDir}`);
      console.log();
      console.log("  It will remove installed ADIT hooks and delete the local .adit/ data directory.");
      console.log();
      console.log("  Run with --yes to confirm.");
      console.log();
    }
    process.exitCode = 1;
    return;
  }

  const result = await uninstallProject(config.projectRoot, config.dataDir);

  if (opts?.json) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  console.log();
  for (const displayName of result.uninstalled) {
    console.log(`  ${marks.change} Removed ${displayName} hooks`);
  }
  if (result.uninstalled.length === 0) {
    console.log("  No ADIT hooks found to remove.");
  }
  if (result.dataRemoved) {
    console.log(`  ${marks.change} Removed data directory: ${result.dataDir}`);
  } else {
    console.log(`  ${marks.skip} Data directory not found: ${result.dataDir}`);
  }
  for (const err of result.errors ?? []) {
    console.error(`  ${marks.fail} ${err}`);
  }
  console.log();

  if (!result.ok) process.exitCode = 1;
}

export async function uninstallProject(
  projectRoot: string,
  dataDir: string,
): Promise<ProjectUninstallResult> {
  const errors: string[] = [];
  const hooksResult = await uninstallInstalledPlatformHooks(projectRoot);
  errors.push(...hooksResult.errors);

  let dataRemoved = false;
  if (existsSync(dataDir)) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      dataRemoved = true;
    } catch (err) {
      errors.push(`Failed to remove data directory: ${(err as Error).message}`);
    }
  }

  let checkpointRefsRemoved = 0;
  try {
    const refs = await listCheckpointRefs(projectRoot);
    for (const ref of refs) {
      if (await deleteCheckpointRef(projectRoot, ref.stepId)) {
        checkpointRefsRemoved++;
      } else {
        errors.push(`Failed to remove checkpoint ref: ${ref.stepId}`);
      }
    }
  } catch (err) {
    errors.push(`Failed to list checkpoint refs: ${(err as Error).message}`);
  }

  return {
    ok: errors.length === 0,
    action: "project-uninstall",
    projectRoot,
    dataDir,
    uninstalled: hooksResult.uninstalled,
    dataRemoved,
    checkpointRefsRemoved,
    errors: errors.length > 0 ? errors : undefined,
  };
}
