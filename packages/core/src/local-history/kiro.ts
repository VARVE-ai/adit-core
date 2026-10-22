import {basename,dirname,join} from "node:path";
import {createHash} from "node:crypto";
import {readSource,readSourceJSON,databaseSnapshot,directoryEntries} from "./source-io.js";
import {array,decode,first,message,session,sorted,table,type Row} from "./provider-common.js";
import {HistoryFormatError,jsonLines,record,string,type HistoryMessage} from "./types.js";
export const kiroProviders=["kiro","kiro-ide"];
export async function readKiro(path:string,provider:string,signal?:AbortSignal){
  if(provider === "kiro-ide"){
    const doc=await readSourceJSON(path,signal);
    if(Array.isArray(doc.history)){
      let cwd=string(doc.workspaceDirectory);
      if(!cwd)try{const index=array(JSON.parse((await readSource(join(dirname(path),"sessions.json"),signal)).toString("utf8")));cwd=first(index.find(row=>row.sessionId===doc.sessionId)||index[0],"workspaceDirectory");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      const executions=new Map<string,Row>();
      if(cwd){const hash=createHash("sha256").update(cwd).digest("hex").slice(0,32),executionDir=join(dirname(dirname(dirname(path))),hash,"414d1636299d2b9e4ce7e17fb11f63e9");
        for(const entry of await directoryEntries(executionDir)){if(!entry.isFile()||entry.name.startsWith("."))continue;const execution=await readSourceJSON(join(executionDir,entry.name),signal);if(string(execution.executionId))executions.set(string(execution.executionId),execution);}
      }
      const messages=array(doc.history).map((row,i)=>{
        const wire=record(row.message),execution=executions.get(string(row.executionId)),actions=array(execution?.actions),say=actions.filter(action=>action.actionType==="say").map(action=>first(action,"output.message")).filter(Boolean).join("\n\n");
        const fallback=array(row.promptLogs).map(log=>string(log.completion)).filter(Boolean).join("\n\n");
        return message(wire,i,{content:wire.role==="assistant"?{text:say||wire.content||fallback,actions:actions.filter(action=>action.actionType!=="say")}:wire.content,raw:{...row,execution}});
      });
      return [session(provider,doc.sessionId,cwd,messages,{title:doc.title})];
    }
    if(!Array.isArray(doc.chat))throw new HistoryFormatError("Kiro IDE chat history is missing");
    return [session(provider,doc.executionId || basename(path,".chat"),"",array(doc.chat).map((row,i)=>message(row,i,{model:first(doc,"metadata.modelId")||undefined})),{metadata:doc.metadata})];
  }
  if(path.endsWith(".sqlite3"))return databaseSnapshot(path,db=>{
    const rows=sorted(table(db,"conversations_v2",["key","conversation_id","value","created_at","updated_at"],["key","conversation_id","value"]),"updated_at","created_at","key");
    const canonical=new Map<unknown,Row>();for(const row of rows)canonical.set(row.conversation_id,row);
    return [...canonical.values()].map(row=>{
      const doc=record(decode(row.value));
      if(!Array.isArray(doc.history))throw new HistoryFormatError("Kiro SQLite history is missing");
      const messages:HistoryMessage[]=[];let cwd="";
      for(const turn of array(doc.history)){
        signal?.throwIfAborted();
        const user=record(turn.user),assistant=record(turn.assistant);
        cwd ||= first(user,"env_context.env_state.current_working_directory");
        if(Object.keys(user).length)messages.push(message(user,messages.length,{role:Object.hasOwn(record(user.content),"ToolResults") ? "tool" : "user"}));
        if(Object.keys(assistant).length){const data=record(assistant.Response ?? assistant.ToolUse ?? assistant);messages.push(message({...data,timestamp:record(turn.request_metadata).stream_end_timestamp_ms},messages.length,{role:"assistant",content:assistant,raw:turn}));}
      }
      return session(provider,row.conversation_id,cwd || row.key,messages);
    });
  });
  const rows=jsonLines((await readSource(path,signal)).toString("utf8"));
  if(basename(path)==="messages.jsonl"){
    let metadata:Row={};try{metadata=await readSourceJSON(join(dirname(path),"session.json"),signal);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    const messages=rows.filter(row=>["user","assistant","tool_call","tool_result"].includes(first(row,"payload.type"))).map((row,index)=>{
      const payload=record(row.payload),kind=string(payload.type);
      return message({...payload,timestamp:row.timestamp},index,{role:kind==="tool_result"?"tool":kind==="tool_call"?"assistant":kind,content:kind.startsWith("tool_")?payload:payload.content,model:string(payload.reasoningModelId)||undefined,raw:row});
    });
    return [session(provider,basename(dirname(path)),Array.isArray(metadata.workspacePaths)?metadata.workspacePaths[0]:"",messages,{title:metadata.title})];
  }
  let meta:Row={};try{meta=await readSourceJSON(path.replace(/\.jsonl$/,".json"),signal);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  return [session(provider,meta.session_id || basename(path,".jsonl"),meta.cwd,rows.filter(r=>["Prompt","AssistantMessage","ToolResults"].includes(string(r.kind))).map((row,i)=>message(row,i,{role:row.kind === "Prompt" ? "user" : row.kind === "ToolResults" ? "tool" : "assistant",content:row.data})),{title:meta.title})];
}
