import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { LocalStore, registerWorkspace, loadConfig, projectRepositories, resolveLocalProject } from "@varveai/adit-core";
import { initCommand } from "./init.js";
import { localRequest } from "./local-api.js";
import { repositories } from "../local/collector.js";
import { canPromptForInit, selectInitChoices, confirmInit, InitCancelled } from "./init-selection.js";
vi.mock("./skills.js",()=>({installSkillsWithReport:vi.fn(()=>({})),printSkillsSection:vi.fn()}));
vi.mock("./local-api.js",()=>({localRequest:vi.fn()}));
vi.mock("./init-selection.js",async original=>({...(await original<typeof import("./init-selection.js")>()),canPromptForInit:vi.fn(()=>true),selectInitChoices:vi.fn(),confirmInit:vi.fn(()=>true)}));
vi.mock("../local/collector.js",async original=>({...(await original<typeof import("../local/collector.js")>()),repositories:vi.fn()}));
let root:string,repo:string,store:LocalStore;
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),"adit-unified-init-"));repo=join(root,"repo");mkdirSync(repo);
 vi.stubEnv("ADIT_LOCAL_DATA_DIR",join(root,"state"));store=new LocalStore();
 vi.spyOn(console,"log").mockImplementation(()=>{});vi.spyOn(console,"error").mockImplementation(()=>{});process.exitCode=0;
 vi.mocked(canPromptForInit).mockReturnValue(true);
 vi.mocked(confirmInit).mockResolvedValue(true);
 vi.mocked(selectInitChoices).mockImplementation(async (_title,choices)=>choices.filter(c=>c.checked).map(c=>c.id));
 vi.mocked(repositories).mockImplementation(async path=>[{path,count:3}]);
 vi.mocked(localRequest).mockImplementation(async (path,method="GET",body:any)=>{
   if(path==="/providers")return ["codex","claude","cursor","cursor-ide"].map(id=>({id,name:id,enabled:true,supported:true,paths:[],homes:[],version:1,format:"JSONL"}));
   if(path==="/discoveries")return {id:"discovery",workspaceId:body.path,kind:"discover",status:"done",providers:{codex:2},pending:{},repositories:[{path:body.path,count:3}]};
   if(path==="/workspaces"&&method==="POST")return registerWorkspace(store,body);
   const match=/^\/workspaces\/([^/]+)(\/collect)?$/.exec(path);
   if(match?.[2]){store.markStarted(match[1]);return {id:"collection",workspaceId:match[1],kind:"collect",status:"done"};}
   if(match&&method==="PATCH")return registerWorkspace(store,body,match[1]);
   throw new Error(`Unexpected local request: ${method} ${path}`);
 });
});
afterEach(()=>{store.close();vi.restoreAllMocks();vi.clearAllMocks();vi.unstubAllEnvs();process.exitCode=0;rmSync(root,{recursive:true,force:true});});
function git(){
 execFileSync("git",["init",repo],{windowsHide:true,stdio:"ignore"});
 execFileSync("git",["-C",repo,"remote","add","origin","https://example.invalid/test.git"],{windowsHide:true,stdio:"ignore"});
}
it("rejects a plain directory before creating project state and uses the same service as HTTP",async()=>{
 await initCommand({cwd:repo});expect(process.exitCode).toBe(1);expect(store.workspaces()).toEqual([]);
 expect(()=>registerWorkspace(store,{path:repo})).toThrow(/No Git repository/);
 expect(existsSync(join(repo,".adit"))).toBe(false);expect(existsSync(join(repo,".git"))).toBe(false);
});
it("registers without author identity, shares config, and preserves settings and IDs on re-init",async()=>{
 git();writeFileSync(join(repo,"settings.json"),'{"captureEnv":true}');
 await initCommand({cwd:repo,platform:"codex"});expect(process.exitCode).toBe(0);
 let w=store.workspaces()[0];const id=w.id,ids=projectRepositories(store.db,w);store.markStarted(id);
 w=store.workspace(id);store.saveWorkspace({version:w.version,cloud:{enabled:true,mode:"manual",interval:60}},id);
 store.set("account-sentinel",{value:"kept"});
 await initCommand({cwd:repo,force:true});w=store.workspace(id);
 expect(store.workspaces()).toHaveLength(1);expect(w).toMatchObject({id,started:true,cloud:{enabled:true,mode:"manual",interval:60},providers:["codex"]});
 expect(projectRepositories(store.db,w)).toEqual(ids);expect(store.get("account-sentinel",null)).toEqual({value:"kept"});
 expect(loadConfig(repo)).toMatchObject({projectId:id,dbPath:store.dbPath,dataDir:join(store.directory,"runtime",id),captureEnv:false});
 expect(existsSync(join(repo,".adit"))).toBe(false);expect(existsSync(join(repo,".gitignore"))).toBe(false);
 expect(readFileSync(join(repo,"settings.json"),"utf8")).toBe('{"captureEnv":true}');
});
it("adopts old identities once without importing or writing history; works after old files move away",async()=>{
 git();mkdirSync(join(repo,".adit"));
 const file=join(repo,".adit","project.json"),legacy=join(repo,".adit","adit.sqlite");
 writeFileSync(file,JSON.stringify({schemaVersion:3,projectId:"old-project",repositories:[{relativePath:".",repositoryId:"old-repository",syncEnabled:false}],createdAt:"2026-01-01",updatedAt:"2026-01-01"}));
 const old=new Database(legacy);old.exec("CREATE TABLE events(value TEXT); INSERT INTO events VALUES ('private old history')");old.close();const before=readFileSync(legacy);
 await initCommand({cwd:repo});expect(process.exitCode).toBe(0);expect(store.workspaces()[0].id).toBe("old-project");
 expect(projectRepositories(store.db,store.workspaces()[0])[0].localRepositoryId).toBe("old-repository");
 expect(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='events'").get()).toBeUndefined();expect(readFileSync(legacy)).toEqual(before);
 renameSync(join(repo,".adit"),join(root,"old-backup"));await initCommand({cwd:repo});
 expect(resolveLocalProject({path:repo}).projectId).toBe("old-project");expect(existsSync(join(repo,".adit"))).toBe(false);
 expect(store.workspace("old-project").repositoryPolicies?.["."].syncEnabled).toBe(false);
});
it("selects Git first, then real session metadata, then saves and starts the page's collection endpoint",async()=>{
 git();const order:string[]=[];
 vi.mocked(selectInitChoices).mockImplementation(async(title,choices)=>{
   order.push(title);
   if(title.startsWith("1.")){expect(localRequest).not.toHaveBeenCalled();return [repo];}
   expect(choices.find(c=>c.id==="codex")).toMatchObject({checked:true,detail:"2 sessions"});
   expect(choices.find(c=>c.id==="claude")).toMatchObject({checked:false});
   expect(store.workspaces()).toEqual([]);return ["codex"];
 });
 vi.mocked(confirmInit).mockImplementation(async()=>{order.push("confirm");expect(store.workspaces()).toEqual([]);return true;});
 await initCommand({cwd:repo});
 expect(process.exitCode).toBe(0);expect(order).toEqual(["1. Git repositories","2. Session sources","confirm"]);
 const w=store.workspaces()[0];expect(w).toMatchObject({repositories:[repo],providers:["codex"],started:true});
 expect(localRequest).toHaveBeenLastCalledWith(`/workspaces/${w.id}/collect`,"POST",{});
 expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Open adit server to review the directory and start organizing"));
});
it("does not write settings or start collection when canceled",async()=>{
 git();const w=registerWorkspace(store,{path:repo,providers:["claude"],repositories:[repo]});
 vi.mocked(confirmInit).mockResolvedValue(false);
 await initCommand({cwd:repo});
 expect(store.workspace(w.id)).toEqual(w);
 expect(vi.mocked(localRequest).mock.calls.some(([path])=>path.startsWith("/workspaces"))).toBe(false);
 vi.mocked(selectInitChoices).mockRejectedValueOnce(new InitCancelled());vi.mocked(localRequest).mockClear();
 await initCommand({cwd:repo});expect(process.exitCode).toBe(130);expect(localRequest).not.toHaveBeenCalled();
});
it("requires explicit noninteractive acceptance instead of silently selecting all installed Agents",async()=>{
 git();vi.mocked(canPromptForInit).mockReturnValue(false);
 await initCommand({cwd:repo});expect(process.exitCode).toBe(1);expect(localRequest).not.toHaveBeenCalled();
 process.exitCode=0;await initCommand({cwd:repo,yes:true});expect(process.exitCode).toBe(0);
 expect(selectInitChoices).not.toHaveBeenCalled();expect(confirmInit).not.toHaveBeenCalled();
 expect(store.workspaces()[0]).toMatchObject({providers:["codex"],started:true});
});
it("leaves registration untouched if discovery cannot complete",async()=>{
 git();const request=vi.mocked(localRequest).getMockImplementation()!;
 vi.mocked(localRequest).mockImplementation(async(...args)=>args[0]==="/discoveries"?{id:"failed",kind:"discover",status:"interrupted",error:"Metadata unavailable"}:request(...args));
 await initCommand({cwd:repo});expect(process.exitCode).toBe(1);expect(store.workspaces()).toEqual([]);expect(confirmInit).not.toHaveBeenCalled();
});
it("rejects overlapping projects, unsupported providers, and stale writes atomically",()=>{
 git();const w=registerWorkspace(store,{path:repo});
 const child=join(repo,"child");mkdirSync(join(child,".git"),{recursive:true});
 expect(()=>registerWorkspace(store,{path:child})).toThrow(/overlaps/);
 expect(()=>registerWorkspace(store,{providers:["invalid"],version:w.version},w.id)).toThrow(/Unsupported/);
 expect(()=>registerWorkspace(store,{name:"wrong",version:0},w.id)).toThrow(/Settings changed/);
 expect(store.workspace(w.id)).toEqual(w);expect(store.workspaces()).toHaveLength(1);
});
