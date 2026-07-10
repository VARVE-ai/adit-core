/**
 * `adit config` — View and manage ADIT configuration.
 */

import type { AditConfig } from "@varveai/adit-core";
import { loadInitializedProjectConfig } from "./project-initialization.js";

/** `adit config` — show current config */
export async function configCommand(
  opts?: { json?: boolean },
): Promise<void> {
  const config = loadInitializedProjectConfig("adit config");
  if (!config) return;

  if (opts?.json) {
    console.log(JSON.stringify(configToPlain(config), null, 2));
    return;
  }

  console.log("ADIT Configuration\n");
  console.log(`  Project root:    ${config.projectRoot}`);
  console.log(`  Data directory:  ${config.dataDir}`);
  console.log(`  Database:        ${config.dbPath}`);
  console.log(`  Project ID:      ${config.projectId}`);
  console.log(`  Project type:    ${config.projectType}`);
  console.log(`  Repositories:    ${config.repositories.length}`);
  console.log(`  Client ID:       ${config.clientId}`);
  console.log(`  Capture env:     ${config.captureEnv}`);
}

function configToPlain(config: AditConfig): Record<string, unknown> {
  return {
    projectRoot: config.projectRoot,
    dataDir: config.dataDir,
    dbPath: config.dbPath,
    projectId: config.projectId,
    projectType: config.projectType,
    repositories: config.repositories,
    clientId: config.clientId,
    captureEnv: config.captureEnv,
  };
}
