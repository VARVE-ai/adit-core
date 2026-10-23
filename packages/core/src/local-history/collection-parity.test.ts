import {afterEach,expect,it} from "vitest";
import Database from "better-sqlite3";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {zstdCompressSync} from "node:zlib";
import {createHistorySchema} from "./schema.js";
import {StructuredHistory} from "./structured-store.js";
import {claudeBranches} from "./claude-lineage.js";
import {parseCodexRows} from "./codex.js";
import {readCodexSession} from "./codex-file.js";
import {readCopilotPaw} from "./copilot-paw.js";
import {readVSCodeChat} from "./vscode-chat.js";
import {readOpenCodeDatabase} from "./opencode.js";
import {sourceFiles} from "./sources.js";
import {LocalHistory} from "./archive.js";
import {historyFinalReply} from "./message-semantics.js";
import type {HistorySession} from "./types.js";

const roots:string[]=[],dbs:Database.Database[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"adit-parity-"));roots.push(root);const db=new Database(":memory:");dbs.push(db);createHistorySchema(db);return {root,db,store:new StructuredHistory(db)};}
const jsonl=(rows:unknown[])=>rows.map(r=>JSON.stringify(r)).join("\n")+"\n";
const cu=(uuid:string,content:unknown,extra={})=>({type:"user",uuid,sessionId:"c",cwd:"D:/fixture",message:{role:"user",content},...extra});
const cx=(content:unknown)=>({type:"response_item",payload:{type:"message",role:"user",content}});
const meta={type:"session_meta",payload:{id:"cx",cwd:"D:/fixture"}};
const command=(name:string)=>`<command-name>/${name}</command-name><command-message>${name}</command-message><command-args></command-args>`;

it("normalizes Claude local commands without counting metadata and output as prompts",()=>{
  const f=fixture(),rows=[cu("m","<local-command-caveat>notice</local-command-caveat>",{isMeta:true}),cu("c",command("model"),{parentUuid:"m"}),cu("o","<local-command-stdout>Set model</local-command-stdout>",{parentUuid:"c"})];
  const s=claudeBranches(rows,"c.jsonl")[0];f.store.write(s);
  expect(s.messages.map(m=>m.content)).toEqual(["/model"]);
  expect(s.messages[0].raw.message).toEqual(rows[1].message);
  expect(f.db.prepare("SELECT user_prompt_count,first_prompt FROM adit_history_sessions").get()).toEqual({user_prompt_count:1,first_prompt:null});
  expect(claudeBranches([cu("u",command("usage"))],"c.jsonl")).toEqual([]);
  expect(claudeBranches([cu("u",command("usage")),cu("p","Actual question",{parentUuid:"u"})],"c.jsonl")).toHaveLength(1);
});

it.each(["<task-notification>done</task-notification>","[Request interrupted by user]","<ide_selection>context</ide_selection>","<system-reminder>notice</system-reminder>"])("classifies Claude native system content: %s",text=>{
  const f=fixture(),s=claudeBranches([cu("sys",text),cu("p","Question",{parentUuid:"sys"})],"c.jsonl")[0];f.store.write(s);
  expect(s.messages[0].role).toBe("system");expect(f.db.prepare("SELECT user_prompt_count FROM adit_history_sessions").get()).toEqual({user_prompt_count:1});
});
it("keeps Claude compact boundaries, mixed real prompts, quoted tags and images",()=>{
  const rows=[cu("c","summary",{isMeta:true,isCompactSummary:true}),cu("p","<ide_opened_file>a.ts</ide_opened_file>\nFix it",{parentUuid:"c"}),cu("q","Explain <task-notification>x</task-notification>",{parentUuid:"p"}),cu("i",[{type:"image",source:{type:"base64",data:"AA=="}}],{parentUuid:"q"})];
  const s=claudeBranches(rows,"c.jsonl")[0];expect(s.messages.map(m=>m.role)).toEqual(["system","user","user","user"]);
  expect(s.messages[1].content).toBe("Fix it");expect(s.messages[2].content).toBe(rows[2].message.content);expect(s.messages[3].content).toEqual(rows[3].message.content);
});
it("collects queued prompts in order and marks SDK worker origin without inventing a parent",()=>{
  const s=claudeBranches([cu("u","first",{timestamp:"2026-01-01T00:00:00Z",entrypoint:"sdk-cli",turnOrigin:"sdk",origin:{kind:"agent"}}),
    {type:"assistant",uuid:"a",parentUuid:"u",sessionId:"c",timestamp:"2026-01-01T00:00:02Z",message:{content:"answer"}},
    {type:"attachment",uuid:"q",parentUuid:"u",timestamp:"2026-01-01T00:00:01Z",attachment:{type:"queued_command",prompt:"also check tests"}}],"c.jsonl")[0];
  expect(s.messages.map(m=>m.key)).toEqual(["u","q","a"]);expect(s.metadata?.nativeSessionKind).toBe("subagent");expect(s.parentId).toBeUndefined();
  expect(claudeBranches([cu("u","human",{entrypoint:"sdk-cli",turnOrigin:"sdk",origin:{kind:"human"}})],"c.jsonl")[0].metadata?.nativeSessionKind).toBeUndefined();
  expect(claudeBranches([{type:"attachment",uuid:"only",sessionId:"c",cwd:"D:/fixture",attachment:{type:"queued_command",prompt:"Only queued prompt"}}],"c.jsonl")[0].messages[0].content).toBe("Only queued prompt");
});
it("handles a long Claude ancestry without recursively revisiting every prefix",()=>{
  const rows=Array.from({length:15000},(_,i)=>cu(`u${i}`,`question ${i}`,{parentUuid:i?`u${i-1}`:null}));
  expect(claudeBranches(rows,"c.jsonl")[0].messages).toHaveLength(15000);
});

