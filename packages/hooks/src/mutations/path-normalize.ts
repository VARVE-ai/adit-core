/**
 * Normalize mutation paths to a single semantic: project-root-relative.
 *
 * Extractors emit whatever the platform transcript recorded — Claude/Gemini/
 * Cursor tool inputs carry absolute host paths, Codex mixes absolute
 * (resolved shell targets) and cwd-relative (apply_patch keys). Storing those
 * raw produced illegal `diff --git a//Users/...` headers, leaked the local
 * filesystem layout to the cloud, and split path-keyed aggregations between
 * relative and absolute spellings of the same file.
 *
 * Rules:
 *  - absolute path inside the project root  → root-relative
 *  - relative path (treated as cwd-relative) → resolved, then root-relative
 *  - anything resolving outside the root     → kept absolute (an honest
 *    marker that the agent touched a file outside the project)
 * Output always uses forward slashes.
 */

import { isAbsolute, relative, resolve } from "node:path";
import type { AgentFileMutation } from "./types.js";

export function normalizeMutationPaths(
  mutations: AgentFileMutation[],
  opts: { projectRoot: string; cwd: string },
): AgentFileMutation[] {
  const root = resolve(opts.projectRoot);
  const cwd = resolve(opts.cwd);
  return mutations.map((m) => {
    const normalized = normalizeOnePath(m.path, root, cwd);
    return normalized === m.path ? m : { ...m, path: normalized };
  });
}

function normalizeOnePath(rawPath: string, root: string, cwd: string): string {
  const slashed = rawPath.replace(/\\/g, "/");
  if (!slashed) return slashed;
  const absolute = isAbsolute(slashed) ? resolve(slashed) : resolve(cwd, slashed);
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    // Outside the project root — keep the absolute form rather than a
    // misleading ../../ chain.
    return absolute.replace(/\\/g, "/");
  }
  return rel.replace(/\\/g, "/");
}
