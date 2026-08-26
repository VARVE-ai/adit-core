/**
 * Local project manifest and repository resolution.
 *
 * A local ADIT project is defined by `.adit/project.json`, written only by
 * `adit init`. It records the project identity, the project type (single
 * repo or multi-repo workspace) and the explicit repository member list.
 * Every other command reads this manifest; nothing else may write it.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

export type ProjectType = "repo" | "workspace";

export interface ProjectManifestRepository {
  relativePath: string;
  /**
   * Persisted member-repository identity (workspace projects). Minted once
   * when the repository is registered and carried across directory renames —
   * never re-derived from the path at runtime. Absent on single-repo entries
   * (their identity is the project ID) and on manifests written before this
   * field existed; resolution falls back to the legacy derivation formula,
   * which produces the identical value, and the next init persists it.
   */
  repositoryId?: string;
  /**
   * Recorded remote URL — a non-authoritative hint used only by init to
   * recognize directory renames (old path gone, same remote, unique match).
   * Refreshed on every init write; link/sync always read the live git config.
   */
  repositoryUrl?: string | null;
}

export interface ProjectManifest {
  schemaVersion: 1;
  projectId: string;
  projectType: ProjectType;
  repositories: ProjectManifestRepository[];
  createdAt: string;
  updatedAt: string;
}

export interface LocalRepository {
  localRepositoryId: string;
  relativePath: string;
  displayName: string;
  repositoryUrl: string | null;
  canonicalRepoKey: string | null;
  path: string;
}

/** Legacy workspace manifest — read only by the init migration path. */
export interface WorkspaceManifest {
  workspaceId: string;
  createdAt: string;
}

/** The project manifest is unreadable or violates a hard validation rule. */
export class ProjectManifestError extends Error {
  constructor(
    message: string,
    public readonly manifestPath: string,
  ) {
    super(message);
    this.name = "ProjectManifestError";
  }
}

/** Another `adit init` is already writing the manifest. */
export class ProjectInitLockError extends Error {
  constructor(public readonly lockPath: string) {
    super("Another 'adit init' appears to be running for this project. Wait for it to finish and retry.");
    this.name = "ProjectInitLockError";
  }
}

export const projectManifestRelativePath = ".adit/project.json";
export const workspaceManifestRelativePath = ".adit/workspace.json";

const MANIFEST_SCHEMA_VERSION = 1;
const INIT_LOCK_STALE_MS = 10 * 60 * 1000;

export function projectManifestPath(projectRoot: string): string {
  return join(projectRoot, projectManifestRelativePath);
}

/** Generate a fresh project ID for a brand-new project. */
export function generateProjectId(): string {
  return randomUUID();
}

/**
 * Compute the legacy repo project ID from root and optional remote URL.
 *
 * Retained only for the init migration path (recovering the identity of a
 * pre-manifest single-repo project). New projects use `generateProjectId`.
 */
export function computeRepoProjectId(projectRoot: string, remoteUrl?: string | null): string {
  const input = remoteUrl ? `${remoteUrl}:${projectRoot}` : projectRoot;
  return hashId(input);
}

/**
 * Compute a stable repository ID within a local project.
 *
 * Frozen formula: the cloud registers repositories under unique keys derived
 * from these IDs, so the derivation must not change. Single-repo projects use
 * the project ID itself as the repository ID (see resolveManifestRepositories).
 */
export function computeLocalRepositoryId(
  localProjectId: string,
  relativePath: string,
  repositoryUrl?: string | null,
): string {
  const repoIdentity = repositoryUrl ? `${repositoryUrl}:${relativePath}` : relativePath;
  return hashId(`${localProjectId}:${repoIdentity}`);
}

/**
 * Read and hard-validate the project manifest.
 *
 * Returns null when the manifest file does not exist. Throws
 * ProjectManifestError when the file exists but is unreadable or violates a
 * hard rule — callers must stop and surface the problem, never fall back to
 * a guessed identity.
 */
