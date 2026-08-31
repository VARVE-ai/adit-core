/**
 * Tests for git metadata collection utilities.
 *
 * Pure functions (projectNameFromRemoteUrl) are tested directly.
 * Git-dependent functions are tested with a temporary git repository.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  projectNameFromRemoteUrl,
  collectBranches,
  collectRemoteBranchSnapshot,
  branchHeadMap,
  collectGitRefsFingerprint,
  collectCommitsBetweenRefSnapshots,
  collectCurrentBranch,
  collectCommitLogs,
  collectCommitCount,
  collectCommitFileStats,
  collectDefaultBranch,
  collectGitIdentity,
  collectRemoteUrl,
  parseNumstatLog,
  resolveCommitBranches,
  resolveNumstatPath,
} from "./git-collector.js";

describe("projectNameFromRemoteUrl", () => {
  it("extracts name from HTTPS URL with .git suffix", () => {
    expect(projectNameFromRemoteUrl("https://github.com/user/my-repo.git")).toBe("my-repo");
  });

  it("extracts name from HTTPS URL without .git suffix", () => {
    expect(projectNameFromRemoteUrl("https://github.com/user/my-repo")).toBe("my-repo");
  });

  it("extracts name from SSH URL", () => {
    expect(projectNameFromRemoteUrl("git@github.com:user/my-repo.git")).toBe("my-repo");
  });

  it("extracts name from SSH URL without .git", () => {
    expect(projectNameFromRemoteUrl("git@github.com:user/my-repo")).toBe("my-repo");
  });

  it("handles nested paths", () => {
    expect(projectNameFromRemoteUrl("https://gitlab.com/org/sub/my-repo.git")).toBe("my-repo");
  });

  it("handles bare names", () => {
    expect(projectNameFromRemoteUrl("my-repo")).toBe("my-repo");
  });
});

describe("Git Collector (with temp repo)", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = join(tmpdir(), `adit-git-test-${randomBytes(8).toString("hex")}`);
    mkdirSync(repoDir, { recursive: true });

    // Initialize a git repo with a commit
    execSync("git init", { cwd: repoDir, stdio: "pipe" });
    execSync("git config user.email 'test@example.com'", { cwd: repoDir, stdio: "pipe" });
    execSync("git config user.name 'Test User'", { cwd: repoDir, stdio: "pipe" });
    // Set default branch name explicitly
    execSync("git checkout -b main", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "README.md"), "# Test\n");
    execSync("git add . && git commit -m 'Initial commit'", { cwd: repoDir, stdio: "pipe" });
  });

  afterEach(() => {
    try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("collectRemoteUrl throws when no remote exists", async () => {
    await expect(collectRemoteUrl(repoDir)).rejects.toThrow("No git remote 'origin'");
  });

  it("collectRemoteUrl returns URL when remote exists", async () => {
    execSync("git remote add origin https://github.com/test/repo.git", { cwd: repoDir, stdio: "pipe" });
    const url = await collectRemoteUrl(repoDir);
    expect(url).toBe("https://github.com/test/repo.git");
  });

  it("collectDefaultBranch detects main branch", async () => {
    const branch = await collectDefaultBranch(repoDir);
    expect(branch).toBe("main");
  });

  it("collectBranches lists branches with SHA", async () => {
    const branches = await collectBranches(repoDir);
    expect(branches.length).toBeGreaterThanOrEqual(1);
    const main = branches.find((b) => b.name === "main");
    expect(main).toBeDefined();
    expect(main!.headSha).toBeTruthy();
    expect(branchHeadMap(branches).main).toBe(main!.headSha);
  });

  it("fingerprints refs and collects only commits added after the previous heads", async () => {
    const beforeBranches = await collectBranches(repoDir);
    const beforeHeads = branchHeadMap(beforeBranches);
    const beforeFingerprint = await collectGitRefsFingerprint(repoDir);

    writeFileSync(join(repoDir, "incremental.txt"), "one\n");
    execSync("git add . && git commit -m 'Incremental one'", { cwd: repoDir, stdio: "pipe" });
    execSync("git checkout -b feature/incremental", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "feature.txt"), "feature\n");
    execSync("git add . && git commit -m 'Incremental feature'", { cwd: repoDir, stdio: "pipe" });

    const afterBranches = await collectBranches(repoDir);
    const afterHeads = branchHeadMap(afterBranches);
    const afterFingerprint = await collectGitRefsFingerprint(repoDir);
    const commits = await collectCommitsBetweenRefSnapshots(repoDir, afterHeads, beforeHeads);

    expect(afterFingerprint).not.toBe(beforeFingerprint);
    expect(commits.map((commit) => commit.message)).toEqual([
      "Incremental feature",
      "Incremental one",
    ]);
    expect(commits.some((commit) => commit.message === "Initial commit")).toBe(false);
  });

  it("collectBranches skips remote HEAD aliases", async () => {
    execSync("git remote add origin https://github.com/test/repo.git", { cwd: repoDir, stdio: "pipe" });
    execSync("git update-ref refs/remotes/origin/main HEAD", { cwd: repoDir, stdio: "pipe" });
    execSync("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
      cwd: repoDir,
      stdio: "pipe",
    });

    // No assertion on the raw `git branch -a` listing here: whether the
    // origin/HEAD symref shows up in it depends on the git version
    // (2.50 prints it, 2.39 does not). Either way collectBranches must
    // not surface it as a branch.
    const branches = await collectBranches(repoDir);
    expect(branches.some((branch) => branch.name === "origin")).toBe(false);
    expect(branches.filter((branch) => branch.name === "main")).toHaveLength(1);
  });

  it("collectRemoteBranchSnapshot ignores local and stale remote-tracking branches", async () => {
    const remoteDir = mkdtempSync(join(tmpdir(), "adit-remote-"));
    try {
      execSync("git init --bare", { cwd: remoteDir, stdio: "pipe" });
      execSync(`git remote add origin ${JSON.stringify(remoteDir)}`, {
        cwd: repoDir,
        stdio: "pipe",
      });
      execSync("git push -u origin main", { cwd: repoDir, stdio: "pipe" });
      execSync("git checkout -b feature/stale", { cwd: repoDir, stdio: "pipe" });
      writeFileSync(join(repoDir, "stale.txt"), "stale\n");
      execSync("git add . && git commit -m 'Stale feature'", { cwd: repoDir, stdio: "pipe" });
      execSync("git push -u origin feature/stale", { cwd: repoDir, stdio: "pipe" });
      execSync("git push origin --delete feature/stale", { cwd: repoDir, stdio: "pipe" });
      execSync("git update-ref refs/remotes/origin/feature/stale HEAD", {
        cwd: repoDir,
        stdio: "pipe",
      });

      const allBranches = await collectBranches(repoDir);
      const remoteSnapshot = await collectRemoteBranchSnapshot(repoDir);

      expect(allBranches.some((branch) => branch.name === "feature/stale")).toBe(true);
      expect(remoteSnapshot.branches.map((branch) => branch.name)).toEqual(["main"]);
      expect(remoteSnapshot.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  it("collectCommitLogs returns commits", async () => {
    // Add a second commit
    writeFileSync(join(repoDir, "file.txt"), "hello\n");
    execSync("git add . && git commit -m 'Add file'", { cwd: repoDir, stdio: "pipe" });

    const commits = await collectCommitLogs(repoDir);
    expect(commits.length).toBe(2);
    expect(commits[0].message).toBe("Add file");
    expect(commits[1].message).toBe("Initial commit");
    expect(commits[0].authorEmail).toBe("test@example.com");
    expect(commits[0].parentSha).toBe(commits[1].sha);
    expect(commits[1].parentSha).toBeNull();
  });

  it("collectCommitLogs uses the first parent for merge commits", async () => {
    const mainBaseSha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();

    execSync("git checkout -b feature/merge-parent", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "feature-parent.txt"), "feature\n");
    execSync("git add . && git commit -m 'Feature parent commit'", { cwd: repoDir, stdio: "pipe" });
    const featureSha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();

    execSync("git checkout main", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "main-parent.txt"), "main\n");
    execSync("git add . && git commit -m 'Main parent commit'", { cwd: repoDir, stdio: "pipe" });
    const mainSha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();

    expect(mainSha).not.toBe(mainBaseSha);
    execSync("git merge --no-ff feature/merge-parent -m 'Merge feature parent'", {
      cwd: repoDir,
      stdio: "pipe",
    });

    const commits = await collectCommitLogs(repoDir);
    const mergeCommit = commits.find((commit) => commit.message === "Merge feature parent");

    expect(mergeCommit).toBeDefined();
    expect(mergeCommit!.parentSha).toBe(mainSha);
    expect(mergeCommit!.parentSha).not.toBe(featureSha);
  });

  it("collectCommitLogs returns incremental commits since SHA", async () => {
    // Get the first commit SHA
    const firstSha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();

    // Add two more commits
    writeFileSync(join(repoDir, "a.txt"), "a\n");
    execSync("git add . && git commit -m 'Add a'", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "b.txt"), "b\n");
    execSync("git add . && git commit -m 'Add b'", { cwd: repoDir, stdio: "pipe" });

    const commits = await collectCommitLogs(repoDir, firstSha);
    expect(commits.length).toBe(2);
    expect(commits[0].message).toBe("Add b");
    expect(commits[1].message).toBe("Add a");
  });

  it("collectCommitLogs handles commit messages with pipe characters", async () => {
    writeFileSync(join(repoDir, "pipe.txt"), "content\n");
    execSync("git add . && git commit -m 'fix: handle a|b|c cases'", { cwd: repoDir, stdio: "pipe" });

    const commits = await collectCommitLogs(repoDir);
    const latest = commits[0];
    expect(latest.message).toBe("fix: handle a|b|c cases");
  });

  it("collectCommitLogs captures multi-line commit body", async () => {
    writeFileSync(join(repoDir, "body.txt"), "content\n");
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    // Use git commit with a multi-line message (subject + body)
    execSync(
      "git commit -m 'feat: add new feature' -m 'This is the body explaining the change.\n\nIt spans multiple lines with a blank line.'",
      { cwd: repoDir, stdio: "pipe" },
    );

    const commits = await collectCommitLogs(repoDir);
    const latest = commits[0];
    expect(latest.message).toContain("feat: add new feature");
    expect(latest.message).toContain("This is the body explaining the change.");
    expect(latest.message).toContain("It spans multiple lines");
  });

  it("collectCommitLogs handles commit body with pipe and special chars", async () => {
    writeFileSync(join(repoDir, "special.txt"), "content\n");
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync(
      "git commit -m 'fix: edge case' -m 'Handle input|output pipes and special chars: <>&'",
      { cwd: repoDir, stdio: "pipe" },
    );

    const commits = await collectCommitLogs(repoDir);
    const latest = commits[0];
    expect(latest.message).toContain("fix: edge case");
    expect(latest.message).toContain("input|output pipes");
  });

  it("collectCurrentBranch returns current branch name", async () => {
    const branch = await collectCurrentBranch(repoDir);
    expect(branch).toBe("main");
  });

  it("collectGitIdentity returns the effective repo git author identity", async () => {
    const identity = await collectGitIdentity(repoDir);

    expect(identity).toEqual({
      authorName: "Test User",
      authorEmail: "test@example.com",
    });
  });

  it("collectCurrentBranch returns branch after checkout", async () => {
    execSync("git checkout -b feature/test", { cwd: repoDir, stdio: "pipe" });
    const branch = await collectCurrentBranch(repoDir);
    expect(branch).toBe("feature/test");
  });

  it("collectCurrentBranch returns null in detached HEAD state", async () => {
    const sha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();
    execSync(`git checkout ${sha}`, { cwd: repoDir, stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const branch = await collectCurrentBranch(repoDir);
    expect(branch).toBeNull();
  });

  it("collectCommitLogs tags commits with branch when provided via options", async () => {
    writeFileSync(join(repoDir, "tagged.txt"), "content\n");
    execSync("git add . && git commit -m 'Tagged commit'", { cwd: repoDir, stdio: "pipe" });

    const commits = await collectCommitLogs(repoDir, { branch: "main" });
    expect(commits.length).toBe(2);
    expect(commits[0].branch).toBe("main");
    expect(commits[1].branch).toBe("main");
  });

  it("collectCommitLogs leaves branch undefined when not provided", async () => {
    const commits = await collectCommitLogs(repoDir);
    expect(commits[0].branch).toBeUndefined();
  });

  it("collectCommitLogs works with options object and sinceCommitSha", async () => {
    const firstSha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();

    writeFileSync(join(repoDir, "opt.txt"), "options\n");
    execSync("git add . && git commit -m 'Options commit'", { cwd: repoDir, stdio: "pipe" });

    const commits = await collectCommitLogs(repoDir, {
      sinceCommitSha: firstSha,
      branch: "feature/x",
    });
    expect(commits.length).toBe(1);
    expect(commits[0].message).toBe("Options commit");
    expect(commits[0].branch).toBe("feature/x");
  });

  it("collectCommitLogs still accepts legacy string argument for backward compat", async () => {
    const firstSha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();

    writeFileSync(join(repoDir, "compat.txt"), "compat\n");
    execSync("git add . && git commit -m 'Compat commit'", { cwd: repoDir, stdio: "pipe" });

    const commits = await collectCommitLogs(repoDir, firstSha);
    expect(commits.length).toBe(1);
    expect(commits[0].message).toBe("Compat commit");
    expect(commits[0].branch).toBeUndefined();
  });

  it("collectCommitLogs can include commits from branches outside current HEAD", async () => {
    execSync("git checkout -b plan/day-25", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "day-25.txt"), "plan\n");
    execSync("git add . && git commit -m 'Day 25 plan'", { cwd: repoDir, stdio: "pipe" });

    execSync("git checkout main", { cwd: repoDir, stdio: "pipe" });

    const headCommits = await collectCommitLogs(repoDir);
    expect(headCommits.some((commit) => commit.message === "Day 25 plan")).toBe(false);

    const allCommits = await collectCommitLogs(repoDir, { allRefs: true });
    expect(allCommits.some((commit) => commit.message === "Day 25 plan")).toBe(true);
  });

  it("collectCommitLogs excludes ADIT checkpoint refs from allRefs collection", async () => {
    const headSha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();
    const treeSha = execSync("git write-tree", { cwd: repoDir, encoding: "utf-8" }).trim();
    const checkpointSha = execSync(
      `git commit-tree ${treeSha} -p ${headSha} -m '[adit] assistant response (completed)'`,
      { cwd: repoDir, encoding: "utf-8" },
    ).trim();
    execSync(`git update-ref refs/adit/checkpoints/01TEST ${checkpointSha}`, {
      cwd: repoDir,
      stdio: "pipe",
    });

    const commits = await collectCommitLogs(repoDir, { allRefs: true });

    expect(commits.some((commit) => commit.sha === checkpointSha)).toBe(false);
    expect(commits.some((commit) => commit.message === "[adit] assistant response (completed)")).toBe(false);
  });

  it("collectCommitCount returns total count", async () => {
    const count = await collectCommitCount(repoDir);
    expect(count).toBe(1);

    writeFileSync(join(repoDir, "x.txt"), "x\n");
    execSync("git add . && git commit -m 'Second'", { cwd: repoDir, stdio: "pipe" });

    const count2 = await collectCommitCount(repoDir);
    expect(count2).toBe(2);
  });

  it("collectCommitCount includes commits reachable only from other branches", async () => {
    execSync("git checkout -b plan/day-25", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "branch-only.txt"), "branch\n");
    execSync("git add . && git commit -m 'Branch only commit'", { cwd: repoDir, stdio: "pipe" });

    execSync("git checkout main", { cwd: repoDir, stdio: "pipe" });

    const headCount = Number(execSync("git rev-list --count HEAD", { cwd: repoDir, encoding: "utf-8" }).trim());
    const allCount = await collectCommitCount(repoDir);

    expect(headCount).toBe(1);
    expect(allCount).toBe(2);
  });

  it("collectCommitCount excludes commits only reachable from ADIT checkpoint refs", async () => {
    const headSha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();
    const treeSha = execSync("git write-tree", { cwd: repoDir, encoding: "utf-8" }).trim();
    const checkpointSha = execSync(
      `git commit-tree ${treeSha} -p ${headSha} -m '[adit] assistant response (completed)'`,
      { cwd: repoDir, encoding: "utf-8" },
    ).trim();
    execSync(`git update-ref refs/adit/checkpoints/01TEST ${checkpointSha}`, {
      cwd: repoDir,
      stdio: "pipe",
    });

    const count = await collectCommitCount(repoDir);
    const allRefCount = Number(
      execSync("git rev-list --count --all", { cwd: repoDir, encoding: "utf-8" }).trim(),
    );

    expect(count).toBe(1);
    expect(allRefCount).toBe(2);
  });

  it("resolveCommitBranches assigns correct branch per commit", async () => {
    // Create a feature branch with its own commit
    execSync("git checkout -b feature/x", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "feature.txt"), "feature\n");
    execSync("git add . && git commit -m 'Feature commit'", { cwd: repoDir, stdio: "pipe" });

    // Switch back to main and add another commit
    execSync("git checkout main", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "main.txt"), "main\n");
    execSync("git add . && git commit -m 'Main commit'", { cwd: repoDir, stdio: "pipe" });

    // Collect all commits from main (2: "Main commit" + "Initial commit")
    const mainCommits = await collectCommitLogs(repoDir);
    expect(mainCommits.length).toBe(2);

    // Collect branches
    const branches = await collectBranches(repoDir);

    // Resolve branches
    await resolveCommitBranches(repoDir, mainCommits, branches, "main");

    // "Main commit" should be on main (only reachable from main)
    const mainCommit = mainCommits.find((c) => c.message === "Main commit");
    expect(mainCommit).toBeDefined();
    expect(mainCommit!.branch).toBe("main");

    // "Initial commit" is reachable from both branches; feature/x should
    // win because non-default branches are processed first
    const initialCommit = mainCommits.find((c) => c.message === "Initial commit");
    expect(initialCommit).toBeDefined();
    expect(initialCommit!.branch).toBe("feature/x");
  });

  it("resolveCommitBranches attributes feature branch commits correctly", async () => {
    // Create two feature branches with distinct commits
    execSync("git checkout -b feature/a", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "a.txt"), "a\n");
    execSync("git add . && git commit -m 'Commit on A'", { cwd: repoDir, stdio: "pipe" });

    execSync("git checkout main", { cwd: repoDir, stdio: "pipe" });
    execSync("git checkout -b feature/b", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "b.txt"), "b\n");
    execSync("git add . && git commit -m 'Commit on B'", { cwd: repoDir, stdio: "pipe" });

    // Collect commits from feature/b (sees "Commit on B" + "Initial commit")
    const commits = await collectCommitLogs(repoDir);
    const branches = await collectBranches(repoDir);

    await resolveCommitBranches(repoDir, commits, branches, "main");

    const commitB = commits.find((c) => c.message === "Commit on B");
    expect(commitB).toBeDefined();
    expect(commitB!.branch).toBe("feature/b");
  });

  it("resolveCommitBranches prefers the nearest branch head for shared commits", async () => {
    execSync("git checkout -b plan/day-25", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "day-25.txt"), "plan\n");
    execSync("git add . && git commit -m 'Day 25 plan'", { cwd: repoDir, stdio: "pipe" });

    execSync("git checkout -b feature/add-agents-md", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "agents.md"), "agents\n");
    execSync("git add . && git commit -m 'Add agents doc'", { cwd: repoDir, stdio: "pipe" });

    const commits = await collectCommitLogs(repoDir, { allRefs: true });
    const branches = await collectBranches(repoDir);

    await resolveCommitBranches(repoDir, commits, branches, "main");

    const day25Commit = commits.find((c) => c.message === "Day 25 plan");
    expect(day25Commit).toBeDefined();
    expect(day25Commit!.branch).toBe("plan/day-25");

    const agentsCommit = commits.find((c) => c.message === "Add agents doc");
    expect(agentsCommit).toBeDefined();
    expect(agentsCommit!.branch).toBe("feature/add-agents-md");
  });

  it("resolveCommitBranches handles empty commits array", async () => {
    const branches = await collectBranches(repoDir);
    const result = await resolveCommitBranches(repoDir, [], branches, "main");
    expect(result).toEqual([]);
  });

  it("resolveCommitBranches handles empty branches array", async () => {
    const commits = await collectCommitLogs(repoDir);
    await resolveCommitBranches(repoDir, commits, [], "main");
    // All commits should have no branch assigned
    for (const c of commits) {
      expect(c.branch).toBeUndefined();
    }
  });
});

describe("resolveNumstatPath", () => {
  it("keeps plain paths", () => {
    expect(resolveNumstatPath("src/lib/db.ts")).toBe("src/lib/db.ts");
  });

  it("resolves brace renames to the new side", () => {
    expect(resolveNumstatPath("src/{old => new}/file.ts")).toBe("src/new/file.ts");
  });

  it("resolves brace renames with an empty side", () => {
    expect(resolveNumstatPath("src/{ => nested}/file.ts")).toBe("src/nested/file.ts");
  });

  it("resolves bare arrow renames to the new side", () => {
    expect(resolveNumstatPath("old-name.ts => new-name.ts")).toBe("new-name.ts");
  });

  it("returns null for empty input", () => {
    expect(resolveNumstatPath("  ")).toBeNull();
  });
});

describe("parseNumstatLog", () => {
  it("parses multi-commit numstat output with binary entries", () => {
    const stdout = [
      "\0abc123",
      "10\t2\tsrc/a.ts",
      "-\t-\tassets/logo.png",
      "\0def456",
      "0\t5\tREADME.md",
      "",
    ].join("\n");

    const parsed = parseNumstatLog(stdout);
    expect(parsed.get("abc123")).toEqual([
      { path: "src/a.ts", additions: 10, deletions: 2 },
      { path: "assets/logo.png", additions: 0, deletions: 0 },
    ]);
    expect(parsed.get("def456")).toEqual([
      { path: "README.md", additions: 0, deletions: 5 },
    ]);
  });

  it("keeps commits without numstat lines (merges) with empty file lists", () => {
    const parsed = parseNumstatLog("\0abc123\n\0def456\n1\t1\tx.ts\n");
    expect(parsed.get("abc123")).toEqual([]);
    expect(parsed.get("def456")).toEqual([{ path: "x.ts", additions: 1, deletions: 1 }]);
  });
});

describe("collectCommitFileStats (with temp repo)", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = join(tmpdir(), `adit-git-filestat-${randomBytes(8).toString("hex")}`);
    mkdirSync(repoDir, { recursive: true });
    execSync("git init", { cwd: repoDir, stdio: "pipe" });
    execSync("git config user.email 'test@example.com'", { cwd: repoDir, stdio: "pipe" });
    execSync("git config user.name 'Test User'", { cwd: repoDir, stdio: "pipe" });
    execSync("git checkout -b main", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "README.md"), "# Test\n");
    execSync("git add . && git commit -m 'Initial commit'", { cwd: repoDir, stdio: "pipe" });
  });

  afterEach(() => {
    try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("collects per-commit changed files for the requested shas only", async () => {
    writeFileSync(join(repoDir, "a.ts"), "const a = 1;\nconst b = 2;\n");
    execSync("git add . && git commit -m 'add a'", { cwd: repoDir, stdio: "pipe" });
    const firstSha = execSync("git rev-parse HEAD", { cwd: repoDir }).toString().trim();

    writeFileSync(join(repoDir, "b.ts"), "export {};\n");
    execSync("git add . && git commit -m 'add b'", { cwd: repoDir, stdio: "pipe" });
    const secondSha = execSync("git rev-parse HEAD", { cwd: repoDir }).toString().trim();

    const stats = await collectCommitFileStats(repoDir, [firstSha, secondSha]);
    expect(stats.get(firstSha)).toEqual([
      { path: "a.ts", additions: 2, deletions: 0 },
    ]);
    expect(stats.get(secondSha)).toEqual([
      { path: "b.ts", additions: 1, deletions: 0 },
    ]);
  });

  it("resolves renames to the new path", async () => {
    writeFileSync(join(repoDir, "old.ts"), "export const x = 1;\n");
    execSync("git add . && git commit -m 'add old'", { cwd: repoDir, stdio: "pipe" });
    execSync("git mv old.ts new.ts && git commit -m 'rename'", { cwd: repoDir, stdio: "pipe" });
    const renameSha = execSync("git rev-parse HEAD", { cwd: repoDir }).toString().trim();

    const stats = await collectCommitFileStats(repoDir, [renameSha]);
    expect(stats.get(renameSha)).toEqual([
      { path: "new.ts", additions: 0, deletions: 0 },
    ]);
  });

  it("returns an empty map for unknown shas", async () => {
    const stats = await collectCommitFileStats(repoDir, ["0000000000000000000000000000000000000000"]);
    expect(stats.size).toBe(0);
  });
});
