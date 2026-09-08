/**
 * Manifest planning for `adit init`.
 *
 * Decides — together with the user — what `.adit/project.json` should say,
 * then writes it atomically under the init lock. A project is "this
 * directory plus the Git repositories registered under it": the root itself
 * (`.`) when it is a repository, and any immediate child repositories. There
 * is no project type to choose; init only decides which repositories are
 * registered and which of them sync to Cloud.
 *
 * Covers fresh initialization, migration of pre-manifest projects (identity
 * is carried over, never regenerated), schema upgrades, re-init diffs, and
 * the member-repository notice.
 */

import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  MANIFEST_SCHEMA_VERSION,
  ProjectManifestError,
  computeLocalRepositoryId,
  computeRepoProjectId,
  generateProjectId,
  isRootRepositoryPath,
  openDatabase,
  closeDatabase,
  readProjectManifest,
  readWorkspaceManifest,
  withProjectInitLock,
  workspaceManifestRelativePath,
  writeProjectManifest,
  type ProjectManifest,
  type ProjectManifestRepository,
} from "@varveai/adit-core";
import type { ProjectLayoutAnalysis } from "./project-layout.js";
import { getAditProjectInitializationPaths } from "./project-initialization.js";
import {
  applyRepositorySelection,
  promptRepositorySelection,
} from "./init-repository-select.js";
import {
  AbsorbPreconditionError,
  clearMergedMarker,
  collectChildProjects,
  markMergedInto,
  moveProjectRootUp,
  pickAbsorbTarget,
  promptAbsorbTarget,
  type AbsorbedProject,
  type ChildProject,
} from "./init-absorb.js";

export interface InitModeFlags {
  /** Shortcut: sync only the root repository (`.`). */
  singleRepo?: boolean;
  /** Shortcut: sync every child repository; on re-init also apply list changes without asking. */
  multiRepo?: boolean;
  /** Explicit list of repository paths to sync (`.` for the root). */
  repos?: string[];
  /** Split this repository out of the parent project that registers it. */
  detach?: boolean;
  /** Move an already initialized child project's root up here without asking. */
  absorb?: boolean;
}

export type ManifestPlanResult =
  | {
      status: "written";
      manifest: ProjectManifest;
      migratedFrom: string | null;
      /** Member directories whose hooks must record into this project. */
      hookRoots?: string[];
    }
  | { status: "unchanged"; manifest: ProjectManifest }
  /** This repository belongs to a parent project; nothing was written. */
  | { status: "member"; parentRoot: string; relativePath: string }
  | { status: "cancelled" }
  | { status: "failed" };

/** A Git repository that may be registered under the init root. */
export interface RepositoryCandidate {
  relativePath: string;
  path: string;
  displayName: string;
  originUrl: string | null;
}

/** Plan and (when needed) write the project manifest for this init run. */
export async function prepareProjectManifest(
  root: string,
  analysis: ProjectLayoutAnalysis,
  flags: InitModeFlags,
): Promise<ManifestPlanResult> {
  if (flags.singleRepo && flags.multiRepo) {
    console.error("  [x] --single-repo and --multi-repo cannot be combined.");
    return { status: "failed" };
  }

  let existing: ProjectManifest | null;
  try {
    existing = readProjectManifest(root);
  } catch (err) {
    if (!(err instanceof ProjectManifestError)) throw err;
    const rebuilt = await confirmManifestRebuild(err);
    if (!rebuilt) return { status: "failed" };
    rmSync(err.manifestPath, { force: true });
    existing = null;
  }

  // A repository registered by a parent project is part of that project.
  // Only --detach turns it back into a project of its own.
  const registeredBy = analysis.root.registeredBy;
  if (registeredBy && (!existing || existing.mergedIntoProjectId)) {
    if (!flags.detach) {
      return { status: "member", parentRoot: registeredBy.root, relativePath: registeredBy.relativePath };
    }
    await detachFromParent(root, registeredBy);
    if (existing?.mergedIntoProjectId) {
      clearMergedMarker(root);
      existing = readProjectManifest(root);
    }
  }

  if (existing) {
    return reinitExistingManifest(root, existing, analysis, flags);
  }
  return initFreshManifest(root, analysis, flags);
}

