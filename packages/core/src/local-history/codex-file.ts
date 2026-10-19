import {openSync,readSync,closeSync,fstatSync,lstatSync} from "node:fs";
import {basename} from "node:path";
import {HistoryFormatError,record,string} from "./types.js";
import {parseCodexRows} from "./parsers.js";
import {sourceFiles} from "./sources.js";

// Bound a single record rather than the total session: long sessions can exceed 128 MiB.
export function* codexFileRows(path:string,signal?:AbortSignal):Generator<Record<string,unknown>>{
 signal?.throwIfAborted();if(lstatSync(path).isSymbolicLink())throw new HistoryFormatError("Symbolic sources are not collected");
 const fd=openSync(path,"r"),chunk=Buffer.allocUnsafe(1024*1024);let pending=Buffer.alloc(0),line=0;
 const parse=(bytes:Buffer)=>{line++;const text=bytes.toString("utf8").replace(/^\uFEFF/,"").trim();if(!text)return undefined;let value:unknown;try{value=JSON.parse(text);}catch{throw new HistoryFormatError(`Invalid JSON record at line ${line}`);}if(!value||typeof value!=="object"||Array.isArray(value))throw new HistoryFormatError(`Invalid JSON record at line ${line}`);return value as Record<string,unknown>;};
 try{
  const before=fstatSync(fd);if(!before.isFile())throw new HistoryFormatError("Source is not a regular file");
  while(true){signal?.throwIfAborted();const size=readSync(fd,chunk,0,chunk.length,null);if(!size)break;const data=pending.length?Buffer.concat([pending,chunk.subarray(0,size)]):chunk.subarray(0,size);let start=0,end:number;
   while((end=data.indexOf(10,start))!==-1){if(end-start>64*1024*1024)throw new HistoryFormatError("Codex record exceeds the 64 MiB record limit");const row=parse(data.subarray(start,end));if(row)yield row;start=end+1;}
   pending=Buffer.from(data.subarray(start));if(pending.length>64*1024*1024)throw new HistoryFormatError("Codex record exceeds the 64 MiB record limit");
  }
  if(pending.length){let valid=true;try{JSON.parse(pending.toString("utf8"));}catch{valid=false;}if(valid){const row=parse(pending);if(row)yield row;}}
  const after=fstatSync(fd);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new HistoryFormatError("Source changed while reading; retry on the next collection");
 }finally{closeSync(fd);}
}
export async function readCodexSession(path:string,provider:string,root:string,signal?:AbortSignal){
 let parent="";
 for(const row of codexFileRows(path,signal))if(row.type==="session_meta"){const meta=record(row.payload);parent=string(meta.forked_from_id)||string(record(record(record(meta.source).subagent).thread_spawn).parent_thread_id);break;}
 let turns:Set<string>|undefined;
 if(parent)for await(const candidate of sourceFiles(provider,root,signal)){
  if(candidate===path||!basename(candidate).includes(parent))continue;
  let match=false;const found=new Set<string>();
  for(const row of codexFileRows(candidate,signal)){
   const payload=record(row.payload);if(row.type==="session_meta"&&!match){if(payload.id!==parent)break;match=true;}
   if(row.type==="turn_context"&&string(payload.turn_id))found.add(string(payload.turn_id));
  }
  if(match){turns=found;break;}
 }
 const session=parseCodexRows(codexFileRows(path,signal),turns,path);session.provider=provider;return [session];
}
