import { open, lstat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { cursorWorkspace } from "./cursor.js";
import { geminiWorkspace } from "./sources.js";
import { trackSource } from "./source-checkpoints.js";
import { readDatabaseMetadata } from "./discovery-databases.js";
import { isCodexInternalReview } from "./codex.js";
import {codexFileRows} from "./codex-file.js";
import {record,string} from "./types.js";

export interface SessionMetadata {
  id: string;
  cwd: string;
  parentId?: string;
  relationship?: string;
}
export interface MetadataResult { sessions: SessionMetadata[]; pending?: boolean }

// Discovery has a strict I/O budget per file. Never decode transcript bodies,
// decompress archives, resolve tool calls or follow parent transcripts here.
export const METADATA_BYTES = 128 * 1024;
type Fields = Record<string, string>;
export function projectMetadata(text: string, wanted: readonly string[], complete?:(fields:Fields)=>boolean): Fields {
  const keys = new Set(wanted), fields: Fields = Object.create(null);
  const stack: { path: string; array: boolean; index: number; key: string; keyExpected: boolean }[] = [];
  const path = () => {
    const frame = stack.at(-1);
    return frame ? [frame.path, frame.array ? String(frame.index) : frame.key].filter(Boolean).join(".") : "";
  };
  const consumed = () => { const frame=stack.at(-1); if(frame?.array)frame.index++; };
  for (let pos=0;pos<text.length;) {
    const char=text[pos];
    if (/\s|\uFEFF/.test(char) || char === ":") { pos++; continue; }
    if (char === ",") { const frame=stack.at(-1);if(frame&&!frame.array)frame.keyExpected=true;pos++;continue; }
    if (char === "{" || char === "[") {
      const next=path();consumed();stack.push({path:next,array:char==="[",index:0,key:"",keyExpected:char==="{"});pos++;continue;
    }
    if (char === "}" || char === "]") { stack.pop();if(!stack.length&&complete?.(fields))break;pos++;continue; }
    let end=pos+1;
    if(char === '"') {
      let closed=false;
      for(;end<text.length;end++) {
        if(text[end]==="\\") { end++;continue; }
        if(text[end]==='"') { end++;closed=true;break; }
      }
      if(!closed)break; // A bounded prefix can end inside a body string.
    } else {
      while(end<text.length&&!/[\s,\]}]/.test(text[end]))end++;
      if(end===text.length)break;
    }
    const frame=stack.at(-1);
    if(frame&&!frame.array&&frame.keyExpected) {
      if(char!=='"')break;
      frame.key=end-pos<=256?JSON.parse(text.slice(pos,end)):"";
      frame.keyExpected=false;
    } else {
      const key=path();
      if(keys.has(key)&&fields[key]===undefined&&end-pos<=4096) {
        try { const value:unknown=JSON.parse(text.slice(pos,end));if(typeof value==="string"||typeof value==="number"||typeof value==="boolean")fields[key]=String(value); } catch { break; }
      }
      consumed();
    }
    pos=end;
  }
  return fields;
}

export async function metadataFields(path:string, keys:readonly string[], signal?:AbortSignal, complete?:(fields:Fields)=>boolean):Promise<Fields> {
  trackSource(path);signal?.throwIfAborted();
  try {
    if((await lstat(path)).isSymbolicLink())throw new Error("Symbolic source links are not collected");
    const file=await open(path,"r");
    try {
      if(!(await file.stat()).isFile())return {};
      const bytes=Buffer.allocUnsafe(METADATA_BYTES);
      const read=await file.read(bytes,0,bytes.length,0);
      signal?.throwIfAborted();
      return projectMetadata(bytes.subarray(0,read.bytesRead).toString("utf8"),keys,complete);
    } finally { await file.close(); }
  } catch(error) { if((error as NodeJS.ErrnoException).code==="ENOENT")return {};throw error; }
}
const pick=(f:Fields,...keys:string[])=>keys.map(key=>f[key]).find(Boolean)||"";
const baseID=(path:string)=>basename(path).replace(/\.(jsonl?|txt|ndjson|chat)$/i,"");
const result=(id:string,cwd:string,parentId?:string,relationship="subagent"):MetadataResult=>({
  sessions:id?[{id,cwd:cwd||"",...(parentId?{parentId,relationship}:{})}]:[], pending:!id||!cwd,
});

