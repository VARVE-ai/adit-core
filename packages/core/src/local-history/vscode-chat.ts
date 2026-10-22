import {basename,dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {readSource,readSourceJSON} from "./source-io.js";
import {array,first,message,session,type Row} from "./provider-common.js";
import {HistoryFormatError,jsonLines,jsonDocument,record,string,type HistoryMessage} from "./types.js";
export const vscodeChatProviders=["vscode-copilot","positron"];
export function replayChatOperations(rows:Row[]):Row{
  let state:unknown;
  for(const op of rows){
    if(op.kind===0){state=op.v;continue;}
    if(!state || !Array.isArray(op.k) || !op.k.length)throw new HistoryFormatError("Chat mutation has no initial snapshot or path");
    const keys=op.k as (string|number)[];
    if(keys.some(k=>!(typeof k === "string" || Number.isSafeInteger(k)) || ["__proto__","prototype","constructor"].includes(String(k))))throw new HistoryFormatError("Unsafe chat mutation path");
    let container=state as Record<string,unknown>;
    for(const key of keys.slice(0,-1)){
      if(!container || typeof container!=="object")throw new HistoryFormatError("Invalid chat mutation ancestor");
      container=container[String(key)] as Record<string,unknown>;
    }
    if(!container || typeof container!=="object")throw new HistoryFormatError("Invalid chat mutation target");
    const key=String(keys.at(-1));
    if(op.kind===1)container[key]=op.v;
    else if(op.kind===2){const target=container[key];if(!Array.isArray(target)||!Array.isArray(op.v))throw new HistoryFormatError("Chat push requires arrays");const index=op.i===undefined?target.length:Number(op.i);if(!Number.isSafeInteger(index)||index<0||index>target.length)throw new HistoryFormatError("Invalid chat push index");target.splice(index,0,...op.v);}
    else if(op.kind===3){if(Array.isArray(container)){const index=Number(key);if(!Number.isSafeInteger(index)||index<0)throw new HistoryFormatError("Invalid chat delete index");container.splice(index,1);}else delete container[key];}
    else throw new HistoryFormatError("Unsupported chat mutation kind");
  }
  return record(state);
}
export async function readVSCodeChat(path:string,provider:string,signal?:AbortSignal){
  const text=(await readSource(path,signal)).toString("utf8");
  const doc=path.endsWith(".jsonl") ? replayChatOperations(jsonLines(text)) : jsonDocument(text);
  if(!Array.isArray(doc.requests))throw new HistoryFormatError("VS Code chat requests are missing");
  let cwd="";
  try{const workspace=await readSourceJSON(join(dirname(dirname(path)),"workspace.json"),signal);const uri=string(workspace.folder);if(uri.startsWith("file:"))cwd=fileURLToPath(uri);}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const messages:HistoryMessage[]=[];
  for(const row of array(doc.requests)){
    signal?.throwIfAborted();
    const id=string(row.requestId)||String(messages.length),usage=record(record(row.result).metadata),model=first(usage,"resolvedModel") || string(row.modelId);
    messages.push(message(row,messages.length,{key:`${id}:user`,role:"user",content:row.message,usage:undefined}));
    if(Array.isArray(row.response))messages.push(message(row,messages.length,{key:`${id}:assistant`,role:"assistant",content:row.response,model:model||undefined,usage:Object.keys(usage).length?usage:undefined}));
  }
  return [session(provider,doc.sessionId || basename(path).replace(/\.jsonl?$/,""),cwd,messages,{title:doc.customTitle})];
}
