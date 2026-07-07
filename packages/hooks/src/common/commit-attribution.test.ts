/**
 * Integration tests for turn-boundary commit attribution.
 *
 * Uses a real temporary git repository and a real SQLite database —
 * the detection logic is git- and schema-shaped, so mocks would test
 * nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase,
  insertSession,
  getSessionRepoHeads,
  type LocalRepository,
} from "@varveai/adit-core";
import type Database from "better-sqlite3";
import {
  detectAndRecordCommits,
  initializeSessionRepoBaselines,
} from "./commit-attribution.js";
import type { HookContext } from "./context.js";

const SESSION_ID = "01TESTSESSION0000000000000";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function commitFile(cwd: string, name: string, message: string): string {
  writeFileSync(join(cwd, name), `${message}\n`);
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

describe("commit attribution", () => {
  let dir: string;
  let repoDir: string;
  let db: Database.Database;
  let ctx: HookContext;
  let recorded: Array<Record<string, unknown>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adit-attr-"));
    repoDir = join(dir, "repo");
    execFileSync("git", ["init", "-b", "main", repoDir]);
    git(repoDir, "config", "user.email", "test@adit.dev");
    git(repoDir, "config", "user.name", "Adit Test");
    commitFile(repoDir, "seed.txt", "seed commit");

    db = openDatabase(join(dir, "adit.db"));
    insertSession(db, {
      id: SESSION_ID,
      projectId: "proj-1",
      clientId: "client-1",
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: new Date().toISOString(),
      metadataJson: null,
      vclockJson: "{}",
    });

    const repository: LocalRepository = {
      localRepositoryId: "repo-1",
      relativePath: ".",
      displayName: "repo",
      repositoryUrl: null,
      canonicalRepoKey: null,
      path: repoDir,
    };

    recorded = [];
    ctx = {
      db,
      session: { id: SESSION_ID } as HookContext["session"],
      config: {
        projectRoot: repoDir,
        dataDir: join(dir, ".adit"),
        dbPath: join(dir, "adit.db"),
        clientId: "client-1",
        projectId: "proj-1",
        projectType: "repo",
        repositories: [repository],
        refPrefix: "refs/adit",
        captureEnv: false,
      },
    } as HookContext;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const timeline = () => ({
    recordEvent: async (params: Record<string, unknown>) => {
      recorded.push(params);
      return params;
    },
  });

  it("seeds baselines on init without emitting events", async () => {
    await initializeSessionRepoBaselines(ctx);

    const heads = getSessionRepoHeads(db, SESSION_ID);
    expect(heads).toHaveLength(1);
    expect(heads[0].lastSha).toBe(git(repoDir, "rev-parse", "HEAD"));
    expect(recorded).toHaveLength(0);
  });

  it("records one git_commit event per new commit, oldest first", async () => {
    await initializeSessionRepoBaselines(ctx);
    const shaA = commitFile(repoDir, "a.txt", "feat: first");
    const shaB = commitFile(repoDir, "b.txt", "feat: second");

    await detectAndRecordCommits(ctx, timeline());

    expect(recorded).toHaveLength(2);
    expect(recorded[0].eventType).toBe("git_commit");
    expect(recorded[0].gitHeadSha).toBe(shaA);
    expect(recorded[1].gitHeadSha).toBe(shaB);
    expect(recorded[0].gitBranch).toBe("main");
    expect(recorded[0].responseText).toBe("feat: first");

    const payload = JSON.parse(recorded[0].toolInputJson as string);
    expect(payload.commitSha).toBe(shaA);
    expect(payload.parentShas).toHaveLength(1);
    expect(payload.relativePath).toBe(".");
    expect(payload.localRepositoryId).toBe("repo-1");
    expect(payload.authorEmail).toBe("test@adit.dev");

    // Baseline advanced: re-running detects nothing new.
    recorded.length = 0;
    await detectAndRecordCommits(ctx, timeline());
    expect(recorded).toHaveLength(0);
  });

  it("detects commits on a switched branch with correct branch name", async () => {
    await initializeSessionRepoBaselines(ctx);
    git(repoDir, "checkout", "-b", "feature/x");
    const sha = commitFile(repoDir, "c.txt", "feat: on branch");

    await detectAndRecordCommits(ctx, timeline());

    expect(recorded).toHaveLength(1);
    expect(recorded[0].gitHeadSha).toBe(sha);
    expect(recorded[0].gitBranch).toBe("feature/x");
  });

  it("seeds baseline without events when session predates the feature", async () => {
    // No init call — simulates an in-flight session from before this feature.
    commitFile(repoDir, "d.txt", "feat: unseen");

    await detectAndRecordCommits(ctx, timeline());

    expect(recorded).toHaveLength(0);
    expect(getSessionRepoHeads(db, SESSION_ID)).toHaveLength(1);
  });

  it("attributes amended commits via the rewritten sha", async () => {
    await initializeSessionRepoBaselines(ctx);
    commitFile(repoDir, "e.txt", "feat: original");
    await detectAndRecordCommits(ctx, timeline());
    recorded.length = 0;

    git(repoDir, "commit", "--amend", "-m", "feat: amended");
    await detectAndRecordCommits(ctx, timeline());

    expect(recorded).toHaveLength(1);
    expect(recorded[0].responseText).toBe("feat: amended");
    expect(recorded[0].gitHeadSha).toBe(git(repoDir, "rev-parse", "HEAD"));
  });

  it("fails open when the repo path is not a git repository", async () => {
    ctx.config.repositories = [
      { ...ctx.config.repositories[0], path: join(dir, "nope"), relativePath: "nope" },
    ];

    await initializeSessionRepoBaselines(ctx);
    await detectAndRecordCommits(ctx, timeline());

    expect(recorded).toHaveLength(0);
    expect(getSessionRepoHeads(db, SESSION_ID)).toHaveLength(0);
  });

  // ── HEAD movement that must NOT attribute (pull/checkout/etc.) ───────────

  /** Clone the seeded repo as a "remote" and add commits the local doesn't have. */
  function makeRemoteAhead(commitCount: number): { remoteDir: string; shas: string[] } {
    const remoteDir = join(dir, "remote-src");
    execFileSync("git", ["clone", "-q", repoDir, remoteDir]);
    git(remoteDir, "config", "user.email", "remote@adit.dev");
    git(remoteDir, "config", "user.name", "Remote");
    const shas: string[] = [];
    for (let i = 1; i <= commitCount; i++) {
      shas.push(commitFile(remoteDir, `remote-${i}.txt`, `remote commit ${i}`));
    }
    git(repoDir, "remote", "add", "origin", remoteDir);
    git(repoDir, "fetch", "-q", "origin");
    return { remoteDir, shas };
  }

  it("does not attribute remote history from a fast-forward pull", async () => {
    await initializeSessionRepoBaselines(ctx);
    makeRemoteAhead(2);

    git(repoDir, "pull", "-q", "origin", "main");
    await detectAndRecordCommits(ctx, timeline());

    expect(recorded).toHaveLength(0);
    // Baseline still advances so the same remote commits are never re-scanned.
    expect(getSessionRepoHeads(db, SESSION_ID)[0].lastSha).toBe(
      git(repoDir, "rev-parse", "HEAD"),
    );
  });

  it("does not attribute commits reached by checking out a remote branch", async () => {
    await initializeSessionRepoBaselines(ctx);
    const { remoteDir } = makeRemoteAhead(0);
    git(remoteDir, "checkout", "-qb", "feature/r");
    commitFile(remoteDir, "r1.txt", "remote feature 1");
    commitFile(remoteDir, "r2.txt", "remote feature 2");
    git(repoDir, "fetch", "-q", "origin");

    git(repoDir, "checkout", "-qb", "feature/r", "origin/feature/r");
    await detectAndRecordCommits(ctx, timeline());

    expect(recorded).toHaveLength(0);
    expect(getSessionRepoHeads(db, SESSION_ID)[0].lastSha).toBe(
      git(repoDir, "rev-parse", "HEAD"),
    );
  });

  it("attributes only the local commits in a mixed pull-plus-commit turn", async () => {
    await initializeSessionRepoBaselines(ctx);
    const { shas: remoteShas } = makeRemoteAhead(2);

    git(repoDir, "pull", "-q", "origin", "main");
    const local1 = commitFile(repoDir, "l1.txt", "feat: local one");
    const local2 = commitFile(repoDir, "l2.txt", "feat: local two");
    await detectAndRecordCommits(ctx, timeline());

    expect(recorded.map((r) => r.gitHeadSha)).toEqual([local1, local2]);
    for (const remoteSha of remoteShas) {
      expect(recorded.map((r) => r.gitHeadSha)).not.toContain(remoteSha);
    }
  });

  it("attributes only the merge commit for a no-ff merge, not the merged history", async () => {
    await initializeSessionRepoBaselines(ctx);
    makeRemoteAhead(2);

    git(repoDir, "merge", "-q", "--no-ff", "origin/main", "-m", "merge remote work");
    await detectAndRecordCommits(ctx, timeline());

    expect(recorded).toHaveLength(1);
    expect(recorded[0].gitHeadSha).toBe(git(repoDir, "rev-parse", "HEAD"));
    expect(recorded[0].responseText).toBe("merge remote work");
  });

  it("attributes the merge commit of a diverged pull --no-rebase, not the pulled history", async () => {
    await initializeSessionRepoBaselines(ctx);
    const { shas: remoteShas } = makeRemoteAhead(2);
    // Local commit on top of the baseline so the pull cannot fast-forward.
    const localSha = commitFile(repoDir, "diverge.txt", "feat: local diverging work");

    git(repoDir, "pull", "-q", "--no-rebase", "origin", "main", "--no-edit");
    const mergeSha = git(repoDir, "rev-parse", "HEAD");
    await detectAndRecordCommits(ctx, timeline());

    // Exactly the two locally created commits: the diverging commit and the
    // merge commit produced by the pull ("pull ...: Merge made by ...").
    const shas = recorded.map((r) => r.gitHeadSha);
    expect(shas).toEqual([localSha, mergeSha]);
    for (const remoteSha of remoteShas) {
      expect(shas).not.toContain(remoteSha);
    }
  });

  it("attributes only the rewritten local commit after pull --rebase", async () => {
    await initializeSessionRepoBaselines(ctx);
    const { shas: remoteShas } = makeRemoteAhead(2);
    const localBefore = commitFile(repoDir, "mine.txt", "feat: my local work");

    git(repoDir, "pull", "-q", "--rebase", "origin", "main");
    await detectAndRecordCommits(ctx, timeline());

    const rewritten = git(repoDir, "rev-parse", "HEAD");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].gitHeadSha).toBe(rewritten);
    expect(rewritten).not.toBe(localBefore);
    for (const remoteSha of remoteShas) {
      expect(recorded.map((r) => r.gitHeadSha)).not.toContain(remoteSha);
    }
  });

  it("does not attribute commits discarded by reset before the turn ended", async () => {
    await initializeSessionRepoBaselines(ctx);
    const kept = commitFile(repoDir, "k.txt", "feat: kept");
    commitFile(repoDir, "d.txt", "feat: discarded");
    git(repoDir, "reset", "-q", "--hard", kept);

    await detectAndRecordCommits(ctx, timeline());

    expect(recorded.map((r) => r.gitHeadSha)).toEqual([kept]);
  });

  it("attributes the conflict-resolution merge commit (commit (merge) action)", async () => {
    await initializeSessionRepoBaselines(ctx);
    git(repoDir, "checkout", "-qb", "side");
    const sideSha = commitFile(repoDir, "seed.txt", "side change");
    git(repoDir, "checkout", "-q", "main");
    const mainSha = commitFile(repoDir, "seed.txt", "main change");

    let conflicted = false;
    try {
      git(repoDir, "merge", "side");
    } catch {
      conflicted = true; // expected: both sides edited seed.txt
    }
    expect(conflicted).toBe(true);
    writeFileSync(join(repoDir, "seed.txt"), "resolved\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "--no-edit");
    const mergeSha = git(repoDir, "rev-parse", "HEAD");

    await detectAndRecordCommits(ctx, timeline());

    // All three were created locally this turn: both branch commits and the
    // conflict-resolution merge commit (reflog action "commit (merge)").
    const shas = recorded.map((r) => r.gitHeadSha);
    expect(shas).toHaveLength(3);
    expect(shas).toContain(sideSha);
    expect(shas).toContain(mainSha);
    expect(shas).toContain(mergeSha);
  });

  it("stays silent but advances the baseline when the reflog is unavailable", async () => {
    await initializeSessionRepoBaselines(ctx);
    const sha = commitFile(repoDir, "n.txt", "feat: no reflog");
    rmSync(join(repoDir, ".git", "logs"), { recursive: true, force: true });

    await detectAndRecordCommits(ctx, timeline());

    expect(recorded).toHaveLength(0);
    expect(getSessionRepoHeads(db, SESSION_ID)[0].lastSha).toBe(sha);
  });
});