export async function readSessionMetadata(path:string,provider:string,root:string,workspace:string,signal?:AbortSignal):Promise<MetadataResult> {
  const dir=dirname(path), stem=baseID(path);
  const fields=(file:string,keys:readonly string[])=>metadataFields(file,keys,signal);
  if(/\.(db|sqlite|sqlite3|vscdb)$/.test(path))return readDatabaseMetadata(path,provider,signal);
  if(provider==="cursor") {
    const normalize=(value:string)=>{const key=value.split(/[:\\/._-]+/).filter(Boolean).join("-");return process.platform==="win32"?key.toLowerCase():key;};
    const project=normalize(relative(root,path).split(/[\\/]/)[0]),scope=normalize(workspace);
    if(project!==scope&&!project.startsWith(scope+"-"))return {sessions:[]};
    return result(stem,await cursorWorkspace(root,path,workspace,signal),basename(dir)==="subagents"?basename(dirname(dir)):undefined);
  }
  if(["vscode-copilot","positron"].includes(provider)) {
    const meta=await fields(join(dirname(dir),"workspace.json"),["folder"]);
    const doc=await fields(path,["sessionId","v.sessionId"]);
    let cwd="";if(meta.folder?.startsWith("file:"))try{cwd=fileURLToPath(meta.folder);}catch{}
    return result(pick(doc,"sessionId","v.sessionId")||stem,cwd);
  }
  if(provider==="aider")return {sessions:[],pending:true}; // One file contains multiple runs, split during collection.
  if(["codex","traex","augure-code"].includes(provider)) {
    if(path.endsWith(".zst")) {
      for(const row of codexFileRows(path,signal))if(row.type==="session_meta") {
        const p=record(row.payload);
        if(isCodexInternalReview(p.source))return {sessions:[]};
        const fork=string(p.forked_from_id),parent=fork||string(record(record(record(p.source).subagent).thread_spawn).parent_thread_id)||string(p.parent_thread_id);
        return result(string(p.id),string(p.cwd),parent,fork?"fork":"subagent");
      }
      return {sessions:[],pending:true};
    }
    const meta=await metadataFields(path,["type","payload.id","payload.cwd","payload.forked_from_id","payload.source.subagent.thread_spawn.parent_thread_id","payload.source.subagent.other","payload.session_id"],signal,meta=>meta.type==="session_meta");
    if(meta.type==="session_meta"&&isCodexInternalReview({subagent:{other:meta["payload.source.subagent.other"]}}))return {sessions:[]};
    // Paginated Traex/Augure sources need lineage from the complete native record.
    if(provider!=="codex")return {sessions:[],pending:true};
    if(meta.type!=="session_meta")return {sessions:[],pending:true};
    const fork=meta["payload.forked_from_id"],parent=fork||meta["payload.source.subagent.thread_spawn.parent_thread_id"];
    return result(meta["payload.id"],meta["payload.cwd"],parent,fork?"fork":"subagent");
  }
  if(["claude","openclaude","qwen","commandcode"].includes(provider)||(provider==="icodemate"&&path.endsWith(".jsonl"))) {
    const meta=await fields(path,["sessionId","cwd","metadata.projectPath","metadata.context.cwd"]);
    const child=provider==="claude"&&(basename(dir)==="subagents"||stem.startsWith("agent-"));
    const side=provider==="commandcode"?await fields(path.replace(/\.jsonl$/,".meta.json"),["sessionId","projectPath","cwd"]):{};
    return result(child?stem:pick(meta,"sessionId")||pick(side,"sessionId"),pick(meta,"cwd","metadata.projectPath","metadata.context.cwd")||pick(side,"projectPath","cwd"),child?meta.sessionId:undefined);
  }
  if(["pi","omp","omo","prime-agent","stepcode"].includes(provider)) {
    const meta=await fields(path,["id","cwd","branchedFrom","parentSession"]);
    const parent=pick(meta,"branchedFrom","parentSession");
    if(parent)return result(meta.id||stem,meta.cwd,baseID(parent),"fork");
    const candidate=provider==="omp"?dir+".jsonl":["pi","omo"].includes(provider)&&basename(path)==="session.jsonl"?dirname(dirname(dir))+".jsonl":"";
    const owner=candidate?await fields(candidate,["id"]):{};
    return result(meta.id||stem,meta.cwd,owner.id);
  }
  if(["cline","vibe"].includes(provider)) {
    const meta=await fields(path,["session_id","cwd","workspace_root","working_dir","environment.working_directory","parent_session_id"]);
    const origin=provider==="cline"?await fields(join(dir,`${basename(dir)}.messages.json`),["origin.parentThreadId"]):{};
    return result(meta.session_id||basename(dir),pick(meta,"cwd","workspace_root","working_dir","environment.working_directory"),origin["origin.parentThreadId"]||meta.parent_session_id);
  }
  if(["opencode","kilo","mimocode","icodemate"].includes(provider)) {
    const meta=await fields(path,["id","directory","parentID","projectID"]);
    let cwd=meta.directory;
    if(!cwd||cwd==="/") {
      const project=await fields(join(dir,"..","..","project",basename(dir)+".json"),["worktree"]);cwd=project.worktree;
    }
    return result(meta.id,cwd==="/"?"":cwd,meta.parentID);
  }
  if(provider==="gemini") {
    const meta=await fields(path,["sessionId","cwd","projectPath"]);
    return result(meta.sessionId,pick(meta,"cwd","projectPath")||await geminiWorkspace(root,path));
  }
  if(["fx","openhands"].includes(provider)) {
    const meta=await fields(provider==="fx"?join(dir,"session.json"):path,["id","conversation_id","workspace_root","workspace.cwd","workspace.path","workspace.mount_path","workspace.root","workspace.repo_path","workspace.repo_root","workspace.working_dir"]);
    const owner=provider==="fx"?await fields(join(dir,"subagent","owner.json"),["parent_id"]):{};
    return result(pick(meta,"id","conversation_id")||basename(dir),pick(meta,"workspace_root","workspace.cwd","workspace.path","workspace.mount_path","workspace.root","workspace.repo_path","workspace.repo_root","workspace.working_dir"),owner.parent_id);
  }
  if(provider==="codebuff") {
    const meta=await fields(join(dir,"run-state.json"),["sessionState.fileContext.cwd"]);
    return result(`${basename(dirname(dirname(dir)))}:${basename(dir)}`,meta["sessionState.fileContext.cwd"]);
  }
  if(provider==="posit-assistant") {
    const meta=await fields(path,["root.id"]);let workspaceDir=dirname(dir),parentId:string|undefined;
    if(basename(workspaceDir)==="subagents"){parentId=basename(dirname(workspaceDir));workspaceDir=dirname(dirname(workspaceDir));}
    const ws=await fields(join(workspaceDir,"workspace.json"),["path"]);
    return result(meta["root.id"]||basename(dir),ws.path,parentId);
  }
  if(["roocode","kilo-legacy"].includes(provider)) {
    const meta=await fields(join(dir,provider==="roocode"?"history_item.json":"task_metadata.json"),["id","workspace","parentTaskId"]);
    return result(meta.id||basename(dir),meta.workspace,meta.parentTaskId);
  }
  if(provider==="kiro") {
    const meta=await fields(path.replace(/\.jsonl$/,".json"),["session_id","cwd"]);
    return result(meta.session_id||stem,meta.cwd);
  }
  if(provider==="copilot") {
    const meta=await fields(path,["data.sessionId","data.context.cwd"]);
    return result(meta["data.sessionId"]||basename(dir),meta["data.context.cwd"]);
  }
  if(provider==="cortex") {
    const meta=await fields(path,["session_id","working_directory","git_root"]);
    return result(meta.session_id,pick(meta,"working_directory","git_root"));
  }
  if(provider==="grok") {
    const meta=await fields(path,["cwd","source_workspace_dir","git_root_dir","parent_session_id","parentSessionId","producer_session_kind"]);
    return result(basename(dir),pick(meta,"cwd","source_workspace_dir","git_root_dir"),pick(meta,"parent_session_id","parentSessionId"),meta.producer_session_kind?.includes("subagent")?"subagent":"fork");
  }
  if(provider==="reasonix") {
    const meta=await fields(path+".meta",["id","workspace_root"]);
    return result(meta.id||stem,meta.workspace_root);
  }
  if(provider==="deepseek-tui") {
    const meta=await fields(path,["metadata.id","metadata.workspace"]);
    return result(meta["metadata.id"],meta["metadata.workspace"]);
  }
  if(provider==="deepseek-harness"&&!path.endsWith(".zstd")) {
    const meta=await fields(path,["id","cwd","parentSession","origin"]);
    return result(meta.id,meta.cwd,meta.parentSession,meta.origin==="subagent"?"subagent":"fork");
  }
  if(provider==="evener") {
    const meta=await fields(path,["session_id","working_dir","parent_session_id","depth"]);
    const side=await fields(path.replace(/\.transcript\.jsonl$/,".meta.json"),["parent_session_id","divergence_turn","is_subagent"]);
    return result(meta.session_id,meta.working_dir,side.parent_session_id||meta.parent_session_id,Number(side.divergence_turn)>0?"fork":side.is_subagent==="true"||Number(meta.depth)>0?"subagent":"fork");
  }
  if(["openclaw","qclaw"].includes(provider)) {
    const meta=await fields(path,["id","cwd"]);
    return result(`${basename(dirname(dir))}:${meta.id||basename(path).split(".jsonl")[0]}`,meta.cwd);
  }
  if(["iflow","workbuddy","muse","poolside","tau","kiro-ide"].includes(provider)) {
    const meta=await fields(path,["sessionId","executionId","cwd","workspaceDirectory","payload.record.workspace_root","payload.record.cwd","session_start.workspace","session_start.working_directories.0"]);
    const cwd=pick(meta,"cwd","workspaceDirectory","payload.record.workspace_root","payload.record.cwd","session_start.workspace","session_start.working_directories.0");
    const id=provider==="iflow"?stem.replace(/^session-/,""):provider==="workbuddy"?`${basename(dir)}:${stem}`:provider==="muse"?basename(dir):provider==="poolside"?stem.replace(/^trajectory-/,""):provider==="tau"?stem:pick(meta,"sessionId","executionId");
    if(path.split(/[\\/]/).some(part=>part==="subagents"||part==="subagent"))return {sessions:[],pending:true};
    return result(id,cwd);
  }
  // Sources without independently readable identity/directory metadata remain
  // selectable. Full collection retains every existing provider adapter.
  return {sessions:[],pending:true};
}
