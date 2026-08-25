/**
 * Manifest planning for `adit init`.
 *
 * Decides — together with the user — what `.adit/project.json` should say,
 * then writes it atomically under the init lock. Covers fresh initialization,
 * migration of pre-manifest projects (identity is carried over, never
 * regenerated), re-init diffs, and member-repository standalone init.
 */

import { existsSync, rmSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  ProjectManifestError,
  computeRepoProjectId,
  findProjectManifestRoot,
  generateProjectId,
  openDatabase,
  closeDatabase,
  readProjectManifest,
  readWorkspaceManifest,
  withProjectInitLock,
  workspaceManifestRelativePath,
  writeProjectManifest,
  type ProjectManifest,
  type ProjectType,
} from "@varveai/adit-core";
import type { ProjectLayoutAnalysis } from "./project-layout.js";
import { getAditProjectInitializationPaths } from "./project-initialization.js";

export interface InitModeFlags {
  singleRepo?: boolean;
  multiRepo?: boolean;
}

export type ManifestPlanResult =
  | { status: "written"; manifest: ProjectManifest; migratedFrom: string | null }
  | { status: "unchanged"; manifest: ProjectManifest }
  | { status: "cancelled" }
  | { status: "failed" }
  | { status: "redirect-child"; childPath: string };

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

  if (existing) {
    return reinitExistingManifest(root, existing, analysis, flags);
  }
  return initFreshManifest(root, analysis, flags);
}

// --- Re-init of an already initialized project -------------------------------

async function reinitExistingManifest(
  root: string,
  existing: ProjectManifest,
  analysis: ProjectLayoutAnalysis,
  flags: InitModeFlags,
): Promise<ManifestPlanResult> {
  const targetType: ProjectType | null = flags.singleRepo ? "repo" : flags.multiRepo ? "workspace" : null;

  if (targetType && targetType !== existing.projectType) {
    return convertManifestType(root, existing, analysis, targetType);
  }

  if (existing.projectType === "repo") {
    console.log("  [=] Project manifest unchanged (single-repo project).");
    return { status: "unchanged", manifest: existing };
  }

  const registered = existing.repositories.map((repo) => repo.relativePath);
  const discovered = analysis.childRepositories.map((repo) => repo.relativePath);
  const added = discovered.filter((path) => !registered.includes(path));
  const removed = registered.filter((path) => !discovered.includes(path));

  if (added.length === 0 && removed.length === 0) {
    console.log(`  [=] Repository list unchanged (${registered.length} repositories).`);
    return { status: "unchanged", manifest: existing };
  }

  console.log("  Repository changes detected:");
  for (const path of added) console.log(`    + ${path}`);
  for (const path of removed) console.log(`    - ${path} (no longer a Git repository here)`);
  console.log();

  const apply = flags.multiRepo
    ? true
    : isInteractive()
      ? await askYesNo("  Update the registered repository list?")
      : null;
  if (apply === null) {
    console.log("  [!] Keeping the current repository list. Re-run 'adit init' in an interactive terminal (or with --multi-repo) to update it.");
    return { status: "unchanged", manifest: existing };
  }
  if (!apply) {
    console.log("  [=] Keeping the current repository list.");
    return { status: "unchanged", manifest: existing };
  }
  if (discovered.length === 0) {
    console.error("  [x] No child Git repositories left — a multi-repo project needs at least one.");
    return { status: "failed" };
  }

  const manifest: ProjectManifest = {
    ...existing,
    repositories: discovered.map((relativePath) => ({ relativePath })),
    updatedAt: new Date().toISOString(),
  };
  await withProjectInitLock(root, async () => writeProjectManifest(root, manifest));
  console.log("  [+] Updated project manifest.");
  return { status: "written", manifest, migratedFrom: null };
}

