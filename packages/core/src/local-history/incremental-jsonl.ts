import {openSync,closeSync,readSync,fstatSync,lstatSync} from "node:fs";
import {createHash} from "node:crypto";
import {resolve} from "node:path";
import type Database from "better-sqlite3";
import {codexFileRows,codexThreadTitle} from "./codex-file.js";
import {parseCodexRows,codexResumeState,type CodexResume} from "./codex.js";
import {claudeBranches} from "./claude-lineage.js";
import {StructuredHistory} from "./structured-store.js";
import {sourceStamp,trackSource} from "./source-checkpoints.js";
import {HistoryFormatError,record,string,type HistorySession} from "./types.js";

interface Cursor {session_id:string;byte_offset:number;prefix_hash:string;file_identity:string;state_json:string;manifest_json:string}
interface State {codex?:CodexResume;claude?:{lastUuid:string}}

// No transcript copy: only byte position, integrity digest and small parser state.
// Hashing the old bytes catches in-place rewrites even when the inode is unchanged.
// Only the appended records go through JSON decoding and source normalization.
function integrity(path:string,length?:number,signal?:AbortSignal) {
  trackSource(path);
  if(lstatSync(path).isSymbolicLink())throw new HistoryFormatError("Symbolic sources are not collected");
  const fd=openSync(path,"r"),buffer=Buffer.allocUnsafe(1024*1024),hash=createHash("sha256");
  try {
    const stat=fstatSync(fd),limit=length??stat.size;
    if(!stat.isFile())throw new HistoryFormatError("Source is not a regular file");
    if(limit>stat.size)return null;
    let position=0,last=-1;
    while(position<limit) {
      signal?.throwIfAborted();
      const size=readSync(fd,buffer,0,Math.min(buffer.length,limit-position),position);
      if(!size)return null;
      hash.update(buffer.subarray(0,size));position+=size;last=buffer[size-1];
    }
    return {size:stat.size,offset:limit,hash:hash.digest("hex"),identity:`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,newline:!limit||last===10};
  } finally {closeSync(fd);}
}

function claudeState(session:HistorySession):State|undefined {
  if(session.parentId || !session.messages.length)return;
  let previous="";
  for(const m of session.messages) {
    const raw=m.raw,id=string(raw.uuid);
    if(!id || !["user","assistant"].includes(string(raw.type)) || (previous && raw.parentUuid!==previous))return;
    previous=id;
  }
  return {claude:{lastUuid:previous}};
}

export async function collectIncrementalJSONL(db:Database.Database,provider:string,path:string,scope:string,version:number,
  full:()=>Promise<HistorySession[]>,signal?:AbortSignal) {
  const supported=["claude","codex","traex","augure-code"].includes(provider)&&path.endsWith(".jsonl");
  if(!supported)return {sessions:await full(),commit:()=>{}};
  const pathKey=process.platform==="win32"?resolve(path).toLowerCase():resolve(path);
  const cursor=db.prepare(`SELECT c.*,f.manifest_json FROM adit_history_jsonl_cursors c
    JOIN adit_history_file_checkpoints f USING(provider,path,scope)
    WHERE c.provider=? AND c.path=? AND c.scope=? AND c.parser_version=? AND f.parser_version=?`)
    .get(provider,pathKey,scope,version,version) as Cursor|undefined;
  let snapshots:HistorySession[]|undefined,usedAppend=false;
  if(cursor) {
    const state=JSON.parse(cursor.state_json) as State;
    const dependencies=JSON.parse(cursor.manifest_json) as [string,string][];
    const depsStable=dependencies.every(([file,stamp])=>resolve(file).toLowerCase()===resolve(path).toLowerCase() || sourceStamp(file)===stamp);
    const prefix=depsStable?integrity(path,cursor.byte_offset,signal):null;
    if(prefix && prefix.newline && prefix.identity===cursor.file_identity && prefix.hash===cursor.prefix_hash) {
      const previous=new StructuredHistory(db).read(provider,cursor.session_id);
      if(previous) {
        const tail=[...codexFileRows(path,signal,cursor.byte_offset)];
        if(state.codex && !tail.some(r=>["session_meta","history_mutation"].includes(string(r.type)))) {
          const s=parseCodexRows(tail,undefined,path,provider,{session:previous,state:state.codex});s.provider=provider;
          s.metadata={...s.metadata,title:await codexThreadTitle(path,string(s.metadata?.nativeSessionId)||s.id,signal)};
          snapshots=[s];usedAppend=true;
        } else if(state.claude) {
          const known=new Set(previous.messages.map(m=>m.key)),responses=new Set(previous.messages.map(m=>record(m.raw.message).id).filter(Boolean));
          let parent=state.claude.lastUuid;
          const linear=tail.every(row=>{
            const id=string(row.uuid),response=record(row.message).id;
            if(!["user","assistant"].includes(string(row.type)) || !id || known.has(id) || row.parentUuid!==parent || (response&&responses.has(response)))return false;
            known.add(id);if(response)responses.add(response);parent=id;return true;
          });
          if(linear) {
            const appended=tail.length?claudeBranches(tail,path,provider):[];
            if(appended.length<=1 && (!appended[0] || appended[0].id===previous.id)) {
              snapshots=[{...previous,messages:[...previous.messages,...(appended[0]?.messages??[])]}];usedAppend=true;
            }
          }
        }
      }
    }
  }
  snapshots??=await full();
  let state:State|undefined;
  if(snapshots.length===1 && !snapshots[0].parentId && !snapshots[0].metadata?.lineageRetry) {
    state=provider==="claude"?claudeState(snapshots[0]):codexResumeState(snapshots[0])?{codex:codexResumeState(snapshots[0])}:undefined;
  }
  const stamp=state?integrity(path,undefined,signal):null;
  const sessions=snapshots;
  return {sessions,usedAppend,commit:()=>{
    db.prepare("DELETE FROM adit_history_jsonl_cursors WHERE provider=? AND path=? AND scope=?").run(provider,pathKey,scope);
    if(state && stamp?.newline && sessions.length===1 && db.prepare("SELECT 1 FROM adit_history_sessions WHERE provider=? AND id=?").get(provider,sessions[0].id))
      db.prepare("INSERT INTO adit_history_jsonl_cursors VALUES (?,?,?,?,?,?,?,?,?)").run(provider,pathKey,scope,version,sessions[0].id,stamp.offset,stamp.hash,stamp.identity,JSON.stringify(state));
  }};
}
