/**
 * Turn-boundary commit attribution.
 *
 * On session-start we record the current HEAD of every project repository
 * as a per-session baseline. On stop we compare the current
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
  hasGitCommitEvent,
  upsertSessionRepoHead,
  type LocalRepository,
} from "@varveai/adit-core";
import { runGit, getCurrentBranch, getHeadSha } from "@varveai/adit-engine";
import type { HookContext } from "./context.js";

/** Upper bound of commits attributed per repo per turn (runaway guard) */
const MAX_COMMITS_PER_TURN = 50;

/** How many HEAD reflog entries to scan when locating the turn window */
const REFLOG_SCAN_LIMIT = 200;

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

  // Action layer: shas produced by local commit-creating actions this turn.
  // HEAD also advances on pull/checkout/fetch/reset — those move through
  // remote history that this session did NOT create and must never be
  // attributed (recorded attribution is displayed as fact).
  const createdShas = await listLocallyCreatedShas(repo.path, ctx.session.startedAt);
  if (createdShas.size === 0) {
    // Pure pull/checkout/etc: silently accept the new HEAD as the
    // observation point so the same remote commits are never re-scanned.
    upsertSessionRepoHead(ctx.db, {
      sessionId: ctx.session.id,
      relativePath: repo.relativePath,
      lastSha: head,
    });
    return;
  }

  // Result layer: commits still reachable from HEAD and not in the baseline
  // history. Intersecting drops created-then-discarded shas (commit + reset)
  // and guards the reflog window when the baseline entry cannot be found.
  // Dedupe against events already written by this session: a pure checkout
  // legally moves the baseline backward (feature tip → main tip), so a later
  // turn's baseline..HEAD can contain commits attributed in earlier turns
  // while their reflog entries are still inside the scan window.
  const rangeCommits = await listRangeCommits(repo.path, baseline, head);
  const commits = rangeCommits.filter(
    (commit) =>
      createdShas.has(commit.sha) &&
      !hasGitCommitEvent(ctx.db, ctx.session.id, commit.sha),
  );
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
 * Collect shas produced by local commit-creating actions during this
 * session, from the recent HEAD reflog window.
 *
 * Entries older than the session start are dropped: a fresh session whose
 * baseline..HEAD range happens to contain commits created by an EARLIER
 * session (checkout onto a branch the previous session committed to) must
 * not claim them — it merely moved through that history. Reflog timestamps
 * are second-precision; entries within the session's starting second are
 * kept, a sub-second window that cannot precede a real agent turn.
 *
 * The whole window is scanned deliberately — no early stop at the baseline
 * entry. The baseline sha can reappear mid-turn (checkout back to the
 * branch tip, reset to baseline) and would truncate the window; turn
 * correctness comes from the caller intersecting with rev-list
 * baseline..HEAD plus the per-session dedupe against already-written
 * git_commit events.
 *
 * When the reflog is unavailable (core.logAllRefUpdates=false) this returns
 * an empty set: better to miss an attribution (cloud-side inference still
 * provides a weak match) than to record history as fact.
 */
async function listLocallyCreatedShas(
  cwd: string,
  sessionStartedAt: string,
): Promise<Set<string>> {
  const result = await runGit(
    ["reflog", "--date=unix", "--format=%H%x01%gd%x01%gs", `--max-count=${REFLOG_SCAN_LIMIT}`],
    { cwd },
  );
  if (result.exitCode !== 0) return new Set();

  const startedAtSec = Math.floor(Date.parse(sessionStartedAt) / 1000);
  const created = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    const [sha, selector, action] = line.split("\x01");
    if (!sha || !selector || !action) continue;
    const entrySec = parseReflogEpoch(selector);
    if (entrySec !== null && Number.isFinite(startedAtSec) && entrySec < startedAtSec) {
      continue; // created before this session existed
    }
    if (isCreationAction(action)) created.add(sha.trim());
  }
  return created;
}

/** Parse the epoch out of a --date=unix reflog selector like "HEAD@{1720255140}". */
function parseReflogEpoch(selector: string): number | null {
  const match = selector.match(/@\{(\d+)\}/u);
  return match ? Number(match[1]) : null;
}

/** Rebase step markers that rewrite/create commits; start/finish/abort move HEAD only. */
const REBASE_CREATION_STEP = /\((pick|squash|fixup|edit|reword|continue)\):/u;
const REBASE_MOTION_STEP = /\((start|finish|abort)\):/u;

/**
 * Reflog actions that create commits locally. Everything else — checkout,
 * reset, clone, fetch, fast-forward pull/merge — moves HEAD without
 * creating anything and must not attribute.
 *
 * Notes pinned by real-repo probing:
 * - Action prefixes are NOT fixed verbs: pull records its full command line
 *   ("pull -q --rebase origin main (pick): ...", "pull -q --no-rebase origin
 *   main: Merge made by ..."), so rebase steps are matched by their
 *   "(step):" marker and merges by their result phrase — never by prefix.
 * - "(start)" points at the UPSTREAM TIP — during `pull --rebase` that is a
 *   remote commit inside baseline..HEAD, so motion steps stay excluded.
 * - Merge commits (from `git merge` or a merge-type pull) always end with
 *   the fixed phrase ": Merge made by the '<strategy>' strategy." (reflog
 *   messages are not localized). Fast-forwards say ": Fast-forward" and
 *   create nothing.
 * - Conflict-resolution merges land as "commit (merge): ...".
 */
function isCreationAction(action: string): boolean {
  if (action.startsWith("commit")) return true; // commit: / (amend) / (initial) / (merge)
  if (action.startsWith("cherry-pick:")) return true;
  if (action.startsWith("revert:")) return true;
  if (REBASE_MOTION_STEP.test(action)) return false;
  if (REBASE_CREATION_STEP.test(action)) return true;
  if (action.includes(": Merge made by ")) return true;
  return false;
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
