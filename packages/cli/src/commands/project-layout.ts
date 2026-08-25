/**
 * Project layout analysis for `adit init`.
 *
 * Answers two questions before anything is written: which directory is this
 * init run about (5.1 in the plan), and what project shape does the layout
 * suggest (the 5.2 recommendation matrix). Only init consumes this — the
 * analysis never feeds runtime config.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  discoverWorkspaceRepositories,
  findGitRoot,
  findProjectManifestRoot,
} from "@varveai/adit-core";
import { getHeadSha, getRemoteUrl } from "@varveai/adit-engine";

export type InitRootReason = "git-root" | "manifest-root" | "container" | "none";

export interface InitRootResolution {
  root: string;
  reason: InitRootReason;
}

export type LayoutRecommendation =
  | "single-repo"
  | "multi-repo"
  | "choose-child"
  | "choose-explicit"
  | "cannot-initialize";

export interface ProjectLayoutAnalysis {
  root: {
    path: string;
    isGitRepository: boolean;
    hasHead: boolean;
    originUrl: string | null;
  };
  childRepositories: Array<{
    path: string;
    relativePath: string;
    displayName: string;
    originUrl: string | null;
  }>;
  recommendation: LayoutRecommendation;
  requiresConfirmation: boolean;
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

/** Inspect the init root and its immediate children, then apply the 5.2 matrix. */
export async function analyzeProjectLayout(root: string): Promise<ProjectLayoutAnalysis> {
  const isGitRepository = existsSync(join(root, ".git"));
  const hasHead = isGitRepository ? (await getHeadSha(root)) !== null : false;
  const originUrl = isGitRepository ? await getRemoteUrl(root) : null;

  const childRepositories = await Promise.all(
    discoverWorkspaceRepositories(root).map(async (child) => ({
      ...child,
      originUrl: await getRemoteUrl(child.path),
    })),
  );

  const { recommendation, requiresConfirmation } = recommend({
    isGitRepository,
    hasHead,
    hasOrigin: originUrl !== null,
    childCount: childRepositories.length,
  });

  return {
    root: { path: root, isGitRepository, hasHead, originUrl },
    childRepositories,
    recommendation,
    requiresConfirmation,
  };
}

function recommend(input: {
  isGitRepository: boolean;
  hasHead: boolean;
  hasOrigin: boolean;
  childCount: number;
}): { recommendation: LayoutRecommendation; requiresConfirmation: boolean } {
  const { isGitRepository, hasHead, hasOrigin, childCount } = input;

  if (isGitRepository && hasOrigin) {
    return { recommendation: "single-repo", requiresConfirmation: childCount > 0 };
  }
  if (isGitRepository && hasHead) {
    // A meta repository: real commits but no remote. With child repositories
    // present the layout is ambiguous — never pick a default.
    if (childCount > 0) return { recommendation: "choose-explicit", requiresConfirmation: true };
    return { recommendation: "single-repo", requiresConfirmation: false };
  }
  if (isGitRepository) {
    // Empty repository (no commits, no remote) — likely a container marker.
    if (childCount >= 2) return { recommendation: "multi-repo", requiresConfirmation: true };
    if (childCount === 1) return { recommendation: "choose-child", requiresConfirmation: true };
    return { recommendation: "single-repo", requiresConfirmation: false };
  }
  if (childCount > 0) {
    return { recommendation: "multi-repo", requiresConfirmation: true };
  }
  return { recommendation: "cannot-initialize", requiresConfirmation: false };
}
