import { basename, dirname } from "node:path";
import { databaseSnapshot, hasTable } from "./source-io.js";
import { table, decode, type Row } from "./provider-common.js";
import { string } from "./types.js";
import type { MetadataResult, SessionMetadata } from "./discovery-metadata.js";

/** Queries only session/catalog metadata, never message/part/bubble bodies. */
export function readDatabaseMetadata(path:string,provider:string,signal?:AbortSignal):MetadataResult {
  if(!["cursor-ide","opencode","kilo","mimocode","icodemate","zcode","shelley","goose","hermes","augure-desktop","crush","zed","warp","piebald","devin"].includes(provider))return {sessions:[],pending:true};
  return databaseSnapshot(path,db=>{
    signal?.throwIfAborted();
    const make=(id:unknown,cwd:unknown,parent?:unknown):SessionMetadata=>({id:Buffer.isBuffer(id)?id.toString("hex"):String(id??""),cwd:string(cwd),...(parent?{parentId:String(parent),relationship:"subagent"}:{})});
    let sessions:SessionMetadata[];
    if(provider==="cursor-ide") {
      if(!hasTable(db,"cursorDiskKV"))return {sessions:[]};
      sessions=(db.prepare(`SELECT substr(key,14) AS id,
        coalesce(json_extract(CAST(value AS TEXT),'$.workspaceIdentifier.uri.fsPath'),json_extract(CAST(value AS TEXT),'$.trackedGitRepos[0].repoPath'),'') AS cwd
        FROM cursorDiskKV WHERE key>='composerData:' AND key<'composerData;' AND json_valid(CAST(value AS TEXT))`).all() as {id:string;cwd:string}[]).map(r=>make(r.id,r.cwd));
    } else if(["opencode","kilo","mimocode","icodemate","zcode"].includes(provider)) {
      if(!hasTable(db,"session"))return {sessions:[],pending:true};
      const projects=hasTable(db,"project")?new Map(table(db,"project",["id","worktree"],["id"]).map(r=>[r.id,r.worktree])):new Map();
      sessions=table(db,"session",["id","directory","parent_id","project_id"],["id"]).map(r=>make(r.id,r.directory&&r.directory!=="/"?r.directory:projects.get(r.project_id),r.parent_id));
    } else if(provider==="shelley") {
      sessions=table(db,"conversations",["conversation_id","cwd","parent_conversation_id","user_initiated"],["conversation_id"]).map(r=>make(r.conversation_id,r.cwd,r.user_initiated===0?r.parent_conversation_id:undefined));
    } else if(provider==="zed") {
      sessions=table(db,"threads",["id","folder_paths","parent_id"],["id"]).map(r=>{
        const paths=decode(r.folder_paths,[]);return make(r.id,Array.isArray(paths)?paths[0]:"",r.parent_id);
      });
    } else if(provider==="warp") {
      const directories=new Map<unknown,string>();
      for(const r of table(db,"ai_queries",["conversation_id","working_directory","start_ts"],["conversation_id"]).sort((a,b)=>Number(a.start_ts)-Number(b.start_ts)))if(r.working_directory&&!directories.has(r.conversation_id))directories.set(r.conversation_id,string(r.working_directory));
      sessions=table(db,"agent_conversations",["conversation_id"],["conversation_id"]).map(r=>make(r.conversation_id,directories.get(r.conversation_id)));
    } else if(provider==="piebald") {
      const projects=hasTable(db,"projects")?new Map(table(db,"projects",["id","directory"],["id"]).map(r=>[r.id,r.directory])):new Map();
      sessions=table(db,"chats",["id","project_id","current_directory","worktree_path","is_deleted"],["id"]).filter(r=>!r.is_deleted).map(r=>make(r.id,r.current_directory||r.worktree_path||projects.get(r.project_id)));
    } else {
      const rows=table(db,"sessions",["id","working_dir","working_directory","parent_session_id","hidden"],["id"]);
      sessions=rows.filter(r=>provider!=="devin"||r.hidden!==1).map((r:Row)=>make(r.id,provider==="crush"&&basename(dirname(path))===".crush"?dirname(dirname(path)):r.working_dir||r.working_directory,["goose","crush"].includes(provider)?r.parent_session_id:undefined));
    }
    return {sessions,pending:sessions.some(s=>!s.id||!s.cwd)};
  });
}
