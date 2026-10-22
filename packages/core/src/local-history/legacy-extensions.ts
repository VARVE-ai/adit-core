import {basename,dirname,join,parse} from "node:path";
import {readSource,readSourceJSON} from "./source-io.js";
import {array,first,message,session,type Row} from "./provider-common.js";
import {HistoryFormatError,jsonLines,record,string} from "./types.js";
import {claudeBranches} from "./claude-lineage.js";
export const legacyExtensionProviders=["cowork","roocode","kilo-legacy"];
async function optional(path:string,signal?:AbortSignal){try{return await readSourceJSON(path,signal);}catch(error){if((error as NodeJS.ErrnoException).code === "ENOENT")return {};throw error;}}
export async function readLegacyExtension(path:string,provider:string,signal?:AbortSignal){
 if(provider === "cowork"){
  let dir=dirname(path);while(dir!==parse(dir).root && !basename(dir).startsWith("local_"))dir=dirname(dir);
  const metadata=basename(dir).startsWith("local_")?await optional(`${dir}.json`,signal):{};
  const results=claudeBranches(jsonLines((await readSource(path,signal)).toString("utf8")),path,provider,metadata);
  for(const result of results)result.metadata={...result.metadata,title:metadata.title};return results;
 }
 const dir=dirname(path),metadata=await optional(join(dir,provider === "roocode" ? "history_item.json":"task_metadata.json"),signal);
 const text=(await readSource(path,signal)).toString("utf8");let data:unknown;
 try{data=JSON.parse(text);}catch{throw new HistoryFormatError("Invalid legacy extension transcript");}
 if(!Array.isArray(data))throw new HistoryFormatError("Legacy extension transcript must be an array");
 let cwd=string(metadata.workspace);const usageEvents:Row[]=[];
 const messages=array(data).filter(row=>!row.partial).flatMap((row,i)=>{
  const kind=string(row.say || row.ask);
  if(kind === "api_req_started"){
   try{usageEvents.push(record(JSON.parse(string(row.text))));}catch{throw new HistoryFormatError("Invalid legacy API usage record");}return [];
  }
  if(["api_req_deleted","api_req_retried","checkpoint_saved"].includes(kind))return [];
  cwd ||= /(?:Current Working Directory|Workspace Folder)[^\n]*?:\s*([^<\r\n]+)/.exec(string(row.text))?.[1]?.trim()||"";
  const role=i===0 || ["user_feedback","user_feedback_diff"].includes(kind) ? "user" : ["command_output"].includes(kind) ? "tool" : ["error","condense_context","sliding_window_truncation","mcp_server_response","subtask_result"].includes(kind) ? "system" : "assistant";
  return [message({...row,timestamp:row.ts},i,{role,content:{text:row.text,reasoning:row.reasoning,images:row.images,kind},model:first(metadata,"apiConfigName")||undefined,usage:undefined})];
 });
 const result=session(provider,metadata.id || basename(dir),cwd,messages,{title:metadata.task,metadata,usageEvents});
 if(metadata.parentTaskId){result.parentId=string(metadata.parentTaskId);result.relationship="subagent";}
 return [result];
}
