/**
 * ADIT configuration management.
 *
 * Loads config from environment variables with sensible defaults.
 * The data directory (.adit/) lives inside the project root by default.
 */

import { resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { getLocalClientId } from "../local-state.js";
import {
  deriveProjectType,
  findProjectManifestRoot,
  findRegisteringParent,
  hasLegacyProjectTraces,
  isRootRepositoryPath,
  readProjectManifest,
  resolveActiveManifestRepositories,
  type LocalRepository,
  type ProjectType,
} from "./project.js";

/**
 * How this directory relates to an ADIT project.
 *
 * - `initialized`: a valid project manifest was found — identity comes from it.
 * - `legacy`: no manifest, but traces of a pre-manifest project exist
 *   (old workspace.json or a local database). Needs `adit init` migration.
 * - `uninitialized`: no manifest and no traces — never initialized here.
 */
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
  /** Project identifier from the manifest. Empty when not initialized. */
  projectId: string;
  /** Derived project shape (see `deriveProjectType`); never read from disk. */
  projectType: ProjectType;
  /** Git repositories that belong to this local project (empty when not initialized) */
  repositories: LocalRepository[];
  /** Whole-project Cloud deletion tombstone mirrored into the manifest. */
  cloudDeletedAt: string | null;
  /** Whether a project manifest was found at the resolved root */
  initialization: ProjectInitializationState;
  /** Whether to capture environment snapshots */
  captureEnv: boolean;
}

/** Get or create a persistent client ID */
function getClientId(): string {
  return getLocalClientId();
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

/** Load file-based settings from settings.json in project root */
function loadSettingsFile(projectRoot: string): Record<string, unknown> {
  const settingsPath = join(projectRoot, "settings.json");
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Resolve the project root for the current location.
 *
 * Inside a Git repository: its own manifest wins. Without one (or when its
 * manifest was merged into a parent), a parent project that registers this
 * repository owns it — commands and hooks route to the parent. An
 * unregistered repository stays its own (uninitialized) root. Outside any Git
 * repository we walk up looking for the nearest manifest, so plain folders
 * inside a project resolve to the project.
 */
function resolveProjectRoot(cwd?: string): string {
  const envRoot = process.env.ADIT_PROJECT_ROOT;
  if (envRoot) return envRoot;

  const gitRoot = findGitRoot(cwd);
  if (gitRoot) {
    const own = readProjectManifest(gitRoot);
    if (own && !own.mergedIntoProjectId) return gitRoot;
    return findRegisteringParent(gitRoot)?.root ?? gitRoot;
  }

  return findProjectManifestRoot(cwd) ?? resolve(cwd ?? process.cwd());
}

/**
 * Load configuration from the project manifest + environment overrides.
 *
 * Identity (project ID, type, repository members) comes exclusively from
 * `.adit/project.json`. Without a manifest the config carries an
 * `initialization` state of `legacy` or `uninitialized` and an empty
 * identity — callers must gate on it before using projectId/repositories.
 *
 * Throws ProjectManifestError when a manifest exists but is damaged.
 */
export function loadConfig(cwd?: string): AditConfig {
  const projectRoot = resolveProjectRoot(cwd);

  const dataDir =
    process.env.ADIT_DATA_DIR ?? join(projectRoot, ".adit");

  const dbPath =
    process.env.ADIT_DB_PATH ?? join(dataDir, "adit.sqlite");

  const clientId =
    process.env.ADIT_CLIENT_ID ?? getClientId();

  const manifest = readProjectManifest(projectRoot);

  let initialization: ProjectInitializationState;
  let projectType: ProjectType;
  let projectId: string;
  let repositories: LocalRepository[];
  let cloudDeletedAt: string | null;

  if (manifest) {
    initialization = "initialized";
    projectType = deriveProjectType(manifest);
    projectId = manifest.projectId;
    repositories = resolveActiveManifestRepositories(projectRoot, manifest);
    cloudDeletedAt = manifest.cloudDeletedAt ?? null;
    const remoteUrl = process.env.ADIT_REMOTE_URL;
    const rootIndex = repositories.findIndex((repo) => isRootRepositoryPath(repo.relativePath));
    if (remoteUrl && rootIndex >= 0) {
      repositories[rootIndex] = { ...repositories[rootIndex], repositoryUrl: remoteUrl };
    }
  } else {
    initialization = hasLegacyProjectTraces(projectRoot, dbPath) ? "legacy" : "uninitialized";
    projectType = "repo";
    projectId = "";
    repositories = [];
    cloudDeletedAt = null;
  }

  // Load file-based settings (lowest priority — env vars override)
  const fileSettings = loadSettingsFile(projectRoot);

  return {
    projectRoot,
    dataDir,
    dbPath,
    clientId,
    projectId,
    projectType,
    repositories,
    cloudDeletedAt,
    initialization,
    captureEnv: process.env.ADIT_CAPTURE_ENV !== undefined
      ? process.env.ADIT_CAPTURE_ENV !== "false"
      : (fileSettings.captureEnv as boolean) ?? true,
  };
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
