import {basename,dirname} from "node:path";
import {readSource,readSourceJSON} from "./source-io.js";
import {parseClaude,claudeSessionTitle} from "./claude.js";
import {HistoryFormatError,jsonLines,string,type HistorySession,type HistoryMessage,record} from "./types.js";
import {message,session,type Row} from "./provider-common.js";
import {claudeUserMessage} from "./native-user-content.js";
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
  const nodes:Row[]=[],nodeIndexes=new Map<string,number>(),aliases=new Map<string,string>(),responses=new Map<string,string>();
  for(const row of rows){
    if(!["user","assistant"].includes(string(row.type)))continue;
    const id=string(row.uuid) || `row:${nodes.length}`,payload=record(row.message),response=row.type === "assistant" && payload.id ? `${payload.id}:${string(row.requestId)}` : "";
    const previous=responses.get(response);
    if(response && previous){
      const node=nodes[nodeIndexes.get(previous)!];
      const old=record(node.message);
      node.message={...payload,content:Array.isArray(old.content)&&Array.isArray(payload.content)?[...old.content,...payload.content]:payload.content};
      aliases.set(id,previous);continue;
    }
    const oldIndex=nodeIndexes.get(id);
    if(oldIndex!==undefined){nodes[oldIndex]={...row,uuid:id};continue;}
    nodeIndexes.set(id,nodes.length);nodes.push({...row,uuid:id});if(response)responses.set(response,id);
  }
  for(const node of nodes)node.parentUuid=aliases.get(string(node.parentUuid)) || node.parentUuid;
  const byId=new Map(nodes.map(n=>[string(n.uuid),n]));
  const children=new Map<string,Row[]>();
  for(const node of nodes){const key=string(node.parentUuid);if(key && byId.has(key)){const list=children.get(key)||[];list.push(node);children.set(key,list);}}
  const roots=nodes.filter(n=>!byId.has(string(n.parentUuid)));
  if(nodes.length && !roots.length)throw new HistoryFormatError("Claude ancestry cycle");
  const outputs:HistorySession[]=[],globalVisited=new Set<string>();
  // Bottom-up counts avoid rewalking every ancestry chain and recursion on long logs.
  const remaining=new Map(nodes.map(n=>[string(n.uuid),(children.get(string(n.uuid))||[]).length]));
  const counts=new Map(nodes.map(n=>[string(n.uuid),n.type==="user"?1:0]));
  const leaves=nodes.filter(n=>remaining.get(string(n.uuid))===0);
  for(let i=0;i<leaves.length;i++) {
    const node=leaves[i],parent=string(node.parentUuid);
    if(!byId.has(parent))continue;
    counts.set(parent,counts.get(parent)!+counts.get(string(node.uuid))!);
    remaining.set(parent,remaining.get(parent)!-1);if(remaining.get(parent)===0)leaves.push(byId.get(parent)!);
  }
  if(leaves.length!==nodes.length)throw new HistoryFormatError("Claude ancestry cycle");
  const countTurns=(node:Row)=>counts.get(string(node.uuid))||0;
  const emit=(branch:Row[],id:string,parentId?:string,linear=false)=>{
    const result=parseClaude([{type:"system",cwd,sessionId:rootId},...branch].map(r=>JSON.stringify({...r,cwd:r.cwd || cwd,sessionId:rootId})).join("\n")+"\n",path,{linear});
    result.id=id;result.provider=provider;result.metadata={...result.metadata,...metadata,title};
    const branchIds=new Set(branch.map(r=>r.uuid));
    for(const [index,row] of rows.entries()) {
      const attachment=record(row.attachment);
      if(row.type!=="attachment" || attachment.type!=="queued_command" || typeof attachment.prompt!=="string")continue;
      if(row.parentUuid?!branchIds.has(row.parentUuid):!!parentId)continue;
      const peer=/^\s*<cross-session-message(?:\s|>)/.test(attachment.prompt);
      const queued=claudeUserMessage({key:string(row.uuid)||`queued:${index}`,role:"user",timestamp:string(row.timestamp)||undefined,
        content:attachment.prompt,raw:peer?{...row,isMeta:false}:row});
      if(queued && !result.messages.some(m=>m.key===queued.key))result.messages.push({...queued,raw:row});
    }
    // Stable ordering also handles queued prompts written after their timestamp.
    if(rows.some(r=>record(r.attachment).type==="queued_command"))result.messages.sort((a,b)=>(a.timestamp||"").localeCompare(b.timestamp||""));
    if(parentId){result.parentId=parentId;result.relationship="fork";}
    else if(parent){result.parentId=parent;result.relationship="subagent";}
    const prompts=result.messages.filter(m=>m.role==="user");
    const onlyUsage=prompts.length>0 && prompts.every(m=>typeof m.content==="string"?m.content.trim()==="/usage":
      Array.isArray(m.content)&&m.content.every(b=>record(b).type==="text")&&m.content.map(b=>string(record(b).text)).join("\n").trim()==="/usage");
    if(!onlyUsage && result.messages.length)outputs.push(result);
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
  // System/attachment records can bridge messages but are absent from this graph.
  // An incomplete chain is not evidence of a fork: retain all messages in file order.
  if(nodes.length && (roots.length!==1 || nodes.some(n=>string(n.parentUuid) && !byId.has(string(n.parentUuid)))))emit(nodes,rootId,undefined,true);
  else if(roots.length)walk(roots[0],rootId);
  else if(rows.some(r=>record(r.attachment).type==="queued_command"))emit([],rootId,undefined,true);
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
