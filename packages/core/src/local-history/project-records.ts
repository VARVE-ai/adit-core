import {basename,dirname,join} from "node:path";
import {readSource,readSourceJSON,childPath} from "./source-io.js";
import {array,decode,first,message,session} from "./provider-common.js";
import {HistoryFormatError,jsonLines,record,string,type HistoryMessage} from "./types.js";
export const projectRecordProviders=["reasonix","workbuddy","cortex","codebuddy"];
async function optional(path:string,signal?:AbortSignal){try{return await readSourceJSON(path,signal);}catch(error){if((error as NodeJS.ErrnoException).code === "ENOENT")return {};throw error;}}
export async function readProjectRecords(path:string,provider:string,signal?:AbortSignal){
  if(provider === "cortex"){
    const doc=await readSourceJSON(path,signal);
    let history=doc.history;
    if(!Array.isArray(history))history=jsonLines((await readSource(path.replace(/\.json$/,".history.jsonl"),signal)).toString("utf8"));
    return [session(provider,doc.session_id,doc.working_directory || doc.git_root,array(history).map((row,i)=>message({...row,timestamp:row.user_sent_time},i)),{title:doc.title,gitBranch:doc.git_branch})];
  }
  if(provider === "codebuddy"){
    const index=await readSourceJSON(path,signal);
    if(!Array.isArray(index.messages))throw new HistoryFormatError("CodeBuddy manifest messages are missing");
    const messages:HistoryMessage[]=[];let cwd="";
    for(const ref of array(index.messages)){
      const row=await readSourceJSON(childPath(join(dirname(path),"messages"),`${string(ref.id)}.json`),signal);
      const extra=record(decode(row.extra)),inner=decode(row.message);
      const text=array(record(inner).content).filter(block=>block.type === "text").map(block=>string(block.text)).join("\n");
      if(row.role === "user")cwd ||= /Workspace Folder:\s*([^<\r\n]+)/.exec(text)?.[1]?.trim() || "";
      messages.push(message({...row,timestamp:row.createdAt},messages.length,{key:string(ref.id),model:first(extra,"modelId","modelName") || undefined,content:inner,raw:{...row,extra}}));
    }
    return [session(provider,`${basename(dirname(dirname(path)))}:${basename(dirname(path))}`,cwd,messages)];
  }
  const rows=jsonLines((await readSource(path,signal)).toString("utf8"));
  if(provider === "reasonix"){
    const metadata=await optional(`${path}.meta`,signal);
    return [session(provider,metadata.id || basename(path,".jsonl"),metadata.workspace_root,rows.filter(row=>["user","assistant","tool"].includes(string(row.role))).map((row,i)=>message(row,i,{content:{text:row.content,reasoning:row.reasoning_content,tool_calls:row.tool_calls,tool_call_id:row.tool_call_id},model:string(metadata.model) || undefined})),{title:metadata.topic_title,metadata})];
  }
  let cwd="",title="";const messages:HistoryMessage[]=[];
  for(const row of rows){
    cwd ||= string(row.cwd);
    if(row.type === "ai-title")title=string(row.aiTitle);
    if(!["message","function_call","function_call_result"].includes(string(row.type)))continue;
    const role=row.type === "function_call" ? "assistant" : row.type === "function_call_result" ? "tool" : string(row.role).toLowerCase();
    messages.push(message(row,messages.length,{role:role === "human" ? "user" : role === "ai" ? "assistant" : role,content:row.type === "message" ? row.content : row}));
  }
  const result=session(provider,`${basename(dirname(path))}:${basename(path,".jsonl")}`,cwd,messages,{title});
  if(basename(dirname(path)) === "subagents"){
    const parent=basename(dirname(dirname(path)));result.id=`${parent}:${basename(path,".jsonl")}`;result.parentId=`${basename(dirname(dirname(dirname(path))))}:${parent}`;result.relationship="subagent";
  }
  return [result];
}
