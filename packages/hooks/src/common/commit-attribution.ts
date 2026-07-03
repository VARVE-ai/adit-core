/**
 * Turn-boundary commit attribution.
 *
 * On session-start we record the current HEAD of every project repository
 * as a per-session baseline. On stop/session-end we compare the current
 * HEAD against that baseline: any new commits in between happened during
 * this session's turn and are recorded as git_commit events attributed to
 * the session, then the baseline advances.
 *
 * git_commit events store the commit's own sha in gitHeadSha (single
 * value, never comma-joined) so the cloud can resolve commit → sessions
 * with an indexed equality lookup instead of inferring from sha trails.
 */

import {
  getSessionRepoHeads,
  upsertSessionRepoHead,
  type LocalRepository,
} from "@varveai/adit-core";
import { runGit, getCurrentBranch, getHeadSha } from "@varveai/adit-engine";
import type { HookContext } from "./context.js";

/** Upper bound of commits attributed per repo per turn (runaway guard) */
const MAX_COMMITS_PER_TURN = 50;

interface TimelineRecorder {
  recordEvent(params: {
    sessionId: string;
    eventType: "git_commit";
    actor: "system";
    responseText?: string | null;
    toolInputJson?: string | null;
    gitBranch?: string | null;
    gitHeadSha?: string | null;
  }): Promise<unknown>;
}

interface RangeCommit {
  sha: string;
  parentShas: string[];
  authorName: string;
  authorEmail: string;
  committedAt: string;
  message: string;
}

/**
 * Initialize per-session HEAD baselines without emitting events.
 * Called on session-start so commits made during the very first turn
 * are detectable by the first stop hook.
 */
export async function initializeSessionRepoBaselines(ctx: HookContext): Promise<void> {
  try {
    const known = new Map(
      getSessionRepoHeads(ctx.db, ctx.session.id).map((h) => [h.relativePath, h.lastSha]),
    );
    for (const repo of ctx.config.repositories) {
      if (known.has(repo.relativePath)) continue;
      const head = await safeHead(repo.path);
      if (!head) continue;
      upsertSessionRepoHead(ctx.db, {
        sessionId: ctx.session.id,
        relativePath: repo.relativePath,
        lastSha: head,
      });
    }
  } catch {
    // Fail-open: attribution must never break a hook
  }
}

/**
 * Detect HEAD advancement since the session baseline and record one
 * git_commit event per new commit. Repos without a baseline (session
 * predates this feature, or repo added mid-session) get their baseline
 * seeded without emitting events.
 */
export async function detectAndRecordCommits(
  ctx: HookContext,
  timeline: TimelineRecorder,
): Promise<void> {
  try {
    const baselines = new Map(
      getSessionRepoHeads(ctx.db, ctx.session.id).map((h) => [h.relativePath, h.lastSha]),
    );

    for (const repo of ctx.config.repositories) {
      try {
        await detectForRepo(ctx, timeline, repo, baselines.get(repo.relativePath));
      } catch {
        // Fail-open per repo — one broken repo must not block the rest
      }
    }
  } catch {
    // Fail-open
  }
}

async function detectForRepo(
  ctx: HookContext,
  timeline: TimelineRecorder,
  repo: LocalRepository,
  baseline: string | undefined,
): Promise<void> {
  const head = await safeHead(repo.path);
  if (!head) return;

  if (!baseline) {
    // First sighting for this session/repo: seed only.
    upsertSessionRepoHead(ctx.db, {
      sessionId: ctx.session.id,
      relativePath: repo.relativePath,
      lastSha: head,
    });
    return;
  }

  if (baseline === head) return;

  const commits = await listRangeCommits(repo.path, baseline, head);
  const branch = await safeBranch(repo.path);

  for (const commit of commits) {
    await timeline.recordEvent({
      sessionId: ctx.session.id,
      eventType: "git_commit",
      actor: "system",
      responseText: firstLine(commit.message),
      gitBranch: branch,
      gitHeadSha: commit.sha,
      toolInputJson: JSON.stringify({
        commitSha: commit.sha,
        parentShas: commit.parentShas,
        branch,
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
        committedAt: commit.committedAt,
        message: commit.message,
        localRepositoryId: repo.localRepositoryId,
        relativePath: repo.relativePath,
      }),
    });
  }

  upsertSessionRepoHead(ctx.db, {
    sessionId: ctx.session.id,
    relativePath: repo.relativePath,
    lastSha: head,
  });
}

/**
 * List commits reachable from `to` but not from `from`, oldest first.
 * Works across amend/rebase (old baseline no longer an ancestor): git
 * still returns the commits unique to the new HEAD side.
 */
async function listRangeCommits(
  cwd: string,
  from: string,
  to: string,
): Promise<RangeCommit[]> {
  const result = await runGit(
    [
      "log",
      `--max-count=${MAX_COMMITS_PER_TURN}`,
      "--reverse",
      "--format=%H%x01%P%x01%an%x01%ae%x01%cI%x01%B%x00",
      `${from}..${to}`,
    ],
    { cwd },
  );
  if (result.exitCode !== 0) return [];

  const commits: RangeCommit[] = [];
  for (const chunk of result.stdout.split("\x00")) {
    const trimmed = chunk.replace(/^\n/, "");
    if (!trimmed.trim()) continue;
    const [sha, parents, authorName, authorEmail, committedAt, ...rest] =
      trimmed.split("\x01");
    if (!sha || rest.length === 0) continue;
    commits.push({
      sha: sha.trim(),
      parentShas: (parents ?? "").split(" ").map((p) => p.trim()).filter(Boolean),
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      committedAt: committedAt ?? "",
      message: rest.join("\x01").replace(/\n+$/, ""),
    });
  }
  return commits;
}

function firstLine(message: string): string {
  return message.split("\n", 1)[0]?.trim() ?? "";
}

async function safeHead(cwd: string): Promise<string | null> {
  try {
    return await getHeadSha(cwd);
  } catch {
    return null;
  }
}

async function safeBranch(cwd: string): Promise<string | null> {
  try {
    return await getCurrentBranch(cwd);
  } catch {
    return null;
  }
}
