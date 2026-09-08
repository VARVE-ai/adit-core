/**
 * Project layout analysis for `adit init`.
 *
 * Answers two questions before anything is written: which directory is this
 * init run about, and which Git repositories (the root itself and its
 * immediate children) it could register. Only init consumes this — the
 * analysis never feeds runtime config.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  discoverWorkspaceRepositories,
  findGitRoot,
  findProjectManifestRoot,
  findRegisteringParent,
  readProjectManifest,
} from "@varveai/adit-core";
import { getHeadSha, getRemoteUrl } from "@varveai/adit-engine";

export type InitRootReason = "git-root" | "manifest-root" | "container" | "none";

export interface InitRootResolution {
  root: string;
  reason: InitRootReason;
}

/** A child directory that already carries its own ADIT project. */
export interface ChildProjectInfo {
  projectId: string;
  createdAt: string;
  /** Present when that project was already merged into some parent. */
  mergedIntoProjectId: string | null;
  cloudDeletedAt: string | null;
}

export interface ProjectLayoutAnalysis {
  root: {
    path: string;
    isGitRepository: boolean;
    hasHead: boolean;
    originUrl: string | null;
    /** The parent project that registers this root as one of its repositories. */
    registeredBy: { root: string; relativePath: string } | null;
  };
  childRepositories: Array<{
    path: string;
    relativePath: string;
    displayName: string;
    originUrl: string | null;
    existingProject: ChildProjectInfo | null;
  }>;
}

/**
 * Resolve which directory this init run initializes.
 *
 * The enclosing Git repository always wins — running init inside a member
 * repository of an initialized parent means "initialize this repository as
 * its own project", never "re-initialize the parent". Only outside any Git
 * repository do we fall back to the nearest manifest (re-init) or treat the
 * directory as a multi-repo container candidate.
 */
export function resolveInitRoot(cwd: string): InitRootResolution {
  const gitRoot = findGitRoot(cwd);
  if (gitRoot) return { root: gitRoot, reason: "git-root" };

  const manifestRoot = findProjectManifestRoot(cwd);
  if (manifestRoot) return { root: manifestRoot, reason: "manifest-root" };

  const candidate = resolve(cwd);
  if (discoverWorkspaceRepositories(candidate).length > 0) {
    return { root: candidate, reason: "container" };
  }
  return { root: candidate, reason: "none" };
}

/** Inspect the init root and its immediate child repositories. */
export async function analyzeProjectLayout(root: string): Promise<ProjectLayoutAnalysis> {
  const isGitRepository = existsSync(join(root, ".git"));
  const hasHead = isGitRepository ? (await getHeadSha(root)) !== null : false;
  const originUrl = isGitRepository ? await getRemoteUrl(root) : null;

  const childRepositories = await Promise.all(
    discoverWorkspaceRepositories(root).map(async (child) => ({
      ...child,
      originUrl: await getRemoteUrl(child.path),
      existingProject: readChildProject(child.path),
    })),
  );
  const parent = isGitRepository ? findRegisteringParent(root) : null;

  return {
    root: {
      path: root,
      isGitRepository,
      hasHead,
      originUrl,
      registeredBy: parent ? { root: parent.root, relativePath: parent.relativePath } : null,
    },
    childRepositories,
  };
}

function readChildProject(path: string): ChildProjectInfo | null {
  try {
    const manifest = readProjectManifest(path);
    if (!manifest) return null;
    return {
      projectId: manifest.projectId,
      createdAt: manifest.createdAt,
      mergedIntoProjectId: manifest.mergedIntoProjectId ?? null,
      cloudDeletedAt: manifest.cloudDeletedAt ?? null,
    };
  } catch {
    return null; // a damaged child manifest is reported when init runs there
  }
}
