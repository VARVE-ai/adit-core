import {Decompress} from "fzstd";
import {databaseSnapshot,hasTable} from "./source-io.js";
import {array,decode,group,message,session,sorted,table,type Row} from "./provider-common.js";
import {HistoryFormatError,record,string} from "./types.js";
import {zedFirstFolderPath} from "./zed-paths.js";
export const desktopDatabaseProviders=["warp","zed","omnigent","piebald"];
const identity=(value:unknown)=>Buffer.isBuffer(value)?value.toString("hex"):String(value ?? "");
// Zed uses externally tagged content variants; preserve native evidence in raw.
function zedContent(value:unknown):unknown {
 if(Array.isArray(value))return value.map(zedContent);
 const block=record(value);
 if(Object.hasOwn(block,"Text"))return {type:"text",text:typeof block.Text==="string"?block.Text:string(record(block.Text).text)};
 if(Object.hasOwn(block,"Thinking"))return {type:"thinking",thinking:string(record(block.Thinking).text)};
 if(Object.hasOwn(block,"ToolUse")){const tool=record(block.ToolUse);return {type:"tool_use",id:tool.id,name:tool.name,input:tool.input??tool.raw_input};}
 return value;
}
export function readDesktopDatabase(path:string,provider:string,signal?:AbortSignal){
 return databaseSnapshot(path,db=>{
  if(provider === "warp"){
   const exchanges=group(sorted(table(db,"ai_queries",["conversation_id","exchange_id","start_ts","input","model_id","working_directory","output_status"],["conversation_id","input"]),"start_ts"),"conversation_id");
   return table(db,"agent_conversations",["conversation_id","conversation_data","last_modified_at"],["conversation_id"]).map(row=>{
    const queries=exchanges.get(row.conversation_id)||[];
    return session(provider,row.conversation_id,queries.map(q=>string(q.working_directory)).find(Boolean),queries.map((q,i)=>message({...q,timestamp:q.start_ts},i,{key:string(q.exchange_id)||String(i),role:"user",content:decode(q.input,[]),model:string(q.model_id)||undefined})),{nativeMetrics:decode(row.conversation_data)});
   });
  }
  if(provider === "zed")return table(db,"threads",["id","summary","updated_at","data_type","data","parent_id","folder_paths","created_at"],["id","data"]).map(row=>{
   signal?.throwIfAborted();
   let bytes=Buffer.isBuffer(row.data)?row.data:Buffer.from(string(row.data));
   if(row.data_type === "zstd"){
    const chunks:Uint8Array[]=[];let total=0;
    // fzstd's streaming callback bounds the decompressed payload before retaining it.
    new Decompress(output=>{total+=output.byteLength;if(total>128*1024*1024)throw new HistoryFormatError("Zed transcript exceeds decompressed limit");chunks.push(output);}).push(bytes,true);bytes=Buffer.concat(chunks);
   }else if(row.data_type && row.data_type!=="json")throw new HistoryFormatError("Unsupported Zed data type");
   const doc=record(decode(bytes));
   const cwd=zedFirstFolderPath(row.folder_paths);
   const result=session(provider,row.id,cwd,array(doc.messages).map((wire,i)=>{
    const role=Object.hasOwn(wire,"User")?"user":"assistant",data=record(wire.User ?? wire.Agent);
    return message(data,i,{key:string(data.id)||String(i),role,content:zedContent(data.content ?? wire.User ?? wire.Agent),timestamp:string(data.timestamp)||string(row.created_at)||string(row.updated_at)||undefined,raw:wire});
   }),{title:string(row.summary)||string(doc.title),nativeMetadata:doc.token_usage || doc.usage});
   if(string(row.parent_id)){result.parentId=string(row.parent_id);result.relationship="subagent";}return result;
  });
  if(provider === "omnigent"){
   const conversations=table(db,"conversations",["workspace_id","id","root_conversation_id","parent_conversation_id","title","kind","workspace","session_usage"],["workspace_id","id"]);
   const metadata=hasTable(db,"omnigent_conversation_metadata")?table(db,"omnigent_conversation_metadata",["workspace_id","id","kind","workspace","git_branch","session_usage"],["workspace_id","id"]):[];
   const key=(row:Row,id=row.id)=>`${row.workspace_id}:${identity(id)}`;
   const meta=new Map(metadata.map(row=>[key(row),row]));
   const items=group(sorted(table(db,"conversation_items",["workspace_id","conversation_id","position","type","data","search_text"],["workspace_id","conversation_id","data"]),"position"),"workspace_id");
   return conversations.map(row=>{
    const own=meta.get(key(row)) || row,root=meta.get(key(row,row.root_conversation_id))||conversations.find(c=>key(c)===key(row,row.root_conversation_id))||{};
    const messages=(items.get(row.workspace_id)||[]).filter(item=>identity(item.conversation_id)===identity(row.id)).map((item,i)=>{
     const data=record(decode(item.data)),kind=String(item.type);
     const role=string(data.role)||(["3","function_call_output"].includes(kind)?"tool":["2","4","function_call","reasoning"].includes(kind)?"assistant":"system");
     return message(data,i,{role,content:data.content ?? data,raw:item});
    });
    const result=session(provider,key(row),own.workspace || root.workspace,messages,{title:row.title,usage:decode(own.session_usage)});
    if(["2","sub_agent"].includes(String(own.kind))){const parent=row.parent_conversation_id || row.root_conversation_id;if(parent){result.parentId=key(row,parent);result.relationship="subagent";}}
    return result;
   });
  }
  const chats=table(db,"chats",["id","title","project_id","current_directory","worktree_path","is_deleted"],["id"]);
  const projects=hasTable(db,"projects")?new Map(table(db,"projects",["id","directory"],["id"]).map(row=>[row.id,row])):new Map<unknown,Row>();
  const messages=group(sorted(table(db,"messages",["id","parent_chat_id","parent_message_id","enabled","role","model","created_at","input_tokens","output_tokens","reasoning_tokens","cache_read_tokens","cache_write_tokens"],["id","parent_chat_id","role"]),"created_at","id"),"parent_chat_id");
  const parts=group(sorted(table(db,"message_parts",["id","parent_chat_message_id","part_type","part_index"],["id","parent_chat_message_id"]),"part_index","id"),"parent_chat_message_id");
  const textNodes=hasTable(db,"message_node_text")?new Map(table(db,"message_node_text",["node_id","content"],["node_id"]).map(row=>[row.node_id,row.content])):new Map();
  const nodes=hasTable(db,"message_content_nodes")?group(sorted(table(db,"message_content_nodes",["id","parent_text_part_id","node_index","node_type"],["id","parent_text_part_id"]),"node_index"),"parent_text_part_id"):new Map<unknown,Row[]>();
  const tools=hasTable(db,"message_part_tool_call")?new Map(table(db,"message_part_tool_call",["message_part_id","provider_tool_use_id","tool_name","tool_input","tool_result","tool_error","tool_state","sub_agent_chat_id"],["message_part_id"]).map(row=>[row.message_part_id,row])):new Map<unknown,Row>();
  return chats.filter(row=>!row.is_deleted).map(row=>session(provider,String(row.id),row.current_directory || row.worktree_path || projects.get(row.project_id)?.directory,(messages.get(row.id)||[]).filter(m=>m.enabled!==0).map((m,i)=>message(m,i,{
   key:String(m.id),parentKey:m.parent_message_id?String(m.parent_message_id):undefined,
   content:(parts.get(m.id)||[]).map(part=>({...part,text:(nodes.get(part.id)||[]).map(node=>textNodes.get(node.id)),tool:tools.get(part.id)})),
   usage:Object.fromEntries(Object.entries(m).filter(([key])=>key.endsWith("_tokens"))),
  })),{title:row.title}));
 });
}
