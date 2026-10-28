import {afterEach,expect,it} from "vitest";
import Database from "better-sqlite3";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {readNativeMessages} from "./native-messages.js";
import {readEventDirectory} from "./event-directories.js";
const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function root(){const dir=mkdtempSync(join(tmpdir(),"adit-native-"));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function write(path:string,value:unknown){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==="string" ? value:JSON.stringify(value));}
const lines=(...rows:unknown[])=>rows.map(r=>JSON.stringify(r)).join("\n")+"\n";
it("retains Amp native usage and project display metadata without making it a working directory",async()=>{
  const path=join(root(),"T-thread.json");write(path,{id:"T-thread",title:"Title",env:{initial:{trees:[{displayName:"project"}]}},messages:[{role:"assistant",content:[{type:"text",text:"answer"}],usage:{model:"gpt-example",inputTokens:20,cacheCreationInputTokens:5}}]});
  const [result]=await readNativeMessages(path,"amp");
  expect(result.cwd).toBe("");expect(result.messages[0]).toMatchObject({model:"gpt-example",usage:{inputTokens:20,cacheCreationInputTokens:5}});
});
it("carries gptme assistant models forward and retains usage metadata",async()=>{
  const path=join(root(),"conversation/conversation.jsonl");write(path,lines({role:"user",content:"prompt"},{role:"assistant",content:"answer",metadata:{model:"m",usage:{input_tokens:20}}},{role:"assistant",content:"second"}));
  const [result]=await readNativeMessages(path,"gptme");expect(result.messages[2].model).toBe("m");expect(result.messages[1].usage).toEqual({input_tokens:20});
});
it.each(["openclaw","qclaw"])("namespaces %s sessions by agent and preserves tool output",async provider=>{
  const path=join(root(),"agent-a/sessions/session.jsonl");write(path,lines({type:"session",id:"session",cwd:"D:/work"},{type:"message",id:"m",message:{role:"toolResult",toolCallId:"tool",content:[{type:"text",text:"result"}]}}));
  const [result]=await readNativeMessages(path,provider);expect(result).toMatchObject({id:"agent-a:session",provider,cwd:"D:/work"});expect(result.messages[0].role).toBe("tool");
});
it("reads OpenClaw SQLite transcript records from the committed WAL",async()=>{
  const path=join(root(),"agent-a/agent/openclaw-agent.sqlite");mkdirSync(dirname(path),{recursive:true});const db=new Database(path);cleanup.push(()=>db.close());db.pragma("journal_mode=WAL");db.exec("CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT)");
  db.prepare("INSERT INTO transcript_events VALUES (?,?,?)").run("s",0,JSON.stringify({type:"session",id:"s",cwd:"D:/work"}));db.prepare("INSERT INTO transcript_events VALUES (?,?,?)").run("s",1,JSON.stringify({type:"message",message:{role:"assistant",content:"answer",usage:{input:2,output:3}}}));
  const [result]=await readNativeMessages(path,"openclaw");expect(result.id).toBe("agent-a:s");expect(result.messages[0].usage).toEqual({input:2,output:3});
});
it("reads fx sidecar ownership and native tool events without inventing token counters",async()=>{
  const dir=root(),path=join(dir,"events.jsonl");write(join(dir,"session.json"),{schema_version:4,workspace_root:"D:/work"});write(join(dir,"subagent/owner.json"),{schema_version:1,parent_id:"p"});write(path,lines({schema_version:3,timestamp_ms:1700000000000,event:{assistant:{text:"answer",provider_replay:{source:{model:"m"}}}}},{schema_version:3,event:{tool_result:{call_id:"call",preview:"result"}}}));
  const [result]=await readEventDirectory(path,"fx");expect(result).toMatchObject({parentId:"p",relationship:"subagent"});expect(result.messages[0]).toMatchObject({model:"m",timestamp:"2023-11-14T22:13:20.000Z"});expect(result.messages[1].usage).toBeUndefined();
});
it("reads OpenHands event files and workspace metadata including tool observations",async()=>{
  const dir=root(),path=join(dir,"base_state.json");write(path,{id:"s",workspace:{working_dir:"D:/work"}});write(join(dir,"events/001.json"),{kind:"MessageEvent",llm_message:{role:"user",content:[{type:"text",text:"prompt"}]}});write(join(dir,"events/002.json"),{kind:"ObservationEvent",tool_call_id:"call",observation:{content:"result"}});
  const [result]=await readEventDirectory(path,"openhands");expect(result).toMatchObject({id:"s",cwd:"D:/work"});expect(result.messages.map(m=>m.role)).toEqual(["user","tool"]);
});