export function readProjectManifest(projectRoot: string): ProjectManifest | null {
  const manifestPath = projectManifestPath(projectRoot);
  if (!existsSync(manifestPath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    throw new ProjectManifestError("Project manifest is not valid JSON.", manifestPath);
  }

  return validateManifest(parsed, manifestPath);
}

/** Validate a manifest object against the hard rules (schema and path safety). */
export function validateProjectManifest(manifest: ProjectManifest, projectRoot: string): ProjectManifest {
  return validateManifest(manifest, projectManifestPath(projectRoot));
}

/** Atomically write the project manifest. Only `adit init` may call this. */
export function writeProjectManifest(projectRoot: string, manifest: ProjectManifest): void {
  const manifestPath = projectManifestPath(projectRoot);
  validateManifest(manifest, manifestPath);

  mkdirSync(join(projectRoot, ".adit"), { recursive: true });
  const tempPath = `${manifestPath}.tmp-${process.pid}`;
  const fd = openSync(tempPath, "w");
  try {
    writeSync(fd, JSON.stringify(manifest, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, manifestPath);
}

/**
 * Run `fn` while holding the exclusive init lock for this project.
 *
 * A concurrent init fails fast with ProjectInitLockError instead of racing
 * on the manifest. A stale lock (older than 10 minutes, e.g. after a crash)
 * is removed and re-acquired.
 */
export async function withProjectInitLock<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(projectRoot, ".adit", "init.lock");
  mkdirSync(join(projectRoot, ".adit"), { recursive: true });
  acquireInitLock(lockPath);
  try {
    return await fn();
  } finally {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // best effort — a leftover lock is recovered via the stale check
    }
  }
}

/** Find the nearest ancestor directory containing a project manifest. */
export function findProjectManifestRoot(startDir?: string): string | null {
  let dir = resolve(startDir ?? process.cwd());
  while (true) {
    if (existsSync(projectManifestPath(dir))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Build the repository list from the manifest's explicit relative paths.
 *
 * Missing repository directories are kept (soft check — status/doctor/link
 * report them); a path that resolves outside the project root via symlinks is
 * a hard error.
 */
export function resolveManifestRepositories(
  projectRoot: string,
  manifest: ProjectManifest,
): LocalRepository[] {
  const manifestPath = projectManifestPath(projectRoot);
  return manifest.repositories.map((entry) => {
    const relativePath = entry.relativePath;
    const path = relativePath === "." ? resolve(projectRoot) : resolve(projectRoot, relativePath);
    assertInsideProjectRoot(projectRoot, path, relativePath, manifestPath);
    return {
      // Persistence first: a stored repositoryId survives directory renames.
      // The derivation formula is only the fallback for entries written
      // before the field existed (it yields the identical value).
      localRepositoryId:
        manifest.projectType === "repo"
          ? manifest.projectId
          : entry.repositoryId ?? computeLocalRepositoryId(manifest.projectId, relativePath),
      relativePath,
      displayName: relativePath === "." ? basename(resolve(projectRoot)) : basename(relativePath),
      repositoryUrl: null,
      canonicalRepoKey: null,
      path,
    };
  });
}

/**
 * Legacy traces of a pre-manifest project: an old workspace manifest or an
 * existing local database. Used to tell "needs migration" apart from "never
 * initialized".
 */
export function hasLegacyProjectTraces(projectRoot: string, dbPath: string): boolean {
  return existsSync(join(projectRoot, workspaceManifestRelativePath)) || existsSync(dbPath);
}

/** Read the legacy workspace manifest. Only the init migration path uses this. */
export function readWorkspaceManifest(projectRoot: string): WorkspaceManifest | null {
  const manifestPath = join(projectRoot, workspaceManifestRelativePath);
  if (!existsSync(manifestPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    const workspaceId = typeof parsed.workspaceId === "string" ? parsed.workspaceId.trim() : "";
    const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : "";
    if (!workspaceId) return null;
    return {
      workspaceId,
      createdAt: createdAt || new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Discover Git repositories in immediate child directories only.
 *
 * Init-time (and doctor read-only diff) tool — never used to decide project
 * membership at runtime. Hidden directories are excluded.
 */
export function discoverWorkspaceRepositories(projectRoot: string): Array<{
  path: string;
  relativePath: string;
  displayName: string;
}> {
  const entries = safeReadDir(projectRoot);
  const repos: Array<{ path: string; relativePath: string; displayName: string }> = [];

  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const childPath = join(projectRoot, entry);
    if (!safeIsDirectory(childPath)) continue;
    if (!existsSync(join(childPath, ".git"))) continue;

    repos.push({
      path: childPath,
      relativePath: normalizeRelativePath(relative(projectRoot, childPath)),
      displayName: basename(childPath),
    });
  }

  return repos.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function toRepositoryPayload(repository: LocalRepository): {
  localRepositoryId: string;
  relativePath: string;
  displayName: string;
  repositoryUrl?: string;
  canonicalRepoKey?: string;
} {
  return {
    localRepositoryId: repository.localRepositoryId,
    relativePath: repository.relativePath,
    displayName: repository.displayName,
    ...(repository.repositoryUrl ? { repositoryUrl: repository.repositoryUrl } : {}),
    ...(repository.canonicalRepoKey ? { canonicalRepoKey: repository.canonicalRepoKey } : {}),
  };
}

function validateManifest(parsed: unknown, manifestPath: string): ProjectManifest {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProjectManifestError("Project manifest must be a JSON object.", manifestPath);
  }
  const manifest = parsed as Record<string, unknown>;

  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new ProjectManifestError(
      `Unsupported project manifest schemaVersion: ${String(manifest.schemaVersion)}. This adit version supports version ${MANIFEST_SCHEMA_VERSION}.`,
      manifestPath,
    );
  }
  const projectId = typeof manifest.projectId === "string" ? manifest.projectId.trim() : "";
  if (!projectId) {
    throw new ProjectManifestError("Project manifest is missing projectId.", manifestPath);
  }
  const projectType = manifest.projectType;
  if (projectType !== "repo" && projectType !== "workspace") {
    throw new ProjectManifestError(
      `Project manifest has invalid projectType: ${String(projectType)}.`,
      manifestPath,
    );
  }
  if (!Array.isArray(manifest.repositories) || manifest.repositories.length === 0) {
    throw new ProjectManifestError("Project manifest must list at least one repository.", manifestPath);
  }

  const seen = new Set<string>();
  const seenRepositoryIds = new Set<string>();
  const repositories = manifest.repositories.map((entry) => {
    const record =
      typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    const relativePath = typeof record.relativePath === "string" ? record.relativePath : "";
    assertSafeRelativePath(relativePath, manifestPath);
    if (seen.has(relativePath)) {
      throw new ProjectManifestError(
        `Project manifest lists repository '${relativePath}' more than once.`,
        manifestPath,
      );
    }
    seen.add(relativePath);

    const repositoryId =
      typeof record.repositoryId === "string" && record.repositoryId.trim()
        ? record.repositoryId.trim()
        : undefined;
    if (repositoryId) {
      if (seenRepositoryIds.has(repositoryId)) {
        throw new ProjectManifestError(
          `Project manifest lists repositoryId '${repositoryId}' more than once.`,
          manifestPath,
        );
      }
      seenRepositoryIds.add(repositoryId);
    }
    const repositoryUrl =
      typeof record.repositoryUrl === "string" && record.repositoryUrl.trim()
        ? record.repositoryUrl.trim()
        : null;

    return {
      relativePath,
      ...(repositoryId ? { repositoryId } : {}),
      ...(repositoryUrl ? { repositoryUrl } : {}),
    };
  });

  if (projectType === "repo" && (repositories.length !== 1 || repositories[0].relativePath !== ".")) {
    throw new ProjectManifestError(
      "A single-repo project manifest must contain exactly one repository with relativePath '.'.",
      manifestPath,
    );
  }
  if (projectType === "workspace" && repositories.some((repo) => repo.relativePath === ".")) {
    throw new ProjectManifestError(
      "A multi-repo project manifest must not contain '.' — only immediate child directories.",
      manifestPath,
    );
  }

  const createdAt = typeof manifest.createdAt === "string" ? manifest.createdAt : "";
  const updatedAt = typeof manifest.updatedAt === "string" ? manifest.updatedAt : "";
  if (!createdAt || !updatedAt) {
    throw new ProjectManifestError("Project manifest is missing createdAt/updatedAt.", manifestPath);
  }

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    projectId,
    projectType,
    repositories,
    createdAt,
    updatedAt,
  };
}

function assertSafeRelativePath(relativePath: string, manifestPath: string): void {
  if (!relativePath) {
    throw new ProjectManifestError("Project manifest contains an empty repository path.", manifestPath);
  }
  const normalized = relativePath.replace(/\\/gu, "/");
  if (normalized !== relativePath) {
    throw new ProjectManifestError(
      `Repository path '${relativePath}' must use forward slashes.`,
      manifestPath,
    );
  }
  if (relativePath === ".") return;
  if (relativePath.startsWith("/") || /^[A-Za-z]:/u.test(relativePath)) {
    throw new ProjectManifestError(
      `Repository path '${relativePath}' must be relative to the project root.`,
      manifestPath,
    );
  }
  const segments = relativePath.split("/");
  if (segments.length !== 1) {
    throw new ProjectManifestError(
      `Repository path '${relativePath}' must be an immediate child directory.`,
      manifestPath,
    );
  }
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ProjectManifestError(
      `Repository path '${relativePath}' must not contain '.', '..' or empty segments.`,
      manifestPath,
    );
  }
}

function assertInsideProjectRoot(
  projectRoot: string,
  path: string,
  relativePath: string,
  manifestPath: string,
): void {
  if (!existsSync(path)) return; // missing repositories are a soft condition
  try {
    const realRoot = realpathSync(resolve(projectRoot));
    const realPath = realpathSync(path);
    if (realPath !== realRoot && !realPath.startsWith(realRoot + sep)) {
      throw new ProjectManifestError(
        `Repository path '${relativePath}' resolves outside the project root.`,
        manifestPath,
      );
    }
  } catch (err) {
    if (err instanceof ProjectManifestError) throw err;
    // realpath failures (e.g. permissions) fall through to soft checks
  }
}

function acquireInitLock(lockPath: string): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const age = lockAgeMs(lockPath);
      if (age !== null && age > INIT_LOCK_STALE_MS) {
        rmSync(lockPath, { force: true });
        continue;
      }
      throw new ProjectInitLockError(lockPath);
    }
  }
  throw new ProjectInitLockError(lockPath);
}

function lockAgeMs(lockPath: string): number | null {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

function hashId(input: string): string {
  return createHash("sha256").update(input).digest("hex").substring(0, 16);
}

function normalizeRelativePath(path: string): string {
  const normalized = path.replace(/\\/gu, "/");
  return normalized || ".";
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
