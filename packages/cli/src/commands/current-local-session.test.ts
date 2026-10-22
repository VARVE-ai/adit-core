import { afterEach,expect,it,vi } from "vitest";
import { mkdtempSync,mkdirSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { LocalStore } from "@varveai/adit-core";
import { createHistorySchema } from "../../../core/src/local-history/schema.js";
import { StructuredHistory } from "../../../core/src/local-history/structured-store.js";
import { currentLocalSession } from "./current-local-session.js";
import { syncKey } from "../local/cloud-projection.js";
import type { CurrentSessionDeps } from "./cloud-history.js";
vi.mock("@varveai/adit-cloud",async original=>({...await original<typeof import("@varveai/adit-cloud")>(),loadCredentials:()=>({accountId:"local-account",serverUrl:"http://localhost:3000"})}));
const resources:{root:string;store:LocalStore}[]=[];
afterEach(()=>{for(const {root,store} of resources.splice(0)){store.close();if(!resolve(root).startsWith(resolve(tmpdir())))throw new Error("Unsafe cleanup");rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}});
function fixture(){const root=mkdtempSync(join(tmpdir(),"adit-current-local-")),path=join(root,"project"),directory=join(root,"state");mkdirSync(path);const store=new LocalStore(directory);resources.push({root,store});createHistorySchema(store.db);const w=store.saveWorkspace({path,providers:["codex"]});const h=new StructuredHistory(store.db);h.write({provider:"codex",id:"native",cwd:path,messages:[{key:"u",role:"user",content:"test",timestamp:"2026-10-21T00:00:00Z",raw:{}}]});const cloud=vi.fn().mockResolvedValue({session:{title:"Cloud session",analysis:null}});const deps={cwd:path,env:{},serverUrl:"http://localhost:3000",now:new Date("2026-10-21T01:00:00Z"),cloud} as unknown as CurrentSessionDeps;return {path,directory,store,w,h,deps,cloud};}
it("resolves a collected session without an old .adit database and never sends native IDs to Cloud",async()=>{
  const {directory,w,deps,cloud}=fixture();
  const report=await currentLocalSession(deps,"native","codex",directory);
  expect(report).toMatchObject({state:"resolved",project:{id:w.id},session:{nativeId:"native",cloudId:null},cloud:{status:"notSynced"},local:{unsyncedEvents:null}});
  expect(cloud).not.toHaveBeenCalled();
});
it("resolves native segments as one current conversation instead of ambiguous candidates",async()=>{
 const {directory,path,h,deps}=fixture();
 h.write({provider:"codex",id:"native_page",cwd:path,parentId:"native",relationship:"continuation",messages:[{key:"p",role:"user",content:"continued",raw:{},timestamp:"2026-10-21T00:30:00Z"}]});
 const result=await currentLocalSession(deps,null,null,directory);expect(result).toMatchObject({state:"resolved",session:{nativeId:"native",lastEventAt:"2026-10-21T00:30:00.000Z"}});
 expect(result?.candidates).toHaveLength(1);
 expect(await currentLocalSession(deps,"native_page","codex",directory)).toMatchObject({state:"resolved",session:{nativeId:"native"}});
});
it("uses the current account's persisted Cloud mapping and returns ambiguity for several recent sessions",async()=>{
  const {directory,path,store,w,h,deps,cloud}=fixture();
  store.db.exec("CREATE TABLE adit_local_cloud_sessions(scope TEXT,provider TEXT,native_id TEXT,cloud_id TEXT)");
  store.db.prepare("INSERT INTO adit_local_cloud_sessions VALUES (?,'codex','native','cloud-id')").run(syncKey(deps.serverUrl,"local-account",w.id));
  const report=await currentLocalSession(deps,"native","codex",directory);
  expect(report?.session?.id).toBe("cloud-id");expect(cloud).toHaveBeenCalledWith("cloud-id");
  h.write({provider:"codex",id:"second",cwd:path,messages:[{key:"u",role:"user",content:"other",timestamp:"2026-10-21T00:30:00Z",raw:{}}]});
  expect(await currentLocalSession(deps,null,null,directory)).toMatchObject({state:"ambiguous",session:null});
});
