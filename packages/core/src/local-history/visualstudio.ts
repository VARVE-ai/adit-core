import {basename,dirname,join} from "node:path";
import {directoryEntries,readSource} from "./source-io.js";
import {array,decode,message,session,type Row} from "./provider-common.js";
import {jsonLines,record,string,type HistoryMessage} from "./types.js";

export function visualStudioSource(path:string):boolean {
 return /_VSGitHubCopilot_traces.*\.jsonl$/.test(basename(path)) || (basename(dirname(path)).toLowerCase()==="sessions" && /^[a-f\d-]{36}$/i.test(basename(path)) && path.toLowerCase().split(/[\\/]/).includes("copilot-chat"));
}
function spans(row:Row):Row[]{
 if(Array.isArray(row.resourceSpans))return array(row.resourceSpans).flatMap(resource=>array(resource.scopeSpans).flatMap(scope=>array(scope.spans)));
 if(Array.isArray(row.spans))return array(row.spans);
 return [row];
}
export async function readVisualStudio(path:string,signal?:AbortSignal){
 const paths=/_VSGitHubCopilot_traces/.test(basename(path)) ? (await directoryEntries(dirname(path))).filter(e=>e.isFile()&&/_VSGitHubCopilot_traces.*\.jsonl$/.test(e.name)).map(e=>join(dirname(path),e.name)):[path];
 const conversations=new Map<string,Map<string,Row>>();
 for(const source of paths)for(const row of jsonLines((await readSource(source,signal)).toString("utf8")))for(const span of spans(row)){
  const attrs:Row={};for(const entry of array(span.attributes)){const value=record(entry.value);attrs[string(entry.key)]=value.stringValue??value.intValue??value.boolValue;}
  const id=string(attrs["gen_ai.conversation.id"]);if(!id)continue;
  const key=string(span.spanId);if(!key)continue;
  const members=conversations.get(id)||new Map<string,Row>();const previous=members.get(key);
  if(!previous || String(span.endTimeUnixNano||"")>=String(previous.endTimeUnixNano||""))members.set(key,{...span,attrs});
  conversations.set(id,members);
 }
 return [...conversations].map(([id,members])=>{
  const messages:HistoryMessage[]=[];let cwd="";const usageEvents:Row[]=[];let lastUser="";
  for(const span of [...members.values()].sort((a,b)=>String(a.startTimeUnixNano).localeCompare(String(b.startTimeUnixNano)))){
   const attrs=record(span.attrs),model=string(attrs["gen_ai.response.model"])||string(attrs["gen_ai.request.model"]);
   cwd ||= string(attrs["process.cwd"])||string(attrs.cwd)||string(attrs["workspace.path"]);
   const time=string(span.startTimeUnixNano);let timestamp:string|undefined;
   if(/^\d+$/.test(time)){const date=new Date(Number(BigInt(time)/1000000n));if(Number.isFinite(date.getTime()))timestamp=date.toISOString();}
   const push=(role:string,content:unknown,suffix:string)=>messages.push(message(span,messages.length,{key:`${span.spanId}:${suffix}`,role,content,model:model||undefined,timestamp}));
   const input=array(decode(attrs["gen_ai.input.messages"],[]));const user=[...input].reverse().find(v=>v.role==="user");
   if(user){const content=user.parts??user.content;const fingerprint=JSON.stringify(content);if(fingerprint!==lastUser){push("user",content,"input");lastUser=fingerprint;}}
   for(const [index,output] of array(decode(attrs["gen_ai.output.messages"],[])).entries())if(output.role==="assistant")push("assistant",output.parts??output.content,`output:${index}`);
   if(attrs["gen_ai.tool.name"])push("tool",{name:attrs["gen_ai.tool.name"],id:attrs["gen_ai.tool.call.id"],arguments:attrs["gen_ai.tool.call.arguments"],result:attrs["gen_ai.tool.call.result"]},"tool");
   if(attrs["gen_ai.usage.input_tokens"]!==undefined||attrs["gen_ai.usage.output_tokens"]!==undefined)usageEvents.push({spanId:span.spanId,model,input_tokens:attrs["gen_ai.usage.input_tokens"],output_tokens:attrs["gen_ai.usage.output_tokens"]});
  }
  return session("visualstudio-copilot",id,cwd,messages,{usageEvents});
 });
}