/** Remove this repository from the parent manifest that registers it. */
async function detachFromParent(
  root: string,
  registeredBy: { root: string; relativePath: string },
): Promise<void> {
  const parent = readProjectManifest(registeredBy.root);
  if (!parent) return;
  const repositories = parent.repositories.filter(
    (entry) => entry.relativePath !== registeredBy.relativePath,
  );
  if (repositories.length === parent.repositories.length) return;
  if (repositories.length === 0) {
    console.log(`  [!] ${registeredBy.relativePath} was the only repository of the project at ${registeredBy.root}; that project still lists it until you run 'adit init' there.`);
  }
  const { projectType: _legacyType, ...rest } = parent;
  void _legacyType;
  await withProjectInitLock(registeredBy.root, async () =>
    writeProjectManifest(registeredBy.root, {
      ...rest,
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      repositories: repositories.length > 0 ? repositories : parent.repositories,
      updatedAt: new Date().toISOString(),
    }),
  );
  console.log(`  [~] Detached ${basename(root)} from the project at ${registeredBy.root}.`);
}

// --- Candidates and default selection ---------------------------------------

/**
 * Every repository the layout offers: the root itself when it is a Git
 * repository, followed by the immediate child repositories.
 */
export function buildRepositoryCandidates(analysis: ProjectLayoutAnalysis): RepositoryCandidate[] {
  const candidates: RepositoryCandidate[] = [];
  if (analysis.root.isGitRepository) {
    candidates.push({
      relativePath: ".",
      path: analysis.root.path,
      displayName: basename(analysis.root.path),
      originUrl: analysis.root.originUrl,
    });
  }
  for (const child of analysis.childRepositories) {
    candidates.push({
      relativePath: child.relativePath,
      path: child.path,
      displayName: child.displayName,
      originUrl: child.originUrl,
    });
  }
  return candidates;
}

/**
 * Which candidates sync by default.
 *
 * A root repository with a remote is the project; child repositories are
 * offered but not synced unless the user picks them. A root without a remote
 * (an empty marker repository or a meta repository) cannot be shared, so the
 * children are synced instead. Without a root repository every child syncs.
 */
export function defaultRepositorySelection(
  analysis: ProjectLayoutAnalysis,
  candidates: RepositoryCandidate[],
): Set<string> {
  const hasRoot = analysis.root.isGitRepository;
  const children = candidates.filter((candidate) => !isRootRepositoryPath(candidate.relativePath));
  if (!hasRoot) return new Set(children.map((child) => child.relativePath));
  if (analysis.root.originUrl || children.length === 0) return new Set(["."]);
  return new Set(children.map((child) => child.relativePath));
}

type FlagSelection =
  | { kind: "none" }
  | { kind: "select"; paths: Set<string> }
  | { kind: "failed" };

function resolveFlagSelection(
  flags: InitModeFlags,
  analysis: ProjectLayoutAnalysis,
  candidates: RepositoryCandidate[],
): FlagSelection {
  const children = candidates.filter((candidate) => !isRootRepositoryPath(candidate.relativePath));

  if (flags.repos && flags.repos.length > 0) {
    const known = new Set(candidates.map((candidate) => candidate.relativePath));
    const paths = new Set<string>();
    for (const raw of flags.repos) {
      const normalized = normalizeRepoFlag(raw);
      if (!known.has(normalized)) {
        console.error(`  [x] --repos: '${raw}' is not a Git repository at this project root.`);
        console.error(`      Available: ${[...known].join(", ")}`);
        return { kind: "failed" };
      }
      paths.add(normalized);
    }
    return { kind: "select", paths };
  }
  if (flags.singleRepo) {
    if (!analysis.root.isGitRepository) {
      console.error("  [x] --single-repo requires the project root to be a Git repository.");
      return { kind: "failed" };
    }
    return { kind: "select", paths: new Set(["."]) };
  }
  if (flags.multiRepo) {
    if (children.length === 0) {
      console.error("  [x] --multi-repo requires at least one child Git repository.");
      return { kind: "failed" };
    }
    return { kind: "select", paths: new Set(children.map((child) => child.relativePath)) };
  }
  return { kind: "none" };
}

function normalizeRepoFlag(raw: string): string {
  const trimmed = raw.trim().replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  return trimmed === "" ? "." : trimmed;
}

// --- Fresh initialization / migration ----------------------------------------

