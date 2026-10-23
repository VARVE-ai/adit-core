import {basename,dirname,join} from "node:path";
import {lstat} from "node:fs/promises";
import {trackSource} from "./source-checkpoints.js";
import {readSource,readSourceJSON,databaseSnapshot,hasTable} from "./source-io.js";
import {at,array,first,message,session} from "./provider-common.js";
import {HistoryFormatError,jsonLines,record,string,type HistoryMessage} from "./types.js";
import {separateCollectedTools} from "./collected-blocks.js";
export const copilotPawProviders=["copilot","qwenpaw"];
const usageFields=["id","session_id","model","input_tokens","output_tokens","cache_read_tokens","cache_write_tokens","reasoning_tokens","cost","timestamp","created_at","duration_ms","initiator","interaction_id"];
function normalizeUsage(value:Record<string,unknown>,model:unknown):Record<string,unknown> {
  const input=value.input_tokens??value.inputTokens,read=value.cache_read_tokens??value.cacheReadTokens,write=value.cache_write_tokens??value.cacheWriteTokens;
  return {...value,model,input_tokens:typeof input==="number"&&typeof read==="number"&&typeof write==="number"?Math.max(0,input-read-write):input,
    cache_read_tokens:read,cache_write_tokens:write,output_tokens:value.output_tokens??value.outputTokens,reasoning_tokens:value.reasoning_tokens??value.reasoningTokens,
    adit_input_semantics:typeof read==="number"&&typeof write==="number"?"excludes_cache":"unknown"};
}
async function copilotTitle(path:string,signal?:AbortSignal):Promise<string>{
  try {
    const text=(await readSource(join(dirname(path),"workspace.yaml"),signal)).toString("utf8");
    // Copilot writes a top-level name scalar for both generated titles and /rename.
    return /^name: (.*)$/m.exec(text)?.[1].trim() || "";
  } catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return "";throw error;}
}
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
  const messages:HistoryMessage[]=[],usageEvents:Record<string,unknown>[]=[];
  const calls=new Set<string>(),shutdownUsage=new Map<string,Record<string,unknown>>();
  for(const row of rows){
    signal?.throwIfAborted();
    const data=record(row.data),kind=string(row.type);
    if(kind === "session.start"){
      id=string(data.sessionId) || id;cwd=first(data,"context.cwd") || cwd;model=string(data.selectedModel) || model;
    }
    if(kind === "session.model_change")model=string(data.newModel);
    if(kind === "session.shutdown" || kind === "assistant.usage"){
      usageEvents.push(row);
      if(kind==="session.shutdown")for(const [modelName,metrics] of Object.entries(record(data.modelMetrics)))
        shutdownUsage.set(modelName,{...normalizeUsage(record(record(metrics).usage),modelName),timestamp:row.timestamp});
      continue;
    }
    if(!["user.message","assistant.message","assistant.reasoning","tool.execution_start","tool.execution_complete"].includes(kind))continue;
    if(kind === "user.message" && (string(data.source).startsWith("skill-") || string(data.content).startsWith("<skill-context")))continue;
    const role=kind.startsWith("user") ? "user" : kind === "tool.execution_complete" ? "tool" : "assistant";
    const content:unknown[]=[];
    if(kind.endsWith("message")) {
      if(typeof data.content==="string")content.push({type:"text",text:data.content});
      if(data.reasoningText)content.push({type:"thinking",thinking:data.reasoningText});
      for(const request of array(data.toolRequests)) {
        const call=string(request.toolCallId);if(call&&calls.has(call))continue;
        if(call)calls.add(call);content.push({type:"tool_use",id:call||undefined,name:request.name,input:request.arguments});
      }
    } else if(kind==="assistant.reasoning")content.push({type:"thinking",thinking:data.content??data.text});
    else if(kind==="tool.execution_start") {
      const call=string(data.toolCallId);if(call&&calls.has(call))continue;
      if(!data.toolName)continue;
      if(call)calls.add(call);content.push({type:"tool_use",id:call||undefined,name:data.toolName,input:data.arguments});
    } else content.push({type:"tool_result",tool_use_id:data.toolCallId,content:record(data.result).content??data.result,is_error:data.success===false});
    messages.push(message({...data,timestamp:row.timestamp},messages.length,{key:string(row.id) || String(messages.length),role,content,model:role === "assistant" ? string(data.model) || model || undefined : undefined,usage:undefined,raw:row}));
  }
  const storePath=join(dirname(dirname(dirname(path))),"session-store.db");
  let storeUsage:Record<string,unknown>[]=[];
  try{
    trackSource(storePath);
    if((await lstat(storePath)).isFile())storeUsage=databaseSnapshot(storePath,db=>{
      if(!hasTable(db,"assistant_usage_events"))return [];
      const columns=new Set((db.prepare("PRAGMA table_info(assistant_usage_events)").all() as {name:string}[]).map(c=>c.name));
      if(!columns.has("id")||!columns.has("session_id"))throw new HistoryFormatError("Unsupported Copilot usage schema");
      return db.prepare(`SELECT ${usageFields.filter(f=>columns.has(f)).join(",")} FROM assistant_usage_events WHERE session_id=? ORDER BY id`).all(id) as Record<string,unknown>[];
    });
  }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  return [session(provider,id,cwd,separateCollectedTools(messages),{title:await copilotTitle(path,signal),usageEvents:storeUsage.length?storeUsage:usageEvents,
    usage:storeUsage.length?storeUsage.map(r=>normalizeUsage(r,r.model)):[...shutdownUsage.values()],
    transcriptUsageEvents:storeUsage.length?usageEvents:undefined,usageSource:storeUsage.length?"session-store":"transcript"})];
}
