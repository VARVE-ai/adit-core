import {afterEach, expect, it} from "vitest";
import {mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import Database from "better-sqlite3";
import {LocalStore} from "../local-state.js";
import {LocalHistory} from "./archive.js";
import {sourceDefinitions} from "./sources.js";
import {readAdditionalSource} from "./additional-sources.js";
import {qoderDesktopMetadata, readQoderDesktop} from "./qoder-desktop.js";

const cleanups: (()=>void)[]=[];
afterEach(()=>{for(const fn of cleanups.splice(0).reverse())fn();});
const id="12345678-1234-1234-1234-123456789abc";
const line=(role:string,text:string)=>JSON.stringify({role,message:{content:[{type:"text",text}]}})+"\n";
function fixture() {
  const home=mkdtempSync(join(tmpdir(),"adit-qoder-"));
  cleanups.push(()=>rmSync(home,{recursive:true,force:true}));
  const root=join(home,".qoder","cache","projects"),workspace=join(home,"workspace");
  const path=join(root,"workspace-1234","conversation-history",id.slice(0,8),id.slice(0,8)+".jsonl");
  mkdirSync(dirname(path),{recursive:true});mkdirSync(workspace);
  writeFileSync(path,line("user","<user_query>\n你好\n</user_query>")+line("assistant","你好！我是 Qoder。"));
  const dbPath=join(home,"AppData","Roaming","Qoder","SharedClientCache","cache","db","local.db");
  mkdirSync(dirname(dbPath),{recursive:true});
  const db=new Database(dbPath);cleanups.push(()=>db.close());db.pragma("journal_mode=WAL");
  db.exec(`CREATE TABLE chat_session(session_id TEXT PRIMARY KEY,session_title TEXT,project_uri TEXT,project_id TEXT,gmt_create INTEGER,gmt_modified INTEGER,parent_session_id TEXT);
    CREATE TABLE chat_message(id TEXT PRIMARY KEY,session_id TEXT,request_id TEXT,role TEXT,gmt_create INTEGER,token_info TEXT,model_info TEXT,content TEXT);
    CREATE TABLE auth_tokens(secret TEXT); INSERT INTO auth_tokens VALUES('must-not-read');`);
  db.prepare("INSERT INTO chat_session VALUES(?,?,?,?,?,?,?)").run(id,"Greeting",workspace,workspace,1700000000000,1700000001000,"");
  const insert=(mid:string,role:string,ts:number,usage:unknown={})=>db.prepare("INSERT INTO chat_message VALUES(?,?,?,?,?,?,?,?)")
    .run(mid,id,mid.startsWith("second")?"request2":"request1",role,ts,JSON.stringify(usage),JSON.stringify({model_key:"qfmodel"}),"encrypted-not-a-transcript");
  insert("user","user",1700000000000);
  insert("assistant","assistant",1700000001000,{prompt_tokens:17361,completion_tokens:132,cached_tokens:15360,max_input_tokens:200000});
  const store=new LocalStore(join(home,"adit-state"));cleanups.push(()=>store.close());
  const history=new LocalHistory(store.db),sources=[{id:"qoder",paths:[root]}];
  return {home,root,workspace,path,dbPath,db,store,history,sources,insert};
}

it("discovers the IDE cache using native full identity and cwd without reading transcript bodies",async()=>{
  const f=fixture();writeFileSync(f.path,"{invalid body deferred until collection}");
  const source=sourceDefinitions(f.home,{}).find(s=>s.id==="qoder")!;
  expect(source.paths).toContain(f.root);
  f.db.exec("DROP TABLE chat_message");
  expect(await f.history.scan(f.workspace,[source],{preview:true})).toMatchObject({counts:{qoder:1},errors:[],updated:0});
  expect(f.store.db.prepare("SELECT count(*) n FROM adit_history_sessions").get()).toEqual({n:0});
});

it("reads real desktop role/message envelopes and preserves raw text without archiving encrypted/auth fields",async()=>{
  const f=fixture(),[s]=await readAdditionalSource(f.path,"qoder");
  expect(s).toMatchObject({id,provider:"qoder",cwd:f.workspace,metadata:{title:"Greeting",nativeMetadataAligned:true},messages:[
    {key:"desktop:0",role:"user",timestamp:"2023-11-14T22:13:20.000Z",content:[{type:"text",text:"你好"}]},
    {key:"desktop:1",role:"assistant",model:"qfmodel",content:[{type:"text",text:"你好！我是 Qoder。"}],usage:{input_tokens:17361,output_tokens:132,cache_read_input_tokens:15360,adit_input_semantics:"includes_cache"}},
  ]});
  expect(JSON.stringify(s.messages[0].raw)).toContain("<user_query>");
  expect(JSON.stringify(s)).not.toContain("encrypted-not-a-transcript");expect(JSON.stringify(s)).not.toContain("must-not-read");
});

it("reuses unchanged checkpoints, appends rounds with stable keys, and does not double count cache tokens",async()=>{
  const f=fixture();
  expect(await f.history.scan(f.workspace,f.sources)).toMatchObject({updated:1,errors:[],counts:{qoder:1}});
  const usage=()=>f.store.db.prepare("SELECT input_total_tokens,uncached_input_tokens,cache_read_tokens,output_tokens,total_tokens FROM adit_history_usage_entries WHERE provider='qoder' AND ledger_role='canonical'").all();
  expect(usage()).toEqual([{input_total_tokens:17361,uncached_input_tokens:2001,cache_read_tokens:15360,output_tokens:132,total_tokens:17493}]);
  expect(await f.history.scan(f.workspace,f.sources)).toMatchObject({updated:0,errors:[]});
  appendFileSync(f.path,line("user","second question")+line("assistant","second answer"));
  f.insert("second-user","user",1700000002000);
  f.insert("second-assistant","assistant",1700000003000,{prompt_tokens:30,completion_tokens:5,cached_tokens:10});
  expect(await new LocalHistory(f.store.db).scan(f.workspace,f.sources)).toMatchObject({updated:1,errors:[],counts:{qoder:1}});
  expect(f.history.session("qoder",id)?.messages.map(m=>m.key)).toEqual(["desktop:0","desktop:1","desktop:2","desktop:3"]);
  expect(usage()).toHaveLength(2);
  expect(await f.history.scan(f.workspace,f.sources)).toMatchObject({updated:0,errors:[]});
});

it("refreshes usage when only the catalog WAL changes",async()=>{
  const f=fixture();await f.history.scan(f.workspace,f.sources);
  f.db.prepare("UPDATE chat_message SET token_info=? WHERE id='assistant'").run(JSON.stringify({prompt_tokens:17361,completion_tokens:140,cached_tokens:15360}));
  expect(await f.history.scan(f.workspace,f.sources)).toMatchObject({updated:1,errors:[]});
  expect(f.history.session("qoder",id)?.messages[1].usage?.output_tokens).toBe(140);
});

it("updates preview project matching when the catalog changes, and excludes other projects",async()=>{
  const f=fixture();expect((await f.history.scan(f.workspace,f.sources,{preview:true})).counts).toEqual({qoder:1});
  const other=join(f.home,"another-workspace");
  f.db.prepare("UPDATE chat_session SET project_uri=?").run(other);
  expect((await f.history.scan(f.workspace,f.sources,{preview:true})).counts).toEqual({});
  expect(await f.history.scan(f.workspace,f.sources)).toMatchObject({updated:0,counts:{},errors:[]});
  expect((await f.history.scan(other,f.sources)).counts).toEqual({qoder:1});
});

it("leaves missing metadata pending and retries when the full identity arrives",async()=>{
  const f=fixture();f.db.prepare("DELETE FROM chat_session").run();
  expect(await qoderDesktopMetadata(f.path)).toEqual({sessions:[],pending:true});
  expect((await f.history.scan(f.workspace,f.sources)).errors).toHaveLength(1);
  expect(f.history.session("qoder",id)).toBeUndefined();
  f.db.prepare("INSERT INTO chat_session(session_id,project_uri) VALUES(?,?)").run(id,f.workspace);
  expect(await f.history.scan(f.workspace,f.sources)).toMatchObject({counts:{qoder:1},errors:[]});
});

it("refuses colliding short identities instead of assigning the wrong session/project",async()=>{
  const f=fixture();f.db.prepare("INSERT INTO chat_session(session_id,project_uri) VALUES(?,?)").run("12345678-5678-1234-1234-123456789abc",join(f.home,"other"));
  await expect(readQoderDesktop(f.path)).rejects.toThrow("ambiguous");
});

it("retains original text on malformed replacement and does not bind metadata across unmatched sequences",async()=>{
  const f=fixture();await f.history.scan(f.workspace,f.sources);
  writeFileSync(f.path,"{broken}\n");
  expect((await f.history.scan(f.workspace,f.sources)).errors).toHaveLength(1);
  expect(f.history.session("qoder",id)?.messages).toHaveLength(2);
  writeFileSync(f.path,line("user","question only"));
  await expect(readQoderDesktop(f.path)).rejects.toThrow("not synchronized");
  expect((await f.history.scan(f.workspace,f.sources)).errors).toHaveLength(1);
  expect(f.history.session("qoder",id)?.messages[1].usage?.output_tokens).toBe(132);
  writeFileSync(f.path,"");
  expect((await f.history.scan(f.workspace,f.sources)).errors).toHaveLength(1);
  expect(f.history.session("qoder",id)?.messages).toHaveLength(2);
});

it("preserves attachments/tools and does not strip user-authored inline tags",async()=>{
  const f=fixture();writeFileSync(f.path,[
    {role:"user",message:{content:[{type:"text",text:"Explain <user_query>x</user_query>"},{type:"image",source:{type:"base64",data:"test"}}]}},
    {role:"assistant",message:{content:[{type:"tool_use",id:"call1",name:"read_file",input:{path:"README.md"}}]}},
    {role:"tool",message:{content:[{type:"tool_result",tool_use_id:"call1",content:"file text"}]}},
  ].map(r=>JSON.stringify(r)).join("\n")+"\n");
  f.insert("tool","tool",1700000002000);
  const [s]=await readQoderDesktop(f.path);
  expect(s.messages[0].content).toEqual([{type:"text",text:"Explain <user_query>x</user_query>"},{type:"image",source:{type:"base64",data:"test"}}]);
  expect((s.messages[1].content as any[])[0].type).toBe("tool_use");expect(s.messages[2].role).toBe("tool");
});

it("keeps the existing Qoder CLI/legacy parser intact",async()=>{
  const f=fixture(),path=join(f.home,"legacy.jsonl");
  writeFileSync(path,[{type:"user",uuid:"u",sessionId:"legacy",cwd:f.workspace,message:{role:"user",content:"legacy question"}},
    {type:"assistant",uuid:"a",parentUuid:"u",sessionId:"legacy",cwd:f.workspace,message:{role:"assistant",content:"legacy answer",usage:{input_tokens:5,cache_read_input_tokens:10,cache_creation_input_tokens:0,output_tokens:2}}}].map(r=>JSON.stringify(r)).join("\n")+"\n");
  writeFileSync(path.replace(".jsonl","-session.json"),JSON.stringify({title:"Legacy"}));
  expect((await readAdditionalSource(path,"qoder"))[0]).toMatchObject({id:"legacy",cwd:f.workspace,metadata:{title:"Legacy"},messages:[{role:"user"},{role:"assistant"}]});
  await f.history.scan(f.workspace,[{id:"qoder",paths:[path]}]);
  expect(f.store.db.prepare("SELECT input_semantics,input_total_tokens,total_tokens FROM adit_history_usage_entries WHERE session_id='legacy'").get())
    .toEqual({input_semantics:"excludes_cache",input_total_tokens:15,total_tokens:17});
});
