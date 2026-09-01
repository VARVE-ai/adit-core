/**
 * Git metadata collection for project link.
 *
 * Collects remote URL, branches, commit logs, and default branch
 * using the existing @varveai/adit-engine git runner. All functions are
 * fail-safe — they throw on critical errors (no git repo, no remote)
 * but return empty arrays for non-critical failures.
 */

import { runGit, getRemoteUrl } from "@varveai/adit-engine";
import type { GitBranch, GitCommit, GitCommitFileStat, GitIdentity } from "./types.js";

/** Collect the remote origin URL. Throws if no remote is configured. */
export async function collectRemoteUrl(cwd: string): Promise<string> {
  const url = await getRemoteUrl(cwd);
  if (!url) {
    throw new Error("No git remote 'origin' configured. Add one with: git remote add origin <url>");
  }
  return url;
}

/**
 * Detect the default branch name.
 *
 * Tries `git symbolic-ref refs/remotes/origin/HEAD` first (reliable
 * if the remote HEAD is set). Falls back to checking for `main` then
 * `master` branch existence.
 */
export async function collectDefaultBranch(cwd: string): Promise<string | null> {
  const result = await runGit(
    ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
    { cwd },
  );

  if (result.exitCode === 0) {
    // Returns "origin/main" — strip the "origin/" prefix
    const ref = result.stdout.trim();
    return ref.replace(/^origin\//, "");
  }

  // Fallback: check if main or master exists
  for (const branch of ["main", "master"]) {
    const check = await runGit(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd });
    if (check.exitCode === 0) return branch;
  }

  return null;
}

/**
 * Get the currently checked-out branch name.
 *
 * Uses `git branch --show-current` which returns an empty string
 * in detached HEAD state. Returns null if not on a branch or if
 * the command fails.
 */
export async function collectCurrentBranch(cwd: string): Promise<string | null> {
  const result = await runGit(["branch", "--show-current"], { cwd });
  if (result.exitCode !== 0) return null;

  const branch = result.stdout.trim();
  return branch || null;
}

/**
 * Collect the Git author identity that is effective for this repository.
 *
 * `git config --get user.*` resolves local config first, then global/system
 * config, which matches the identity Git will use for new commits.
 */
export async function collectGitIdentity(cwd: string): Promise<GitIdentity> {
  const [nameResult, emailResult] = await Promise.all([
    runGit(["config", "--get", "user.name"], { cwd }),
    runGit(["config", "--get", "user.email"], { cwd }),
  ]);

  return {
    authorName: nameResult.exitCode === 0 ? normalizeGitIdentityValue(nameResult.stdout) : null,
    authorEmail: emailResult.exitCode === 0 ? normalizeGitIdentityValue(emailResult.stdout) : null,
  };
}

/**
 * Collect all branches (local + remote) with their HEAD SHAs.
 *
 * Remote branches are included and deduplicated — if a local branch
 * name matches a remote tracking branch, the local version is kept.
 */
export async function collectBranches(cwd: string): Promise<GitBranch[]> {
  const result = await runGit(
    ["branch", "-a", "--format=%(refname)|%(refname:short)|%(objectname)"],
    { cwd },
  );

  if (result.exitCode !== 0) return [];

  const defaultBranch = await collectDefaultBranch(cwd);
  const seen = new Map<string, GitBranch>();

  for (const line of result.stdout.trim().split("\n")) {
    if (!line) continue;
    const [fullRef, rawName, headSha] = line.split("|");
    if (!fullRef || !rawName || !headSha) continue;
    if (fullRef.startsWith("refs/remotes/") && fullRef.endsWith("/HEAD")) continue;

    const name = normalizeBranchRef(fullRef, rawName);
    if (!name) continue;
    // Skip HEAD pointer
    if (name === "HEAD" || name.includes("->")) continue;

    // Local branches take priority over remote tracking branches
    if (!seen.has(name) || !rawName.startsWith("origin/")) {
      seen.set(name, {
        name,
        headSha: headSha.trim(),
        isDefault: name === defaultBranch,
      });
    }
  }

  return Array.from(seen.values());
}

