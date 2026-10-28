import {afterEach,expect,it} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import Database from "better-sqlite3";
import {readDesktopDatabase} from "./desktop-databases.js";
import {readLegacyExtension} from "./legacy-extensions.js";
import {readAider} from "./aider.js";
import {readHermesTranscript} from "./hermes-transcripts.js";
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"adit-desktop-"));roots.push(root);return root;}
function write(path:string,value:unknown,lines=false){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,lines?(value as unknown[]).map(v=>JSON.stringify(v)).join("\n")+"\n":JSON.stringify(value));}
it("preserves Warp's recorded query and native metrics without inventing assistant prose",()=>{
 const root=fixture(),path=join(root,"warp.sqlite"),db=new Database(path);db.exec("CREATE TABLE agent_conversations(conversation_id TEXT,conversation_data TEXT);CREATE TABLE ai_queries(conversation_id TEXT,input TEXT,working_directory TEXT,model_id TEXT)");db.prepare("INSERT INTO agent_conversations VALUES(?,?)").run("s",JSON.stringify({usage:{output_tokens:5}}));db.prepare("INSERT INTO ai_queries VALUES(?,?,?,?)").run("s",JSON.stringify({text:"question"}),root,"model");db.close();expect(readDesktopDatabase(path,"warp")[0]).toMatchObject({cwd:root,messages:[{role:"user",model:"model",content:{text:"question"}}],metadata:{nativeMetrics:{usage:{output_tokens:5}}}});
});
it("reads Piebald text nodes, native usage and tool state while excluding disabled messages",()=>{
 const root=fixture(),path=join(root,"app.db"),db=new Database(path);db.exec("CREATE TABLE chats(id INTEGER,current_directory TEXT,is_deleted INTEGER);CREATE TABLE messages(id INTEGER,parent_chat_id INTEGER,role TEXT,enabled INTEGER,input_tokens INTEGER);CREATE TABLE message_parts(id INTEGER,parent_chat_message_id INTEGER,part_type TEXT,part_index INTEGER);CREATE TABLE message_content_nodes(id INTEGER,parent_text_part_id INTEGER,node_index INTEGER,node_type TEXT);CREATE TABLE message_node_text(node_id INTEGER,content TEXT)");db.prepare("INSERT INTO chats VALUES(?,?,?)").run(1,root,0);db.exec("INSERT INTO messages VALUES(1,1,'assistant',1,7),(2,1,'user',0,0);INSERT INTO message_parts VALUES(10,1,'text',0);INSERT INTO message_content_nodes VALUES(100,10,0,'text');INSERT INTO message_node_text VALUES(100,'answer')");db.close();const [result]=readDesktopDatabase(path,"piebald");expect(result.cwd).toBe(root);expect(result.messages).toHaveLength(1);expect(result.messages[0]).toMatchObject({role:"assistant",usage:{input_tokens:7},content:[{text:["answer"]}]});
});
it("keeps Omnigent workspace identities separate and inherits subagent workspace evidence",()=>{
 const root=fixture(),path=join(root,"chat.db"),db=new Database(path);db.exec("CREATE TABLE conversations(workspace_id TEXT,id TEXT,root_conversation_id TEXT,kind TEXT,workspace TEXT);CREATE TABLE conversation_items(workspace_id TEXT,conversation_id TEXT,position INTEGER,type TEXT,data TEXT)");const conv=db.prepare("INSERT INTO conversations VALUES(?,?,?,?,?)");conv.run("w","parent",null,"root",root);conv.run("w","child","parent","sub_agent",null);db.prepare("INSERT INTO conversation_items VALUES(?,?,?,?,?)").run("w","child",0,"2",JSON.stringify({role:"assistant",content:"answer"}));db.close();expect(readDesktopDatabase(path,"omnigent")[1]).toMatchObject({id:"w:child",cwd:root,parentId:"w:parent",relationship:"subagent",messages:[{role:"assistant",content:"answer"}]});
});
it.each(["roocode","kilo-legacy"])("reads %s's initial human task, tool output and separate native usage",async provider=>{
 const root=fixture(),path=join(root,"task","ui_messages.json");write(path,[{say:"text",text:"initial task",ts:1700000000000},{say:"api_req_started",text:JSON.stringify({tokensIn:7,tokensOut:3})},{say:"text",text:"answer"},{say:"command_output",text:"result"},{say:"text",text:"partial",partial:true}]);write(join(dirname(path),provider==="roocode"?"history_item.json":"task_metadata.json"),{workspace:root});const [result]=await readLegacyExtension(path,provider);expect(result.messages.map(m=>m.role)).toEqual(["user","assistant","tool"]);expect(result.metadata?.usageEvents).toEqual([{tokensIn:7,tokensOut:3}]);expect(result.cwd).toBe(root);
});
it("keeps Cowork in its own provider with native task title",async()=>{
 const root=fixture(),path=join(root,"local_task","projects","project","session.jsonl");write(join(root,"local_task.json"),{title:"native title"});write(path,[{type:"user",uuid:"u",sessionId:"s",cwd:root,message:{role:"user",content:"question"}},{type:"assistant",uuid:"a",parentUuid:"u",sessionId:"s",cwd:root,message:{role:"assistant",content:"answer"}}],true);expect((await readLegacyExtension(path,"cowork"))[0]).toMatchObject({provider:"cowork",cwd:root,metadata:{title:"native title"},messages:[{role:"user"},{role:"assistant"}]});
});
it("splits Aider runs without inventing message timestamps",async()=>{
 const root=fixture(),path=join(root,".aider.chat.history.md");writeFileSync(path,"# aider chat started at 2026-10-01 12:00:00\n#### question\n\nanswer\n> command output\n# aider chat started at 2026-10-02 12:00:00\n#### next\n\nsecond answer\n");const sessions=await readAider(path);expect(sessions).toHaveLength(2);expect(sessions[0].messages.map(m=>m.role)).toEqual(["user","assistant","tool"]);expect(sessions[0].messages.every(m=>!m.timestamp)).toBe(true);expect((await readAider(path)).map(s=>s.id)).toEqual(sessions.map(s=>s.id));
});
it("reads Hermes's transcript fallback without fabricating cwd or usage",async()=>{
 const root=fixture(),path=join(root,"sessions","s.jsonl");write(path,[{role:"session_meta",model:"native",platform:"cli"},{role:"user",content:"question"},{role:"assistant",content:"answer",reasoning:"thinking",tool_calls:[{name:"read"}]},{role:"tool",content:"result",tool_call_id:"call"}],true);expect((await readHermesTranscript(path))[0]).toMatchObject({id:"s",cwd:"",messages:[{role:"user"},{role:"assistant",model:"native",content:{reasoning:"thinking"}},{role:"tool"}]});
});
