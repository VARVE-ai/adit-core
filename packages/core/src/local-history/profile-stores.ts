import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {databaseSnapshot,hasTable,readSourceJSON,childPath} from "./source-io.js";
import {array,decode,first,group,message,session,sorted,table,type Row} from "./provider-common.js";
import {HistoryFormatError,record,string,type HistorySession} from "./types.js";
export const profileStoreProviders=["windsurf","trae","devin"];
export async function readProfileStore(path:string,provider:string,signal?:AbortSignal):Promise<HistorySession[]>{
 if(provider==="trae" && path.endsWith("database.db"))throw new HistoryFormatError("Trae ModularData is encrypted and has no supported local transcript format; the readable legacy chat store remains available");
 if(provider === "devin"){
  const snapshots=databaseSnapshot(path,db=>{
   const sessions=table(db,"sessions",["id","title","working_directory","model","hidden","main_chain_id"],["id"]);
   const nodes=hasTable(db,"message_nodes")?group(sorted(table(db,"message_nodes",["row_id","node_id","parent_node_id","chat_message","created_at","session_id"],["node_id","session_id","chat_message"]),"created_at","row_id"),"session_id"):new Map<unknown,Row[]>();
   return sessions.filter(row=>row.hidden!==1).map(row=>({row,nodes:nodes.get(row.id)||[]}));
  });
  const result:HistorySession[]=[];
  for(const {row,nodes} of snapshots){
   signal?.throwIfAborted();let entries:Row[]=[];
   if(nodes.length){
    const selected:Row[]=[];let id=row.main_chain_id;const seen=new Set<unknown>();
    while(id!==undefined&&id!==null){if(seen.has(id))throw new HistoryFormatError("Devin conversation ancestry cycle");seen.add(id);const node=nodes.find(n=>n.node_id===id || n.row_id===id);if(!node)throw new HistoryFormatError("Devin conversation ancestor is missing");selected.unshift(node);id=node.parent_node_id;}
    entries=(selected.length?selected:nodes).map(node=>({...record(decode(node.chat_message)),timestamp:node.created_at}));
   }else{
    const doc=await readSourceJSON(childPath(join(dirname(path),"transcripts"),`${String(row.id)}.json`),signal);
    if(!Array.isArray(doc.messages)&&!Array.isArray(doc.steps))throw new HistoryFormatError("Devin transcript steps are missing");
    entries=array(doc.messages ?? doc.steps).map(step=>step.source?{...step,role:step.source==="agent"?"assistant":step.source,content:{message:step.message,tool_use:step.tool_use,tool_result:step.tool_result},usage:step.metrics,model:first(step,"extra.generation_model","model_name")}:step);
   }
   result.push(session(provider,String(row.id),row.working_directory,entries.map((entry,i)=>message(entry,i,{model:first(entry,"metadata.generation_model","model")||string(row.model)||undefined,usage:entry.usage?record(entry.usage):record(record(entry.metadata).metrics)})),{title:row.title}));
  }
  return result;
 }
 let cwd="";
 try{const workspace=await readSourceJSON(join(dirname(path),"workspace.json"),signal);if(string(workspace.folder).startsWith("file:"))cwd=fileURLToPath(string(workspace.folder));}
 catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 return databaseSnapshot(path,db=>{
  const keys=provider === "windsurf" ? ["workbench.panel.aichat.view.aichat.chatdata","aiChat.chatdata"] : ["memento/icube-ai-agent-storage"];
  const result:HistorySession[]=[];
  for(const key of keys){
   const row=db.prepare("SELECT value FROM ItemTable WHERE key=?").get(key) as {value:string}|undefined;if(!row)continue;
   const doc=record(decode(row.value));
   if(provider === "windsurf"){
    for(const tab of array(doc.tabs))result.push(session(provider,tab.tabId,cwd,array(tab.bubbles).map((bubble,i)=>message(bubble,i,{role:["2","ai","assistant"].includes(String(bubble.type).toLowerCase())?"assistant":"user",content:first(bubble,"text","rawText","initText")})),{title:tab.chatTitle}));
   }else{
    if(!Array.isArray(doc.list))throw new HistoryFormatError("Trae chat store has no readable session list");
    for(const item of array(doc.list))result.push(session(provider,item.sessionId,cwd,array(item.messages).map((wire,i)=>message(wire,i,{model:string(wire.model)||string(item.model)||undefined,content:{text:wire.content,agentTaskContent:wire.agentTaskContent}}))));
   }
  }
  return result;
 });
}
