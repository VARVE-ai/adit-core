import Database from "better-sqlite3";
import {afterEach,expect,it} from "vitest";
import {createHistorySchema} from "./schema.js";
import {StructuredHistory} from "./structured-store.js";
import type {HistorySession} from "./types.js";

const databases:Database.Database[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
function fixture(){const db=new Database(":memory:");databases.push(db);createHistorySchema(db);return {db,store:new StructuredHistory(db)};}
function sample():HistorySession{return {provider:"claude",id:"s",cwd:"/work",metadata:{title:"Native title"},messages:[
  {key:"u",role:"user",timestamp:"2026-10-19T00:00:00Z",content:"查询历史记录",raw:{}},
  {key:"a",role:"assistant",timestamp:"2026-10-19T00:10:00Z",model:"model-a",effort:"high",content:[
    {type:"thinking",thinking:"private reasoning"},
    {type:"tool_use",id:"call-1",name:"Write",input:{file_path:"/work/a.ts",content:"export const answer = 42;"}},
  ],usage:{input_tokens:10,cache_read_input_tokens:20,cache_creation_input_tokens:5,output_tokens:8},raw:{requestId:"request-1",message:{id:"response-1"}}},
  {key:"t",role:"user",timestamp:"2026-10-19T00:10:01Z",content:[{type:"tool_result",tool_use_id:"call-1",content:"saved"}],raw:{}},
  {key:"a2",role:"assistant",timestamp:"2026-10-19T00:10:02Z",content:"done",raw:{}},
]};}
it("retains completed turns on append, reconciles usage groups and rebuilds only a changed suffix",()=>{
  const {db,store}=fixture(),first=sample();
  store.write(first);
  db.exec(`CREATE TEMP TABLE deleted_messages(id TEXT); CREATE TEMP TRIGGER count_deleted AFTER DELETE ON adit_history_messages
    BEGIN INSERT INTO deleted_messages VALUES (OLD.id); END;`);
  const second:HistorySession={...first,messages:[...first.messages,{key:"u2",role:"user",content:"next",raw:{}},
    {...first.messages[1],key:"duplicate-request"}]};
  store.write(second);
  expect(db.prepare("SELECT count(*) n FROM deleted_messages").get()).toEqual({n:0});
  expect(db.prepare("SELECT count(*) n FROM adit_history_usage_entries WHERE ledger_role='canonical'").get()).toEqual({n:1});
  const firstBlocks=db.prepare("SELECT b.rowid,b.* FROM adit_history_blocks b JOIN adit_history_messages m ON m.id=b.message_id WHERE m.ordinal<4 ORDER BY b.rowid").all();
  store.write({...second,messages:[...second.messages,{key:"last",role:"assistant",content:"final",raw:{}}]});
  expect(db.prepare("SELECT count(*) n FROM deleted_messages").get()).toEqual({n:2});
  expect(db.prepare("SELECT b.rowid,b.* FROM adit_history_blocks b JOIN adit_history_messages m ON m.id=b.message_id WHERE m.ordinal<4 ORDER BY b.rowid").all()).toEqual(firstBlocks);
  store.write(first);
  expect(store.read("claude","s")!.messages).toHaveLength(4);
  expect(db.prepare("SELECT ledger_role FROM adit_history_usage_entries").get()).toEqual({ledger_role:"canonical"});
  expect(db.prepare("SELECT count(*) n FROM adit_history_turns").get()).toEqual({n:1});
});
it("stores queryable messages, token columns, tools and original Chinese text without search copies",()=>{
  const {db,store}=fixture(),session=sample();db.transaction(()=>store.write(session))();
  expect((db.prepare("PRAGMA table_info(adit_history_sessions)").all() as {name:string}[]).some(c=>c.name==="data")).toBe(false);
  expect(db.prepare("SELECT title,message_count,user_prompt_count,started_at FROM adit_history_sessions").get()).toMatchObject({title:"Native title",message_count:4,user_prompt_count:1,started_at:Date.parse("2026-10-19T00:00:00Z")});
  expect(db.prepare("SELECT count(*) AS n FROM adit_history_turns").get()).toEqual({n:1});
  expect(db.prepare("SELECT model,input_total_tokens,uncached_input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,total_tokens FROM adit_history_usage_entries").get()).toEqual({model:"model-a",input_total_tokens:35,uncached_input_tokens:10,cache_read_tokens:20,cache_write_tokens:5,output_tokens:8,total_tokens:43});
  expect(db.prepare("SELECT tool_name,file_path FROM adit_history_tool_calls").get()).toEqual({tool_name:"Write",file_path:"/work/a.ts"});
  expect(db.prepare("SELECT content_text,tool_call_id FROM adit_history_tool_results").get()).toMatchObject({content_text:"saved",tool_call_id:expect.any(String)});
  expect(db.prepare("SELECT content_text FROM adit_history_edit_evidence").get()).toEqual({content_text:"export const answer = 42;"});
  expect(db.prepare("SELECT count(*) AS n FROM adit_history_blocks WHERE text_content LIKE ?").get('%历史记录%')).toEqual({n:1});
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'adit_history_text_fts%'").all()).toEqual([]);
  expect(JSON.parse(JSON.stringify(store.read("claude","s")))).toEqual(JSON.parse(JSON.stringify(session)));
});
it("keeps missing and zero usage distinct, normalizes inclusive input, and does not add reasoning twice",()=>{
  const {db,store}=fixture();
  store.write({provider:"codex",id:"s",cwd:"/work",messages:[
    {key:"missing",role:"assistant",content:"missing",usage:{output_tokens:0},raw:{}},
    {key:"zero",role:"assistant",content:"zero",usage:{input_tokens:0,cached_input_tokens:0,output_tokens:0},raw:{}},
    {key:"normal",role:"assistant",content:"normal",usage:{input_tokens:100,cached_input_tokens:80,output_tokens:20,reasoning_output_tokens:10},raw:{}},
  ]});
  expect(db.prepare("SELECT input_total_tokens,uncached_input_tokens,output_tokens,total_tokens FROM adit_history_usage_entries ORDER BY rowid").all()).toEqual([
    {input_total_tokens:null,uncached_input_tokens:null,output_tokens:0,total_tokens:null},
    {input_total_tokens:0,uncached_input_tokens:0,output_tokens:0,total_tokens:0},
    {input_total_tokens:100,uncached_input_tokens:20,output_tokens:20,total_tokens:120},
  ]);
});
it("supersedes duplicate native request observations and retains overlapping session totals as observations",()=>{
  const {db,store}=fixture(),session=sample();
  session.messages.push({...session.messages[1],key:"stream-revision"});
  session.metadata!.usage={input_tokens:100,output_tokens:50};
  store.write(session);
  expect(db.prepare("SELECT count(*) AS n FROM adit_history_usage_entries WHERE ledger_role='canonical'").get()).toEqual({n:1});
  expect(db.prepare("SELECT count(*) AS n FROM adit_history_usage_observations").get()).toEqual({n:3});
  expect(db.prepare("SELECT ledger_role,exclusion_reason FROM adit_history_usage_entries WHERE scope='session'").get()).toEqual({ledger_role:"observation",exclusion_reason:"session_total_may_overlap_message_usage"});
});
it("replaces derived rows atomically, removes stale search entries and cascades session deletion",()=>{
  const {db,store}=fixture(),session=sample();store.write(session);
  const before=db.prepare("SELECT count(*) AS n FROM adit_history_blocks").get();
  expect(()=>db.transaction(()=>{store.write({...session,messages:[]});throw new Error("rollback");})()).toThrow("rollback");
  expect(db.prepare("SELECT count(*) AS n FROM adit_history_blocks").get()).toEqual(before);
  db.transaction(()=>store.write({...session,messages:[{key:"new",role:"user",content:"replacement",raw:{}}]}))();
  expect(db.prepare("SELECT count(*) AS n FROM adit_history_blocks WHERE text_content LIKE ?").get('%历史记录%')).toEqual({n:0});
  expect(db.prepare("SELECT count(*) AS n FROM adit_history_usage_entries").get()).toEqual({n:0});
  expect(db.prepare("SELECT count(*) AS n FROM adit_history_edit_evidence").get()).toEqual({n:0});
  db.prepare("DELETE FROM adit_history_sessions").run();
  for(const table of ["messages","blocks","turns","work_intervals","tool_calls","tool_results","usage_observations","usage_entries"])
    expect(db.prepare(`SELECT count(*) AS n FROM adit_history_${table}`).get()).toEqual({n:0});
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'adit_history_text_fts%'").all()).toEqual([]);
});
it("caps evidenced work gaps at five minutes and leaves missing timestamps unknown",()=>{
  const {db,store}=fixture();const session=sample();session.messages=session.messages.slice(0,2);store.write(session);
  expect(db.prepare("SELECT work_duration_ms FROM adit_history_turns").get()).toEqual({work_duration_ms:300_000});
  session.messages[0].timestamp=undefined;store.write(session);
  expect(db.prepare("SELECT work_duration_ms,duration_status FROM adit_history_turns").get()).toEqual({work_duration_ms:null,duration_status:"partial"});
});
it("refuses the old JSON schema without deleting or silently migrating it",()=>{
  const db=new Database(":memory:");databases.push(db);db.exec("CREATE TABLE adit_history_sessions(provider TEXT,id TEXT,data TEXT); INSERT INTO adit_history_sessions VALUES('old','s','{}')");
  expect(()=>createHistorySchema(db)).toThrow("automatic migration is disabled");
  expect(db.prepare("SELECT data FROM adit_history_sessions").get()).toEqual({data:"{}"});
});