it.each(["<environment_context>context</environment_context>","<goal_context>keep working</goal_context>",'<codex_internal_context source="goal">work</codex_internal_context>',"<subagent_notification>done</subagent_notification>"])("does not turn Codex context into a prompt: %s",text=>{
  const f=fixture(),s=parseCodexRows([meta,cx([{type:"input_text",text}]),cx([{type:"input_text",text:"Real prompt"}])]);f.store.write(s);
  expect(f.db.prepare("SELECT user_prompt_count,first_prompt FROM adit_history_sessions").get()).toEqual({user_prompt_count:1,first_prompt:"Real prompt"});
});
it("strips Codex injected blocks independently and retains quoted tags and image prompts",()=>{
  const s=parseCodexRows([meta,cx([{type:"input_text",text:"Real prompt"},{type:"input_text",text:"<environment_context>cwd</environment_context>"},{type:"input_text",text:"<skill>rules</skill>"},{type:"input_text",text:"<INSTRUCTIONS>rules</INSTRUCTIONS>\nKeep APIs"}]),cx([{type:"input_image",image_url:"data:image/png;base64,AA=="}]),cx([{type:"input_text",text:"Explain <INSTRUCTIONS>this</INSTRUCTIONS>"}])]);
  expect(s.messages[0].content).toEqual([{type:"input_text",text:"Real prompt"},{type:"input_text",text:""},{type:"input_text",text:""},{type:"input_text",text:"Keep APIs"}]);expect(s.messages[1].role).toBe("user");expect(s.messages[2].content).toEqual([{type:"input_text",text:"Explain <INSTRUCTIONS>this</INSTRUCTIONS>"}]);
  const f=fixture();f.store.write(s);f.db.prepare("INSERT INTO adit_history_text_edits VALUES (?,?,?,?,?,?)").run("codex","cx","message:0",3,"Keep edited APIs",1);f.store.write(s);
  expect((f.store.read("codex","cx")!.messages[0].content as {text:string}[])[3].text).toBe("Keep edited APIs");
});
it("uses delivered agent tasks, hides outgoing receipts and recognizes top-level parent identity",()=>{
  const am=(recipient:string,body:string)=>({type:"response_item",payload:{type:"agent_message",recipient,content:[{type:"input_text",text:"receipt"},{type:"encrypted_content",encrypted_content:body}]}});
  const s=parseCodexRows([{type:"session_meta",payload:{...meta.payload,thread_source:"subagent",parent_thread_id:"parent",agent_path:"/root/worker"}},am("/root/worker","Do the task"),am("/root","Sent result"),am("/root/worker","gAAAA"+"A".repeat(80))]);
  expect(s.parentId).toBe("parent");expect(s.messages).toHaveLength(1);expect(s.messages[0]).toMatchObject({role:"user",content:[{type:"input_text",text:"Do the task"}]});
});
it("reads TraeX append and usage events and rejects unsupported mutations without guessing",()=>{
  const rows=[meta,{type:"history_mutation",payload:{version:1,operation:"append",items:[{type:"message",role:"assistant",content:[{type:"output_text",text:"Done"}]}]}},{type:"token_usage_record",payload:{usage:{input_tokens:100,output_tokens:20}}}];
  expect(parseCodexRows(rows,undefined,undefined,"traex").messages[0].usage).toEqual({input_tokens:100,output_tokens:20});
  expect(parseCodexRows(rows).messages).toHaveLength(0);
  expect(()=>parseCodexRows([meta,{type:"history_mutation",payload:{operation:"replace"}}],undefined,undefined,"traex")).toThrow("mutation");
});
it("discovers and reads compressed Codex sources, preferring the plain sibling",async()=>{
  const f=fixture(),path=join(f.root,"rollout-cx.jsonl"),data=jsonl([{type:"session_meta",payload:{id:"cx",cwd:f.root}},cx([{type:"input_text",text:"hello"}])]);
  writeFileSync(path+".zst",zstdCompressSync(Buffer.from(data)));
  expect((await readCodexSession(path+".zst","codex",f.root))[0].messages[0].role).toBe("user");
  const history=new LocalHistory(f.db);expect((await history.scan(f.root,[{id:"codex",paths:[f.root]}],{preview:true})).counts).toEqual({codex:1});
  writeFileSync(path,data);const files=[];for await(const p of sourceFiles("codex",f.root))files.push(p);expect(files).toEqual([path]);
  writeFileSync(path+".zst",zstdCompressSync(Buffer.from(data)).subarray(0,12));await expect(readCodexSession(path+".zst","codex",f.root)).rejects.toBeDefined();
});