async function initFreshManifest(
  root: string,
  analysis: ProjectLayoutAnalysis,
  flags: InitModeFlags,
): Promise<ManifestPlanResult> {
  const candidates = buildRepositoryCandidates(analysis);
  if (candidates.length === 0) {
    console.error("  [x] Not a Git repository, and no Git repositories were found one level below.");
    console.error("      Run 'git init' first, or run this from a directory that contains repositories.");
    return { status: "failed" };
  }

  const flagSelection = resolveFlagSelection(flags, analysis, candidates);
  if (flagSelection.kind === "failed") return { status: "failed" };

  if (candidates.length > 1) printRepositoryCandidates(analysis, candidates);

  // Child repositories that are already projects: move one of them up (its
  // identity becomes this project's), mark the rest as merged.
  const childProjects = collectChildProjects(analysis);
  let absorbed: { target: ChildProject; result: AbsorbedProject } | null = null;
  const hookRoots: string[] = [];
  if (childProjects.length > 0) {
    const target = flags.absorb
      ? pickAbsorbTarget(childProjects)
      : isInteractive()
        ? await promptAbsorbTarget(childProjects)
        : null;
    if (target) {
      try {
        absorbed = { target, result: moveProjectRootUp(root, target) };
      } catch (err) {
        if (!(err instanceof AbsorbPreconditionError)) throw err;
        console.error(`  [x] ${err.message}`);
        return { status: "failed" };
      }
      console.log(`  [~] Moved .adit from ${target.relativePath}/ to ./ (project ID ${target.projectId} kept).`);
      console.log(`  [~] Repository ${target.relativePath}: path ./ → ${target.relativePath} (repository ID kept).`);
      hookRoots.push(target.path);
    } else if (!isInteractive() && !flags.absorb) {
      for (const project of childProjects) {
        console.log(`  [!] ${project.relativePath} is already an ADIT project; registered but not synced here.`);
      }
      console.log("      Re-run 'adit init --absorb' to move its project root up to this directory.");
    }
  }

  const recovered = absorbed ? null : recoverLegacyProjectId(root);
  const projectId = absorbed?.result.projectId ?? recovered?.projectId ?? generateProjectId();
  const now = new Date().toISOString();
  const selection =
    flagSelection.kind === "select"
      ? flagSelection.paths
      : defaultRepositorySelection(analysis, candidates);
  if (absorbed && flagSelection.kind === "none") selection.add(absorbed.target.relativePath);

  let repositories = candidates.map((candidate) => {
    if (absorbed && candidate.relativePath === absorbed.target.relativePath) {
      const entry = absorbed.result.rootEntry;
      return {
        ...entry,
        ...(selection.has(candidate.relativePath) ? {} : { syncEnabled: false }),
        ...(candidate.originUrl ? { repositoryUrl: candidate.originUrl } : {}),
      };
    }
    const otherProject = childProjects.find((project) => project.relativePath === candidate.relativePath);
    if (otherProject) {
      // Keep the child project's repository identity so the Cloud recognizes
      // the repository. When it is merged into this project it follows the
      // normal selection; while it stays an independent project it is synced
      // only on explicit request.
      const enabled = absorbed
        ? selection.has(candidate.relativePath)
        : flagSelection.kind === "select" && selection.has(candidate.relativePath);
      return toManifestEntry(projectId, candidate, enabled, {
        relativePath: candidate.relativePath,
        repositoryId: otherProject.projectId,
      });
    }
    return toManifestEntry(projectId, candidate, selection.has(candidate.relativePath));
  });
  if (flagSelection.kind === "none" && candidates.length > 1 && isInteractive()) {
    console.log();
    repositories = await promptRepositorySelection(repositories);
  }

  const manifest: ProjectManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    projectId,
    repositories,
    createdAt: absorbed?.result.createdAt ?? now,
    updatedAt: now,
  };

  await withProjectInitLock(root, async () => {
    writeProjectManifest(root, manifest);
    const legacyWorkspaceManifest = join(root, workspaceManifestRelativePath);
    if (existsSync(legacyWorkspaceManifest)) {
      rmSync(legacyWorkspaceManifest, { force: true });
      console.log("  [~] Removed legacy workspace.json (migrated into project.json).");
    }
  });

  if (absorbed) {
    for (const project of childProjects) {
      if (project.relativePath === absorbed.target.relativePath) continue;
      markMergedInto(project.path, projectId);
      hookRoots.push(project.path);
      console.log(`  [~] ${project.relativePath} keeps its local history and now records into this project.`);
    }
  }

  return {
    status: "written",
    manifest,
    migratedFrom: recovered?.source ?? null,
    ...(hookRoots.length > 0 ? { hookRoots } : {}),
  };
}