function normalizeBranchRef(fullRef: string, shortRef: string): string | null {
  const trimmedFullRef = fullRef.trim();
  const trimmedShortRef = shortRef.trim();

  if (trimmedFullRef.startsWith("refs/heads/")) {
    return trimmedFullRef.slice("refs/heads/".length);
  }

  if (trimmedFullRef.startsWith("refs/remotes/")) {
    const remoteBranch = trimmedFullRef.slice("refs/remotes/".length);
    const slashIndex = remoteBranch.indexOf("/");
    if (slashIndex < 0) return null;
    return remoteBranch.slice(slashIndex + 1);
  }

  return trimmedShortRef || null;
}

function normalizeGitIdentityValue(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Options for collecting commit logs.
 */
export interface CollectCommitOptions {
  /** Only return commits after this SHA (incremental sync). */
  sinceCommitSha?: string | null;
  /** Branch name to tag on each returned commit (legacy — prefer resolveCommitBranches). */
  branch?: string | null;
  /** Collect commits reachable from every local/remote branch instead of only HEAD. */
  allRefs?: boolean;
}

/**
 * Collect commit logs, optionally since a specific commit SHA.
 *
 * When `sinceCommitSha` is provided, only commits after that SHA
 * are returned (incremental sync). Otherwise, all commits are returned.
 * Commits are ordered newest-first (git log default). When `allRefs`
 * is true, commits are collected from every local/remote branch ref.
 *
 * When `branch` is provided, each returned commit will have its
 * `branch` field set to that value. For accurate per-commit branch
 * assignment, use `resolveCommitBranches()` after collecting commits
 * instead of this option.
 *
 * Format uses NUL (\x00) as record delimiter and SOH (\x01) as field
 * delimiter so that pipe characters and newlines inside commit messages
 * (%B = subject + body, multi-line) are preserved without ambiguity.
 */
export async function collectCommitLogs(
  cwd: string,
  sinceCommitShaOrOptions?: string | null | CollectCommitOptions,
): Promise<GitCommit[]> {
  // Support both the old positional signature and the new options object.
  // Old: collectCommitLogs(cwd, sinceCommitSha)
  // New: collectCommitLogs(cwd, { sinceCommitSha, branch, allRefs })
  let sinceCommitSha: string | null | undefined;
  let branch: string | null | undefined;
  let allRefs = false;

  if (
    sinceCommitShaOrOptions !== null &&
    sinceCommitShaOrOptions !== undefined &&
    typeof sinceCommitShaOrOptions === "object"
  ) {
    sinceCommitSha = sinceCommitShaOrOptions.sinceCommitSha;
    branch = sinceCommitShaOrOptions.branch;
    allRefs = sinceCommitShaOrOptions.allRefs === true;
  } else {
    sinceCommitSha = sinceCommitShaOrOptions;
  }
  // %H  = full SHA
  // %P  = parent SHAs, space-separated (first parent is used for parentSha)
  // %an = author name
  // %ae = author email
  // %aI = author date (ISO 8601 strict)
  // %B  = subject + body (may contain newlines)
  // %x01 = SOH field delimiter, %x00 = NUL record delimiter
  const args = ["log", "--format=%H%x01%P%x01%an%x01%ae%x01%aI%x01%B%x00"];

  if (allRefs) {
    args.push("--branches", "--remotes");
  }

  if (sinceCommitSha) {
    // Verify the SHA still exists (could have been force-pushed away)
    const exists = await runGit(["cat-file", "-t", sinceCommitSha], { cwd });
    if (exists.exitCode === 0) {
      args.push(allRefs ? `^${sinceCommitSha}` : `${sinceCommitSha}..HEAD`);
    }
    // If SHA doesn't exist, fall through to full log
  }

  const result = await runGit(args, { cwd, timeout: 30_000 });
  if (result.exitCode !== 0) return [];

  const commits: GitCommit[] = [];

  // Split on NUL to get individual commit records.
  // %B includes a trailing newline; we trim each record to strip it.
  for (const record of result.stdout.split("\0")) {
    const trimmed = record.trim();
    if (!trimmed) continue;

    const fields = trimmed.split("\x01");
    if (fields.length < 6) continue;

    const parentSha = fields[1]?.trim().split(/\s+/).filter(Boolean)[0] ?? null;

    commits.push({
      sha: fields[0],
      parentSha,
      authorName: fields[2],
      authorEmail: fields[3],
      date: fields[4],
      // %B may contain SOH-free multi-line text; everything after the 5th
      // SOH is the message (rejoin in case of unexpected extra SOH chars).
      message: fields.slice(5).join("\x01").trim(),
      branch: branch ?? undefined,
    });
  }

  return commits;
}

/**
 * Resolve per-commit branch assignments for a set of commits.
 *
 * For each known branch, runs `git rev-list <branch>` to collect the SHAs
 * reachable from that branch, newest first. Commits are assigned to the
 * nearest branch head that contains them, so a branch-tip commit stays on
 * that branch even if another branch was created from it later.
 *
 * Only SHAs present in `commitShas` are assigned — this avoids building
 * a map for the entire repository history when doing incremental sync.
 *
 * Mutates the `branch` field of each commit in `commits` in-place and
 * also returns the same array for chaining convenience.
 */
export async function resolveCommitBranches(
  cwd: string,
  commits: GitCommit[],
  branches: GitBranch[],
  defaultBranch: string | null,
): Promise<GitCommit[]> {
  if (commits.length === 0 || branches.length === 0) return commits;

  // Build a set of SHAs we care about for fast lookup
  const targetShas = new Set(commits.map((c) => c.sha));

  type BranchCandidate = {
    branch: string;
    rank: number;
    isDefault: boolean;
    order: number;
  };

  const shaToCandidate = new Map<string, BranchCandidate>();

  function isBetterCandidate(
    candidate: BranchCandidate,
    existing: BranchCandidate | undefined,
  ): boolean {
    if (!existing) return true;
    if (candidate.rank !== existing.rank) return candidate.rank < existing.rank;
    if (candidate.isDefault !== existing.isDefault) return !candidate.isDefault;
    return candidate.order < existing.order;
  }

  // Sort branches deterministically. Non-default branches win ties, while
  // distance from the branch head is the primary signal.
  const sorted = [...branches].sort((a, b) => {
    const aIsDefault = a.name === defaultBranch ? 1 : 0;
    const bIsDefault = b.name === defaultBranch ? 1 : 0;
    return aIsDefault - bIsDefault || a.name.localeCompare(b.name);
  });

  for (const [order, branch] of sorted.entries()) {
    let result = await runGit(
      ["rev-list", branch.name],
      { cwd, timeout: 30_000 },
    );

    if (result.exitCode !== 0 && branch.headSha) {
      result = await runGit(
        ["rev-list", branch.headSha],
        { cwd, timeout: 30_000 },
      );
    }

    if (result.exitCode !== 0) continue;

    const lines = result.stdout.trim().split("\n");
    for (let rank = 0; rank < lines.length; rank++) {
      const line = lines[rank];
      const sha = line.trim();
      if (!sha || !targetShas.has(sha)) continue;

      const candidate: BranchCandidate = {
        branch: branch.name,
        rank,
        isDefault: branch.name === defaultBranch,
        order,
      };

      if (isBetterCandidate(candidate, shaToCandidate.get(sha))) {
        shaToCandidate.set(sha, candidate);
      }
    }
  }

  // Apply resolved branches to commits
  for (const commit of commits) {
    const resolved = shaToCandidate.get(commit.sha)?.branch;
    if (resolved) {
      commit.branch = resolved;
    }
  }

  return commits;
}

/** Upper bound of files reported per commit (runaway guard for huge commits). */
const MAX_FILES_PER_COMMIT = 200;

/** Max shas per `git log --no-walk` invocation (Windows argv length safety). */
const FILE_STAT_SHA_CHUNK = 300;

/**
 * Collect per-commit changed-file stats (numstat) for a set of commits.
 *
 * Runs `git log --no-walk --numstat` in sha chunks so only the requested
 * commits are inspected — no history walk. Merge commits produce no
 * numstat output by default and end up with an empty file list, which is
 * intentional: content attribution has nothing to say about merges.
 *
 * Fail-safe: any git failure yields an empty map (commit file lists are
 * an enrichment, never a sync blocker).
 */
export async function collectCommitFileStats(
  cwd: string,
  shas: string[],
): Promise<Map<string, GitCommitFileStat[]>> {
  const result = new Map<string, GitCommitFileStat[]>();
  const unique = Array.from(new Set(shas.filter(Boolean)));

  for (let i = 0; i < unique.length; i += FILE_STAT_SHA_CHUNK) {
    const chunk = unique.slice(i, i + FILE_STAT_SHA_CHUNK);
    const gitResult = await runGit(
      ["log", "--no-walk=unsorted", "--numstat", "--format=%x00%H", ...chunk],
      { cwd, timeout: 60_000 },
    );
    if (gitResult.exitCode !== 0) continue;
    for (const [sha, files] of parseNumstatLog(gitResult.stdout)) {
      result.set(sha, files);
    }
  }

  return result;
}

/**
 * Parse `git log --numstat --format=%x00%H` output into per-commit file
 * stats. Each NUL-delimited record is the commit sha on the first line
 * followed by numstat lines ("adds<TAB>dels<TAB>path"). Binary files
 * report "-" for both counters and are kept with 0/0 — path presence is
 * the signal that matters for content matching.
 */
export function parseNumstatLog(stdout: string): Map<string, GitCommitFileStat[]> {
  const bySha = new Map<string, GitCommitFileStat[]>();

  for (const record of stdout.split("\0")) {
    const trimmed = record.trim();
    if (!trimmed) continue;

    const lines = trimmed.split("\n");
    const sha = lines[0]?.trim();
    if (!sha) continue;

    const files: GitCommitFileStat[] = [];
    for (const line of lines.slice(1)) {
      if (files.length >= MAX_FILES_PER_COMMIT) break;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const additions = parseNumstatCount(parts[0]);
      const deletions = parseNumstatCount(parts[1]);
      const path = resolveNumstatPath(parts.slice(2).join("\t"));
      if (!path) continue;
      files.push({ path, additions, deletions });
    }

    bySha.set(sha, files);
  }

  return bySha;
}

/** "-" (binary) parses to 0; anything non-numeric parses to 0. */
function parseNumstatCount(value: string | undefined): number {
  const parsed = parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Resolve a numstat path to the post-change path.
 *
 * Renames appear as "old => new" or with a shared prefix/suffix as
 * "dir/{old => new}/file" (either side may be empty). We keep the NEW
 * side, since attribution compares against diffs of the resulting tree.
 */
export function resolveNumstatPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  const braceRename = /\{(.*?) => (.*?)\}/;
  if (braceRename.test(trimmed)) {
    return trimmed
      .replace(braceRename, (_match, _from: string, to: string) => to)
      .replace(/\/{2,}/g, "/")
      .replace(/^\//, "");
  }

  const arrowIndex = trimmed.indexOf(" => ");
  if (arrowIndex >= 0) {
    const to = trimmed.slice(arrowIndex + 4).trim();
    return to || null;
  }

  return trimmed;
}

/** Count total commits reachable from all local/remote branch refs. */
export async function collectCommitCount(cwd: string): Promise<number> {
  const result = await runGit(["rev-list", "--count", "--branches", "--remotes"], { cwd });
  if (result.exitCode !== 0) return 0;
  return parseInt(result.stdout.trim(), 10) || 0;
}

/**
 * Extract a project name from a git remote URL.
 *
 * Examples:
 *   "https://github.com/user/my-repo.git" → "my-repo"
 *   "git@github.com:user/my-repo.git"     → "my-repo"
 *   "https://github.com/user/my-repo"     → "my-repo"
 */
export function projectNameFromRemoteUrl(url: string): string {
  // Strip trailing .git
  const cleaned = url.replace(/\.git$/, "");

  // Handle SSH: git@host:user/repo → take last segment
  if (cleaned.includes(":") && !cleaned.includes("://")) {
    const afterColon = cleaned.split(":").pop() ?? "";
    return afterColon.split("/").pop() ?? cleaned;
  }

  // Handle HTTPS: https://host/user/repo → take last path segment
  try {
    const parsed = new URL(cleaned);
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments.pop() ?? cleaned;
  } catch {
    // Fallback: just take the last path segment
    return cleaned.split("/").pop() ?? cleaned;
  }
}
