import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "./local-state.js";
import { directoryAvailable, projectRepositories } from "./local-projects.js";
import { resolveLocalProject } from "./project-resolution.js";
import { createHistorySchema } from "./local-history/schema.js";
import { StructuredHistory } from "./local-history/structured-store.js";
import { analyticsSessions } from "./local-history/analytics-scope.js";
import { createAttributionSchema } from "./local-history/attribution-schema.js";
import { computeLocalRepositoryId } from "./config/project.js";
const cleanup: (()=>void)[]=[];
afterEach(()=>cleanup.splice(0).reverse().forEach(fn=>fn()));
function fixture() {
  const root=mkdtempSync(join(tmpdir(),"adit-project-resolution-")),path=join(root,"project"),directory=join(root,"state");
  mkdirSync(join(path,"repo",".git"),{recursive:true});mkdirSync(join(path,"repo","src"));
  const store=new LocalStore(directory);
  cleanup.push(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return {root,path,directory,store};
}
function manifest(path:string,id="original-project",repositoryId="original-repository") {
  mkdirSync(join(path,".adit"),{recursive:true});
  writeFileSync(join(path,".adit","project.json"),JSON.stringify({schemaVersion:3,projectId:id,repositories:[{relativePath:"repo",repositoryId}],createdAt:"2026-10-01T00:00:00Z",updatedAt:"2026-10-01T00:00:00Z"}));
}
it("imports exact old IDs, resolves child directories and preserves the old manifest unchanged",()=>{
  const {store,path,directory}=fixture();manifest(path);
  const before=readFileSync(join(path,".adit","project.json"),"utf8");
  expect(resolveLocalProject({path:join(path,"repo","src"),directory})).toMatchObject({projectId:"original-project",source:"manifest"});
  expect(store.workspaces()).toEqual([]);
  const w=store.saveWorkspace({path,repositories:[join(path,"repo")]});
  expect(w.id).toBe("original-project");
  expect(resolveLocalProject({path:join(path,"repo","src"),directory,requireRepository:true})).toMatchObject({projectId:w.id,source:"registry",repository:{localRepositoryId:"original-repository"}});
  expect(store.saveWorkspace({version:w.version,name:"new display name"},w.id).id).toBe(w.id);
  expect(readFileSync(join(path,".adit","project.json"),"utf8")).toBe(before);
});
it("uses UUIDs for new projects and keeps repository IDs when selection changes",()=>{
  const {store,path}=fixture();
  let w=store.saveWorkspace({path,repositories:[join(path,"repo")]});
  expect(w.id).toMatch(/^[a-f0-9-]{36}$/);const before=projectRepositories(store.db,w);
  w=store.saveWorkspace({version:w.version,repositories:[]},w.id);
  w=store.saveWorkspace({version:w.version,repositories:[join(path,"repo")]},w.id);
  expect(projectRepositories(store.db,w)).toEqual(before);
});
it("reports ambiguous overlapping projects instead of choosing the most recent",()=>{
  const {store,path,directory}=fixture();
  store.saveWorkspace({path});const child=store.saveWorkspace({path:join(path,"repo"),repositories:[join(path,"repo")]});
  expect(()=>resolveLocalProject({path:join(path,"repo","src"),directory})).toThrow(/multiple/);
  expect(resolveLocalProject({path:join(path,"repo","src"),directory,workspaceId:child.id}).projectId).toBe(child.id);
});
it("requires Settings to maintain a renamed registered project, then retains history and IDs across repeated moves",()=>{
  const {store,path,directory,root}=fixture();manifest(path);
  let w=store.saveWorkspace({path,providers:["codex"],repositories:[join(path,"repo")]});
  createHistorySchema(store.db);createAttributionSchema(store.db);const history=new StructuredHistory(store.db);
  history.write({provider:"codex",id:"old",cwd:join(path,"repo"),messages:[{key:"q",role:"user",content:"original text",raw:{}}]});
  store.db.prepare("INSERT INTO adit_local_commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(join(path,"repo"),"sha","tree",1,"user","user@test",1,"user","user@test","subject","body",1);
  store.db.prepare("INSERT INTO adit_local_commit_files VALUES (?,?,?,?,?,?,?,?)").run(join(path,"repo"),"sha",0,null,"a.ts",10,0,0);
  const repoId=projectRepositories(store.db,w)[0].localRepositoryId;
  const moved=join(root,"renamed");renameSync(path,moved);
  expect(directoryAvailable(w.path)).toBe(false);
  expect(()=>resolveLocalProject({path:join(moved,"repo"),directory})).toThrow(/Settings/);
  expect(()=>store.saveWorkspace({path:moved})).toThrow(/already registered/);
  w=store.saveWorkspace({version:w.version,path:moved},w.id);
  expect(w.id).toBe("original-project");expect(w.repositories).toEqual([join(moved,"repo")]);
  expect(projectRepositories(store.db,w)[0].localRepositoryId).toBe(repoId);
  expect(analyticsSessions(store.db,w).map(s=>s.id)).toEqual(["old"]);
  expect(history.read("codex","old")!.cwd).toBe(join(path,"repo"));
  expect(store.db.prepare("SELECT additions FROM adit_local_commit_files WHERE repository=?").get(join(moved,"repo"))).toEqual({additions:10});
  mkdirSync(path);history.write({provider:"codex",id:"unrelated-new-project",cwd:path,messages:[]});
  expect(analyticsSessions(store.db,w).map(s=>s.id)).toEqual(["old"]);
  history.write({provider:"codex",id:"new",cwd:join(moved,"repo"),messages:[]});
  expect(analyticsSessions(store.db,w)).toHaveLength(2);
  rmSync(path,{recursive:true});renameSync(moved,path);
  w=store.saveWorkspace({version:w.version,path},w.id);
  expect(projectRepositories(store.db,w)[0].localRepositoryId).toBe(repoId);
  expect(analyticsSessions(store.db,w).map(s=>s.id)).toContain("new");
  expect(store.db.pragma("foreign_key_check")).toEqual([]);
});
it("rejects conflicting identities and unfinished collection without partial writes",()=>{
  const {store,path,root}=fixture();manifest(path);
  const w=store.saveWorkspace({path});
  const other=join(root,"other");mkdirSync(join(other,"repo"),{recursive:true});manifest(other,"different-project");
  expect(()=>store.saveWorkspace({version:w.version,path:other},w.id)).toThrow(/identity conflicts/);
  expect(store.workspace(w.id)).toEqual(w);
  store.job({id:"j",workspaceId:w.id,status:"queued"});
  const moved=join(root,"moved");renameSync(path,moved);
  expect(()=>store.saveWorkspace({version:w.version,path:moved},w.id)).toThrow(/finish/);
  expect(store.workspace(w.id)).toEqual(w);
});
it("recovers a legacy workspace and repository IDs unchanged through rename and re-registration",()=>{
  const {store,path,root}=fixture();
  mkdirSync(join(path,".adit"));
  const original=JSON.stringify({workspaceId:"bca160f77ea6807f",createdAt:"2026-08-19T02:31:22.574Z"});
  writeFileSync(join(path,".adit","workspace.json"),original);
  let w=store.saveWorkspace({path,repositories:[join(path,"repo")]});
  expect(w.id).toBe("bca160f77ea6807f");
  const repoId=computeLocalRepositoryId(w.id,"repo");
  expect(projectRepositories(store.db,w)[0].localRepositoryId).toBe(repoId);
  const moved=join(root,"renamed");renameSync(path,moved);
  w=store.saveWorkspace({version:w.version,path:moved},w.id);
  expect(projectRepositories(store.db,w)[0].localRepositoryId).toBe(repoId);
  expect(readFileSync(join(moved,".adit","workspace.json"),"utf8")).toBe(original);
});
it.each(["project_link_cache","sessions"])("recovers saved identity from %s without migrating or writing the old database",(table)=>{
  const {store,path}=fixture();mkdirSync(join(path,".adit"));
  const dbPath=join(path,".adit","adit.sqlite"),legacy=new Database(dbPath);
  legacy.exec(`CREATE TABLE ${table} (project_id TEXT); INSERT INTO ${table} VALUES ('saved-project'),('saved-project')`);
  if(table==="project_link_cache")legacy.exec("CREATE TABLE sessions (project_id TEXT); INSERT INTO sessions VALUES ('older-session-project')");
  legacy.close();const before=readFileSync(dbPath);
  expect(store.saveWorkspace({path,repositories:[join(path,"repo")]}).id).toBe("saved-project");
  expect(readFileSync(dbPath)).toEqual(before);
});
it("allows new directories with an empty old database and rejects genuinely ambiguous or unreadable identities",()=>{
  const {store,path,root}=fixture();mkdirSync(join(path,".adit"));
  writeFileSync(join(path,".adit","adit.sqlite"),"");
  expect(store.saveWorkspace({path}).id).toMatch(/^[a-f0-9-]{36}$/);
  const other=join(root,"ambiguous");mkdirSync(join(other,".adit"),{recursive:true});
  const dbPath=join(other,".adit","adit.sqlite"),legacy=new Database(dbPath);
  legacy.exec("CREATE TABLE sessions (project_id TEXT); INSERT INTO sessions VALUES ('first'),('second')");legacy.close();
  expect(()=>store.saveWorkspace({path:other})).toThrow(/multiple project identities/);
  writeFileSync(dbPath,"not a database");
  expect(()=>store.saveWorkspace({path:other})).toThrow(/Unable to read/);
  rmSync(dbPath);writeFileSync(join(other,".adit","workspace.json"),"not json");
  expect(()=>store.saveWorkspace({path:other})).toThrow(/configuration is unreadable/);
  expect(store.workspaces()).toHaveLength(1);
});
it("all device identity callers retain the original client-id, with database precedence",()=>{
  const {store,directory}=fixture();writeFileSync(join(directory,"client-id"),"old-client");
  expect(store.identity("client")).toBe("old-client");
  writeFileSync(join(directory,"client-id"),"different-value");
  expect(store.identity("client")).toBe("old-client");
});
