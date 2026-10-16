/**
 * `adit config` — View and manage ADIT configuration.
 */

import { existsSync, statSync } from "node:fs";
import { basename, relative } from "node:path";
import { projectManifestPath, readProjectManifest, type AditConfig } from "@varveai/adit-core";
import { dim, formatBytes, joinParts, printEnd, printRows, printTitle, strong } from "./cli-style.js";
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

  const root = config.projectRoot;
  const inProject = (path: string) => {
    const relativePath = relative(root, path);
    return relativePath && !relativePath.startsWith("..") ? relativePath : path;
  };
  const entries = readProjectManifest(root)?.repositories ?? [];
  const repositories = entries.map((entry) => {
    const name = entry.relativePath === "." ? "./" : entry.relativePath;
    const state = entry.cloudDeletedAt ? "deleted in Cloud" : entry.syncEnabled === false ? "not synced" : null;
    return state ? `${name} ${dim(`(${state})`)}` : name;
  });
  const databaseSize = existsSync(config.dbPath) ? formatBytes(statSync(config.dbPath).size) : null;

  printTitle("Config", basename(root));
  printRows([
    { label: "Project root", value: strong(root) },
    { label: "Manifest", value: inProject(projectManifestPath(root)) },
    { label: "Data directory", value: inProject(config.dataDir) },
    { label: "Database", value: joinParts([inProject(config.dbPath), databaseSize && dim(databaseSize)]) },
    { label: "Project ID", value: config.projectId },
    { label: "Client ID", value: config.clientId },
    { label: "Repositories", value: repositories.length > 0 ? repositories.join(", ") : "-" },
    { label: "Capture env", value: config.captureEnv ? "yes" : "no" },
  ]);
  printEnd();
}

function configToPlain(config: AditConfig): Record<string, unknown> {
  return {
    projectRoot: config.projectRoot,
    manifestPath: projectManifestPath(config.projectRoot),
    dataDir: config.dataDir,
    dbPath: config.dbPath,
    projectId: config.projectId,
    projectType: config.projectType,
    repositories: config.repositories,
    clientId: config.clientId,
    captureEnv: config.captureEnv,
  };
}
