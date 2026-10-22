import {afterEach,expect,it} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import Database from "better-sqlite3";
import {createCipheriv,createHash} from "node:crypto";
import {readCopilotPaw} from "./copilot-paw.js";
import {readCompanionChat} from "./companion-chats.js";
import {readKiro} from "./kiro.js";
import {readRuntimeEvents} from "./runtime-events.js";
import {readReviewEvents} from "./review-events.js";
import {readProfileStore} from "./profile-stores.js";
import {readDesktopDatabase} from "./desktop-databases.js";
import {decryptAntigravity} from "./antigravity.js";
import {parseCodex} from "./parsers.js";
import {sourceDefinitions,sourceHomePaths} from "./sources.js";
import {readSemanticSession} from "./semantic-jsonl.js";
import {LocalHistory} from "./archive.js";
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"adit-extended-"));roots.push(root);return root;}
function write(path:string,value:unknown,lines=false){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,lines?(value as unknown[]).map(v=>JSON.stringify(v)).join("\n")+"\n":JSON.stringify(value));}
it("preserves Copilot's model changes, tools and native usage without duplicating ledger totals",async()=>{
 const root=fixture(),path=join(root,"session-state","id","events.jsonl");write(path,[{type:"session.start",data:{sessionId:"id",context:{cwd:root},selectedModel:"first"}},{id:"u",type:"user.message",data:{content:"question"}},{type:"session.model_change",data:{newModel:"second"}},{id:"a",type:"assistant.message",data:{content:"answer"}},{id:"t",type:"tool.execution_complete",data:{result:"ok"}},{type:"assistant.usage",data:{inputTokens:7,outputTokens:3}}],true);
 const [result]=await readCopilotPaw(path,"copilot");expect(result.messages.map(m=>m.role)).toEqual(["user","assistant","tool"]);expect(result.messages[1].model).toBe("second");expect(result.messages.every(m=>m.usage===undefined)).toBe(true);expect(result.metadata?.usageEvents).toHaveLength(1);
});
it("keeps QwenPaw tool results and explicit unassigned workspace evidence",async()=>{
 const root=fixture(),path=join(root,"workspaces","workspace","sessions","s.json");write(path,{agent:{memory:{content:[[{role:"user",content:"hello"}], [{role:"system",content:[{type:"tool_result",content:"ok"}]}]]}}});
 const [result]=await readCopilotPaw(path,"qwenpaw");expect(result.id).toBe("workspace:s");expect(result.cwd).toBe("");expect(result.messages[1].role).toBe("tool");
});
it("reads active Posit Assistant references and rejects missing referenced LM messages",async()=>{
 const root=fixture(),path=join(root,"workspace","conversation","conversation.json");write(join(root,"workspace","workspace.json"),{path:root});write(path,{schemaVersion:3,root:{id:"s"},messages:[{id:"active",isActive:true,lmMessageIds:["a"]},{id:"inactive",isActive:false,lmMessageIds:["missing"]}]});write(join(dirname(path),"lm-messages.jsonl"),[{id:"a",message:{role:"assistant",content:"answer",providerOptions:{providerMetadata:{native:{modelId:"model",usage:{output_tokens:3}}}}}}],true);
 expect((await readCompanionChat(path,"posit-assistant"))[0]).toMatchObject({cwd:root,messages:[{key:"a",model:"model",usage:{output_tokens:3}}]});write(path,{schemaVersion:3,root:{id:"s"},messages:[{isActive:true,lmMessageIds:["missing"]}]});await expect(readCompanionChat(path,"posit-assistant")).rejects.toThrow("missing");
});
it("classifies Freebuff from native run state and preserves its source identity",async()=>{
 const root=fixture(),path=join(root,"project","chats","date","chat-messages.json");write(path,[{variant:"user",content:"prompt"},{variant:"ai",content:"answer"}]);write(join(dirname(path),"run-state.json"),{sessionState:{mainAgentState:{agentType:"free-agent"},fileContext:{cwd:root}},inference:{model:"native"}});
 expect((await readCompanionChat(path,"codebuff"))[0]).toMatchObject({provider:"codebuff",cwd:root,metadata:{classification:"freebuff"},messages:[{role:"user"},{role:"assistant",model:"native"}]});
});
it("reads Kiro SQLite's latest conversation and its native tool-result role",async()=>{
 const root=fixture(),path=join(root,"data.sqlite3"),db=new Database(path);db.exec("CREATE TABLE conversations_v2(key TEXT,conversation_id TEXT,value TEXT,updated_at INTEGER)");db.prepare("INSERT INTO conversations_v2 VALUES(?,?,?,?)").run(root,"s",JSON.stringify({history:[{user:{content:{ToolResults:["ok"]},env_context:{env_state:{current_working_directory:root}}},assistant:{Response:{content:"answer"}}}]}),2);db.close();
 const [result]=await readKiro(path,"kiro");expect(result.cwd).toBe(root);expect(result.messages.map(m=>m.role)).toEqual(["tool","assistant"]);
 const ide=join(root,"session.chat");write(ide,{executionId:"ide",chat:[{role:"user",content:"question"}],metadata:{modelId:"model"}});expect((await readKiro(ide,"kiro-ide"))[0].id).toBe("ide");
});
it.each(["kimi","kimi-work"])("reads %s semantic events and preserves pending assistant/tool content",async provider=>{
 const root=fixture(),path=join(root,"project","session","wire.jsonl");write(path,[{type:"config.update",cwd:root,modelAlias:"native"},{type:"turn.prompt",input:"question"},{message:{type:"ContentPart",payload:{text:"answer"}}},{message:{type:"ToolResult",payload:{content:"ok"}}},{type:"usage.record",inputTokens:10}],true);const [result]=await readRuntimeEvents(path,provider);expect(result.provider).toBe(provider);expect(result.cwd).toBe(root);expect(result.messages.map(m=>m.role)).toEqual(["user","assistant","tool"]);expect(result.messages[1].model).toBe("native");expect(result.metadata?.usageEvents).toHaveLength(1);
});
it("reads Muse committed events without emitting model usage as another response",async()=>{
 const root=fixture(),path=join(root,"session","session.jsonl");write(path,[{payload_type:"metadata",payload:{record:{workspace_root:root,model_id:"model"}}},{payload_type:"runtime.user_intent.accepted",payload:{intent:{prompt:"question"}}},{payload_type:"runtime.session",payload:{event:{kind:"assistant_message_committed",text:"answer"}}},{payload_type:"runtime.session",payload:{event:{kind:"model_completed",usage:{output:5}}}}],true);const [result]=await readRuntimeEvents(path,"muse");expect(result.messages.map(m=>m.role)).toEqual(["user","assistant"]);expect(result.cwd).toBe(root);expect(result.metadata?.usageEvents).toHaveLength(1);
});
it("preserves Poolside user input, inference model and tool output",async()=>{
 const root=fixture(),path=join(root,"trajectory-s.ndjson");write(path,[{type:"session.start",session_start:{workspace:root,prompt:"question"}},{type:"tool_call.inference.start",tool_call_inference_start:{model:"model"}},{type:"assistant_message.end",assistant_message_end:{content:"answer"}},{type:"tool_call.result",tool_call_result:{output:"ok"}}],true);const [result]=await readRuntimeEvents(path,"poolside");expect(result.id).toBe("s");expect(result.messages.map(m=>m.role)).toEqual(["user","assistant","tool"]);expect(result.messages[1].model).toBe("model");
});
it("extracts only new Open Code Review user turns from cumulative requests",async()=>{
 const root=fixture(),path=join(root,"session.jsonl"),u={role:"user",content:"question"};write(path,[{type:"llm_request",sessionId:"s",cwd:root,messages:[u]},{type:"llm_response",content:"answer"},{type:"llm_request",messages:[u,{role:"assistant",content:"answer"},{role:"user",content:"next"}]},{type:"llm_response",content:"second answer"}],true);expect((await readReviewEvents(path,"opencodereview"))[0].messages.map(m=>m.role)).toEqual(["user","assistant","user","assistant"]);
});
it("applies Junie's history removals and coalesces updates to the same step",async()=>{
 const root=fixture(),path=join(root,"s","events.jsonl");write(join(root,"index.jsonl"),[{sessionId:"s",projectDir:root}],true);write(path,[{kind:"UserPromptEvent",requestId:"u",prompt:"question"},{kind:"SessionA2uxEvent",event:{agentEvent:{kind:"MarkdownBlockUpdatedEvent",stepId:"a",text:"partial"}}},{kind:"SessionA2uxEvent",event:{agentEvent:{kind:"MarkdownBlockUpdatedEvent",stepId:"a",text:"final"}}},{kind:"UserMessagesDroppedFromHistory",userMessageIds:["u"]}],true);expect((await readReviewEvents(path,"junie"))[0]).toMatchObject({cwd:root,messages:[{role:"assistant",content:"final"}]});
});
it("reads Grok history with original parent and model metadata",async()=>{
 const root=fixture(),path=join(root,"s","summary.json");write(path,{cwd:root,current_model_id:"grok",parent_session_id:"parent"});write(join(dirname(path),"chat_history.jsonl"),[{role:"user",content:"question"},{type:"reasoning",text:"thinking"},{type:"tool_result",content:"ok"}],true);expect((await readReviewEvents(path,"grok"))[0]).toMatchObject({parentId:"parent",relationship:"fork",messages:[{role:"user"},{role:"assistant",model:"grok"},{role:"tool"}]});
});
it.each(["windsurf","trae"])("reads only %s's allowlisted chat keys",async provider=>{
 const root=fixture(),path=join(root,"state.vscdb"),db=new Database(path);db.exec("CREATE TABLE ItemTable(key TEXT,value TEXT)");const key=provider==="windsurf"?"aiChat.chatdata":"memento/icube-ai-agent-storage";const value=provider==="windsurf"?{tabs:[{tabId:"s",bubbles:[{type:1,text:"question"},{type:2,text:"answer"}]}]}:{list:[{sessionId:"s",messages:[{role:"user",content:"question"},{role:"assistant",content:"answer"}]}]};db.prepare("INSERT INTO ItemTable VALUES(?,?)").run(key,JSON.stringify(value));db.prepare("INSERT INTO ItemTable VALUES(?,?)").run("auth.token","not-json-secret");db.close();expect((await readProfileStore(path,provider))[0].messages.map(m=>m.role)).toEqual(["user","assistant"]);
});
it("selects Devin's canonical ancestry instead of including abandoned branches",async()=>{
 const root=fixture(),path=join(root,"sessions.db"),db=new Database(path);db.exec("CREATE TABLE sessions(id TEXT,main_chain_id TEXT,working_directory TEXT);CREATE TABLE message_nodes(node_id TEXT,parent_node_id TEXT,session_id TEXT,chat_message TEXT)");db.prepare("INSERT INTO sessions VALUES(?,?,?)").run("s","a",root);const insert=db.prepare("INSERT INTO message_nodes VALUES(?,?,?,?)");insert.run("u",null,"s",JSON.stringify({role:"user",content:"question"}));insert.run("a","u","s",JSON.stringify({role:"assistant",content:"selected"}));insert.run("b","u","s",JSON.stringify({role:"assistant",content:"discard"}));db.close();expect((await readProfileStore(path,"devin"))[0].messages.map(m=>m.content)).toEqual(["question","selected"]);
});
it("reads Zed's JSON thread and subagent lineage",()=>{
 const root=fixture(),path=join(root,"threads.db"),db=new Database(path);db.exec("CREATE TABLE threads(id TEXT,data_type TEXT,data BLOB,folder_paths TEXT,parent_id TEXT)");db.prepare("INSERT INTO threads VALUES(?,?,?,?,?)").run("s","json",Buffer.from(JSON.stringify({messages:[{User:{content:"question"}},{Agent:{content:"answer"}}]})),JSON.stringify([root]),"parent");db.close();expect(readDesktopDatabase(path,"zed")[0]).toMatchObject({cwd:root,parentId:"parent",relationship:"subagent",messages:[{role:"user"},{role:"assistant"}]});
});
it("decrypts archived Antigravity protobuf with AES CTR, CBC and authenticated GCM",()=>{
 const key=Buffer.alloc(32,7),plain=Buffer.from([18,5,...Buffer.from("hello")]);for(const mode of ["ctr","cbc","gcm"]){const iv=Buffer.alloc(mode==="gcm"?12:16,3),cipher=createCipheriv(`aes-256-${mode}`,key,iv),encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);const payload=mode==="gcm"?Buffer.concat([iv,encrypted,(cipher as typeof cipher&{getAuthTag():Buffer}).getAuthTag()]):Buffer.concat([iv,encrypted]);expect(decryptAntigravity(payload,key.toString("base64"))).toEqual(plain);}
});
it("filters Codex copied parent turns and their usage while preserving child-only turns",()=>{
 const root=fixture(),rows=[{type:"session_meta",payload:{id:"child",cwd:root,forked_from_id:"parent"}},{type:"session_meta",payload:{id:"parent",cwd:root}},{type:"turn_context",payload:{turn_id:"parent-turn",model:"old"}},{type:"response_item",payload:{id:"old",type:"message",role:"assistant",content:"copied"}},{type:"turn_context",payload:{turn_id:"child-turn",model:"new"}},{type:"response_item",payload:{id:"new",type:"message",role:"assistant",content:"new answer"}}];const result=parseCodex(rows.map(row=>JSON.stringify(row)).join("\n"),new Set(["parent-turn"]));expect(result).toMatchObject({id:"child",parentId:"parent",relationship:"fork",messages:[{key:"new",model:"new"}]});
});
it("respects native root overrides and does not offer alternate homes for workspace-scoped Aider",()=>{
 const root=fixture(),defs=sourceDefinitions(root,{JUNIE_HOME:join(root,"junie"),FREEBUFF_CONFIG_DIR:join(root,"free"),HERMES_SESSIONS_DIR:join(root,"hermes","sessions")});expect(defs.find(d=>d.id==="junie")?.paths).toEqual([join(root,"junie","sessions")]);expect(defs.find(d=>d.id==="codebuff")?.paths).toEqual([join(root,"free","projects")]);expect(defs.find(d=>d.id==="hermes")?.paths).toEqual([join(root,"hermes")]);expect(defs.find(d=>d.id==="aider")?.homesSupported).toBe(false);
});
it("includes explicitly imported web sessions when workspace collection providers are filtered",async()=>{
 const root=fixture(),path=join(root,"export.json");write(path,[{uuid:"s",chat_messages:[{sender:"human",text:"question"}]}]);const db=new Database(":memory:");try{const history=new LocalHistory(db);await history.importExport(path,"claude-ai",root);expect(history.counts(root,["codex"])).toEqual({"claude-ai":1});}finally{db.close();}
});
it("reads Kiro IDE's referenced execution actions and workspace index",async()=>{
 const root=fixture(),path=join(root,"workspace-sessions","encoded","s.json");write(path,{sessionId:"s",history:[{message:{role:"user",content:"question"}},{executionId:"execution",message:{role:"assistant",content:""}}]});write(join(dirname(path),"sessions.json"),[{sessionId:"s",workspaceDirectory:root}]);const hash=createHash("sha256").update(root).digest("hex").slice(0,32);write(join(root,hash,"414d1636299d2b9e4ce7e17fb11f63e9","execution.json"),{executionId:"execution",actions:[{actionType:"say",output:{message:"native answer"}},{actionType:"create",input:{file:"file.ts",modifiedContent:"code"}}]});
 expect((await readKiro(path,"kiro-ide"))[0]).toMatchObject({cwd:root,messages:[{role:"user"},{role:"assistant",content:{text:"native answer",actions:[{actionType:"create"}]}}]});
});
it("refreshes Copilot usage from committed WAL rows without replaying the transcript totals",async()=>{
 const root=fixture(),path=join(root,"session-state","s","events.jsonl");write(path,[{type:"session.start",data:{sessionId:"s",context:{cwd:root}}},{type:"assistant.message",data:{content:"answer"}},{type:"assistant.usage",data:{outputTokens:3}}],true);const db=new Database(join(root,"session-store.db"));try{db.pragma("journal_mode=WAL");db.exec("CREATE TABLE assistant_usage_events(id INTEGER,session_id TEXT,output_tokens INTEGER,reasoning_tokens INTEGER)");db.exec("INSERT INTO assistant_usage_events VALUES(1,'s',5,2)");expect((await readCopilotPaw(path,"copilot"))[0]).toMatchObject({metadata:{usageSource:"session-store",usageEvents:[{output_tokens:5,reasoning_tokens:2}],transcriptUsageEvents:[{type:"assistant.usage"}]}});db.exec("UPDATE assistant_usage_events SET output_tokens=7");expect((await readCopilotPaw(path,"copilot"))[0].metadata?.usageEvents).toMatchObject([{output_tokens:7}]);}finally{db.close();}
});
it("reconciles removed logical sessions after a valid container rewrite but retains them on parse failure",async()=>{
 const root=fixture(),path=join(root,"state.vscdb"),source=new Database(path),archive=new Database(":memory:");source.exec("CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT)");const update=source.prepare("INSERT INTO ItemTable VALUES('aiChat.chatdata',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");update.run(JSON.stringify({tabs:[{tabId:"one",bubbles:[]},{tabId:"two",bubbles:[]}]}));
 try{const history=new LocalHistory(archive);await history.scan(root,[{id:"windsurf",paths:[path]}]);expect(history.unassigned()).toHaveLength(2);update.run("invalid");expect((await history.scan(root,[{id:"windsurf",paths:[path]}])).errors).toHaveLength(1);expect(history.unassigned()).toHaveLength(2);update.run(JSON.stringify({tabs:[{tabId:"two",bubbles:[]}]}));await history.scan(root,[{id:"windsurf",paths:[path]}]);expect(history.unassigned().map(s=>s.id)).toEqual(["two"]);}finally{source.close();archive.close();}
});
it("offers exactly the four AgentsView alternate homes and resolves each from its Agent root",()=>{
 const root=fixture(),defs=sourceDefinitions(root,{});expect(defs.filter(d=>d.homesSupported).map(d=>d.id).sort()).toEqual(["claude","codex","junie","pi"]);expect(sourceHomePaths("claude",root)).toEqual([join(root,"projects")]);expect(sourceHomePaths("codex",root)).toEqual([join(root,"sessions"),join(root,"archived_sessions")]);expect(sourceHomePaths("amp",root)).toEqual([]);
});
it("reads Kiro current semantic payloads and the session.json workspace sidecar",async()=>{
 const root=fixture(),path=join(root,"sess_native","messages.jsonl");write(path,[{payload:{type:"user",content:"question"}},{payload:{type:"assistant",content:"answer",reasoningModelId:"native"}},{payload:{type:"tool_result",toolCallId:"call",content:"ok"}}],true);write(join(dirname(path),"session.json"),{workspacePaths:[root],title:"native title"});expect((await readKiro(path,"kiro"))[0]).toMatchObject({id:"sess_native",cwd:root,messages:[{role:"user"},{role:"assistant",model:"native"},{role:"tool"}]});
});
it("removes Evener's verified fork prefix while retaining inherited model switches",async()=>{
 const root=fixture(),parent=join(root,"parent.transcript.jsonl"),child=join(root,"child.transcript.jsonl"),prefix=[{kind:"MODEL_SWITCH",model_switch:{new_model:"inherited"}},{kind:"USER_INPUT",message:{content:"copied"}}];write(parent,[{format_version:2,session_id:"parent",working_dir:root},...prefix],true);write(child,[{format_version:2,session_id:"child",working_dir:root},...prefix,{kind:"ASSISTANT",message:{content:"new"}}],true);write(join(root,"child.meta.json"),{id:"child",parent_session_id:"parent",divergence_turn:3});const [result]=await readSemanticSession(child,"evener");expect(result).toMatchObject({parentId:"parent",relationship:"fork",messages:[{role:"assistant",content:"new",model:"inherited"}]});
});
it("gives Codex revert pages separate identities and resolves inherited history_base lineage",()=>{
 const root=fixture(),thread="11111111-1111-1111-1111-111111111111",page="22222222-2222-2222-2222-222222222222",base="33333333-3333-3333-3333-333333333333",path=join(root,`rollout-date-${thread}_${page}.jsonl`);
 const rows=(payload:Record<string,unknown>)=>JSON.stringify({type:"session_meta",payload:{id:thread,cwd:root,...payload}})+"\n";
 expect(parseCodex(rows({history_base:{thread_id:base}}),undefined,path)).toMatchObject({id:`${thread}_${page}`,parentId:`${thread}_${base}`,relationship:"fork"});
 expect(parseCodex(rows({forked_from_id:"original",forked_from_ordinal_exclusive:10,history_base:{thread_id:base,end_ordinal_exclusive:10}}),undefined,path)).toMatchObject({id:`${thread}_${page}`,parentId:"original",relationship:"fork"});
});
it("resolves Goose's producer root through data/sessions and finds Devin's actual default stores",()=>{
 const root=fixture(),defs=sourceDefinitions(root,{GOOSE_PATH_ROOT:root});expect(defs.find(d=>d.id==="goose")?.paths).toEqual([join(root,"data","sessions")]);expect(defs.find(d=>d.id==="devin")?.paths).toEqual([join(root,"Library/Application Support/devin"),join(root,".local/share/devin")]);
});
