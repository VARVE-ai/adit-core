import {basename,dirname} from "node:path";
import {readSource,readSourceJSON} from "./source-io.js";
import {parseClaude,claudeSessionTitle} from "./claude.js";
import {HistoryFormatError,jsonLines,string,type HistorySession,type HistoryMessage,record} from "./types.js";
import {message,session,type Row} from "./provider-common.js";
export const claudeLineageProviders=["claude","qoder","iflow"];
function subagentParent(path:string):string {
  for(let directory=dirname(path);directory!==dirname(directory);directory=dirname(directory)){
    if(basename(directory)==="subagents")return basename(dirname(directory));
  }
  return "";
}
export function claudeBranches(rows:Row[],path:string,provider="claude",metadata:Row={}):HistorySession[]{
  const title=string(metadata.title).trim() || claudeSessionTitle(rows);
  const cwd=rows.map(r=>string(r.cwd)).find(Boolean) || string(metadata.working_dir);
  const parent=subagentParent(path);
  // Keep parent-scoped child identities stable across flat and nested workflow layouts.
  const rootId=parent ? `${parent}:${basename(path,".jsonl")}` : rows.map(r=>string(r.sessionId)).find(Boolean) || basename(path,".jsonl");
  const nodes:Row[]=[],aliases=new Map<string,string>(),responses=new Map<string,string>();
  for(const row of rows){
    if(!["user","assistant"].includes(string(row.type)))continue;
    const id=string(row.uuid) || `row:${nodes.length}`,payload=record(row.message),response=row.type === "assistant" && payload.id ? `${payload.id}:${string(row.requestId)}` : "";
    const previous=responses.get(response);
    if(response && previous){
      const node=nodes.find(n=>n.uuid===previous)!;
      const old=record(node.message);
      node.message={...payload,content:Array.isArray(old.content)&&Array.isArray(payload.content)?[...old.content,...payload.content]:payload.content};
      aliases.set(id,previous);continue;
    }
    if(nodes.some(n=>n.uuid===id)){const index=nodes.findIndex(n=>n.uuid===id);nodes[index]={...row,uuid:id};continue;}
    nodes.push({...row,uuid:id});if(response)responses.set(response,id);
  }
  for(const node of nodes)node.parentUuid=aliases.get(string(node.parentUuid)) || node.parentUuid;
  const byId=new Map(nodes.map(n=>[string(n.uuid),n]));
  const children=new Map<string,Row[]>();
  for(const node of nodes){const key=string(node.parentUuid);if(key && byId.has(key)){const list=children.get(key)||[];list.push(node);children.set(key,list);}}
  const roots=nodes.filter(n=>!byId.has(string(n.parentUuid)));
  if(nodes.length && !roots.length)throw new HistoryFormatError("Claude ancestry cycle");
  const outputs:HistorySession[]=[],globalVisited=new Set<string>();
  const countTurns=(node:Row,seen=new Set<string>()):number=>{const id=string(node.uuid);if(seen.has(id))throw new HistoryFormatError("Claude ancestry cycle");seen.add(id);return (node.type === "user"?1:0)+(children.get(id)||[]).reduce((n,c)=>n+countTurns(c,new Set(seen)),0);};
  const emit=(branch:Row[],id:string,parentId?:string,linear=false)=>{
    const result=parseClaude(branch.map(r=>JSON.stringify({...r,cwd:r.cwd || cwd,sessionId:rootId})).join("\n")+"\n",path,{linear});
    result.id=id;result.provider=provider;result.metadata={...metadata,title};
    if(parentId){result.parentId=parentId;result.relationship="fork";}
    else if(parent){result.parentId=parent;result.relationship="subagent";}
    outputs.push(result);
  };
  const walk=(start:Row,id:string,parentId?:string)=>{
    const branch:Row[]=[],visited=new Set<string>();let node:Row|undefined=start;
    while(node){const key=string(node.uuid);if(visited.has(key))throw new HistoryFormatError("Claude ancestry cycle");visited.add(key);globalVisited.add(key);branch.push(node);
      const kids=children.get(key)||[];
      if(kids.length>1 && countTurns(kids[0])>3){for(const child of kids.slice(1))walk(child,`${rootId}-${child.uuid}`,id);node=kids[0];}
      else node=kids.at(-1);
    }
    emit(branch,id,parentId);
  };
  for(const node of nodes)countTurns(node);
  // System/attachment records can bridge messages but are absent from this graph.
  // An incomplete chain is not evidence of a fork: retain all messages in file order.
  if(nodes.length && (roots.length!==1 || nodes.some(n=>string(n.parentUuid) && !byId.has(string(n.parentUuid)))))emit(nodes,rootId,undefined,true);
  else if(roots.length)walk(roots[0],rootId);
  return outputs;
}
export async function readClaudeLineage(path:string,provider:string,signal?:AbortSignal){
  const rows=jsonLines((await readSource(path,signal)).toString("utf8"));
  if(provider === "iflow"){
    const entries=new Map<string,HistoryMessage>();let cwd="";
    for(const row of rows){cwd ||= string(row.cwd);if(!["user","assistant"].includes(string(row.type)))continue;const wire=record(row.message),key=string(row.uuid)||String(entries.size);entries.set(key,message({...wire,timestamp:row.timestamp},entries.size,{key,role:string(row.type),parentKey:string(row.parentUuid)||undefined,raw:row,usage:undefined}));}
    return [session(provider,basename(path,".jsonl").replace(/^session-/,""),cwd,[...entries.values()])];
  }
  let metadata:Row={};
  if(provider === "qoder")try{metadata=await readSourceJSON(path.replace(/\.jsonl$/,"-session.json"),signal);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const results=claudeBranches(rows,path,provider,metadata);
  for(const result of results)if(metadata.fork_from && !result.parentId){result.parentId=string(metadata.fork_from);result.relationship="fork";}
  return results;
}
