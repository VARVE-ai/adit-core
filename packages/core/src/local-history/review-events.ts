import {basename,dirname,join} from "node:path";
import {readSource,readSourceJSON} from "./source-io.js";
import {array,at,first,message,session,type Row} from "./provider-common.js";
import {jsonLines,record,string,type HistoryMessage} from "./types.js";
export const reviewEventProviders=["junie","grok","opencodereview"];
export async function readReviewEvents(path:string,provider:string,signal?:AbortSignal){
 const lines=async(file:string)=>jsonLines((await readSource(file,signal)).toString("utf8"));
 if(provider === "grok"){
  const doc=await readSourceJSON(path,signal);let rows:Row[]=[];
  try{rows=await lines(join(dirname(path),"chat_history.jsonl"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const result=session(provider,basename(dirname(path)),first(doc,"cwd","source_workspace_dir","git_root_dir"),rows.filter(r=>(r.type || r.role)!=="system").map((row,i)=>{
   const kind=first(row,"type","role"),role=["tool","tool_result"].includes(kind)?"tool":["reasoning","backend_tool_call"].includes(kind)?"assistant":kind;
   return message(row,i,{role,content:row.content ?? row.text ?? row,model:first(doc,"current_model_id","modelId","model_id")||undefined});
  }),{title:first(doc,"generated_title","session_summary","summary"),summary:doc});
  const parent=first(doc,"parent_session_id","parentSessionId");if(parent){result.parentId=parent;result.relationship=string(doc.producer_session_kind).includes("subagent")?"subagent":"fork";}return [result];
 }
 const rows=await lines(path),messages:HistoryMessage[]=[],usageEvents:Row[]=[];
 let id=basename(dirname(path)),cwd="",title="";
 if(provider === "junie"){
  let summaries:Row[]=[];try{summaries=await lines(join(dirname(dirname(path)),"index.jsonl"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const summary=summaries.filter(row=>first(row,"sessionId","id")===id).at(-1)||{};cwd=first(summary,"projectDir");title=first(summary,"taskName");
  const indexed=new Map<string,number>(),inactive=new Set<string>();
  for(const row of rows){
   const kind=string(row.kind),event=record(at(row,"event.agentEvent"));
   if(kind === "SessionTitleSetEvent")title=string(row.name ?? row.title);
   if(["UserMessagesDroppedFromHistory","UserMessagesFailedInHistory"].includes(kind)&&Array.isArray(row.userMessageIds))for(const value of row.userMessageIds)inactive.add(String(value));
   if(kind === "UserMessagesCommittedToHistory"&&Array.isArray(row.userMessageIds))for(const value of row.userMessageIds)inactive.delete(String(value));
   let role="",content:unknown,key="";
   if(["UserPromptEvent","UserResponseEvent","UserAsyncResponseEvent"].includes(kind)){if(row.delivery === "Failed")continue;role="user";content=row.presentablePrompt ?? row.prompt;key=string(row.requestId);}
   else if(kind === "SessionA2uxEvent"){
    if(event.kind === "LlmResponseMetadataEvent"){usageEvents.push(event);continue;}
    if(!["MarkdownBlockUpdatedEvent","ResultBlockUpdatedEvent"].includes(string(event.kind)))continue;
    role="assistant";content=event.text ?? event.result;key=string(event.stepId);
   }else continue;
   const result=message({...row,timestamp:row.timestampMs},messages.length,{key:key||String(messages.length),role,content});
   const old=indexed.get(`${role}:${key}`);if(key&&old!==undefined)messages[old]=result;else{if(key)indexed.set(`${role}:${key}`,messages.length);messages.push(result);}
  }
  return [session(provider,id,cwd,messages.filter(m=>!inactive.has(m.key)),{title,usageEvents})];
 }
 const humanPrefix:string[]=[];
 for(const row of rows){
  id=string(row.sessionId)||id;cwd ||= string(row.cwd);
  if(row.type === "llm_request"){
   const humans=array(row.messages ?? record(row.request).messages).filter(entry=>entry.role==="user");
   let prefix=0;while(prefix<humans.length&&prefix<humanPrefix.length&&JSON.stringify(humans[prefix])===humanPrefix[prefix])prefix++;
   for(let index=prefix;index<humans.length;index++)messages.push(message({...humans[index],timestamp:row.timestamp},messages.length,{role:"user",raw:{...humans[index],request:row}}));
   humanPrefix.splice(0,humanPrefix.length,...humans.map(entry=>JSON.stringify(entry)));
   usageEvents.push(row);continue;
  }
  if(row.type === "llm_response")messages.push(message(row,messages.length,{role:"assistant",content:{text:row.content,reasoning:row.reasoning_content,tool_calls:row.tool_calls},usage:record(row.usage)}));
  else if(row.type === "tool_call")messages.push(message(row,messages.length,{role:"tool",content:row}));
 }
 return [session(provider,id,cwd,messages,{requestContext:usageEvents})];
}
