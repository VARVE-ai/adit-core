/**
 * Tests for Bash working-tree snapshots.
 *
 * The capture/diff tests run against a real temporary git repository so the
 * temp-index trick (never touching the user's staging area) is exercised
 * for real, not mocked.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendPendingInferred,
  captureWorkingTree,
  clearSessionSnapshots,
  diffWorkingTrees,
  diffWorkingTreesWithPatch,
  mergeInferredFiles,
  parseNameStatusZ,
  parsePatchBodies,
  pendingToMutations,
  snapshotSessionDir,
  takePendingInferred,
  takeToolSnapshot,
  toProjectRelativeChanges,
  writeToolSnapshot,
  type PendingInferredEntry,
} from "./index.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "adit-bash-snapshot-"));
  git(dir, "init", "-q");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  writeFileSync(join(dir, ".gitignore"), "ignored/\n.adit/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("captureWorkingTree + diffWorkingTrees (real git)", () => {
  let repo: string;

  beforeEach(() => {
    repo = initRepo();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("lists files a shell-style edit changed, including untracked, deleted and renamed ones", async () => {
    const before = await captureWorkingTree(repo);
    expect(before).not.toBeNull();

    // Simulate what a Bash call would do: rewrite, create, delete, rename,
    // and drop something into an ignored directory.
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
    writeFileSync(join(repo, "src", "new.ts"), "export const n = 1;\n");
    unlinkSync(join(repo, "README.md"));
    renameSync(join(repo, "src", "b.ts"), join(repo, "src", "b-renamed.ts"));
    mkdirSync(join(repo, "ignored"), { recursive: true });
    writeFileSync(join(repo, "ignored", "junk.txt"), "x\n");

    const after = await captureWorkingTree(repo);
    expect(after).not.toBeNull();
    expect(after!.tree).not.toBe(before!.tree);
    expect(after!.head).toBe(before!.head);

    const changes = await diffWorkingTrees(repo, before!.tree, after!.tree);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
    expect(byPath["src/a.ts"]?.status).toBe("M");
    expect(byPath["src/new.ts"]?.status).toBe("A");
    expect(byPath["README.md"]?.status).toBe("D");
    expect(byPath["src/b-renamed.ts"]).toEqual({ path: "src/b-renamed.ts", status: "R", oldPath: "src/b.ts" });
    expect(byPath["ignored/junk.txt"]).toBeUndefined();
  });

  it("detects a same-size rewrite made in the same second the index recorded the file", async () => {
    // Reproduce git's racy-clean window: commit (index records a.ts stat),
    // then overwrite a.ts with same-size content before the second ticks
    // over. With a stale stat cache and a fresh index timestamp git would
    // trust the cache and report the file unchanged.
    let raced = false;
    for (let attempt = 0; attempt < 25 && !raced; attempt++) {
      writeFileSync(join(repo, "src", "a.ts"), `export const a = ${attempt % 10};\n`);
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "--allow-empty", "-m", `attempt ${attempt}`);
      writeFileSync(join(repo, "src", "a.ts"), `export const a = ${(attempt + 1) % 10};\n`);
      const indexSec = Math.floor(statSync(join(repo, ".git", "index")).mtimeMs / 1000);
      const fileSec = Math.floor(statSync(join(repo, "src", "a.ts")).mtimeMs / 1000);
      raced = indexSec === fileSec;
    }
    expect(raced).toBe(true);
    // Let the clock tick past that second: a hook process starting later
    // copies the index at a newer time, which is exactly when git would
    // stop treating the entry as racy and trust the stale stat cache.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const head = git(repo, "rev-parse", "HEAD^{tree}").trim();
    const after = await captureWorkingTree(repo);
    const changes = await diffWorkingTrees(repo, head, after!.tree);
    expect(changes).toEqual([{ path: "src/a.ts", status: "M" }]);
  });

  it("attaches unified diff hunks and line counts to each changed file", async () => {
    const before = await captureWorkingTree(repo);
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\nexport const extra = 3;\n");
    writeFileSync(join(repo, "src", "new.ts"), "line1\nline2\n");
    unlinkSync(join(repo, "README.md"));
    renameSync(join(repo, "src", "b.ts"), join(repo, "src", "b-renamed.ts"));
    writeFileSync(join(repo, "img.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 254]));
    const after = await captureWorkingTree(repo);

    const changes = await diffWorkingTreesWithPatch(repo, before!.tree, after!.tree);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));

    expect(byPath["src/a.ts"]).toMatchObject({ status: "M", additions: 2, deletions: 1 });
    expect(byPath["src/a.ts"].diff).toContain("@@");
    expect(byPath["src/a.ts"].diff).toContain("-export const a = 1;");
    expect(byPath["src/a.ts"].diff).toContain("+export const extra = 3;");
    expect(byPath["src/a.ts"].diff).not.toContain("diff --git");
    expect(byPath["src/a.ts"].diff).not.toMatch(/^\+\+\+ /mu);

    expect(byPath["src/new.ts"]).toMatchObject({ status: "A", additions: 2, deletions: 0 });
    expect(byPath["README.md"]).toMatchObject({ status: "D", additions: 0, deletions: 1 });
    expect(byPath["README.md"].diff).toContain("-# demo");
    // Pure rename: recorded with its old path and an empty body.
    expect(byPath["src/b-renamed.ts"]).toMatchObject({ status: "R", oldPath: "src/b.ts", additions: 0, deletions: 0, diff: "" });
    // Binary content is never inlined.
    expect(byPath["img.bin"].diff).toBeUndefined();
    expect(byPath["img.bin"].omitted).toEqual({ reason: "unavailable" });
  });

  it("returns an identical tree when nothing changed", async () => {
    const before = await captureWorkingTree(repo);
    const after = await captureWorkingTree(repo);
    expect(after!.tree).toBe(before!.tree);
    expect(await diffWorkingTrees(repo, before!.tree, after!.tree)).toEqual([]);
  });

  it("never touches the user's index or staging area", async () => {
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 3;\n");
    writeFileSync(join(repo, "src", "untracked.ts"), "x\n");
    const statusBefore = git(repo, "status", "--porcelain");

    await captureWorkingTree(repo);

    expect(git(repo, "status", "--porcelain")).toBe(statusBefore);
    // Still unstaged / untracked — a real `git add -A` would have staged them.
    expect(statusBefore).toContain(" M src/a.ts");
    expect(statusBefore).toContain("?? src/untracked.ts");
    expect(git(repo, "diff", "--cached", "--name-only").trim()).toBe("");
  });

  it("reports the HEAD commit so callers can detect checkouts", async () => {
    const before = await captureWorkingTree(repo);
    git(repo, "checkout", "-q", "-b", "other");
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 9;\n");
    git(repo, "commit", "-q", "-am", "change");
    const after = await captureWorkingTree(repo);
    expect(before!.head).not.toBeNull();
    expect(after!.head).not.toBe(before!.head);
  });

  it("returns null outside a git repository", async () => {
    const plain = mkdtempSync(join(tmpdir(), "adit-not-a-repo-"));
    try {
      expect(await captureWorkingTree(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("parsePatchBodies", () => {
  it("keys hunk bodies by new path, handles deletions, renames and binaries", () => {
    const out = [
      "diff --git src/a.ts src/a.ts",
      "index 111..222 100644",
      "--- src/a.ts",
      "+++ src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git gone.txt gone.txt",
      "deleted file mode 100644",
      "index 333..000",
      "--- gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git old.ts new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "diff --git pic.png pic.png",
      "index 444..555 100644",
      "Binary files pic.png and pic.png differ",
      "",
    ].join("\n");
    const bodies = parsePatchBodies(out);
    expect(bodies.get("src/a.ts")).toEqual({ diff: "@@ -1 +1 @@\n-old\n+new", binary: false });
    expect(bodies.get("gone.txt")).toEqual({ diff: "@@ -1 +0,0 @@\n-bye", binary: false });
    expect(bodies.get("new.ts")).toEqual({ diff: "", binary: false });
    expect(bodies.get("pic.png")).toEqual({ diff: "", binary: true });
  });
});

describe("pendingToMutations", () => {
  it("emits one mutation per command and file, carrying diff evidence", () => {
    const mutations = pendingToMutations([
      {
        toolUseId: "t1", promptId: null, recordedAt: "t",
        files: [
          { path: "src/a.ts", status: "M", additions: 1, deletions: 1, diff: "@@ -1 +1 @@\n-a\n+b" },
          { path: "big.json", status: "A", additions: 9000, deletions: 0, omitted: { reason: "diff_too_large", bytes: 200000, limitBytes: 131072 } },
        ],
      },
      { toolUseId: "t2", promptId: null, recordedAt: "t", files: [{ path: "src/a.ts", status: "D" }] },
    ], "claude-code");
    expect(mutations).toEqual([
      {
        provider: "claude-code", toolUseId: "t1", toolName: "Bash", path: "src/a.ts", kind: "update",
        status: "completed", source: "claude-bash-snapshot", additions: 1, deletions: 1, diff: "@@ -1 +1 @@\n-a\n+b",
      },
      {
        provider: "claude-code", toolUseId: "t1", toolName: "Bash", path: "big.json", kind: "add",
        status: "completed", source: "claude-bash-snapshot", additions: 9000, deletions: 0,
        omitted: { reason: "diff_too_large", bytes: 200000, limitBytes: 131072 },
      },
      {
        provider: "claude-code", toolUseId: "t2", toolName: "Bash", path: "src/a.ts", kind: "delete",
        status: "completed", source: "claude-bash-snapshot", omitted: { reason: "unavailable" },
      },
    ]);
  });
});

describe("parseNameStatusZ", () => {
  it("parses added, modified, deleted, renamed and type-changed entries", () => {
    const out = ["A", "x.ts", "M", "y.ts", "D", "z.ts", "R100", "old.ts", "new.ts", "T", "link", ""].join("\0");
    expect(parseNameStatusZ(out)).toEqual([
      { path: "x.ts", status: "A" },
      { path: "y.ts", status: "M" },
      { path: "z.ts", status: "D" },
      { path: "new.ts", status: "R", oldPath: "old.ts" },
      { path: "link", status: "M" },
    ]);
  });

  it("ignores unmerged entries and empty output", () => {
    expect(parseNameStatusZ("")).toEqual([]);
    expect(parseNameStatusZ(["U", "conflict.ts", ""].join("\0"))).toEqual([]);
  });
});

describe("toProjectRelativeChanges", () => {
  it("prefixes member repository paths and keeps root repository paths as-is", () => {
    const changes = [{ path: "src/a.ts", status: "M" as const }];
    expect(toProjectRelativeChanges(changes, {
      repositoryRelativePath: ".",
      projectRoot: "/p",
      dataDir: "/p/.adit",
    })).toEqual([{ path: "src/a.ts", status: "M" }]);
    expect(toProjectRelativeChanges(changes, {
      repositoryRelativePath: "adit-core",
      projectRoot: "/p",
      dataDir: "/p/.adit",
    })).toEqual([{ path: "adit-core/src/a.ts", status: "M" }]);
  });

  it("drops ADIT's own data directory and rekeys rename sources", () => {
    const changes = [
      { path: ".adit/bash-snapshots/x.json", status: "A" as const },
      { path: "new.ts", status: "R" as const, oldPath: "old.ts" },
    ];
    expect(toProjectRelativeChanges(changes, {
      repositoryRelativePath: "core",
      projectRoot: "/p",
      dataDir: "/p/core/.adit",
    })).toEqual([{ path: "core/new.ts", status: "R", oldPath: "core/old.ts" }]);
  });
});

describe("snapshot store", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "adit-snapshot-store-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("round-trips a tool snapshot and removes it on take", () => {
    const snapshot = {
      toolUseId: "toolu_01",
      promptId: "p1",
      startedAt: "2026-09-15T00:00:00.000Z",
      repositories: [{ localRepositoryId: "r", relativePath: ".", path: "/p", tree: "abc", head: "h" }],
    };
    writeToolSnapshot(dataDir, "sess/1", snapshot);
    expect(takeToolSnapshot(dataDir, "sess/1", "toolu_01")).toEqual(snapshot);
    expect(takeToolSnapshot(dataDir, "sess/1", "toolu_01")).toBeNull();
  });

  it("drains pending entries and clears the session directory, including orphaned snapshots", () => {
    writeToolSnapshot(dataDir, "s", {
      toolUseId: "orphan", promptId: null, startedAt: "t", repositories: [],
    });
    const entry: PendingInferredEntry = {
      toolUseId: "toolu_02", promptId: "p1", recordedAt: "t",
      files: [{ path: "src/a.ts", status: "M" }],
    };
    appendPendingInferred(dataDir, "s", entry);
    appendPendingInferred(dataDir, "s", { ...entry, toolUseId: "toolu_03" });
    expect(readFileSync(join(snapshotSessionDir(dataDir, "s"), "pending.jsonl"), "utf8").split("\n").filter(Boolean)).toHaveLength(2);

    const drained = takePendingInferred(dataDir, "s");
    expect(drained.map((e) => e.toolUseId)).toEqual(["toolu_02", "toolu_03"]);
    expect(existsSync(snapshotSessionDir(dataDir, "s"))).toBe(false);
    expect(takePendingInferred(dataDir, "s")).toEqual([]);
  });

  it("clearSessionSnapshots is a no-op for unknown sessions", () => {
    expect(() => clearSessionSnapshots(dataDir, "nope")).not.toThrow();
  });
});

describe("mergeInferredFiles", () => {
  const entry = (toolUseId: string, files: PendingInferredEntry["files"]): PendingInferredEntry => ({
    toolUseId, promptId: null, recordedAt: "t", files,
  });

  it("collapses per-command changes into one record per path", () => {
    const merged = mergeInferredFiles([
      entry("t1", [{ path: "a.ts", status: "A" }, { path: "b.ts", status: "M" }, { path: "c.ts", status: "M" }]),
      entry("t2", [{ path: "a.ts", status: "M" }, { path: "b.ts", status: "D" }, { path: "tmp.ts", status: "A" }]),
      entry("t3", [{ path: "tmp.ts", status: "D" }, { path: "d.ts", status: "R", oldPath: "c.ts" }]),
    ]);
    expect(merged).toEqual([
      { path: "a.ts", status: "A", source: "claude-bash-snapshot", toolUseId: "t2" },
      { path: "b.ts", status: "D", source: "claude-bash-snapshot", toolUseId: "t2" },
      { path: "d.ts", status: "R", oldPath: "c.ts", source: "claude-bash-snapshot", toolUseId: "t3" },
    ]);
  });

  it("drops paths already covered by direct tool evidence and caps the list", () => {
    const merged = mergeInferredFiles(
      [entry("t1", [{ path: "a.ts", status: "M" }, { path: "b.ts", status: "M" }, { path: "c.ts", status: "M" }])],
      { exclude: ["b.ts"], maxEntries: 1 },
    );
    expect(merged.map((m) => m.path)).toEqual(["a.ts"]);
  });
});
