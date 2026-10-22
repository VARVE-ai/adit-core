import { basename, dirname, join } from "node:path";
import { databaseSnapshot, readSource, readSourceJSON } from "./source-io.js";
import { array, decode, group, message, session, sorted, table, type Row } from "./provider-common.js";
import { HistoryFormatError, jsonLines, record, string } from "./types.js";

export const nativeMessageProviders=["amp","gptme","openclaw","qclaw"];
function clawSession(rows:Row[],provider:string,agent:string,fallback:string){
  const headers=rows.filter(row=>row.type === "session");
  const ids=new Set(headers.map(h=>string(h.id)).filter(Boolean));
  if(ids.size>1)throw new HistoryFormatError("OpenClaw transcript has conflicting session identities");
  const header=headers[0] || {},id=string(header.id) || fallback;
  const messages=rows.filter(r=>r.type === "message").map((row,i)=>{
    const data=record(row.message);
    return message({...data,timestamp:data.timestamp ?? row.timestamp},i,{key:string(row.id) || String(i),role:data.role === "toolResult" ? "tool" : string(data.role),parentKey:string(row.parentId)||undefined,raw:row});
  });
  return session(provider,`${agent}:${id}`,header.cwd,messages,{agent,sessionId:id});
}
export async function readNativeMessages(path:string,provider:string,signal?:AbortSignal){
  if(provider === "amp"){
    const doc=await readSourceJSON(path,signal);
    if(!Array.isArray(doc.messages))throw new HistoryFormatError("Amp thread messages are missing");
    return [session(provider,basename(path,".json"),"",array(doc.messages).filter(m=>["user","assistant"].includes(string(m.role))).map((row,i)=>{
      const usage=record(row.usage);
      return message({...row,timestamp:usage.timestamp ?? row.timestamp},i,{model:string(usage.model) || string(row.model) || undefined});
    }),{title:doc.title,environment:doc.env})];
  }
  if(provider === "gptme"){
    let model="";
    const rows=jsonLines((await readSource(path,signal)).toString("utf8"));
    return [session(provider,basename(dirname(path)),"",rows.filter(row=>["user","assistant","tool"].includes(string(row.role))).map((row,i)=>{
      const metadata=record(row.metadata);if(row.role === "assistant")model=string(metadata.model) || model;
      const usage=record(metadata.usage);
      return message(row,i,{model:row.role === "assistant" ? model || undefined : undefined,usage:row.role === "assistant" && Object.keys(usage).length ? usage : undefined});
    }))];
  }
  const agent=basename(dirname(dirname(path)));
  if(path.endsWith(".sqlite"))return databaseSnapshot(path,db=>{
    const columns=(name:string)=>new Set((db.prepare(`PRAGMA table_info(${name})`).all() as {name:string}[]).map(c=>c.name));
    const windows=columns("session_windows"),nodes=columns("session_nodes");
    const titles=new Map<unknown,string>();
    if(windows.has("session_id")&&windows.has("session_key")&&nodes.has("session_key")&&(nodes.has("label")||nodes.has("display_name"))){
      const names=new Map(table(db,"session_nodes",["session_key","label","display_name"]).map(row=>[row.session_key,string(row.label).trim()||string(row.display_name).trim()]));
      for(const row of table(db,"session_windows",["session_id","session_key"]))titles.set(row.session_id,names.get(row.session_key)||"");
    }
    const rows=group(sorted(table(db,"transcript_events",["session_id","seq","event_json","created_at"],["session_id","seq","event_json"]),"session_id","seq"),"session_id");
    return [...rows].map(([id,events])=>{
      signal?.throwIfAborted();
      const result=clawSession(events.map(e=>record(decode(e.event_json))),provider,agent,String(id));
      if(result.metadata?.sessionId!==String(id))throw new HistoryFormatError("OpenClaw database session identity mismatch");
      result.metadata={...result.metadata,title:titles.get(id)||""};
      return result;
    });
  });
  // The SQLite transcript is canonical for a migrated session; keep JSONL fallback for other sessions.
  try {
    const canonical=readNativeMessages(join(dirname(path),"openclaw-agent.sqlite"),provider,signal);
    const sessions=await canonical;
    const fallback=basename(path).split(".jsonl")[0];
    if(sessions.some(s=>s.metadata?.sessionId===fallback))return [];
  } catch(error) {
    if((error as NodeJS.ErrnoException).code!=="SQLITE_CANTOPEN" && (error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
  }
  return [clawSession(jsonLines((await readSource(path,signal)).toString("utf8")),provider,agent,basename(path).split(".jsonl")[0])];
}