function toManifestEntry(
  projectId: string,
  candidate: RepositoryCandidate,
  enabled: boolean,
  previous?: ProjectManifestRepository,
): ProjectManifestRepository {
  const root = isRootRepositoryPath(candidate.relativePath);
  return {
    relativePath: candidate.relativePath,
    // The root repository is identified by the project ID; only member
    // repositories carry a persisted identity and a remote hint.
    ...(root ? {} : { repositoryId: previous?.repositoryId ?? computeLocalRepositoryId(projectId, candidate.relativePath) }),
    ...(enabled ? {} : { syncEnabled: false }),
    ...(previous?.cloudDeletedAt ? { cloudDeletedAt: previous.cloudDeletedAt } : {}),
    ...(previous?.cloudDeletionOperationId
      ? { cloudDeletionOperationId: previous.cloudDeletionOperationId }
      : {}),
    ...(!root && candidate.originUrl ? { repositoryUrl: candidate.originUrl } : {}),
  };
}

function printRepositoryCandidates(
  analysis: ProjectLayoutAnalysis,
  candidates: RepositoryCandidate[],
): void {
  const children = candidates.filter((candidate) => !isRootRepositoryPath(candidate.relativePath));
  if (analysis.root.isGitRepository) {
    const remote = analysis.root.originUrl ? "" : " (no remote)";
    console.log(`  This directory is a Git repository${remote}`);
    console.log(`  and contains ${children.length} Git ${children.length === 1 ? "repository" : "repositories"} one level below:`);
  } else {
    console.log(`  Found ${children.length} Git ${children.length === 1 ? "repository" : "repositories"} one level below:`);
  }
  for (const child of children) {
    const origin = child.originUrl ? "" : "  (no remote)";
    console.log(`    - ${child.relativePath}${origin}`);
  }
  console.log();
}

// --- Re-init of an already initialized project -------------------------------

async function reinitExistingManifest(
  root: string,
  existing: ProjectManifest,
  analysis: ProjectLayoutAnalysis,
  flags: InitModeFlags,
): Promise<ManifestPlanResult> {
  if (existing.cloudDeletedAt) {
    return reinitializeCloudDeletedProject(root, existing, analysis);
  }

  const candidates = buildRepositoryCandidates(analysis);
  const flagSelection = resolveFlagSelection(flags, analysis, candidates);
  if (flagSelection.kind === "failed") return { status: "failed" };

  const plan = planRepositories(existing, candidates);
  let target = plan.target;

  if (plan.hasStructuralChanges) {
    console.log("  Repository changes detected:");
    for (const rename of plan.renames) {
      console.log(`    ~ ${rename.fromPath} → ${rename.toPath} (renamed, same remote — identity preserved)`);
    }
    for (const path of plan.addedPaths) console.log(`    + ${path}`);
    for (const path of plan.removedPaths) console.log(`    - ${path} (no longer a Git repository here)`);
    console.log();

    const hasFlags = Boolean(flags.singleRepo || flags.multiRepo || flags.repos?.length);
    const apply = hasFlags
      ? true
      : isInteractive()
        ? await askYesNo("  Update the registered repository list?")
        : null;
    if (apply === null) {
      console.log("  [!] Keeping the current repository list. Re-run 'adit init' in an interactive terminal (or with --multi-repo) to update it.");
      target = existing.repositories;
    } else if (!apply) {
      console.log("  [=] Keeping the current repository list.");
      target = existing.repositories;
    } else if (target.length === 0) {
      console.error("  [x] No Git repositories left here — a project needs at least one.");
      return { status: "failed" };
    }
  }

  // --multi-repo only applies list changes; --single-repo / --repos also pick
  // the synced set. Otherwise the interactive picker decides.
  if (flagSelection.kind === "select" && !flags.multiRepo) {
    target = applyRepositorySelection(target, flagSelection.paths);
  } else if (flagSelection.kind === "none" && isInteractive() && target.length > 1) {
    console.log();
    target = await promptRepositorySelection(target);
  }

  const upgrade = existing.schemaVersion !== MANIFEST_SCHEMA_VERSION;
  if (!upgrade && JSON.stringify(target) === JSON.stringify(existing.repositories)) {
    console.log(`  [=] Repository settings unchanged (${existing.repositories.length} ${existing.repositories.length === 1 ? "repository" : "repositories"}).`);
    return { status: "unchanged", manifest: existing };
  }

  const { projectType: _legacyType, ...rest } = existing;
  void _legacyType;
  const manifest: ProjectManifest = {
    ...rest,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    repositories: target,
    updatedAt: new Date().toISOString(),
  };
  await withProjectInitLock(root, async () => writeProjectManifest(root, manifest));
  if (plan.hasStructuralChanges || JSON.stringify(target) !== JSON.stringify(existing.repositories)) {
    console.log("  [+] Updated project manifest.");
  } else if (plan.needsRewrite) {
    console.log("  [+] Recorded repository identities in the manifest.");
  } else {
    console.log(`  [+] Upgraded project manifest to schema ${MANIFEST_SCHEMA_VERSION}.`);
  }
  return { status: "written", manifest, migratedFrom: null };
}

