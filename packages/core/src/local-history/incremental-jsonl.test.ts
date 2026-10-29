import {afterEach,expect,it,vi} from "vitest";
import Database from "better-sqlite3";
import {mkdtempSync,appendFileSync,writeFileSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {LocalHistory} from "./archive.js";
import {StructuredHistory} from "./structured-store.js";
import {collectIncrementalJSONL} from "./incremental-jsonl.js";
import {SourceCheckpoints,trackSourceReads} from "./source-checkpoints.js";
import {readCodexSession} from "./codex-file.js";
import {readClaudeLineage} from "./claude-lineage.js";

const roots:string[]=[],dbs:Database.Database[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const lines=(...rows:unknown[])=>rows.map(r=>JSON.stringify(r)).join("\n")+"\n";
const prompt=(text:string)=>({type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text}]}});
const answer=(text:string)=>({type:"response_item",payload:{type:"message",role:"assistant",content:[{type:"output_text",text}]}});
function fixture(provider="codex") {
  const root=mkdtempSync(join(tmpdir(),"adit-jsonl-"));roots.push(root);const db=new Database(":memory:");dbs.push(db);new LocalHistory(db);
  const path=join(root,provider==="codex"?"rollout-s.jsonl":"s.jsonl"),key=process.platform==="win32"?path.toLowerCase():path;
  const scope=JSON.stringify([resolve(root),[root]]),full=vi.fn(()=>provider==="codex"?readCodexSession(path,provider,root):readClaudeLineage(path,provider));
  const collect=async(database=db)=>{
    const result=await trackSourceReads(path,()=>collectIncrementalJSONL(database,provider,path,scope,99,full));
    expect(result.stable).toBe(true);
    database.transaction(()=>{for(const s of result.value.sessions)new StructuredHistory(database).write(s);new SourceCheckpoints(database).save(provider,key,scope,99,result.manifest,result.value.sessions.map(s=>[provider,s.id]));result.value.commit();})();
    return result.value;
  };
  return {root,db,path,full,collect};
}
it("resumes Codex across restarts, preserving IDs, models and usage with full-parse equivalence",async()=>{
  const f=fixture();writeFileSync(f.path,lines({type:"session_meta",payload:{id:"s",cwd:f.root}},{type:"turn_context",payload:{turn_id:"t1",model:"model-a",effort:"high"}},prompt("First"),answer("Reply")));
  await f.collect();const before=new StructuredHistory(f.db).read("codex","s")!;
  appendFileSync(f.path,lines({type:"event_msg",payload:{type:"token_count",info:{last_token_usage:{input_tokens:100,cached_input_tokens:20,output_tokens:10}}}},{type:"event_msg",payload:{type:"task_complete"}},prompt("Next"),answer("Next reply")));
  expect((await f.collect()).usedAppend).toBe(true);expect(f.full).toHaveBeenCalledTimes(1);
  expect(new StructuredHistory(f.db).read("codex","s")).toEqual((await readCodexSession(f.path,"codex",f.root))[0]);
  expect(new StructuredHistory(f.db).read("codex","s")!.messages[0].key).toBe(before.messages[0].key);
  new LocalHistory(f.db);appendFileSync(f.path,lines(prompt("Third"),answer("Third reply")));
  expect((await f.collect()).usedAppend).toBe(true);expect(f.full).toHaveBeenCalledTimes(1);
  expect(new StructuredHistory(f.db).read("codex","s")).toEqual((await readCodexSession(f.path,"codex",f.root))[0]);
  expect(f.db.prepare("SELECT length(state_json)<4096 small FROM adit_history_jsonl_cursors").get()).toEqual({small:1});
  expect(f.db.pragma("foreign_key_check")).toEqual([]);
});
it.each(["codex", "claude"])("appends %s after raw compaction with the same history and digests as legacy storage", async provider => {
  const fixtureState = fixture(provider);
  const text = "long native message ".repeat(40);
  const claudeRow = (role: string, key: string, parent: string | null) => ({ type: role, uuid: key, parentUuid: parent,
    sessionId: "s", cwd: fixtureState.root, message: { id: `response-${key}`, role, content: text } });
  writeFileSync(fixtureState.path, provider === "codex"
    ? lines({ type: "session_meta", payload: { id: "s", cwd: fixtureState.root } }, prompt(text), answer(text))
    : lines(claudeRow("user", "prompt", null), claudeRow("assistant", "answer", "prompt")));
  await fixtureState.collect();
  expect(fixtureState.db.prepare("SELECT count(*) count FROM adit_history_messages WHERE raw_content_paths_json IS NOT NULL").get()).toEqual({ count: 2 });
  const legacy = new Database(fixtureState.db.serialize());
  dbs.push(legacy);
  const previous = new StructuredHistory(legacy).read(provider, "s")!;
  for (const message of previous.messages)
    legacy.prepare("UPDATE adit_history_messages SET raw_json=?,raw_content_paths_json=NULL WHERE source_key=?").run(JSON.stringify(message.raw), message.key);
  appendFileSync(fixtureState.path, provider === "codex" ? lines(prompt(text), answer(text))
    : lines(claudeRow("user", "next", "answer"), claudeRow("assistant", "final", "next")));
  expect((await fixtureState.collect()).usedAppend).toBe(true);
  expect((await fixtureState.collect(legacy)).usedAppend).toBe(true);
  expect(fixtureState.full).toHaveBeenCalledTimes(1);
  const expected = provider === "codex" ? await readCodexSession(fixtureState.path, provider, fixtureState.root)
    : await readClaudeLineage(fixtureState.path, provider);
  expect(new StructuredHistory(fixtureState.db).read(provider, "s")).toEqual(expected[0]);
  expect(fixtureState.db.prepare("SELECT * FROM adit_history_message_digests ORDER BY rowid").all())
    .toEqual(legacy.prepare("SELECT * FROM adit_history_message_digests ORDER BY rowid").all());
});
it("falls back on in-place prefix rewrite, truncation, and incomplete trailing records",async()=>{
  const f=fixture(),header={type:"session_meta",payload:{id:"s",cwd:f.root}};writeFileSync(f.path,lines(header,prompt("Before"),answer("Reply")));await f.collect();
  writeFileSync(f.path,readFileSync(f.path,"utf8").replace("Before","Edited")+lines(prompt("More")));
  expect((await f.collect()).usedAppend).toBe(false);expect(f.full).toHaveBeenCalledTimes(2);
  writeFileSync(f.path,lines(header,prompt("Short")));expect((await f.collect()).usedAppend).toBe(false);
  appendFileSync(f.path,'{"type":"response_item","payload":');await f.collect();expect(f.db.prepare("SELECT count(*) n FROM adit_history_jsonl_cursors").get()).toEqual({n:0});
  appendFileSync(f.path,JSON.stringify(answer("Finished").payload)+'}\n');expect((await f.collect()).usedAppend).toBe(false);
  expect(new StructuredHistory(f.db).read("codex","s")).toEqual((await readCodexSession(f.path,"codex",f.root))[0]);
});
it("keeps local edits and deletions on appended collection and cascades cursors on removal",async()=>{
  const f=fixture();writeFileSync(f.path,lines({type:"session_meta",payload:{id:"s",cwd:f.root}},prompt("First"),answer("Reply"),prompt("Delete me"),answer("Deleted reply")));await f.collect();
  f.db.prepare("INSERT INTO adit_history_text_edits VALUES (?,?,?,?,?,?)").run("codex","s","message:0",0,"Local correction",1);
  f.db.prepare("INSERT INTO adit_history_deleted_turns VALUES (?,?,?,?)").run("codex","s","message:2",1);
  appendFileSync(f.path,lines(prompt("New"),answer("New reply")));await f.collect();
  const s=new StructuredHistory(f.db).read("codex","s")!;expect(s.messages.map(m=>m.key)).toEqual(["message:0","message:1","message:4","message:5"]);expect(s.messages[0].content).toEqual([{type:"input_text",text:"Local correction"}]);
  f.db.prepare("UPDATE adit_history_text_edits SET text_content=?").run("<environment_context>My edited text</environment_context>");
  new StructuredHistory(f.db).write(s);
  appendFileSync(f.path,lines(prompt("Another turn"),answer("Another reply")));await f.collect();
  expect(new StructuredHistory(f.db).read("codex","s")!.messages[0]).toMatchObject({role:"user",content:[{type:"input_text",text:"<environment_context>My edited text</environment_context>"}]});
  f.db.prepare("DELETE FROM adit_history_sessions").run();expect(f.db.prepare("SELECT count(*) n FROM adit_history_jsonl_cursors").get()).toEqual({n:0});
});
it("keeps context classification and fallback IDs identical after appending filtered native rows",async()=>{
  const f=fixture();writeFileSync(f.path,lines({type:"session_meta",payload:{id:"s",cwd:f.root}},prompt("<environment_context>cwd</environment_context>"),prompt("First"),answer("Reply")));await f.collect();
  appendFileSync(f.path,lines(prompt("<goal_context>continue</goal_context>"),{type:"event_msg",payload:{type:"token_count",info:{last_token_usage:{input_tokens:5,output_tokens:2}}}},prompt("Next"),answer("Done")));
  await f.collect();expect(new StructuredHistory(f.db).read("codex","s")).toEqual((await readCodexSession(f.path,"codex",f.root))[0]);
  expect(f.db.prepare("SELECT user_prompt_count FROM adit_history_sessions").get()).toEqual({user_prompt_count:2});
});
it("appends linear Claude turns and falls back for streaming revisions and queued prompts",async()=>{
  const f=fixture("claude"),row=(type:string,uuid:string,parentUuid:string|null,content:string)=>({type,uuid,parentUuid,sessionId:"s",cwd:f.root,message:{role:type,content}});
  writeFileSync(f.path,lines(row("user","u",null,"Question"),row("assistant","a","u","Answer")));await f.collect();
  appendFileSync(f.path,lines(row("user","u2","a","Next"),row("assistant","a2","u2","Reply")));expect((await f.collect()).usedAppend).toBe(true);expect(f.full).toHaveBeenCalledTimes(1);
  expect(new StructuredHistory(f.db).read("claude","s")).toEqual((await readClaudeLineage(f.path,"claude"))[0]);
  appendFileSync(f.path,lines({...row("assistant","a2","u2","Revised"),message:{content:"Revised"}}));expect((await f.collect()).usedAppend).toBe(false);
  appendFileSync(f.path,lines({type:"attachment",uuid:"q",parentUuid:"a2",attachment:{type:"queued_command",prompt:"Queued"}}));expect((await f.collect()).usedAppend).toBe(false);expect(new StructuredHistory(f.db).read("claude","s")).toEqual((await readClaudeLineage(f.path,"claude"))[0]);
});
it("uses the same archive scan for first, appended and unchanged collection",async()=>{
  const f=fixture(),h=new LocalHistory(f.db),sources=[{id:"codex",paths:[f.root]}];writeFileSync(f.path,lines({type:"session_meta",payload:{id:"s",cwd:f.root}},prompt("First"),answer("Reply")));
  expect(await h.scan(f.root,sources)).toMatchObject({errors:[],updated:1});appendFileSync(f.path,lines(prompt("Second"),answer("Reply")));
  expect(await h.scan(f.root,sources)).toMatchObject({errors:[],updated:1});expect(await h.scan(f.root,sources)).toMatchObject({errors:[],updated:0});
  expect(f.db.prepare("SELECT user_prompt_count FROM adit_history_sessions").get()).toEqual({user_prompt_count:2});
});
