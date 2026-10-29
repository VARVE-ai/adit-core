import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  LocalHistory,
  LocalStore,
  sourceDefinitions,
} from "@varveai/adit-core";
import { Collector, type CollectionJob } from "./collector.js";
import {
  scanHistoryInBackground,
  type CollectionScanRequest,
} from "./collection-scan.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const workerUrl = new URL(
  "../../dist/local/collection-worker.js",
  import.meta.url,
);
function createRepository(path: string) {
  execFileSync("git", ["init", path], { windowsHide: true, stdio: "pipe" });
  execFileSync("git", ["-C", path, "remote", "add", "origin", "https://example.invalid/test.git"], { windowsHide: true, stdio: "pipe" });
  execFileSync("git", ["-C", path, "config", "user.email", "fixture@example.test"], { windowsHide: true, stdio: "pipe" });
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "adit-collection-worker-"));
  const source = join(root, "source");
  mkdirSync(source);
  createRepository(root);
  const store = new LocalStore(join(root, "state"));
  const history = new LocalHistory(store.db);
  const workspace = store.saveWorkspace({
    path: root,
    providers: ["codex"],
    repositories: [root],
  });
  const definition = sourceDefinitions().find((s) => s.id === "codex")!;
  const sources = [
    { ...definition, ...store.provider("codex"), paths: [source] },
  ];
  const file = join(source, "rollout-fixture.jsonl");
  writeFileSync(
    file,
    JSON.stringify({
      type: "session_meta",
      payload: { id: "fixture", cwd: root },
    }) +
      "\n" +
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: "fixture prompt" },
      }) +
      "\n",
  );
  const job: CollectionJob = {
    id: "fixture-job",
    workspaceId: workspace.id,
    kind: "collect",
    status: "running",
    startedAt: new Date().toISOString(),
  };
  const request: CollectionScanRequest = {
    directory: store.directory,
    path: root,
    workspace,
    sources,
    job,
  };
  cleanups.push(async () => {
    store.close();
    if (
      !resolve(root).startsWith(resolve(tmpdir()) + "\\") &&
      !resolve(root).startsWith(resolve(tmpdir()) + "/")
    )
      throw new Error("Unexpected fixture directory");
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store, history, workspace, request, file };
}
const scan = (
  request: CollectionScanRequest,
  signal = new AbortController().signal,
) => scanHistoryInBackground(request, signal, workerUrl);

it("shares one worker scan across projects and uses identical incremental processing for manual and automatic triggers", async () => {
  const {root,store,history,request,file}=fixture();
  const one=join(root,"one"),two=join(root,"two");createRepository(one);createRepository(two);
  const workspaces=[one,two].map(path=>store.saveWorkspace({path,providers:["codex"],repositories:[path]}));
  for(const workspace of workspaces)store.markStarted(workspace.id);
  const rows=(id:string,cwd:string)=>JSON.stringify({type:"session_meta",payload:{id,cwd}})+"\n"+
    JSON.stringify({type:"response_item",payload:{type:"message",role:"user",content:"question"}})+"\n";
  writeFileSync(file,rows("one",one));
  const secondFile=join(root,"source","rollout-second.jsonl");writeFileSync(secondFile,rows("two",two));
  const background=vi.fn(scan),inspect=vi.fn(async()=>{});
  const collector=new Collector(store,undefined,undefined,inspect,background);
  collector.providers=async()=>request.sources;
  cleanups.push(()=>collector.close());
  const wait=async(jobs:CollectionJob[])=>{
    await expect.poll(()=>jobs.every(job=>store.jobs<CollectionJob>().find(j=>j.id===job.id)?.status==="done"),{timeout:10000}).toBe(true);
  };
  const jobs=collector.collectAll();
  expect(collector.collectAll().map(j=>j.id)).toEqual(jobs.map(j=>j.id));
  await wait(jobs);
  expect(background).toHaveBeenCalledTimes(1);
  expect(background.mock.calls[0][0].workspaces).toHaveLength(2);
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(history.session("codex","one")).toBeDefined();
  expect(history.session("codex","two")).toBeDefined();
  for(const job of jobs)expect(store.jobs<CollectionJob>().find(saved=>saved.id===job.id)?.sourceProgress?.codex).toEqual({completed:1,total:1,status:"done"});
  await wait(collector.collectAll());
  expect(background).toHaveBeenCalledTimes(2);
  expect(inspect).toHaveBeenCalledTimes(2);
  appendFileSync(secondFile,JSON.stringify({type:"response_item",payload:{type:"message",role:"assistant",content:"new automatic reply"}})+"\n");
  collector.schedule(true);
  await expect.poll(()=>background.mock.calls.length,{timeout:10000}).toBe(3);
  await expect.poll(()=>history.session("codex","two")!.messages.length,{timeout:10000}).toBe(2);
  await expect.poll(()=>inspect.mock.calls.length,{timeout:10000}).toBe(3);
  expect(inspect.mock.calls[2][0]).toMatchObject({id:workspaces[1].id});
  await expect.poll(()=>collector.active(workspaces[1].id,"collect"),{timeout:10000}).toBeUndefined();
  await wait(collector.collectAll());
  expect(history.session("codex","two")!.messages).toHaveLength(2);
  expect(inspect).toHaveBeenCalledTimes(3);
}, 15000);