it("stores Copilot text, tool links and authoritative usage without summing repeated shutdown totals",async()=>{
  const f=fixture(),dir=join(f.root,"copilot/session-state/cp");mkdirSync(dir,{recursive:true});const path=join(dir,"events.jsonl");
  const usage={inputTokens:100,outputTokens:20,cacheReadTokens:30,cacheWriteTokens:10};
  writeFileSync(path,jsonl([{id:"s",type:"session.start",data:{sessionId:"cp",context:{cwd:f.root},selectedModel:"test"}},{id:"u",type:"user.message",data:{content:"Question"}},{id:"a",type:"assistant.message",data:{content:"Answer",toolRequests:[{toolCallId:"tc",name:"bash",arguments:{command:"git status"}}]}},{id:"start",type:"tool.execution_start",data:{toolCallId:"tc",toolName:"bash",arguments:{command:"git status"}}},{id:"result",type:"tool.execution_complete",data:{toolCallId:"tc",success:true,result:{content:"clean"}}},...Array.from({length:2},(_,i)=>({id:`end${i}`,type:"session.shutdown",data:{modelMetrics:{test:{usage}}}}))]));
  const s=(await readCopilotPaw(path,"copilot"))[0];f.store.write(s);f.store.write(s);
  expect(f.db.prepare("SELECT count(*) n FROM adit_history_tool_calls").get()).toEqual({n:1});
  expect(f.db.prepare("SELECT source_call_id,tool_call_id IS NOT NULL linked FROM adit_history_tool_results").get()).toEqual({source_call_id:"tc",linked:1});
  expect(f.db.prepare("SELECT input_total_tokens,uncached_input_tokens,cache_read_tokens,cache_write_tokens,output_tokens FROM adit_history_usage_entries WHERE ledger_role='canonical'").all()).toEqual([{input_total_tokens:100,uncached_input_tokens:60,cache_read_tokens:30,cache_write_tokens:10,output_tokens:20}]);
  expect(f.db.prepare("SELECT text_content FROM adit_history_blocks WHERE kind='text' AND text_content IS NOT NULL ORDER BY rowid").all()).toEqual([{text_content:"Question"},{text_content:"Answer"}]);
});
it("extracts VS Code reply text and native tool commands",async()=>{
  const f=fixture(),path=join(f.root,"vs.json");writeFileSync(path,JSON.stringify({sessionId:"vs",requests:[{requestId:"r",message:{text:"Question"},response:[{kind:"toolInvocationSerialized",toolId:"run_in_terminal",toolCallId:"tc",toolSpecificData:{commandLine:{original:"git status"}}},{kind:"markdownContent",value:"Answer"}]}]}));
  f.store.write((await readVSCodeChat(path,"vscode-copilot"))[0]);expect(f.db.prepare("SELECT text_content FROM adit_history_blocks WHERE kind='text' AND text_content IS NOT NULL ORDER BY rowid").all()).toEqual([{text_content:"Question"},{text_content:"Answer"}]);expect(f.db.prepare("SELECT command_text AS command FROM adit_history_tool_calls").get()).toEqual({command:"git status"}); const turn=f.db.prepare("SELECT id FROM adit_history_turns").get() as {id:string}; expect(historyFinalReply(f.db,turn.id,true)).toBeDefined();
});
it("normalizes OpenCode image-only prompts and v2 tool results into existing tables",()=>{
  const f=fixture(),path=join(f.root,"opencode.db"),native=new Database(path);try{native.exec("CREATE TABLE session_v2(id TEXT,directory TEXT,title TEXT);CREATE TABLE session_message(id TEXT,type TEXT,session_id TEXT,data TEXT,time_created INTEGER,seq INTEGER)");native.prepare("INSERT INTO session_v2 VALUES(?,?,?)").run("oc",f.root,"Title");const insert=native.prepare("INSERT INTO session_message VALUES(?,?,?,?,?,?)");insert.run("u","user","oc",JSON.stringify({text:"",files:[{name:"screen.png",mime:"image/png",data:"AA=="}]}),1,1);insert.run("a","assistant","oc",JSON.stringify({content:[{type:"text",text:"Done"},{type:"tool",id:"tc",name:"bash",state:{status:"completed",input:{command:"git status"},content:[{type:"text",text:"clean"}]}}]}),2,2);}finally{native.close();}
  const s=readOpenCodeDatabase(path,"opencode",f.root)[0];f.store.write(s);expect(f.db.prepare("SELECT user_prompt_count,first_prompt FROM adit_history_sessions").get()).toEqual({user_prompt_count:1,first_prompt:"[Attachment: screen.png]"});expect(f.db.prepare("SELECT count(*) n FROM adit_history_tool_calls").get()).toEqual({n:1});expect(f.db.prepare("SELECT source_call_id FROM adit_history_tool_results").get()).toEqual({source_call_id:"tc"});
});