async function reinitializeCloudDeletedProject(
  root: string,
  existing: ProjectManifest,
  analysis: ProjectLayoutAnalysis,
): Promise<ManifestPlanResult> {
  console.log("  [!] This project was deleted in ADIT Cloud.");
  if (!isInteractive()) {
    console.log("      Re-run 'adit init' in an interactive terminal to create it as a new project.");
    return { status: "unchanged", manifest: existing };
  }

  const confirmed = await askYesNo(
    "  Create a new project identity and allow it to sync again?",
  );
  if (!confirmed) {
    console.log("  [=] Keeping the deleted project identity.");
    return { status: "unchanged", manifest: existing };
  }

  const replacement = createReplacementProjectManifest(existing, analysis);
  if (!replacement) {
    console.error("  [x] Not a Git repository, and no Git repositories were found one level below.");
    return { status: "failed" };
  }

  let repositories = replacement.repositories;
  if (repositories.length > 1) {
    console.log();
    repositories = await promptRepositorySelection(repositories);
  }
  const manifest = { ...replacement, repositories };
  await withProjectInitLock(root, async () => writeProjectManifest(root, manifest));
  console.log(`  [+] Created a new project identity: ${manifest.projectId}`);
  return { status: "written", manifest, migratedFrom: null };
}

/**
 * Build a brand-new manifest for a Cloud-deleted project: fresh project and
 * repository identities, current layout, and the previous sync selection
 * carried over by path. Deletion tombstones are never copied.
 */
export function createReplacementProjectManifest(
  existing: ProjectManifest,
  analysis: ProjectLayoutAnalysis,
  projectId = generateProjectId(),
  now = new Date().toISOString(),
): ProjectManifest | null {
  const candidates = buildRepositoryCandidates(analysis);
  if (candidates.length === 0) return null;

  const previousByPath = new Map(
    existing.repositories.map((repository) => [repository.relativePath, repository]),
  );
  const defaults = defaultRepositorySelection(analysis, candidates);
  const repositories = candidates.map((candidate) => {
    const previous = previousByPath.get(candidate.relativePath);
    const enabled =
      typeof previous?.syncEnabled === "boolean"
        ? previous.syncEnabled
        : defaults.has(candidate.relativePath);
    return toManifestEntry(projectId, candidate, enabled);
  });

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    projectId,
    repositories,
    createdAt: now,
    updatedAt: now,
  };
}

interface RepositoryPlan {
  target: ProjectManifestRepository[];
  renames: Array<{ fromPath: string; toPath: string }>;
  addedPaths: string[];
  removedPaths: string[];
  hasStructuralChanges: boolean;
  /** No structural change, but stored identities/remote hints need (re)writing. */
  needsRewrite: boolean;
}

/**
 * Plan the repository list for a re-init.
 *
 * Identity rules: a path already registered keeps its stored repositoryId; a
 * new path whose remote uniquely matches exactly one disappeared entry (in
 * both directions) is treated as a directory rename and inherits that entry's
 * identity; anything ambiguous gets a fresh identity — never guess. The root
 * entry (`.`) never renames and never carries an identity of its own.
 */
