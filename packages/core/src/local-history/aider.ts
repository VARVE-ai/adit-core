import {createHash} from "node:crypto";
import {dirname} from "node:path";
import {readSource} from "./source-io.js";
import {message,session} from "./provider-common.js";
import type {HistoryMessage,HistorySession} from "./types.js";
export async function readAider(path:string,signal?:AbortSignal){
 const text=(await readSource(path,signal)).toString("utf8"),cwd=dirname(path),runs:HistorySession[]=[];
 let startedAt="",messages:HistoryMessage[]=[],role="",content:string[]=[];
 const flush=()=>{if(content.join("\n").trim())messages.push(message({role,content:content.join("\n").trim()},messages.length));content=[];};
 const finish=()=>{flush();if(messages.length){const id=createHash("sha256").update(`${path}\0${runs.length}\0${startedAt}`).digest("hex");runs.push(session("aider",id,cwd,messages,{startedAt}));}messages=[];};
 for(const line of text.split(/\r?\n/)){
  signal?.throwIfAborted();
  if(line.startsWith("# aider chat started at ")){finish();startedAt=line.slice(24).trim();role="";continue;}
  if(line.startsWith("#### ")){flush();role="user";content.push(line.slice(5));continue;}
  const nextRole=line.startsWith("> ")?"tool":"assistant";
  if(line.trim() && nextRole!==role){flush();role=nextRole;}
  content.push(nextRole === "tool"?line.slice(2):line);
 }
 finish();return runs;
}
