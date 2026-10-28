import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, truncateSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { LocalStore } from "../local-state.js";
import { LocalHistory } from "./archive.js";
import { projectMetadata, METADATA_BYTES } from "./discovery-metadata.js";
import * as reader from "./codex-file.js";

const cleanup:(()=>void)[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const fn of cleanup.splice(0).reverse())fn();});
function fixture() {
  const root=mkdtempSync(join(tmpdir(),"adit-discovery-")),source=join(root,"native"),workspace=join(root,"workspace");
  mkdirSync(source);mkdirSync(workspace);
  const store=new LocalStore(join(root,"state")),history=new LocalHistory(store.db,{discovery:true});
  cleanup.push(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const path=join(source,"rollout-one.jsonl"),sources=[{id:"codex",paths:[source]}];
  const header=(id="one",cwd=workspace,extra={})=>JSON.stringify({type:"session_meta",payload:{id,cwd,...extra}})+"\n";
  return {root,source,workspace,store,history,path,sources,header};
}
it("discovers a huge transcript from its bounded metadata prefix, never invoking its full parser",async()=>{
  const f=fixture(),parse=vi.spyOn(reader,"readCodexSession");
  writeFileSync(f.path,f.header()+"{invalid body deferred to collection}\n");truncateSync(f.path,512*1024*1024);
  const found=await f.history.scan(f.workspace,f.sources,{preview:true});
  expect(found).toMatchObject({counts:{codex:1},errors:[],updated:0,cached:0});
  expect(parse).not.toHaveBeenCalled();
  for(const table of ["adit_history_sessions","adit_history_messages","adit_history_sources","adit_history_file_checkpoints"])
    expect(f.store.db.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({n:0});
  const cached=JSON.stringify(f.store.db.prepare("SELECT * FROM adit_history_discovery_cache").all());
  expect(cached).not.toContain("invalid body");expect(cached.length).toBeLessThan(2000);
});
it("reuses metadata across restarts and workspaces, invalidates changed files, and notices additions/deletions",async()=>{
  const f=fixture(),other=join(f.root,"other");mkdirSync(other);writeFileSync(f.path,f.header());
  expect((await f.history.scan(f.workspace,f.sources,{preview:true})).counts).toEqual({codex:1});
  const restarted=new LocalHistory(f.store.db,{discovery:true});
  expect(await restarted.scan(other,f.sources,{preview:true})).toMatchObject({counts:{},cached:1});
  writeFileSync(f.path,f.header("moved",other));
  expect(await restarted.scan(f.workspace,f.sources,{preview:true})).toMatchObject({counts:{},cached:0});
  const added=join(f.source,"rollout-added.jsonl");writeFileSync(added,f.header("new"));
  expect(await restarted.scan(f.workspace,[...f.sources,...f.sources],{preview:true})).toMatchObject({counts:{codex:1},cached:1,scanned:2});
  rmSync(added);
  expect((await restarted.scan(f.workspace,f.sources,{preview:true})).counts).toEqual({});
});
it("counts forks but excludes subagents, without loading parent transcripts",async()=>{
  const f=fixture();writeFileSync(f.path,f.header());
  writeFileSync(join(f.source,"rollout-fork.jsonl"),f.header("fork",f.workspace,{forked_from_id:"one"}));
  writeFileSync(join(f.source,"rollout-child.jsonl"),f.header("child",f.workspace,{source:{subagent:{thread_spawn:{parent_thread_id:"one"}}}}));
  expect((await f.history.scan(f.workspace,f.sources,{preview:true})).counts).toEqual({codex:2});
});
it("full collection still parses new bodies after discovery and retains its own incremental checkpoints",async()=>{
  const f=fixture();writeFileSync(f.path,f.header()+JSON.stringify({type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"real question"}]}})+"\n");
  await f.history.scan(f.workspace,f.sources,{preview:true});
  expect((await f.history.scan(f.workspace,f.sources)).updated).toBe(1);
  expect(f.history.session("codex","one")?.messages[0].content).toContainEqual({type:"input_text",text:"real question"});
  expect((await f.history.scan(f.workspace,f.sources)).updated).toBe(0);
  appendFileSync(f.path,"{invalid}\n");
  expect((await f.history.scan(f.workspace,f.sources,{preview:true})).errors).toEqual([]);
  expect((await f.history.scan(f.workspace,f.sources)).errors).toHaveLength(1);
});
it("invalidates sidecar workspace metadata without reading VSCode request bodies",async()=>{
  const f=fixture(),chats=join(f.source,"chatSessions");mkdirSync(chats);
  const metadata=join(f.source,"workspace.json");writeFileSync(metadata,JSON.stringify({folder:pathToFileURL(f.workspace).href}));
  writeFileSync(join(chats,"chat.json"),JSON.stringify({sessionId:"chat",requests:"body is deliberately not a valid transcript"}));
  const sources=[{id:"vscode-copilot",paths:[f.source]}];
  expect(await f.history.scan(f.workspace,sources,{preview:true})).toMatchObject({counts:{"vscode-copilot":1},cached:0});
  expect((await f.history.scan(f.workspace,sources,{preview:true})).cached).toBe(1);
  writeFileSync(metadata,JSON.stringify({folder:pathToFileURL(join(f.root,"different-directory")).href}));
  const changed=await f.history.scan(f.workspace,sources,{preview:true});
  expect(changed.cached).toBe(0);expect(changed.counts).toEqual({});
});
it("reads native database session columns without requiring message tables",async()=>{
  const f=fixture(),path=join(f.source,"opencode.db"),db=new Database(path);
  db.exec("CREATE TABLE session(id TEXT,directory TEXT,parent_id TEXT)");
  db.prepare("INSERT INTO session VALUES (?,?,?)").run("s1",f.workspace,null);db.close();
  expect(await f.history.scan(f.workspace,[{id:"opencode",paths:[f.source]}],{preview:true})).toMatchObject({counts:{opencode:1},errors:[]});
});
it("marks files needing transcript parsing as pending instead of reporting no sessions or inventing identities",async()=>{
  const f=fixture();writeFileSync(f.path,JSON.stringify({body:"x".repeat(METADATA_BYTES+100),type:"session_meta",payload:{id:"late",cwd:f.workspace}}));
  expect(await f.history.scan(f.workspace,f.sources,{preview:true})).toMatchObject({counts:{},pending:{codex:1},errors:[]});
});
it("projects only exact metadata paths, ignoring transcript-embedded lookalikes and truncated strings",()=>{
  const doc={requests:[{sessionId:"wrong",cwd:"wrong"}],sessionId:"right",folder:"D:\\中文\\test",payload:{source:{subagent:{thread_spawn:{parent_thread_id:"owner"}}}},body:'\"cwd\":\"fake\"'};
  expect({...projectMetadata(JSON.stringify(doc)+"\n"+'{"sessionId":"partial',["sessionId","folder","payload.source.subagent.thread_spawn.parent_thread_id"])}).toEqual({sessionId:"right",folder:"D:\\中文\\test","payload.source.subagent.thread_spawn.parent_thread_id":"owner"});
});
it("reports real per-workspace session progress, including cached sessions and excluding duplicate files and subagents",async()=>{
  const f=fixture(),other=join(f.root,"other");mkdirSync(other);
  const body=JSON.stringify({type:"response_item",payload:{type:"message",role:"user",content:"question"}})+"\n";
  writeFileSync(f.path,f.header()+body);
  writeFileSync(join(f.source,"rollout-two.jsonl"),f.header("two")+body);
  writeFileSync(join(f.source,"rollout-other.jsonl"),f.header("other",other)+body);
  writeFileSync(join(f.source,"rollout-child.jsonl"),f.header("child",f.workspace,{source:{subagent:{thread_spawn:{parent_thread_id:"one"}}}})+body);
  const scopes=[{path:f.workspace,providers:["codex"]},{path:other,providers:["codex"]}];
  const progress=vi.fn();
  const result=await f.history.scan(f.workspace,[{id:"codex",paths:[f.source,f.source]}],{scopes,sourceProgress:progress});
  expect(result.sourceProgress?.[f.workspace].codex).toEqual({completed:2,total:2,status:"done"});
  expect(result.sourceProgress?.[other].codex).toEqual({completed:1,total:1,status:"done"});
  expect(progress.mock.calls).toContainEqual([f.workspace,"codex",{completed:1,total:2,status:"running"}]);
  expect(result.scanned).toBe(4);
  const cached=await f.history.scan(f.workspace,f.sources,{scopes,sourceProgress:progress});
  expect(cached.updated).toBe(0);expect(cached.sourceProgress).toEqual(result.sourceProgress);
});
it("retains incomplete session progress on parse failure, never treating a failed file as a completed session",async()=>{
  const f=fixture();writeFileSync(f.path,f.header()+"{broken}\n");
  const result=await f.history.scan(f.workspace,f.sources,{sourceProgress:()=>{}});
  expect(result.errors).toHaveLength(1);
  expect(result.sourceProgress?.[f.workspace].codex).toEqual({completed:0,total:1,status:"partial"});
});
