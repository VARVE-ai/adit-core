import type Database from "better-sqlite3";
import type { ScanSource } from "./archive.js";
import { discoverHistory } from "./discovery.js";
import { insideDirectory } from "./sources.js";
import type { SessionMetadata } from "./discovery-metadata.js";

export interface SourceScanProgress {
  completed:number;
  total:number|null;
  status:"queued"|"counting"|"running"|"done"|"partial"|"skipped";
}
export type SourceProgressListener=(scope:string,provider:string,progress:SourceScanProgress)=>void;

/** Count logical user sessions; never present a file count as a session count. */
export class ScanProgressTracker {
  readonly files=new Map<string,string[]>();
  readonly errors:string[]=[];
  private expected=new Map<string,Set<string>>();
  private completed=new Map<string,Set<string>>();
  private uncertain=false;
  constructor(private db:Database.Database,private source:ScanSource,private scopes:string[],private emit:SourceProgressListener) {
    for(const scope of scopes){this.expected.set(scope,new Set());this.completed.set(scope,new Set());}
  }
  private include(session:SessionMetadata,target:Map<string,Set<string>>) {
    if(!session.id||(session.parentId&&session.relationship!=="fork"))return;
    const cwd=session.cwd||(this.db.prepare("SELECT workspace FROM adit_history_assignments WHERE provider=? AND session_id=?").get(this.source.id,session.id) as {workspace:string}|undefined)?.workspace;
    if(cwd)for(const scope of this.scopes)if(insideDirectory(scope,cwd))target.get(scope)!.add(session.id);
  }
  async plan(options:{signal?:AbortSignal;beforeSource?:(id:string)=>void}) {
    this.publish("counting");
    // Metadata and file enumeration are shared for all workspaces in this scan.
    const discovery=await discoverHistory(this.db,this.scopes[0],[this.source],{...options,directoryError:error=>this.errors.push(error),file:(root,path,metadata)=>{
      const paths=this.files.get(root)||[];paths.push(path);this.files.set(root,paths);
      for(const session of metadata.sessions)this.include(session,this.expected);
      this.uncertain ||= !!metadata.pending;
    }});
    // Branches require complete ancestry. Cursor path resolution is scope-specific.
    this.uncertain ||= discovery.errors.length>0 || ["claude","qoder","cowork"].includes(this.source.id) || (this.source.id==="cursor"&&this.scopes.length>1);
    this.publish("running");
  }
  processed(references:[string,string][]) {
    const read=this.db.prepare("SELECT id,cwd,parent_id AS parentId,relationship FROM adit_history_sessions WHERE provider=? AND id=?");
    for(const [provider,id] of references){const session=read.get(provider,id) as SessionMetadata|undefined;if(session)this.include(session,this.completed);}
    this.publish("running");
  }
  publish(status:SourceScanProgress["status"]) {
    for(const scope of this.scopes) {
      const completed=this.completed.get(scope)!.size;
      const total=status==="done"?completed:status==="counting"||this.uncertain?null:Math.max(completed,this.expected.get(scope)!.size);
      this.emit(scope,this.source.id,{completed,total,status});
    }
  }
}
