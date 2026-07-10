/**
 * Local project and repository discovery.
 *
 * A local ADIT project can be a single Git repository or a workspace root
 * containing one or more Git repositories in its immediate child directories.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";

export type ProjectType = "repo" | "workspace";

export interface WorkspaceManifest {
  workspaceId: string;
  createdAt: string;
}

export interface LocalRepository {
  localRepositoryId: string;
  relativePath: string;
  displayName: string;
  repositoryUrl: string | null;
  canonicalRepoKey: string | null;
  path: string;
}

export interface LocalProjectDescriptor {
  projectType: ProjectType;
  localProjectId: string;
  projectRoot: string;
  repositories: LocalRepository[];
}

export const workspaceManifestRelativePath = ".adit/workspace.json";

/** Compute the legacy repo project ID from root and optional remote URL. */
export function computeRepoProjectId(projectRoot: string, remoteUrl?: string | null): string {
  const input = remoteUrl ? `${remoteUrl}:${projectRoot}` : projectRoot;
  return hashId(input);
}

/** Compute a stable repository ID within a local project. */
export function computeLocalRepositoryId(
  localProjectId: string,
  relativePath: string,
  repositoryUrl?: string | null,
): string {
  const repoIdentity = repositoryUrl ? `${repositoryUrl}:${relativePath}` : relativePath;
  return hashId(`${localProjectId}:${repoIdentity}`);
}

export function workspaceManifestPath(projectRoot: string): string {
  return join(projectRoot, workspaceManifestRelativePath);
}

export function hasWorkspaceManifest(projectRoot: string): boolean {
  return existsSync(workspaceManifestPath(projectRoot));
}

export function readWorkspaceManifest(projectRoot: string): WorkspaceManifest | null {
  const manifestPath = workspaceManifestPath(projectRoot);
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

export function ensureWorkspaceManifest(projectRoot: string): WorkspaceManifest {
  const existing = readWorkspaceManifest(projectRoot);
  if (existing) return existing;

  const manifest: WorkspaceManifest = {
    workspaceId: hashId(`workspace:${resolve(projectRoot)}:${Date.now()}`),
    createdAt: new Date().toISOString(),
  };

  const manifestPath = workspaceManifestPath(projectRoot);
  mkdirSync(join(projectRoot, ".adit"), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  return manifest;
}

/** Find the nearest ancestor containing a workspace manifest. */
export function findWorkspaceRoot(startDir?: string): string | null {
  let dir = resolve(startDir ?? process.cwd());
  while (true) {
    if (readWorkspaceManifest(dir)) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Discover Git repositories in immediate child directories only. */
export function discoverWorkspaceRepositories(projectRoot: string): Array<{
  path: string;
  relativePath: string;
  displayName: string;
}> {
  const entries = safeReadDir(projectRoot);
  const repos: Array<{ path: string; relativePath: string; displayName: string }> = [];

  for (const entry of entries) {
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

export function createRepoRepository(
  projectRoot: string,
  projectId: string,
  remoteUrl?: string | null,
  canonicalRepoKey?: string | null,
): LocalRepository {
  return {
    localRepositoryId: projectId,
    relativePath: ".",
    displayName: basename(projectRoot),
    repositoryUrl: remoteUrl ?? null,
    canonicalRepoKey: canonicalRepoKey ?? null,
    path: projectRoot,
  };
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
