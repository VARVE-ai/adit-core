import { resolve } from "node:path";
import type Database from "better-sqlite3";
import type { ScanResult, ScanSource } from "./archive.js";
import { insideDirectory, sourceFiles } from "./sources.js";
import { sourceStamp, trackSourceReads } from "./source-checkpoints.js";
import { readSessionMetadata, type MetadataResult } from "./discovery-metadata.js";
import { isRetryableCollectionIssue } from "./collection-issues.js";

const VERSION=1;
export interface DiscoveryOptions {
  signal?:AbortSignal;
  beforeSource?:(id:string)=>void;
  progress?:(scanned:number,updated:number)=>void;
  file?:(root:string,path:string,metadata:MetadataResult)=>void;
  directoryError?:(error:string)=>void;
}

/** A separate cache: discovery must never mark a transcript as collected. */
export async function discoverHistory(db:Database.Database,workspace:string,sources:ScanSource[],options:DiscoveryOptions={}):Promise<ScanResult> {
  db.exec(`CREATE TABLE IF NOT EXISTS adit_history_discovery_cache (
    provider TEXT NOT NULL,path TEXT NOT NULL,scope TEXT NOT NULL,version INTEGER NOT NULL,
    manifest_json TEXT NOT NULL,metadata_json TEXT NOT NULL,PRIMARY KEY(provider,path,scope)
  )`);
  const result:ScanResult={counts:{},errors:[],scanned:0,updated:0,pending:{},cached:0};
  const seen=new Set<string>(),sessions=new Map<string,{provider:string;id:string;cwd:string;parentId?:string;relationship?:string}>();
  const get=db.prepare("SELECT manifest_json,metadata_json FROM adit_history_discovery_cache WHERE provider=? AND path=? AND scope=? AND version=?");
  const put=db.prepare(`INSERT INTO adit_history_discovery_cache VALUES (?,?,?,?,?,?) ON CONFLICT(provider,path,scope)
    DO UPDATE SET version=excluded.version,manifest_json=excluded.manifest_json,metadata_json=excluded.metadata_json`);
  const assigned=db.prepare("SELECT workspace FROM adit_history_assignments WHERE provider=? AND session_id=?");
  for(const source of sources) {
    const version=["codex","traex","augure-code","qoder"].includes(source.id)?2:VERSION;
    options.signal?.throwIfAborted();options.beforeSource?.(source.id);
    for(const root of source.paths) {
      try {
        for await(const path of sourceFiles(source.id,root,options.signal)) {
          options.signal?.throwIfAborted();options.beforeSource?.(source.id);
          const pathKey=process.platform==="win32"?resolve(path).toLowerCase():resolve(path),key=`${source.id}:${pathKey}`;
          if(seen.has(key))continue;seen.add(key);
          // Only Cursor resolves encoded paths against the requested workspace.
          const scope=JSON.stringify([resolve(root),source.id==="cursor"?resolve(workspace):""]);
          try {
            const old=get.get(source.id,pathKey,scope,version) as {manifest_json:string;metadata_json:string}|undefined;
            let metadata:MetadataResult;
            if(old&&(JSON.parse(old.manifest_json) as [string,string][]).every(([file,stamp])=>sourceStamp(file)===stamp)) {
              metadata=JSON.parse(old.metadata_json);result.cached=(result.cached||0)+1;
            } else {
              const captured=await trackSourceReads(path,()=>readSessionMetadata(path,source.id,root,workspace,options.signal));
              metadata=captured.value;
              if(captured.stable)put.run(source.id,pathKey,scope,version,JSON.stringify(captured.manifest),JSON.stringify(metadata));
              else metadata={...metadata,pending:true};
            }
            for(const s of metadata.sessions)if(s.id)sessions.set(`${source.id}:${s.id}`,{...s,provider:source.id});
            if(metadata.pending)result.pending![source.id]=(result.pending![source.id]||0)+1;
            options.file?.(root,path,metadata);
          } catch(error) {
            options.signal?.throwIfAborted();
            options.file?.(root,path,{sessions:[],pending:true});
            const message=`${source.id}: ${error instanceof Error?error.message:"Metadata could not be read"}`;
            if(isRetryableCollectionIssue(error)){
              (result.deferred??=[]).push(message);
              result.pending![source.id]=(result.pending![source.id]||0)+1;
            }else result.errors.push(message);
          }
          result.scanned++;options.progress?.(result.scanned,0);
        }
      } catch(error) {
        options.signal?.throwIfAborted();const message=`${source.id}: ${error instanceof Error?error.message:"Source could not be discovered"}`;
        if(isRetryableCollectionIssue(error))(result.deferred??=[]).push(message);
        else result.errors.push(message);
        options.directoryError?.(message);
      }
    }
  }
  for(const s of sessions.values()) {
    const cwd=s.cwd||(assigned.get(s.provider,s.id) as {workspace:string}|undefined)?.workspace;
    if(cwd&&insideDirectory(workspace,cwd)&&(!s.parentId||s.relationship==="fork"))result.counts[s.provider]=(result.counts[s.provider]||0)+1;
  }
  return result;
}