async function convertManifestType(
  root: string,
  existing: ProjectManifest,
  analysis: ProjectLayoutAnalysis,
  targetType: ProjectType,
): Promise<ManifestPlanResult> {
  if (targetType === "repo" && !analysis.root.isGitRepository) {
    console.error("  [x] --single-repo requires the project root to be a Git repository.");
    return { status: "failed" };
  }
  if (targetType === "workspace" && analysis.childRepositories.length === 0) {
    console.error("  [x] --multi-repo requires at least one child Git repository.");
    return { status: "failed" };
  }

  const label = targetType === "repo" ? "single-repo" : "multi-repo";
  if (isInteractive()) {
    const confirmed = await askYesNo(`  Convert this project to ${label}? The project identity is kept.`);
    if (!confirmed) return { status: "cancelled" };
  }

  const manifest: ProjectManifest = {
    ...existing,
    projectType: targetType,
    repositories:
      targetType === "repo"
        ? [{ relativePath: "." }]
        : analysis.childRepositories.map((repo) => ({ relativePath: repo.relativePath })),
    updatedAt: new Date().toISOString(),
  };
  await withProjectInitLock(root, async () => writeProjectManifest(root, manifest));
  console.log(`  [+] Converted project to ${label} (identity preserved).`);
  return { status: "written", manifest, migratedFrom: null };
}

// --- Fresh initialization / migration ----------------------------------------

