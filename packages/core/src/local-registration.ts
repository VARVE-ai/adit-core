import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalDirectory, LocalStateError, type LocalStore, type LocalWorkspace } from "./local-state.js";
import { containsPath, relocatedRepositories } from "./local-projects.js";
import { sourceDefinitions } from "./local-history/sources.js";

export const missingGitRepository = "No Git repository found. Select a directory containing a Git repository to create the project or start organizing.";
/** Metadata only: the workspace itself and its immediate child repositories. */
export function discoverWorkspaceRepositories(root: string): string[] {
  const path = canonicalDirectory(root);
  const paths = existsSync(join(path, ".git")) ? [path] : [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = join(path, entry.name);
    if (existsSync(join(child, ".git"))) paths.push(canonicalDirectory(child));
  }
  return paths;
}
export function assertWorkspaceGit(root: string): string[] {
  const repositories = discoverWorkspaceRepositories(root);
  if (!repositories.length) throw new LocalStateError(missingGitRepository, 409);
  return repositories;
}
export function workspaceGitStatus(root: string): { available: boolean; error?: string } {
  try { assertWorkspaceGit(root); return { available: true }; }
  catch (error) { return { available: false, error: error instanceof Error ? error.message : "Unable to check Git repositories" }; }
}
/** A missing author identity may leave selection empty, but Git must exist. */
export function validateWorkspaceRepositories(root: string, value: unknown): asserts value is string[] {
  assertWorkspaceGit(root);
  if (!Array.isArray(value) || value.some(path => typeof path !== "string" || !containsPath(root, canonicalDirectory(path)) || !existsSync(join(path, ".git"))))
    throw new LocalStateError("Select Git repositories inside the workspace");
}

/** User-facing registration, shared by CLI and HTTP. Storage also supports reading
 * pre-existing projects whose directories are no longer available. */
export function registerWorkspace(store: LocalStore, input: Record<string, unknown>, id?: string): LocalWorkspace {
  return store.db.transaction(() => {
    const old = id ? store.workspace(id) : undefined;
    const root = canonicalDirectory(String(input.path ?? old?.path ?? ""));
    const selected = input.repositories ?? old?.repositories ?? [];
    validateWorkspaceRepositories(root, old && Array.isArray(selected) ? relocatedRepositories(old, root, selected) : selected);
    const providers = input.providers ?? old?.providers ?? [];
    const definitions = sourceDefinitions();
    if (!Array.isArray(providers) || providers.some(id => !definitions.some(d => d.id === id && d.supported)))
      throw new LocalStateError("Unsupported provider");
    for (const other of store.workspaces()) {
      if (other.id === id) continue;
      if ((!old || old.path !== root) && (containsPath(other.path, root) || containsPath(root, other.path)))
        throw new LocalStateError("This directory overlaps an existing project. Update its working directory in Settings.", 409);
    }
    return store.saveWorkspace(input, id);
  }).immediate();
}
