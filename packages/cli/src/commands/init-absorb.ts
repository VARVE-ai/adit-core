/**
 * Moving an existing member project up into a parent project.
 *
 * When `adit init` runs in a directory whose child repository is already an
 * ADIT project, the child project is not registered a second time. Instead
 * its project root moves up: the parent directory takes over the child's
 * project identity (sessions, blueprints and team mounts stay attached), the
 * child becomes the repository at its relative path, and any other child
 * repositories join as new members.
 *
 * Further child projects cannot share the same identity; they are registered
 * by their own project ID (so the Cloud can recognize the repository) and
 * marked as merged, which routes their commands and hooks to the parent while
 * their local history stays where it is.
 */

import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  closeDatabase,
  openDatabase,
  readProjectManifest,
  writeProjectManifest,
  type ProjectManifest,
  type ProjectManifestRepository,
} from "@varveai/adit-core";
import type { ProjectLayoutAnalysis } from "./project-layout.js";

export interface ChildProject {
  relativePath: string;
  path: string;
  projectId: string;
  createdAt: string;
  sessionCount: number;
}

/** Child repositories that are still independent ADIT projects. */
export function collectChildProjects(analysis: ProjectLayoutAnalysis): ChildProject[] {
  const projects: ChildProject[] = [];
  for (const child of analysis.childRepositories) {
    const existing = child.existingProject;
    if (!existing || existing.mergedIntoProjectId || existing.cloudDeletedAt) continue;
    projects.push({
      relativePath: child.relativePath,
      path: child.path,
      projectId: existing.projectId,
      createdAt: existing.createdAt,
      sessionCount: countLocalSessions(child.path),
    });
  }
  return projects;
}

/** Sessions recorded locally under a project directory (0 when unknown). */
export function countLocalSessions(projectRoot: string): number {
  const dbPath = join(projectRoot, ".adit", "adit.sqlite");
  if (!existsSync(dbPath)) return 0;
  try {
    const db = openDatabase(dbPath);
    try {
      const row = db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count?: number } | undefined;
      return Number(row?.count ?? 0);
    } finally {
      closeDatabase(db);
    }
  } catch {
    return 0;
  }
}

/**
 * Pick which child project becomes the project: the one with the most local
 * sessions; ties go to the earliest created, then the path.
 */
export function pickAbsorbTarget(projects: ChildProject[]): ChildProject {
  return [...projects].sort(
    (a, b) =>
      b.sessionCount - a.sessionCount ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.relativePath.localeCompare(b.relativePath),
  )[0];
}

export class AbsorbPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbsorbPreconditionError";
  }
}

export interface AbsorbedProject {
  projectId: string;
  createdAt: string;
  /** The entry the child project's own root repository turns into. */
  rootEntry: ProjectManifestRepository;
}

/**
 * Move the child's data directory up to `root` and describe the repository
 * entry that replaces the child's former root repository. Throws
 * AbsorbPreconditionError without touching anything when the move is unsafe.
 */
export function moveProjectRootUp(root: string, child: ChildProject): AbsorbedProject {
  const childDataDir = join(child.path, ".adit");
  const rootDataDir = join(root, ".adit");
  if (existsSync(rootDataDir)) {
    throw new AbsorbPreconditionError(
      `${root} already has a .adit directory — move or remove it before absorbing ${child.relativePath}.`,
    );
  }
  const manifest = readProjectManifest(child.path);
  if (!manifest) {
    throw new AbsorbPreconditionError(`${child.relativePath} is no longer an ADIT project.`);
  }
  const memberEntries = manifest.repositories.filter((entry) => entry.relativePath !== ".");
  if (memberEntries.length > 0) {
    throw new AbsorbPreconditionError(
      `${child.relativePath} registers its own member repositories (${memberEntries.map((entry) => entry.relativePath).join(", ")}); nested repositories cannot be moved up.`,
    );
  }
  const formerRoot = manifest.repositories.find((entry) => entry.relativePath === ".");

  renameSync(childDataDir, rootDataDir);

  return {
    projectId: manifest.projectId,
    createdAt: manifest.createdAt,
    rootEntry: {
      relativePath: child.relativePath,
      // The child's root repository was identified by its project ID; keep
      // that identity so the Cloud recognizes the same repository.
      repositoryId: manifest.projectId,
      ...(formerRoot?.syncEnabled === false ? { syncEnabled: false } : {}),
      ...(formerRoot?.cloudDeletedAt ? { cloudDeletedAt: formerRoot.cloudDeletedAt } : {}),
      ...(formerRoot?.cloudDeletionOperationId
        ? { cloudDeletionOperationId: formerRoot.cloudDeletionOperationId }
        : {}),
    },
  };
}

/** Mark a child project as merged into `parentProjectId` (routes it to the parent). */
export function markMergedInto(childPath: string, parentProjectId: string): void {
  const manifest = readProjectManifest(childPath);
  if (!manifest) return;
  const next: ProjectManifest = {
    ...manifest,
    mergedIntoProjectId: parentProjectId,
    updatedAt: new Date().toISOString(),
  };
  writeProjectManifest(childPath, next);
}

/** Remove the merged marker again (used by `adit init --detach`). */
export function clearMergedMarker(childPath: string): void {
  const manifest = readProjectManifest(childPath);
  if (!manifest?.mergedIntoProjectId) return;
  const { mergedIntoProjectId: _merged, ...rest } = manifest;
  void _merged;
  writeProjectManifest(childPath, { ...rest, updatedAt: new Date().toISOString() });
}

export function describeChildProject(project: ChildProject): string {
  const sessions =
    project.sessionCount === 1 ? "1 session" : `${project.sessionCount} sessions`;
  return `${project.relativePath}  (already an ADIT project, ${sessions})`;
}

/** Interactive choice of the project to move up; null keeps every child independent. */
export async function promptAbsorbTarget(projects: ChildProject[]): Promise<ChildProject | null> {
  if (projects.length === 1) {
    const [project] = projects;
    console.log(`  ${project.relativePath} is already initialized (${project.sessionCount} ${project.sessionCount === 1 ? "session" : "sessions"}).`);
    console.log("  Move its project root up to this directory? Its sessions, blueprints and team");
    console.log(`  mounts are kept; ${project.relativePath} becomes repository '${project.relativePath}'.`);
    return (await askYesNo("  Move it up?")) ? project : null;
  }

  const recommended = pickAbsorbTarget(projects);
  console.log("  Several child repositories are already ADIT projects. Which one should become this project?");
  projects.forEach((project, index) => {
    const marker = project === recommended ? " (recommended)" : "";
    console.log(`    ${index + 1}. ${describeChildProject(project)}${marker}`);
  });
  console.log(`    ${projects.length + 1}. Keep them all independent`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("  Choose an option: ")).trim();
    if (answer === "") return recommended;
    const index = Number.parseInt(answer, 10) - 1;
    if (Number.isInteger(index) && index >= 0 && index < projects.length) return projects[index];
    return null;
  } finally {
    rl.close();
  }
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
