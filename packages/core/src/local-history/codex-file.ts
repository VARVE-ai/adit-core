import {openSync,readSync,closeSync,fstatSync,lstatSync} from "node:fs";
import {basename,dirname,join,resolve} from "node:path";
import {HistoryFormatError,record,string} from "./types.js";
import {parseCodexRows,codexContinuationRoot} from "./codex.js";
import {sourceFiles,insideDirectory} from "./sources.js";
import {trackSource,sourceStamp} from "./source-checkpoints.js";
import {readSource} from "./source-io.js";
import type Database from "better-sqlite3";
import {isCompactedReply} from "./message-semantics.js";

/** One-time native-evidence upgrade. IDs, bodies, edits, usage and source checkpoints stay intact. */
export function refreshCodexContexts(db:Database.Database, options:{provider?:string;scopes?:string[];signal?:AbortSignal}={}):number {
 if(options.provider && !['codex','traex','augure-code'].includes(options.provider))return 0;
 const candidates=db.prepare(`SELECT s.provider,s.id,s.cwd,h.path FROM adit_history_sessions s
   JOIN adit_history_sources h ON h.provider=s.provider AND h.session_id=s.id
   WHERE s.provider IN ('codex','traex','augure-code') AND coalesce(json_extract(s.metadata_json,'$.nativeContextVersion'),0)<1`).all() as {provider:string;id:string;cwd:string;path:string}[];
 let changed=0;
 for(const s of candidates){
  if(options.provider && s.provider!==options.provider || options.scopes && !options.scopes.some(scope=>insideDirectory(scope,s.cwd)))continue;
  options.signal?.throwIfAborted();
  const path=s.path.endsWith(`#${s.id}`)?s.path.slice(0,-s.id.length-1):s.path;
  try{
   let candidate:Record<string,unknown>|undefined;const keys=new Set<string>();
   for(const row of codexFileRows(path,options.signal)){
    if(row.type==='response_item')candidate=row;
    if(isCompactedReply(row,candidate)){const key=string(record(candidate?.payload).id);if(key)keys.add(key);}
   }
   changed+=db.transaction(()=>{
    let count=0;
    for(const key of keys)count+=db.prepare(`UPDATE adit_history_messages SET extra_json=json_set(extra_json,'$.contextKind','compaction')
      WHERE provider=? AND session_id=? AND source_key=? AND coalesce(json_extract(extra_json,'$.contextKind'),'')<>'compaction'`).run(s.provider,s.id,key).changes;
    db.prepare("UPDATE adit_history_sessions SET metadata_json=json_set(coalesce(metadata_json,'{}'),'$.nativeContextVersion',1),transcript_revision=transcript_revision+? WHERE provider=? AND id=?").run(count?1:0,s.provider,s.id);
    return count;
   })();
  }catch{options.signal?.throwIfAborted();/* Unavailable or changing sources are retried at the next collection. */}
 }
 return changed;
}

/** Correct old page identities using only the native header, without replaying bodies. */
export function refreshCodexContinuations(db:Database.Database):number {
 const candidates=db.prepare(`SELECT s.provider,s.id,s.parent_id,s.metadata_json,h.path FROM adit_history_sessions s
   JOIN adit_history_sources h ON h.provider=s.provider AND h.session_id=s.id
   WHERE s.provider IN ('codex','traex','augure-code') AND s.relationship='fork'
   AND json_extract(s.metadata_json,'$.historyBase.thread_id') IS NOT NULL`).all() as {provider:string;id:string;parent_id:string;metadata_json:string;path:string}[];
 let changed=0;
 for(const s of candidates){
  const path=s.path.endsWith(`#${s.id}`)?s.path.slice(0,-s.id.length-1):s.path;
  try {
   for(const row of codexFileRows(path)){
    if(row.type!=="session_meta")break;
    const meta=record(row.payload);
    const root=codexContinuationRoot(meta,s.id);if(!root)break;
    db.transaction(()=>{
     db.prepare("UPDATE adit_history_sessions SET relationship='continuation',parent_id=?,metadata_json=? WHERE provider=? AND id=?")
       .run(root,JSON.stringify({...JSON.parse(s.metadata_json),nativeSessionId:root}),s.provider,s.id);
     db.prepare("UPDATE adit_history_relations SET kind='continuation',parent_id=? WHERE provider=? AND session_id=?").run(root,s.provider,s.id);
    })();changed++;break;
   }
  } catch { /* Missing or unreadable native evidence must not merge archived sessions. */ }
 }
 return changed;
}

// Bound a single record rather than the total session: long sessions can exceed 128 MiB.
export function* codexFileRows(path:string,signal?:AbortSignal):Generator<Record<string,unknown>>{
 trackSource(path);
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
 let parent="",nativeId="";
 for(const row of codexFileRows(path,signal))if(row.type==="session_meta"){const meta=record(row.payload);nativeId=string(meta.id);parent=string(meta.forked_from_id)||string(record(record(record(meta.source).subagent).thread_spawn).parent_thread_id);break;}
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
 const session=parseCodexRows(codexFileRows(path,signal),turns,path);session.provider=provider;
 session.metadata={...session.metadata,title:await codexThreadTitle(path,string(session.metadata?.nativeSessionId)||nativeId,signal)};
 return [session];
}

const titleIndexes=new Map<string,{stamp:string;titles:Map<string,string>}>();
/** The native index lives beside sessions/ and archived_sessions/, including custom homes. */
async function codexThreadTitle(path:string,id:string,signal?:AbortSignal):Promise<string>{
 for(let dir=dirname(resolve(path));dir!==dirname(dir);dir=dirname(dir)){
  if(!["sessions","archived_sessions"].includes(basename(dir)))continue;
  const index=join(dirname(dir),"session_index.jsonl");
  trackSource(index);signal?.throwIfAborted();
  const stamp=sourceStamp(index);
  if(stamp==="missing"){titleIndexes.delete(index);return "";}
  let cached=titleIndexes.get(index);
  if(cached?.stamp!==stamp){
   const text=(await readSource(index,signal)).toString("utf8"),titles=new Map<string,string>();
   for(const line of text.split("\n")){
    signal?.throwIfAborted();
    // A partially written or malformed index entry must not hide other titles.
    let row:Record<string,unknown>;try{row=record(JSON.parse(line));}catch{continue;}
    if(string(row.id)&&typeof row.thread_name==="string")titles.set(string(row.id),row.thread_name.trim());
   }
   if(sourceStamp(index)!==stamp)throw new HistoryFormatError("Codex title index changed while reading; retry on the next collection");
   if(titleIndexes.size>=16)titleIndexes.clear();
   cached={stamp,titles};titleIndexes.set(index,cached);
  }
  return cached.titles.get(id)||"";
 }
 return "";
}
