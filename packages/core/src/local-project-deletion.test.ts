import { afterEach, expect, it } from "vitest";
import { mkdtempSync,mkdirSync,rmSync,writeFileSync,existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { LocalStore } from "./local-state.js";
import { createHistorySchema } from "./local-history/schema.js";
import { StructuredHistory } from "./local-history/structured-store.js";
import { LocalSharing } from "./local-history/sharing.js";
import { LocalPrices } from "./local-history/pricing.js";
const resources:{root:string;store:LocalStore}[]=[];
afterEach(()=>{for(const {root,store} of resources.splice(0)){store.close();if(!resolve(root).startsWith(resolve(tmpdir())))throw new Error("Unsafe cleanup");rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}});
function fixture(){const root=mkdtempSync(join(tmpdir(),"adit-project-delete-")),path=join(root,"project"),nested=join(path,"child");mkdirSync(nested,{recursive:true});const store=new LocalStore(join(root,"state"));resources.push({root,store});createHistorySchema(store.db);const history=new StructuredHistory(store.db);return {root,path,nested,store,history};}
it("deletes exclusive history, publications and sync state, while keeping shared data and source files",()=>{
  const {path,nested,store,history}=fixture();
  const first=store.saveWorkspace({path,providers:["codex"],repositories:[path]}),other=store.saveWorkspace({path:nested,providers:["codex"],repositories:[nested]});
  writeFileSync(join(path,"source.txt"),"keep");
  for(const [id,cwd] of [["exclusive",path],["shared",nested]])history.write({provider:"codex",id,cwd,messages:[{key:"p",role:"user",content:`question ${id}`,timestamp:"2026-10-21T00:00:00Z",raw:{}},{key:"a",role:"assistant",content:"response",raw:{},usage:{input_tokens:20,output_tokens:3}}]});
  history.write({provider:"codex",id:"child-session",cwd:"",parentId:"exclusive",relationship:"subagent",messages:[]});
  const sharing=new LocalSharing(store.db,new LocalPrices(store.db));
  sharing.create(first,"codex","exclusive");sharing.create(other,"codex","shared");
  store.db.exec("CREATE TABLE adit_local_cloud_scopes(id TEXT PRIMARY KEY,workspace_id TEXT,baseline TEXT); CREATE TABLE adit_local_cloud_receipts(scope TEXT,kind TEXT,id TEXT,confirmed_at INTEGER); CREATE TABLE adit_local_cloud_sessions(scope TEXT,provider TEXT,native_id TEXT,cloud_id TEXT)");
  store.db.prepare("INSERT INTO adit_local_cloud_scopes VALUES ('scope',?,'{}')").run(first.id);
  store.db.exec("INSERT INTO adit_local_cloud_receipts VALUES ('scope','event','e',1);INSERT INTO adit_local_cloud_sessions VALUES ('scope','codex','exclusive','cloud')");
  store.set(`cloud-job:account:${first.id}`,{workspaceId:first.id,status:"done"});store.set("keep-global",true);
  for (const w of [first,other]) {
    store.db.prepare("INSERT INTO adit_attribution_runs(id,workspace_id,algorithm_version,input_fingerprint,status,started_at) VALUES (?,?,4,'x','done',1)").run(w.id,w.id);
    store.db.prepare("INSERT INTO adit_attribution_writers VALUES (?,?,?,'codex','writer','a.ts',500,0,0)").run(w.id,w.path,"sha");
    store.db.prepare("INSERT INTO adit_attribution_alternatives VALUES (?,?,?,'codex','writer','claude','alternative',0,5,0)").run(w.id,w.path,"sha");
    store.db.prepare("INSERT INTO adit_attribution_turns VALUES (?,?,?,'codex','original','turn')").run(w.id,w.path,"sha");
  }
  expect(store.deletionPreview(first.id)).toMatchObject({sessions:2,sharedSessions:1});
  store.deleteWorkspace(first.id,first.version);
  expect(store.db.prepare("SELECT id FROM adit_history_sessions").all()).toEqual([{id:"shared"}]);
  expect(store.db.prepare("SELECT count(*) n FROM adit_history_blocks WHERE text_content LIKE '%exclusive%'").get()).toEqual({n:0});
  expect(store.db.prepare("SELECT count(*) n FROM adit_history_blocks WHERE text_content LIKE '%shared%'").get()).toEqual({n:1});
  expect(store.db.prepare("SELECT workspace_id FROM adit_shares").all()).toEqual([{workspace_id:other.id}]);
  for(const table of ["adit_local_cloud_scopes","adit_local_cloud_receipts","adit_local_cloud_sessions"])expect(store.db.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({n:0});
  expect(store.get(`cloud-job:account:${first.id}`,null)).toBeNull();expect(store.get("keep-global",false)).toBe(true);
  for(const table of ["writers","alternatives","turns"]) expect(store.db.prepare(`SELECT run_id FROM adit_attribution_${table}`).all()).toEqual([{run_id:other.id}]);
  expect(store.db.pragma("foreign_key_check")).toEqual([]);expect(existsSync(join(path,"source.txt"))).toBe(true);
});
it("blocks publishing and keeps registration when file cleanup fails",()=>{
  const {path,store}=fixture(),w=store.saveWorkspace({path});
  expect(()=>store.deleteWorkspace(w.id,w.version,()=>{throw new Error("file locked");})).toThrow("file locked");
  expect(store.workspace(w.id).id).toBe(w.id);
  store.db.exec("CREATE TABLE adit_shares(id TEXT,workspace_id TEXT,status TEXT)");
  store.db.prepare("INSERT INTO adit_shares VALUES ('share',?,'publishing')").run(w.id);
  expect(()=>store.deleteWorkspace(w.id,w.version)).toThrow(/finish/);
});
it("clears the last history, restores searchable originals on rollback and permits subsequent collection",()=>{
  const {path,store,history}=fixture(),w=store.saveWorkspace({path,providers:["codex"],repositories:[path]});
  history.write({provider:"codex",id:"last",cwd:path,messages:[
    {key:"p",role:"user",content:"oldsearchmarker",raw:{}},
    {key:"call",role:"assistant",content:[{type:"tool_use",id:"native-call",name:"Bash",input:{command:"echo test"}}],raw:{}},
    {key:"result",role:"user",content:[{type:"tool_result",tool_use_id:"native-call",content:"toolresultmarker"}],raw:{}},
  ]});
  const db=store.db,search=(term:string)=>db.prepare("SELECT count(*) n FROM adit_history_blocks WHERE text_content LIKE ?").get(`%${term}%`);
  const original=search("oldsearchmarker");expect(original).toEqual({n:1});
  const before=db.prepare("SELECT * FROM adit_history_tool_results").all();expect(before).toHaveLength(1);
  db.exec("CREATE TRIGGER fail_project_delete BEFORE DELETE ON adit_history_sessions BEGIN SELECT RAISE(ABORT,'simulated deletion failure'); END");
  expect(()=>store.deleteWorkspace(w.id,w.version)).toThrow("simulated deletion failure");
  expect(search("oldsearchmarker")).toEqual(original);
  expect(db.prepare("SELECT * FROM adit_history_tool_results").all()).toEqual(before);
  expect(store.workspace(w.id).id).toBe(w.id);
  db.exec("DROP TRIGGER fail_project_delete");
  store.deleteWorkspace(w.id,w.version);
  for(const table of ["sessions","messages","blocks","tool_calls","tool_results"])
    expect(db.prepare(`SELECT count(*) n FROM adit_history_${table}`).get()).toEqual({n:0});
  history.write({provider:"codex",id:"new",cwd:path,messages:[{key:"p",role:"user",content:"newsearchmarker",raw:{}}]});
  expect(search("newsearchmarker")).toEqual({n:1});expect(search("oldsearchmarker")).toEqual({n:0});
  expect(db.pragma("foreign_key_check")).toEqual([]);
});
it("keeps unregistered history and retained tool results when deleting another project's calls",()=>{
  const {path,nested,store,history,root}=fixture();
  const w=store.saveWorkspace({path:nested,providers:["codex"],repositories:[nested]});
  history.write({provider:"codex",id:"owned",cwd:nested,messages:[
    {key:"p",role:"user",content:"deleteownedmarker",raw:{}},
    {key:"call",role:"assistant",content:[{type:"tool_use",id:"call",name:"Bash",input:{command:"echo x"}}],raw:{}},
  ]});
  history.write({provider:"codex",id:"unregistered",cwd:root,messages:[
    {key:"p",role:"user",content:"retainsearchmarker",raw:{}},
    {key:"result",role:"user",content:[{type:"tool_result",tool_use_id:"call",content:"retainedresultmarker"}],raw:{}},
  ]});
  const db=store.db;
  db.exec("UPDATE adit_history_tool_results SET tool_call_id=(SELECT id FROM adit_history_tool_calls WHERE session_id='owned') WHERE session_id='unregistered'");
  store.deleteWorkspace(w.id,w.version);
  expect(db.prepare("SELECT id FROM adit_history_sessions").all()).toEqual([{id:"unregistered"}]);
  expect(db.prepare("SELECT tool_call_id,content_text FROM adit_history_tool_results").all()).toEqual([{tool_call_id:null,content_text:"retainedresultmarker"}]);
  expect(db.prepare("SELECT count(*) n FROM adit_history_blocks WHERE text_content LIKE '%retainsearchmarker%'").get()).toEqual({n:1});
  expect(db.prepare("SELECT count(*) n FROM adit_history_blocks WHERE text_content LIKE '%deleteownedmarker%'").get()).toEqual({n:0});
  expect(db.pragma("foreign_key_check")).toEqual([]);
});
