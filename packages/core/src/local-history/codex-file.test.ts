import {afterEach,expect,it} from "vitest";
import {mkdtempSync,writeFileSync,appendFileSync,rmSync,mkdirSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {zstdCompressSync} from "node:zlib";
import Database from "better-sqlite3";
import {LocalHistory} from "./archive.js";
import {codexFileRows,refreshCodexContinuations,refreshCodexContexts} from "./codex-file.js";
import {historyFinalReply,nativeContextSql} from "./message-semantics.js";
import {StructuredHistory} from "./structured-store.js";
import {parseCodex} from "./parsers.js";
import {sourceFiles} from "./sources.js";
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"adit-stream-"));roots.push(root);return root;}
it("recognizes old unflagged compaction by native evidence and upgrades metadata without replaying history",async()=>{
 const root=fixture(),path=join(root,'rollout-old.jsonl');
 const rows=[{type:'session_meta',payload:{id:'old',cwd:root}},
  {type:'response_item',payload:{type:'message',id:'p',role:'user',content:'question'}},
  {type:'response_item',payload:{type:'message',id:'answer',role:'assistant',phase:'final_answer',content:'## Task and Scope\nReal reply'}},
  {type:'event_msg',payload:{type:'task_complete'}},
  {type:'response_item',payload:{type:'message',id:'summary',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'generated context'}]}},
  {type:'token_usage_record',payload:{}},
  {type:'compacted',payload:{message:'Native resume prefix\ngenerated context'}}];
 writeFileSync(path,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
 const parsed=parseCodex(rows.map(r=>JSON.stringify(r)).join('\n'));
 expect(parsed.messages.find(m=>m.key==='summary')?.contextKind).toBe('compaction');
 expect(parsed.messages.find(m=>m.key==='answer')?.contextKind).toBeUndefined();
 const db=new Database(':memory:');try{
  const archive=new LocalHistory(db);await archive.scan(root,[{id:'codex',paths:[root]}]);
  db.exec("UPDATE adit_history_sessions SET metadata_json=json_remove(metadata_json,'$.nativeContextVersion'); UPDATE adit_history_messages SET extra_json=json_remove(extra_json,'$.contextKind')");
  const before=db.prepare('SELECT id,source_key,raw_json,content_json FROM adit_history_messages ORDER BY id').all();
  const sources=db.prepare('SELECT * FROM adit_history_sources').all();
  expect(refreshCodexContexts(db)).toBe(1);expect(refreshCodexContexts(db)).toBe(0);
  expect(db.prepare('SELECT id,source_key,raw_json,content_json FROM adit_history_messages ORDER BY id').all()).toEqual(before);
  expect(db.prepare('SELECT * FROM adit_history_sources').all()).toEqual(sources);
  const turn=db.prepare('SELECT id FROM adit_history_turns LIMIT 1').get() as {id:string};
  const answer=db.prepare("SELECT id FROM adit_history_messages WHERE source_key='answer'").get() as {id:string};
  expect(historyFinalReply(db,turn.id,false)?.id).toBe(answer.id);
  expect(db.prepare(`SELECT source_key FROM adit_history_messages m WHERE ${nativeContextSql()}`).all()).toEqual([{source_key:'summary'}]);
 }finally{db.close();}
 const unmatched=rows.slice(0,-1).concat({type:'compacted',payload:{message:'different summary'}});
 expect(parseCodex(unmatched.map(r=>JSON.stringify(r)).join('\n')).messages.at(-1)?.contextKind).toBeUndefined();
});
it("recognizes chained native pages without merging a real fork or changing message identities",async()=>{
 const root=fixture(),id='11111111-1111-1111-1111-111111111111',a='22222222-2222-2222-2222-222222222222',b='33333333-3333-3333-3333-333333333333';
 const db=new Database(':memory:');try{
  const archive=new LocalHistory(db);
  for(const [page,base] of [[a,id],[b,a]]){
   const path=join(root,`rollout-${id}_${page}.jsonl`);
   writeFileSync(path,[{type:'session_meta',payload:{id,session_id:id,cwd:root,history_base:{thread_id:base}}},
    {type:'response_item',payload:{type:'message',id:page,role:'user',content:'question '+page}}].map(r=>JSON.stringify(r)).join('\n')+'\n');
  }
  expect(await archive.scan(root,[{id:'codex',paths:[root]}])).toMatchObject({errors:[],counts:{codex:1}});
  const rows=db.prepare('SELECT id,parent_id,relationship FROM adit_history_sessions ORDER BY id').all();
  expect(rows).toEqual([a,b].map(page=>({id:`${id}_${page}`,parent_id:id,relationship:'continuation'})));
  const messages=db.prepare('SELECT id,content_json FROM adit_history_messages ORDER BY id').all();
  db.prepare("UPDATE adit_history_sessions SET relationship='fork',parent_id=? WHERE id=?").run(`${id}_${a}`,`${id}_${b}`);
  expect(refreshCodexContinuations(db)).toBe(1);expect(refreshCodexContinuations(db)).toBe(0);
  expect(db.prepare('SELECT id,content_json FROM adit_history_messages ORDER BY id').all()).toEqual(messages);
  for(const extra of [{forked_from_id:'other'},{session_id:'other'}]){
   const text=JSON.stringify({type:'session_meta',payload:{id,session_id:id,cwd:root,history_base:{thread_id:a},...extra}});
   expect(parseCodex(text,undefined,join(root,`rollout-${id}_${b}.jsonl`)).relationship).toBe('fork');
  }
 }finally{db.close();}
});
it("retains incremental page checkpoints while identifying a proven native continuation",async()=>{
 const root=fixture(),id="11111111-1111-1111-1111-111111111111",page="22222222-2222-2222-2222-222222222222";
 const first=join(root,`rollout-first-${id}.jsonl`),second=join(root,`rollout-second-${id}_${page}.jsonl`);
 const content=(meta:object,prompt:string)=>[{type:"session_meta",payload:{id,session_id:id,cwd:root,...meta}},
   {type:"response_item",timestamp:"2026-10-21T00:00:00Z",payload:{type:"message",role:"user",content:prompt}}].map(v=>JSON.stringify(v)).join("\n")+"\n";
 writeFileSync(first,content({},"first"));const text=content({history_base:{thread_id:id,end_ordinal_exclusive:2}},"later");writeFileSync(second,text);
 const db=new Database(":memory:");try {
  const archive=new LocalHistory(db),sources=[{id:"codex",paths:[root]}];
  expect(await archive.scan(root,sources)).toMatchObject({errors:[],counts:{codex:1},updated:2});
  expect(archive.session("codex",`${id}_${page}`)).toMatchObject({parentId:id,relationship:"continuation",metadata:{nativeSessionId:id}});
  expect(await archive.scan(root,sources)).toMatchObject({errors:[],updated:0});
  appendFileSync(second,JSON.stringify({type:"response_item",payload:{type:"message",role:"assistant",content:"answer"}})+"\n");
  expect(await archive.scan(root,sources)).toMatchObject({errors:[],counts:{codex:1},updated:1});
  const before=db.prepare("SELECT id,source_key FROM adit_history_messages ORDER BY id").all();
  db.prepare("UPDATE adit_history_sessions SET relationship='fork' WHERE id=?").run(`${id}_${page}`);
  expect(refreshCodexContinuations(db)).toBe(1);expect(refreshCodexContinuations(db)).toBe(0);
  expect(db.prepare("SELECT id,source_key FROM adit_history_messages ORDER BY id").all()).toEqual(before);
  const fork=parseCodex(content({forked_from_id:"other",history_base:{thread_id:id}},"fork"),undefined,second);
  expect(fork.relationship).toBe("fork");new StructuredHistory(db).write(fork);writeFileSync(second,content({forked_from_id:"other",history_base:{thread_id:id}},"fork"));
  expect(refreshCodexContinuations(db)).toBe(0);
 }finally{db.close();}
});
it("collects a Codex source beyond 128 MiB without loading its whole transcript",async()=>{
 const root=fixture(),path=join(root,"rollout-large.jsonl");writeFileSync(path,JSON.stringify({type:"session_meta",payload:{id:"large",cwd:root}})+"\n");const record=JSON.stringify({type:"diagnostic",padding:"x".repeat(1024*1024)})+"\n";for(let i=0;i<129;i++)appendFileSync(path,record);
 appendFileSync(path,JSON.stringify({type:"response_item",payload:{type:"message",role:"user",content:"last message"}})+"\n");expect(statSync(path).size).toBeGreaterThan(128*1024*1024);
 const db=new Database(":memory:");try{const history=new LocalHistory(db),result=await history.scan(root,[{id:"codex",paths:[root]}]);expect(result.errors).toEqual([]);expect(result.counts).toEqual({codex:1});expect(history.session("codex","large")?.messages).toMatchObject([{content:"last message"}]);}finally{db.close();}
});
it("ignores only an unfinished final record and reports malformed complete records",()=>{
 const root=fixture(),path=join(root,"rollout-tail.jsonl");writeFileSync(path,'{"type":"session_meta","payload":{"id":"s"}}\n{"type":');expect([...codexFileRows(path)]).toHaveLength(1);appendFileSync(path,"invalid}\n");expect(()=>[...codexFileRows(path)]).toThrow("line 2");
});
it.each([false,true])("preserves compressed records across read boundaries (concatenated frames: %s)",concatenated=>{
 const root=fixture(),path=join(root,"rollout-chunks.jsonl.zst");
 // Deterministic, poorly compressible data forces several 1 MiB input reads.
 let seed=123456789;
 const rows:Record<string,unknown>[]=[{type:"session_meta",payload:{id:"chunks",cwd:root}}];
 for(let i=0;i<48;i++){
  const bytes=Buffer.alloc(64*1024);
  for(let j=0;j<bytes.length;j++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;bytes[j]=seed&255;}
  rows.push({type:"diagnostic",index:i,text:"跨块内容",data:bytes.toString("base64")});
 }
 rows.push({type:"response_item",payload:{type:"message",role:"user",content:"last record"}});
 const encode=(records:Record<string,unknown>[])=>zstdCompressSync(Buffer.from(records.map(row=>JSON.stringify(row)).join("\n")+"\n"));
 const compressed=concatenated?Buffer.concat([encode(rows.slice(0,25)),encode(rows.slice(25))]):encode(rows);
 expect(compressed.length).toBeGreaterThan(2*1024*1024);
 writeFileSync(path,compressed);
 expect([...codexFileRows(path)]).toEqual(rows);
 // A real truncated archive must still fail, rather than silently losing rows.
 writeFileSync(path,compressed.subarray(0,compressed.length-32));
 expect(()=>[...codexFileRows(path)]).toThrow();
});
it("discovers Cursor's direct database without descending into unrelated extension directories",async()=>{
 const root=fixture(),path=join(root,"state.vscdb");writeFileSync(path,"");mkdirSync(join(root,...Array(15).fill("extension-cache")),{recursive:true});const paths=[];for await(const file of sourceFiles("cursor-ide",root))paths.push(file);expect(paths).toEqual([path]);const explicit=[];for await(const file of sourceFiles("cursor-ide",path))explicit.push(file);expect(explicit).toEqual([path]);
});
it("updates Cursor composers while retaining archived content for empty bubbles without blocking collection",async()=>{
 const root=fixture(),path=join(root,"state.vscdb"),source=new Database(path),db=new Database(":memory:");
 try{
  source.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY,value TEXT)");
  const set=(key:string,value:unknown)=>source.prepare("INSERT OR REPLACE INTO cursorDiskKV VALUES (?,?)").run(key,JSON.stringify(value));
  for(const id of ["complete","unfinished"]){set(`composerData:${id}`,{workspaceIdentifier:{uri:{fsPath:root}},fullConversationHeadersOnly:[{bubbleId:"u",type:1}]});set(`bubbleId:${id}:u`,{type:1,text:"original"});}
  const history=new LocalHistory(db),sources=[{id:"cursor-ide",paths:[root]}];
  expect((await history.scan(root,sources)).counts).toEqual({"cursor-ide":2});
  set("bubbleId:complete:u",{type:1,text:"updated"});set("bubbleId:unfinished:u",{type:1,text:""});
  const result=await history.scan(root,sources);expect(result.errors).toHaveLength(0);expect(result.updated).toBe(1);
  expect(history.session("cursor-ide","complete")?.messages[0].content).toBe("updated");
  expect(history.session("cursor-ide","unfinished")?.messages[0].content).toBe("original");
  expect((await history.scan(root,sources)).errors).toHaveLength(0);
  expect(history.session("cursor-ide","unfinished")?.messages[0].content).toBe("original");
 }finally{source.close();db.close();}
});
it("skips empty Cursor placeholders and collects their content after it becomes available",async()=>{
 const root=fixture(),path=join(root,"state.vscdb"),source=new Database(path),db=new Database(":memory:");
 try{
  source.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY,value TEXT)");
  const set=(key:string,value:unknown)=>source.prepare("INSERT OR REPLACE INTO cursorDiskKV VALUES (?,?)").run(key,JSON.stringify(value));
  set("composerData:session",{workspaceIdentifier:{uri:{fsPath:root}},fullConversationHeadersOnly:[{bubbleId:"u",type:1},{bubbleId:"empty",type:2},{bubbleId:"a",type:2}]});
  set("bubbleId:session:u",{type:1,text:"question"});set("bubbleId:session:empty",{type:2,text:"  \n"});set("bubbleId:session:a",{type:2,text:"answer"});
  const history=new LocalHistory(db),sources=[{id:"cursor-ide",paths:[root]}];
  expect(await history.scan(root,sources)).toMatchObject({errors:[],counts:{"cursor-ide":1}});
  expect(history.session("cursor-ide","session")?.messages.map(message=>message.key)).toEqual(["u","a"]);
  expect(await history.scan(root,sources)).toMatchObject({errors:[],updated:0});
  set("bubbleId:session:empty",{type:2,text:"completed later"});
  expect(await history.scan(root,sources)).toMatchObject({errors:[],updated:1});
  expect(history.session("cursor-ide","session")?.messages.map(message=>message.key)).toEqual(["u","empty","a"]);
 }finally{source.close();db.close();}
});
