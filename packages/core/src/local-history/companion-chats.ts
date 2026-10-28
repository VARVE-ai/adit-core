import {basename,dirname,join} from "node:path";
import {readSource,readSourceJSON} from "./source-io.js";
import {at,array,first,message,session} from "./provider-common.js";
import {HistoryFormatError,jsonLines,record,string,type HistoryMessage} from "./types.js";
export const companionChatProviders=["posit-assistant","codebuff"];
async function optional(path:string,signal?:AbortSignal){try{return await readSourceJSON(path,signal);}catch(error){if((error as NodeJS.ErrnoException).code === "ENOENT")return {};throw error;}}
export async function readCompanionChat(path:string,provider:string,signal?:AbortSignal){
  if(provider === "codebuff"){
    const text=(await readSource(path,signal)).toString("utf8");let rows:unknown;
    try{rows=JSON.parse(text);}catch{throw new HistoryFormatError("Invalid Codebuff chat transcript");}
    if(!Array.isArray(rows))throw new HistoryFormatError("Codebuff chat transcript must be an array");
    const state=await optional(join(dirname(path),"run-state.json"),signal),meta=await optional(join(dirname(path),"chat-meta.json"),signal);
    const agentType=first(state,"sessionState.mainAgentState.agentType");
    return [session(provider,`${basename(dirname(dirname(dirname(path))))}:${basename(dirname(path))}`,first(state,"sessionState.fileContext.cwd"),array(rows).map((row,i)=>{
      const role=row.variant === "user" ? "user" : ["ai","assistant"].includes(string(row.variant)) ? "assistant" : "system";
      return message(row,i,{role,content:{text:row.content,blocks:row.blocks,attachments:row.attachments,userError:row.userError},model:first(row,"metadata.runState.inference.model") || first(state,"inference.model") || undefined,usage:undefined});
    }),{title:meta.name || meta.title,agentType,classification:agentType.toLowerCase().includes("free") ? "freebuff" : "codebuff",nativeState:state,nativeMetadata:meta})];
  }
  const doc=await readSourceJSON(path,signal),root=record(doc.root);
  if(String(doc.schemaVersion)!=="3" || !Array.isArray(doc.messages))throw new HistoryFormatError("Unsupported Posit Assistant conversation schema");
  const rows=jsonLines((await readSource(join(dirname(path),"lm-messages.jsonl"),signal)).toString("utf8"));
  const byId=new Map(rows.map(row=>[row.id,row]));
  let workspaceDir=dirname(dirname(path));
  let parentId:string|undefined;
  if(basename(workspaceDir) === "subagents") {parentId=basename(dirname(workspaceDir));workspaceDir=dirname(dirname(workspaceDir));}
  const workspace=await optional(join(workspaceDir,"workspace.json"),signal);
  const messages:HistoryMessage[]=[];
  for(const node of array(doc.messages)){
    if(!node.isActive)continue;
    if(!Array.isArray(node.lmMessageIds))throw new HistoryFormatError("Posit Assistant message references are missing");
    for(const id of node.lmMessageIds){
      const wire=byId.get(id);if(!wire)throw new HistoryFormatError("Posit Assistant transcript message is missing");
      const data=record(wire.message),providers=record(at(data,"providerOptions.providerMetadata"));
      const usageMeta=record(Object.values(providers)[0]);
      messages.push(message({...data,timestamp:usageMeta.timestamp ?? node.timestamp},messages.length,{key:String(id),model:first(usageMeta,"modelId") || first(root,"metadata.model.id") || undefined,usage:Object.keys(record(usageMeta.usage)).length?record(usageMeta.usage):undefined,parentKey:string(node.parentId)||undefined,raw:{...wire,node}}));
    }
  }
  const result=session(provider,root.id || basename(dirname(path)),workspace.path,messages,{title:root.title || root.summary,root});
  if(parentId){result.parentId=parentId;result.relationship="subagent";}
  return [result];
}