async function initFreshManifest(
  root: string,
  analysis: ProjectLayoutAnalysis,
  flags: InitModeFlags,
): Promise<ManifestPlanResult> {
  const mode = await determineInitMode(analysis, flags);
  if (mode.kind === "cancelled" || mode.kind === "failed") return { status: mode.kind };
  if (mode.kind === "redirect-child") return { status: "redirect-child", childPath: mode.childPath };

  if (mode.projectType === "repo" && !(await confirmMemberRepositoryInit(root))) {
    return { status: "cancelled" };
  }

  const recovered = recoverLegacyProjectId(root);
  const now = new Date().toISOString();
  const manifest: ProjectManifest = {
    schemaVersion: 1,
    projectId: recovered?.projectId ?? generateProjectId(),
    projectType: mode.projectType,
    repositories:
      mode.projectType === "repo"
        ? [{ relativePath: "." }]
        : analysis.childRepositories.map((repo) => ({ relativePath: repo.relativePath })),
    createdAt: now,
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

  return { status: "written", manifest, migratedFrom: recovered?.source ?? null };
}

type InitModeDecision =
  | { kind: "mode"; projectType: ProjectType }
  | { kind: "redirect-child"; childPath: string }
  | { kind: "cancelled" }
  | { kind: "failed" };

async function determineInitMode(
  analysis: ProjectLayoutAnalysis,
  flags: InitModeFlags,
): Promise<InitModeDecision> {
  if (flags.singleRepo) {
    if (!analysis.root.isGitRepository) {
      console.error("  [x] --single-repo requires the project root to be a Git repository.");
      return { kind: "failed" };
    }
    return { kind: "mode", projectType: "repo" };
  }
  if (flags.multiRepo) {
    if (analysis.childRepositories.length === 0) {
      console.error("  [x] --multi-repo requires at least one child Git repository.");
      return { kind: "failed" };
    }
    return { kind: "mode", projectType: "workspace" };
  }

  switch (analysis.recommendation) {
    case "cannot-initialize":
      console.error("  [x] Not a Git repository, and no Git repositories were found one level below.");
      console.error("      Run 'git init' first, or run this from a directory that contains repositories.");
      return { kind: "failed" };
    case "single-repo":
      if (!analysis.requiresConfirmation) return { kind: "mode", projectType: "repo" };
      return promptSingleWithChildren(analysis);
    case "choose-explicit":
      return promptMetaRepository(analysis);
    case "multi-repo":
      return promptMultiRepo(analysis);
    case "choose-child":
      return promptChooseChild(analysis);
  }
}

async function promptSingleWithChildren(analysis: ProjectLayoutAnalysis): Promise<InitModeDecision> {
  printChildRepositories(analysis);
  console.log("  This repository has its own remote; the repositories above are NOT included by default.");
  if (!isInteractive()) return nonInteractiveAmbiguity();

  return askMode([
    { label: "Track only this repository (recommended)", decision: { kind: "mode", projectType: "repo" } },
    {
      label: "Manage only the child repositories as a multi-repo project (this repository itself is NOT tracked)",
      decision: { kind: "mode", projectType: "workspace" },
    },
  ], 0);
}

async function promptMetaRepository(analysis: ProjectLayoutAnalysis): Promise<InitModeDecision> {
  printChildRepositories(analysis);
  console.log("  This repository has commits but no remote — it could be a real project or just a container.");
  if (!isInteractive()) return nonInteractiveAmbiguity();

  return askMode([
    {
      label: "Track only this repository (child repositories are NOT included)",
      decision: { kind: "mode", projectType: "repo" },
    },
    {
      label: "Manage only the child repositories as a multi-repo project (this repository's commits are NOT synced)",
      decision: { kind: "mode", projectType: "workspace" },
    },
  ], null);
}

async function promptMultiRepo(analysis: ProjectLayoutAnalysis): Promise<InitModeDecision> {
  printChildRepositories(analysis);
  if (analysis.root.isGitRepository) {
    console.log("  This directory itself is an empty Git repository without a remote.");
  }
  if (!isInteractive()) return nonInteractiveAmbiguity();

  const options: Array<{ label: string; decision: InitModeDecision }> = [
    {
      label: "Manage them together as one multi-repo project (recommended)",
      decision: { kind: "mode", projectType: "workspace" },
    },
  ];
  if (analysis.root.isGitRepository) {
    options.push({
      label: "Track only this directory as a single-repo project",
      decision: { kind: "mode", projectType: "repo" },
    });
  }
  return askMode(options, 0);
}

async function promptChooseChild(analysis: ProjectLayoutAnalysis): Promise<InitModeDecision> {
  const child = analysis.childRepositories[0];
  printChildRepositories(analysis);
  console.log("  This directory looks like a wrapper around a single repository.");
  if (!isInteractive()) return nonInteractiveAmbiguity();

  return askMode([
    {
      label: `Initialize the repository '${child.displayName}' as its own project`,
      decision: { kind: "redirect-child", childPath: child.path },
    },
    { label: "Manage it as a multi-repo project", decision: { kind: "mode", projectType: "workspace" } },
  ], null);
}

function printChildRepositories(analysis: ProjectLayoutAnalysis): void {
  console.log(`  Found ${analysis.childRepositories.length} Git repositories one level below:`);
  for (const repo of analysis.childRepositories) {
    const origin = repo.originUrl ? "" : "  (no remote)";
    console.log(`    - ${repo.relativePath}${origin}`);
  }
  console.log();
}

function nonInteractiveAmbiguity(): InitModeDecision {
  console.error("  [x] This layout needs a choice, but the current environment is not interactive.");
  console.error("      Re-run with an explicit mode:");
  console.error("        adit init --multi-repo");
  console.error("        adit init --single-repo");
  return { kind: "failed" };
}

// --- Member-repository notice ------------------------------------------------

async function confirmMemberRepositoryInit(root: string): Promise<boolean> {
  const parentRoot = findProjectManifestRoot(dirname(root));
  if (!parentRoot) return true;

  let parent: ProjectManifest | null = null;
  try {
    parent = readProjectManifest(parentRoot);
  } catch {
    return true; // a damaged parent manifest never blocks the child
  }
  if (!parent || parent.projectType !== "workspace") return true;

  const relativePath = relative(parentRoot, root).replace(/\\/gu, "/");
  if (!parent.repositories.some((repo) => repo.relativePath === relativePath)) return true;

  const name = basename(root);
  const parentName = basename(parentRoot);
  console.log(`  [!] ${name} is already registered in the multi-repo project '${parentName}'.`);
  console.log("      Continuing will initialize it as an independent project;");
  console.log("      its Git history will appear in both projects.");
  console.log();

  if (!isInteractive()) return true; // explicit flag path — notice only
  return askYesNo("  Continue and initialize it as an independent project?");
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

async function askMode(
  options: Array<{ label: string; decision: InitModeDecision }>,
  defaultIndex: number | null,
): Promise<InitModeDecision> {
  console.log("  How should ADIT initialize here?");
  options.forEach((option, index) => {
    const marker = defaultIndex === index ? " (default)" : "";
    console.log(`    ${index + 1}. ${option.label}${marker}`);
  });
  console.log(`    ${options.length + 1}. Cancel`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("  Choose an option: ")).trim();
    if (answer === "" && defaultIndex !== null) return options[defaultIndex].decision;
    const index = Number.parseInt(answer, 10) - 1;
    if (Number.isInteger(index) && index >= 0 && index < options.length) {
      return options[index].decision;
    }
    console.log("  Cancelled. Nothing was changed.");
    return { kind: "cancelled" };
  } finally {
    rl.close();
  }
}
