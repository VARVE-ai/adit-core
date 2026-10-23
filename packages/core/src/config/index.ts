/** Compatibility config shape backed exclusively by the shared registry. */
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { getLocalClientId, localDataDir } from "../local-state.js";
import { resolveLocalProject, projectRuntimeDirectory } from "../project-resolution.js";
import type { LocalRepository, ProjectType } from "./project.js";
export type ProjectInitializationState = "initialized" | "legacy" | "uninitialized";

export interface AditConfig {
  /** Project root directory. For workspace projects this is the workspace root. */
  projectRoot: string;
  /** Data directory for ADIT state */
  dataDir: string;
  /** SQLite database path */
  dbPath: string;
  /** Unique client identifier for this machine */
  clientId: string;
  /** Project identifier from the shared registry. */
  projectId: string;
  /** Derived project shape (see `deriveProjectType`); never read from disk. */
  projectType: ProjectType;
  /** Git repositories that belong to this local project (empty when not initialized) */
  repositories: LocalRepository[];
  /** Whole-project Cloud deletion tombstone in the shared registry. */
  cloudDeletedAt: string | null;
  /** Registry initialization status */
  initialization: ProjectInitializationState;
  /** Compatibility field; native collection does not capture environment snapshots */
  captureEnv: boolean;
}

/** Extract the project directory name from a root path, regardless of platform separators. */
export function projectNameFromRoot(projectRoot: string): string {
  const trimmed = projectRoot.trim().replace(/[\\/]+$/u, "");
  if (!trimmed) return "";

  const segments = trimmed.split(/[\\/]+/u);
  const name = segments.at(-1) ?? "";
  return /^[A-Za-z]:$/u.test(name) ? "" : name;
}

/** Find the git root by walking up from cwd */
export function findGitRoot(startDir?: string): string | null {
  let dir = resolve(startDir ?? process.cwd());
  while (true) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadConfig(cwd?:string):AditConfig {
  const project=resolveLocalProject({path:cwd});
  return {projectRoot:project.projectRoot,projectId:project.projectId,repositories:project.repositories,
    projectType:project.repositories.length===1&&project.repositories[0].relativePath==="."?"repo":"workspace",
    dataDir:projectRuntimeDirectory(project.projectId),dbPath:join(localDataDir(),"local.sqlite"),
    clientId:getLocalClientId(),initialization:"initialized",cloudDeletedAt:project.cloudDeletedAt,captureEnv:false};
}
/** Redact sensitive keys from an object (shallow) */
export function redactSensitiveKeys(
  obj: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lowerKeys = new Set(keys.map((k) => k.toLowerCase()));

  for (const [key, value] of Object.entries(obj)) {
    if (lowerKeys.has(key.toLowerCase())) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = redactSensitiveKeys(
        value as Record<string, unknown>,
        keys,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}