function planRepositories(
  existing: ProjectManifest,
  candidates: RepositoryCandidate[],
): RepositoryPlan {
  const registeredByPath = new Map(
    existing.repositories.map((entry) => [entry.relativePath, entry]),
  );
  const discoveredPaths = new Set(candidates.map((candidate) => candidate.relativePath));

  const removedEntries = existing.repositories.filter(
    (entry) => !discoveredPaths.has(entry.relativePath),
  );
  const addedCandidates = candidates.filter(
    (candidate) => !registeredByPath.has(candidate.relativePath),
  );

  const renamePairs = new Map<string, ProjectManifestRepository>();
  for (const candidate of addedCandidates) {
    if (isRootRepositoryPath(candidate.relativePath) || !candidate.originUrl) continue;
    const fromMatches = removedEntries.filter(
      (entry) =>
        !isRootRepositoryPath(entry.relativePath) &&
        entry.repositoryUrl &&
        entry.repositoryUrl === candidate.originUrl,
    );
    if (fromMatches.length !== 1) continue;
    const toMatches = addedCandidates.filter((other) => other.originUrl === candidate.originUrl);
    if (toMatches.length !== 1) continue;
    renamePairs.set(candidate.relativePath, fromMatches[0]);
  }

  const target: ProjectManifestRepository[] = candidates.map((candidate) => {
    const existingEntry = registeredByPath.get(candidate.relativePath);
    const renamedFrom = renamePairs.get(candidate.relativePath);
    const previousEntry = existingEntry ?? renamedFrom;
    const enabled = previousEntry?.syncEnabled !== false;
    if (isRootRepositoryPath(candidate.relativePath)) {
      return toManifestEntry(existing.projectId, candidate, enabled, previousEntry);
    }
    const repositoryId =
      existingEntry?.repositoryId ??
      renamedFrom?.repositoryId ??
      computeLocalRepositoryId(
        existing.projectId,
        renamedFrom ? renamedFrom.relativePath : candidate.relativePath,
      );
    return toManifestEntry(existing.projectId, candidate, enabled, {
      ...(previousEntry ?? { relativePath: candidate.relativePath }),
      repositoryId,
    });
  });

  const renames = [...renamePairs.entries()].map(([toPath, from]) => ({
    fromPath: from.relativePath,
    toPath,
  }));
  const renamedFromPaths = new Set(renames.map((rename) => rename.fromPath));
  const addedPaths = addedCandidates
    .map((candidate) => candidate.relativePath)
    .filter((path) => !renamePairs.has(path));
  const removedPaths = removedEntries
    .map((entry) => entry.relativePath)
    .filter((path) => !renamedFromPaths.has(path));

  const hasStructuralChanges =
    renames.length > 0 || addedPaths.length > 0 || removedPaths.length > 0;
  const needsRewrite =
    !hasStructuralChanges &&
    JSON.stringify(target) !== JSON.stringify(existing.repositories);

  return { target, renames, addedPaths, removedPaths, hasStructuralChanges, needsRewrite };
}

// --- Legacy identity recovery ------------------------------------------------

interface RecoveredIdentity {
  projectId: string;
  source: string;
}

/**
 * Recover the identity of a pre-manifest project so the cloud project, local
 * history, team links and sync cursors all stay attached. Chain: legacy
 * workspace manifest → local link cache → session history → legacy path hash.
 */
function recoverLegacyProjectId(root: string): RecoveredIdentity | null {
  const workspaceManifest = readWorkspaceManifest(root);
  if (workspaceManifest) {
    return { projectId: workspaceManifest.workspaceId, source: "previous multi-repo configuration" };
  }

  const { dbPath } = getAditProjectInitializationPaths(root);
  if (!existsSync(dbPath)) return null;

  const fromDb = recoverProjectIdFromDatabase(dbPath);
  if (fromDb) return fromDb;

  return { projectId: computeRepoProjectId(root), source: "legacy path derivation" };
}

function recoverProjectIdFromDatabase(dbPath: string): RecoveredIdentity | null {
  try {
    const db = openDatabase(dbPath);
    try {
      const linkRow = db
        .prepare(
          "SELECT project_id FROM project_link_cache ORDER BY COALESCE(last_branch_sync_at, '') DESC LIMIT 1",
        )
        .get() as { project_id?: string } | undefined;
      if (linkRow?.project_id) {
        return { projectId: linkRow.project_id, source: "local sync cache" };
      }
      const sessionRow = db
        .prepare("SELECT project_id FROM sessions ORDER BY started_at DESC LIMIT 1")
        .get() as { project_id?: string } | undefined;
      if (sessionRow?.project_id) {
        return { projectId: sessionRow.project_id, source: "local session history" };
      }
      return null;
    } finally {
      closeDatabase(db);
    }
  } catch {
    return null;
  }
}

// --- Small prompt helpers ----------------------------------------------------

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function confirmManifestRebuild(err: ProjectManifestError): Promise<boolean> {
  console.error(`  [x] Project manifest is damaged: ${err.message}`);
  console.error("      Restore .adit/project.json from a backup, or rebuild it now —");
  console.error("      the project identity is recovered from local data when possible.");
  if (!isInteractive()) {
    console.error("      Re-run 'adit init' in an interactive terminal to rebuild it.");
    return false;
  }
  return askYesNo("  Rebuild the project manifest now?");
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} (y/N): `);
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}
