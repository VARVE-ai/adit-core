import {basename,dirname,join} from "node:path";
import {readSource,readSourceJSON} from "./source-io.js";
import {array,decode,first,message,session,type Row} from "./provider-common.js";
import {jsonLines,record,string,type HistoryMessage} from "./types.js";
export const runtimeEventProviders=["kimi","kimi-work","muse","poolside"];
async function kimiTitle(path:string,signal?:AbortSignal):Promise<string>{
 if(basename(dirname(dirname(path)))==="agents")return "";
 for(const [file,field] of [["state.json","custom_title"],["metadata.json","title"]]){
  try {const doc=await readSourceJSON(join(dirname(path),file),signal),title=string(doc[field]).trim();if(title&&title!=="Untitled")return title;}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 }
 return "";
}
export async function readRuntimeEvents(path:string,provider:string,signal?:AbortSignal){
 let rows=jsonLines((await readSource(path,signal)).toString("utf8"));
 let cwd="",model="",title="";const messages:HistoryMessage[]=[],usageEvents:Row[]=[];
 const emit=(row:Row,role:string,content:unknown,usage?:unknown)=>messages.push(message(row,messages.length,{role,content,model:role === "assistant" ? model||undefined:undefined,usage:Object.keys(record(usage)).length?record(usage):undefined}));
 if(provider === "muse"){
  rows=rows.flatMap(row=>row.retained_marker ? [] : row.retained_frame ? array(row.children).map(child=>record(decode(child.record_json))) : [row]);
  for(const row of rows){
   const payload=record(row.payload),facts=record(payload.record),kind=string(row.payload_type),event=record(payload.event);
   cwd ||= string(facts.workspace_root) || string(facts.cwd);model=string(facts.model_id)||model;
   if(kind === "session.name.changed" && payload.source!=="automatic" && string(payload.new_name).trim())title=string(payload.new_name).trim();
   const timed={...row,timestamp:typeof row.recorded_at === "number"?row.recorded_at/1000:undefined};
   if(kind === "runtime.user_intent.accepted")emit(timed,"user",record(payload.intent).prompt);
   if(kind !== "runtime.session")continue;
   const type=string(event.kind);
   if(["assistant_message_committed","reasoning_summary_committed","assistant_tool_calls_committed"].includes(type))emit(timed,"assistant",event);
   else if(type === "tool_result_batch_committed")emit(timed,"tool",event);
   else if(type === "model_completed")usageEvents.push(row);
  }
  const result=session(provider,basename(dirname(path)),cwd,messages,{title,usageEvents});
  if(basename(dirname(dirname(path))) === "subagent"){
   result.parentId=basename(dirname(dirname(dirname(path))));result.relationship="subagent";
   if(!cwd){const parentRows=jsonLines((await readSource(join(dirname(dirname(dirname(path))),"session.jsonl"),signal)).toString("utf8")).slice(0,256);result.cwd=parentRows.map(row=>first(row,"payload.record.workspace_root","payload.record.cwd")).find(Boolean)||"";}
  }
  return [result];
 }
 if(provider === "poolside"){
  for(const row of rows){
   const kind=string(row.type);
   if(kind === "session.start"){const start=record(row.session_start);cwd=string(start.workspace) || (Array.isArray(start.working_directories)?string(start.working_directories[0]):"");if(start.prompt)emit(row,"user",start.prompt);}
   else if(kind === "session.input")emit(row,"user",row.session_input);
   else if(kind === "assistant_message.end")emit(row,"assistant",row.assistant_message_end);
   else if(kind === "thought.end")emit(row,"assistant",row.thought_end);
   else if(kind === "tool_call.parsed")emit(row,"assistant",row.tool_call_parsed);
   else if(kind === "tool_call.result")emit(row,"tool",row.tool_call_result);
   else if(kind === "tool_call.inference.start")model=first(row,"tool_call_inference_start.model")||model;
   else if(kind === "tool_call.inference.end")usageEvents.push(row);
  }
  return [session(provider,basename(path,".ndjson").replace(/^trajectory-/,""),cwd,messages,{usageEvents})];
 }
 let pending:Row[]=[];
 const flush=()=>{if(pending.length){emit(pending[0],"assistant",pending);pending=[];}};
 for(const row of rows){
  signal?.throwIfAborted();
  const type=first(row,"message.type","type"),payload=record(record(row.message).payload),event=record(row.event);
  if(type === "config.update"){cwd=string(row.cwd)||cwd;model=string(row.modelAlias)||model;}
  if(["TurnBegin","turn.prompt","turn.steer"].includes(type)){flush();emit(row,"user",row.input ?? payload.user_input ?? payload);}
  else if(["ContentPart","ToolCall"].includes(type))pending.push(row);
  else if(type === "ToolResult"){flush();emit(row,"tool",payload);}
  else if(type === "TurnEnd")flush();
  else if(type === "StatusUpdate" || type === "usage.record")usageEvents.push(row);
  else if(type === "context.append_loop_event"){
   if(["content.part","tool.call"].includes(string(event.type)))pending.push(row);
   else if(event.type === "tool.result"){flush();emit(row,"tool",event);}
   else if(event.type === "step.end")flush();
  }
 }
 flush();
 const dir=dirname(path),agentLayout=basename(dirname(dir)) === "agents";
 const id=agentLayout?`${basename(dirname(dirname(dirname(dir))))}:${basename(dir)}:${basename(dirname(dirname(dir)))}`:`${basename(dirname(dir))}:${basename(dir)}`;
 return [session(provider,id,cwd,messages,{title:await kimiTitle(path,signal),usageEvents})];
}