it("collects in the worker, persists progress, and updates only changed transcripts", async () => {
  const { store, history, workspace, request, file } = fixture();
  const collector = new Collector(store, undefined, undefined, undefined, scan);
  collector.providers = async () => request.sources;
  cleanups.push(() => collector.close());
  const job = collector.collect(workspace.id);
  await expect
    .poll(
      () => store.jobs<CollectionJob>().find((j) => j.id === job.id)?.status,
      { timeout: 10000 },
    )
    .toBe("done");
  expect(
    store.jobs<CollectionJob>().find((j) => j.id === job.id)?.progress,
  ).toEqual({ files: 1, updated: 1 });
  expect(history.session("codex", "fixture")?.messages[0].content).toBe(
    "fixture prompt",
  );
  expect((await scan(request)).updated).toBe(0);
  appendFileSync(
    file,
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: "fixture reply" },
    }) + "\n",
  );
  expect((await scan(request)).updated).toBe(1);
  expect(history.session("codex", "fixture")?.messages).toHaveLength(2);
  appendFileSync(file, "{invalid}\n");
  expect((await scan(request)).errors).toHaveLength(1);
  expect(history.session("codex", "fixture")?.messages).toHaveLength(2);
}, 15000);

it("keeps discovery read-only and rejects changed workspace/source selections", async () => {
  const { store, history, workspace, request } = fixture();
  expect(
    (
      await scan({
        ...request,
        workspace: undefined,
        job: { ...request.job, kind: "discover" },
      })
    ).counts,
  ).toEqual({ codex: 1 });
  expect(history.session("codex", "fixture")).toBeUndefined();
  await expect(
    scan({
      ...request,
      workspace: { ...workspace, version: workspace.version - 1 },
    }),
  ).rejects.toThrow("Settings changed");
  store.saveProvider("codex", {
    version: request.sources[0].version,
    enabled: true,
    homes: [],
  });
  await expect(scan(request)).rejects.toThrow("Source settings changed");
  expect(history.session("codex", "fixture")).toBeUndefined();
});

it("cancels an active worker and releases SQLite before the next scan", async () => {
  const { request, history } = fixture();
  const controller = new AbortController();
  const pending = scan(request, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow("Collection interrupted");
  expect(history.session("codex", "fixture")).toBeUndefined();
  expect((await scan(request)).updated).toBe(1);
});

it("rolls back an interrupted worker transaction and leaves the writer available", async () => {
  const { root, store, request } = fixture();
  const workerFile = join(root, "transaction-worker.mjs");
  const readyFile = join(root, "transaction-ready");
  const coreUrl = new URL("../../../core/dist/index.js", import.meta.url).href;
  writeFileSync(
    workerFile,
    `
    import { workerData } from 'node:worker_threads';
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { LocalStore } from ${JSON.stringify(coreUrl)};
    const store = new LocalStore(workerData.directory);
    store.db.exec('BEGIN IMMEDIATE');
    store.set('unfinished-worker-write', true);
    writeFileSync(join(workerData.path, 'transaction-ready'), 'ready');
    setInterval(() => {}, 1000);
  `,
  );
  const controller = new AbortController();
  const pending = scanHistoryInBackground(
    request,
    controller.signal,
    pathToFileURL(workerFile),
  );
  try {
    await expect.poll(() => existsSync(readyFile)).toBe(true);
  } finally {
    controller.abort();
    await expect(pending).rejects.toThrow("Collection interrupted");
  }
  expect(store.get("unfinished-worker-write", false)).toBe(false);
  expect((await scan(request)).updated).toBe(1);
});
