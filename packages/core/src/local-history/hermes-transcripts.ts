import {basename,dirname,join} from "node:path";
import {readSource,readSourceJSON} from "./source-io.js";
import {array,message,session} from "./provider-common.js";
import {HistoryFormatError,jsonLines,string} from "./types.js";
import {readDatabaseProvider} from "./database-providers.js";
export async function readHermesTranscript(path:string,signal?:AbortSignal){
 const id=basename(path).replace(/\.jsonl?$/,"").replace(/^session_/,"");
 try{if(readDatabaseProvider(join(dirname(dirname(path)),"state.db"),"hermes",signal).some(s=>s.id===id))return [];}catch(error){if((error as NodeJS.ErrnoException).code!=="SQLITE_CANTOPEN"&&(error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 let model="",platform="";let rows;
 if(path.endsWith(".jsonl"))rows=jsonLines((await readSource(path,signal)).toString("utf8"));
 else {const doc=await readSourceJSON(path,signal);if(!Array.isArray(doc.messages))throw new HistoryFormatError("Hermes snapshot messages are missing");rows=array(doc.messages);model=string(doc.model);platform=string(doc.platform);}
 const messages=[];
 for(const row of rows){signal?.throwIfAborted();if(row.role==="session_meta"){model=string(row.model)||model;platform=string(row.platform)||platform;continue;}if(!["user","assistant","tool","system"].includes(string(row.role)))continue;
  messages.push(message(row,messages.length,{model:row.role==="assistant"?string(row.model)||model||undefined:undefined,content:{content:row.content,reasoning:row.reasoning,reasoning_details:row.reasoning_details,tool_calls:row.tool_calls,tool_call_id:row.tool_call_id},usage:undefined}));
 }
 return [session("hermes",id,"",messages,{platform})];
}
