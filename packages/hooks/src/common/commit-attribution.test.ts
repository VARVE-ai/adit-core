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
});
