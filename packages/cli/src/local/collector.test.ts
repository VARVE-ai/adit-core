import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LocalStore } from "@varveai/adit-core";
import { Collector, repositories, type CollectionJob } from "./collector.js";
import { analyzeAttribution } from "./attribution-analysis.js";
import { queryCommits } from "./commits.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it("publishes Git repositories before waiting for session discovery, without running collection analysis",async()=>{
  const root=mkdtempSync(join(tmpdir(),"adit-discovery-order-")),repo=join(root,"repo");mkdirSync(repo);
  const git=(...args:string[])=>execFileSync("git",["-C",repo,"-c","core.hooksPath=NUL",...args],{windowsHide:true,encoding:"utf8"});
  git("init","--initial-branch=feature/discovery");git("config","user.email","fixture@example.test");git("config","user.name","Fixture");
  const store=new LocalStore(join(root,"state"));
  let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});
  const scan=vi.fn(async()=>{await waiting;return {counts:{codex:2},pending:{aider:1},errors:[],scanned:2,updated:0};});
  const analyze=vi.fn(async()=>{}),collector=new Collector(store,analyze,undefined,undefined,scan);
  collector.providers=async()=>[];
  cleanup.push(async()=>{release();await collector.close();store.close();rmSync(root,{recursive:true,force:true});});
  const job=collector.discover(root);
  await expect.poll(()=>scan.mock.calls.length).toBe(1);
  expect(store.jobs<CollectionJob>().find(j=>j.id===job.id)).toMatchObject({status:"running",phase:"sessions",repositories:[{path:repo,count:0}]});
  release();
  await expect.poll(()=>store.jobs<CollectionJob>().find(j=>j.id===job.id)?.status).toBe("done");
  expect(store.jobs<CollectionJob>().find(j=>j.id===job.id)).toMatchObject({providers:{codex:2},pending:{aider:1}});
  expect(analyze).not.toHaveBeenCalled();
});
it("reports analyzed commits separately from matched commits and excludes failed analysis runs",async()=>{
  const root=mkdtempSync(join(tmpdir(),"adit-analysis-progress-")),repo=join(root,"repo");mkdirSync(repo);
  const store=new LocalStore(join(root,"state")),collector=new Collector(store);
  cleanup.push(async()=>{await collector.close();store.close();rmSync(root,{recursive:true,force:true});});
  const workspace=store.saveWorkspace({path:root,providers:[],repositories:[repo]});
  for(const sha of ["one","two","three"])store.db.prepare("INSERT INTO adit_local_commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(repo,sha,"tree",1,"Fixture","f@example.test",1,"Fixture","f@example.test",sha,sha,1);
  for(const [id,status] of [["old","done"],["current","running"],["failed","failed"]])store.db.prepare("INSERT INTO adit_attribution_runs(id,workspace_id,algorithm_version,input_fingerprint,status,started_at) VALUES (?,?,1,'test',?,1)").run(id,workspace.id,status);
  const commit=store.db.prepare("INSERT INTO adit_attribution_commits(run_id,repository,sha,submit_session_id,eligible_lines,excluded_lines,certain_lines,likely_lines,possible_lines,moved_lines,unknown_lines) VALUES (?,?,?,?,0,0,0,0,0,0,0)");
  commit.run("old",repo,"one","session");commit.run("current",repo,"two",null);commit.run("failed",repo,"three","session");
  store.job({id:"progress",workspaceId:workspace.id,kind:"collect",status:"running",startedAt:new Date().toISOString(),phase:"analysis",activeRepository:repo,repositories:[{path:repo,count:3}]});
  expect(collector.jobs()[0].repositoryProgress?.[repo]).toEqual({completed:2,total:3,matched:1,status:"running"});
  commit.run("current",repo,"three",null);
  expect(collector.jobs()[0].repositoryProgress?.[repo]).toEqual({completed:3,total:3,matched:1,status:"done"});
});
it("skips unavailable directories in automatic collection and applies the same guard to manual collection",async()=>{
  const root=mkdtempSync(join(tmpdir(),"adit-missing-directory-")),missing=join(root,"missing"),available=join(root,"available");
  mkdirSync(missing);mkdirSync(available);
  const store=new LocalStore(join(root,"state"));
  const scan=vi.fn(async(_request: {workspaces?: {id:string}[]})=>({counts:{},errors:[],scanned:0,updated:0}));
  const collector=new Collector(store,undefined,undefined,undefined,scan);
  collector.providers=async()=>[];
  cleanup.push(async()=>{await collector.close();store.close();rmSync(root,{recursive:true,force:true});});
  const a=store.saveWorkspace({path:missing,providers:["codex"]}),b=store.saveWorkspace({path:available,providers:["codex"]});
  store.markStarted(a.id);store.markStarted(b.id);renameSync(missing,join(root,"renamed"));
  expect(()=>collector.collect(a.id)).toThrow(/Settings/);
  const jobs=collector.collectAll();expect(jobs.map(j=>j.workspaceId)).toEqual([b.id]);
  await expect.poll(()=>store.jobs<CollectionJob>().find(j=>j.id===jobs[0].id)?.status).toBe("done");
  expect(scan).toHaveBeenCalledTimes(1);
  expect(scan.mock.calls[0][0].workspaces?.map(w=>w.id)).toEqual([b.id]);
});
it("retains old Git rows, adds only new commits and reconciles rewritten refs", async () => {
  const root=mkdtempSync(join(tmpdir(),"adit-git-incremental-")),repo=join(root,"repo");mkdirSync(repo);
  const store=new LocalStore(join(root,"state")),collector=new Collector(store);
  cleanup.push(async()=>{await collector.close();store.close();rmSync(root,{recursive:true,force:true});});
  const git=(...args:string[])=>execFileSync("git",["-C",repo,"-c","core.hooksPath=NUL",...args],{windowsHide:true,encoding:"utf8"});
  git("init","--initial-branch=feature/incremental");git("config","user.name","Fixture");git("config","user.email","fixture@example.test");
  const commit=(text:string)=>{writeFileSync(join(repo,"file.txt"),text);git("add",".");git("commit","-m",text);return git("rev-parse","HEAD").trim();};
  const first=commit("first");
  const workspace=store.saveWorkspace({path:repo,providers:[],repositories:[repo]});
  const collect=async()=>{const job=collector.collect(workspace.id);await expect.poll(()=>store.jobs<CollectionJob>().find(j=>j.id===job.id)?.status,{timeout:10000}).toBe("done");};
  await collect();
  const original=store.db.prepare("SELECT * FROM adit_local_commits WHERE sha=?").get(first);
  store.db.exec(`CREATE TEMP TABLE writes(kind TEXT,sha TEXT);
    CREATE TEMP TRIGGER commit_insert AFTER INSERT ON adit_local_commits BEGIN INSERT INTO writes VALUES('insert',NEW.sha); END;
    CREATE TEMP TRIGGER commit_delete AFTER DELETE ON adit_local_commits BEGIN INSERT INTO writes VALUES('delete',OLD.sha); END;`);
  await collect();
  expect(store.db.prepare("SELECT * FROM writes").all()).toEqual([]);
  const second=commit("second");await collect();
  expect(store.db.prepare("SELECT * FROM writes").all()).toEqual([{kind:"insert",sha:second}]);
  expect(store.db.prepare("SELECT * FROM adit_local_commits WHERE sha=?").get(first)).toEqual(original);
  git("commit","--amend","-m","rewritten second");const rewritten=git("rev-parse","HEAD").trim();
  await collect();
  expect(store.db.prepare("SELECT sha FROM adit_local_commits ORDER BY sha").all()).toEqual([first,rewritten].sort().map(sha=>({sha})));
  expect(store.db.prepare("SELECT * FROM adit_local_commits WHERE sha=?").get(first)).toEqual(original);
  git("checkout","--detach",first);const detached=commit("detached commit");await collect();
  expect(store.db.prepare("SELECT sha FROM adit_local_commits WHERE sha=?").get(detached)).toEqual({sha:detached});
});
it("retries failed post-processing but does not repeat successful processing for an unchanged source error",async()=>{
  const root=mkdtempSync(join(tmpdir(),"adit-collection-retry-")),store=new LocalStore(join(root,"state"));
  const inspect=vi.fn(async()=>{}).mockRejectedValueOnce(new Error("temporary inspection failure"));
  const collector=new Collector(store,undefined,undefined,inspect,async()=>({counts:{},errors:["codex: malformed native source"],scanned:1,updated:0}));
  collector.providers=async()=>[{id:"codex",name:"Codex",paths:[],homes:[],homesSupported:true,supported:true,format:"JSONL",enabled:true,version:0}];
  cleanup.push(async()=>{await collector.close();store.close();rmSync(root,{recursive:true,force:true});});
  const workspace=store.saveWorkspace({path:root,providers:["codex"],repositories:[]});
  const collect=async()=>{const job=collector.collect(workspace.id);await expect.poll(()=>store.jobs<CollectionJob>().find(j=>j.id===job.id)?.status).toBe("failed");};
  await collect();expect(inspect).toHaveBeenCalledTimes(1);
  await collect();expect(inspect).toHaveBeenCalledTimes(2);
  await collect();expect(inspect).toHaveBeenCalledTimes(2);
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
  const checkpoint = store.db.prepare("SELECT * FROM adit_local_git_checkpoints").all();
  expect((await repositories(repo))[0]).toMatchObject({
    count: null,
    skipReason: "missing-git-email",
  });
  const skipped = await collect();
  expect(skipped).toMatchObject({ status: "done", repositories: [{ path: repo, count: null, skipReason: "missing-git-email" }] });
  expect(skipped.error).toBeUndefined();
  expect(store.db.prepare("SELECT * FROM adit_local_git_checkpoints").all()).toEqual(checkpoint);
  expect(
    store.db.prepare("SELECT count(*) AS n FROM adit_local_commits").get(),
  ).toEqual({ n: 2 });
  const automatic = collector.collectAll()[0];
  await collector.waitFor(workspace.id);
  const automaticResult = store.jobs<CollectionJob>().find(job => job.id === automatic.id);
  expect(automaticResult?.status).toBe("done");
  expect(automaticResult?.error).toBeUndefined();
  expect(collector.repositoryInfo(workspace)[0].skipReason).toBe("missing-git-email");
  git("config", "user.email", "fixture@example.test");
  expect(await collect()).toMatchObject({ status: "done", repositories: [{ path: repo, count: 2 }] });
  expect(collector.repositoryInfo(workspace)[0].skipReason).toBeUndefined();
});

it("corrects saved missing-config failures without hiding real errors and retains unchecked discovery hints", async () => {
  const root = mkdtempSync(join(tmpdir(), "adit-git-config-"));
  const store = new LocalStore(join(root, "state"));
  const workspace = store.saveWorkspace({ path: root, repositories: [] });
  const missing = "请先为该仓库配置 Git user.email，才能只整理自己的提交";
  const skipped = join(root, "unchecked");
  store.job({ id: "discover", kind: "discover", workspaceId: root, status: "partial", startedAt: "2026-01-01T00:00:00Z", error: missing,
    repositories: [{ path: skipped, count: null, error: missing }] });
  store.job({ id: "mixed", kind: "collect", workspaceId: workspace.id, status: "partial", startedAt: "2026-01-02T00:00:00Z", error: `${missing}; Unable to read Git history`,
    repositories: [{ path: skipped, count: null, error: missing }, { path: join(root,"broken"), count: null, error: "Unable to read Git history" }] });
  store.job({ id: "collect", kind: "collect", workspaceId: workspace.id, status: "failed", startedAt: "2026-01-03T00:00:00Z", error: missing,
    repositories: [{ path: skipped, count: null, error: missing }] });
  store.job({ id: "later", kind: "collect", workspaceId: workspace.id, status: "done", startedAt: "2026-01-04T00:00:00Z",
    repositories: [{ path: join(root,"selected"), count: 3 }] });
  const collector = new Collector(store);
  cleanup.push(async () => { await collector.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  expect(store.jobs<CollectionJob>().find(job => job.id === "discover")).toMatchObject({ status: "done" });
  expect(store.jobs<CollectionJob>().find(job => job.id === "collect")).toMatchObject({ status: "done" });
  expect(store.workspace(workspace.id).started).toBe(true);
  expect(store.jobs<CollectionJob>().find(job => job.id === "mixed")).toMatchObject({ status: "partial", error: "Unable to read Git history" });
  expect(collector.repositoryInfo(workspace)).toContainEqual({ path: skipped, count: null, skipReason: "missing-git-email" });
  expect(collector.repositoryInfo(workspace)).toContainEqual({ path: join(root,"selected"), count: 3 });
});
