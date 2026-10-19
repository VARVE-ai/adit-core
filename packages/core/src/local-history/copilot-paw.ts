import {basename,dirname,join} from "node:path";
import {lstat} from "node:fs/promises";
import {readSource,readSourceJSON,databaseSnapshot,hasTable} from "./source-io.js";
import {at,array,first,message,session,table,sorted} from "./provider-common.js";
import {HistoryFormatError,jsonLines,record,string,type HistoryMessage} from "./types.js";
export const copilotPawProviders=["copilot","qwenpaw"];
export async function readCopilotPaw(path:string,provider:string,signal?:AbortSignal){
  if(provider === "qwenpaw"){
    const doc=await readSourceJSON(path,signal),entries=at(doc,"agent.memory.content");
    if(!Array.isArray(entries))throw new HistoryFormatError("QwenPaw agent memory is missing");
    const dir=dirname(path),nested=basename(dir)!=="sessions",workspace=nested ? basename(dirname(dirname(dir))) : basename(dirname(dir));
    const id=[workspace,...(nested ? [basename(dir)] : []),basename(path,".json")];
    if(id.some(part=>!part || /[\\/:~?#%]/.test(part)))throw new HistoryFormatError("Ambiguous QwenPaw identity");
    return [session(provider,id.join(":"),"",entries.map((entry,i)=>{
      if(!Array.isArray(entry) || !entry[0] || typeof entry[0]!=="object")throw new HistoryFormatError("Invalid QwenPaw memory entry");
      const row=record(entry[0]);
      return message(row,i,{role:row.role === "system" && array(row.content).some(block=>block.type === "tool_result") ? "tool" : string(row.role)});
    }))];
  }
  const rows=jsonLines((await readSource(path,signal)).toString("utf8"));
  let id=basename(dirname(path)),cwd="",model="";
  const messages:HistoryMessage[]=[],usageEvents:unknown[]=[];
  for(const row of rows){
    signal?.throwIfAborted();
    const data=record(row.data),kind=string(row.type);
    if(kind === "session.start"){
      id=string(data.sessionId) || id;cwd=first(data,"context.cwd") || cwd;model=string(data.selectedModel) || model;
    }
    if(kind === "session.model_change")model=string(data.newModel);
    if(kind === "session.shutdown" || kind === "assistant.usage"){usageEvents.push(row);continue;}
    if(!["user.message","assistant.message","assistant.reasoning","tool.execution_start","tool.execution_complete"].includes(kind))continue;
    if(kind === "user.message" && (string(data.source).startsWith("skill-") || string(data.content).startsWith("<skill-context")))continue;
    const role=kind.startsWith("user") ? "user" : kind === "tool.execution_complete" ? "tool" : "assistant";
    messages.push(message({...data,timestamp:row.timestamp},messages.length,{key:string(row.id) || String(messages.length),role,content:kind.endsWith("message") ? {content:data.content,reasoningText:data.reasoningText,toolRequests:data.toolRequests} : data,model:role === "assistant" ? string(data.model) || model || undefined : undefined,usage:undefined,raw:row}));
  }
  const storePath=join(dirname(dirname(dirname(path))),"session-store.db");
  let storeUsage:unknown[]=[];
  try{
    if((await lstat(storePath)).isFile())storeUsage=databaseSnapshot(storePath,db=>hasTable(db,"assistant_usage_events")?sorted(table(db,"assistant_usage_events",["id","session_id","model","input_tokens","output_tokens","cache_read_tokens","cache_write_tokens","reasoning_tokens","cost","timestamp","created_at","duration_ms","initiator","interaction_id"],["id","session_id"]),"id").filter(row=>row.session_id===id):[]);
  }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  return [session(provider,id,cwd,messages,{usageEvents:storeUsage.length?storeUsage:usageEvents,transcriptUsageEvents:storeUsage.length?usageEvents:undefined,usageSource:storeUsage.length?"session-store":"transcript"})];
}
