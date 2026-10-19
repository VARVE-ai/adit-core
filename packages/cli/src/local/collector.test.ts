import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LocalStore } from "@varveai/adit-core";
import { Collector, repositories, type CollectionJob } from "./collector.js";
import { analyzeAttribution } from "./attribution-analysis.js";
import { queryCommits } from "./commits.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it("excludes real merge commits from discovery, collection and analysis but keeps their branch commits", async () => {
  const root = mkdtempSync(join(tmpdir(), "adit-no-merges-")),
    repo = join(root, "repo");
  mkdirSync(repo);
  const store = new LocalStore(join(root, "state"));
  const collector = new Collector(store, async (workspace) => {
    await analyzeAttribution(store, workspace);
  });
  cleanup.push(async () => {
    await collector.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, "-c", "core.hooksPath=NUL", ...args], {
      windowsHide: true,
      encoding: "utf8",
    });
  git("init", "--initial-branch=feature/fixture");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  const commit = (name: string, subject: string) => {
    writeFileSync(
      join(repo, name),
      `export const ${name.replace(/\W/g, "_")} = true;\n`,
    );
    git("add", name);
    git("commit", "-m", subject);
    return git("rev-parse", "HEAD").trim();
  };
  const first = commit("base.ts", "root commit");
  git("checkout", "-b", "feature/side");
  const side = commit("side.ts", "feature work");
  git("checkout", "feature/fixture");
  const ordinary = commit("helper.ts", "chore: merge helper improvements");
  git("merge", "--no-ff", "feature/side", "-m", "integrate feature work");
  const merge = git("rev-parse", "HEAD").trim();
  const workspace = store.saveWorkspace({
    path: repo,
    providers: [],
    repositories: [repo],
  });
  // Simulate a merge collected by the previous version. A normal successful
  // collection replaces it without resetting sessions or all analysis results.
  const now = Date.now();
  store.db
    .prepare("INSERT INTO adit_local_commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      repo,
      merge,
      "tree",
      now,
      "Fixture",
      "fixture@example.test",
      now,
      "Fixture",
      "fixture@example.test",
      "integrate feature work",
      "",
      now,
    );
  for (const [ordinal, parent] of [ordinary, side].entries())
    store.db
      .prepare("INSERT INTO adit_local_commit_parents VALUES (?,?,?,?)")
      .run(repo, merge, parent, ordinal);
  store.db
    .prepare("INSERT INTO adit_local_commit_files VALUES (?,?,?,?,?,?,?,?)")
    .run(repo, merge, 0, null, "side.ts", 1, 0, 0);
  expect((await repositories(repo))[0]).toMatchObject({ count: 3 });
  expect(queryCommits(store, workspace).commits).toEqual([]);
  const job = collector.collect(workspace.id);
  await expect
    .poll(
      () => store.jobs<CollectionJob>().find((j) => j.id === job.id)?.status,
      { timeout: 10000 },
    )
    .toBe("done");
  expect(
    store.db.prepare("SELECT sha FROM adit_local_commits ORDER BY sha").all(),
  ).toEqual([first, side, ordinary].sort().map((sha) => ({ sha })));
  expect(
    store.db
      .prepare("SELECT count(*) n FROM adit_local_commit_files WHERE sha=?")
      .get(merge),
  ).toEqual({ n: 0 });
  expect(queryCommits(store, workspace).commits).toHaveLength(3);
  expect(
    store.db
      .prepare(
        "SELECT commit_count,completed_count FROM adit_attribution_runs WHERE status='done'",
      )
      .get(),
  ).toEqual({ commit_count: 3, completed_count: 3 });
  expect(
    store.db
      .prepare("SELECT count(*) n FROM adit_attribution_commits WHERE sha=?")
      .get(merge),
  ).toEqual({ n: 0 });
});
it("collects structured Git authors, parents, commit bodies and renamed/binary file statistics", async () => {
  const root = mkdtempSync(join(tmpdir(), "adit-git-facts-")),
    repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      windowsHide: true,
      encoding: "utf8",
    });
  git("init", "--initial-branch=feature/test-facts");
  git("config", "user.name", "Fixture Author");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(repo, "first file.txt"), "first\nsecond\n");
  writeFileSync(join(repo, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  git("add", ".");
  git("commit", "-m", "first commit", "-m", "body with a second paragraph");
  const first = git("rev-parse", "HEAD").trim();
  git("mv", "first file.txt", "renamed file.txt");
  git("commit", "-m", "rename file");
  const second = git("rev-parse", "HEAD").trim();
  writeFileSync(join(repo, "teammate.txt"), "someone else's work\n");
  git("add", ".");
  git(
    "commit",
    "--author",
    "Other Author <other@example.test>",
    "-m",
    "teammate work",
  );
  expect((await repositories(repo))[0]).toMatchObject({ count: 2 });
  const store = new LocalStore(join(root, "state")),
    collector = new Collector(store, async (workspace) => {
      await analyzeAttribution(store, workspace);
    });
  cleanup.push(async () => {
    await collector.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const workspace = store.saveWorkspace({
    path: repo,
    providers: [],
    repositories: [repo],
  });
  const collect = async () => {
    const job = collector.collect(workspace.id);
    for (let i = 0; i < 200; i++) {
      const result = store
        .jobs<CollectionJob>()
        .find((value) => value.id === job.id);
      if (result && !["queued", "running"].includes(result.status))
        return result;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Git collection did not complete");
  };
  expect(await collect()).toMatchObject({ status: "done" });
  const analysis = () =>
    store.db
      .prepare(
        "SELECT id,commit_count,completed_count FROM adit_attribution_runs WHERE status='done'",
      )
      .get() as { id: string; commit_count: number; completed_count: number };
  const initialAnalysis = analysis();
  expect(initialAnalysis).toMatchObject({
    commit_count: 2,
    completed_count: 2,
  });
  expect(
    store.db
      .prepare(
        "SELECT sha,subject,author_email,body FROM adit_local_commits WHERE sha=?",
      )
      .get(first),
  ).toMatchObject({
    sha: first,
    subject: "first commit",
    author_email: "fixture@example.test",
    body: expect.stringContaining("body with a second paragraph"),
  });
  expect(
    store.db
      .prepare("SELECT parent_sha FROM adit_local_commit_parents WHERE sha=?")
      .get(second),
  ).toEqual({ parent_sha: first });
  expect(
    store.db
      .prepare("SELECT path,old_path FROM adit_local_commit_files WHERE sha=?")
      .get(second),
  ).toEqual({ path: "renamed file.txt", old_path: "first file.txt" });
  expect(
    store.db
      .prepare(
        "SELECT binary,additions,deletions FROM adit_local_commit_files WHERE path='binary.dat'",
      )
      .get(),
  ).toEqual({ binary: 1, additions: null, deletions: null });
  expect(await collect()).toMatchObject({ status: "done" });
  expect(analysis()).toEqual(initialAnalysis);
  expect(
    store.db.prepare("SELECT count(*) AS n FROM adit_local_commits").get(),
  ).toEqual({ n: 2 });
  expect(
    store.db.prepare("SELECT count(*) AS n FROM adit_local_commit_files").get(),
  ).toEqual({ n: 3 });
  expect(
    store.db
      .prepare(
        "SELECT count(*) AS n FROM adit_local_commits WHERE author_email='other@example.test'",
      )
      .get(),
  ).toEqual({ n: 0 });
  git("config", "user.email", "other@example.test");
  expect(await collect()).toMatchObject({ status: "done" });
  const addedAnalysis = analysis();
  expect(addedAnalysis).toMatchObject({ commit_count: 1, completed_count: 1 });
  expect(addedAnalysis.id).not.toBe(initialAnalysis.id);
  expect(
    store.db.prepare("SELECT count(*) AS n FROM adit_local_commits").get(),
  ).toEqual({ n: 1 });
  git("config", "user.email", "FIXTURE@example.test");
  expect(await collect()).toMatchObject({ status: "done" });
  expect(analysis()).toEqual(addedAnalysis);
  expect(
    store.db.prepare("SELECT count(*) AS n FROM adit_local_commits").get(),
  ).toEqual({ n: 2 });
  expect(
    store.db
      .prepare(
        "SELECT count(*) AS n FROM adit_local_commit_files WHERE path='teammate.txt'",
      )
      .get(),
  ).toEqual({ n: 0 });
  git("config", "user.email", "");
  expect((await repositories(repo))[0]).toMatchObject({
    count: null,
    error: expect.stringContaining("user.email"),
  });
  expect(await collect()).toMatchObject({
    status: "failed",
    error: expect.stringContaining("user.email"),
  });
  expect(
    store.db.prepare("SELECT count(*) AS n FROM adit_local_commits").get(),
  ).toEqual({ n: 2 });
});
