import {record,string,type HistoryMessage} from "./types.js";

/** Existing final-reply consumers expect a text reply separately from tool activity.
 * Keep the original key and text block positions for saved local edits. Tool
 * projections reference that message instead of copying its entire raw payload. */
export function separateCollectedTools(messages:HistoryMessage[]):HistoryMessage[] {
  return messages.flatMap(message=>{
    if(message.role!=="assistant" || !Array.isArray(message.content))return [message];
    const blocks=message.content,tool=(b:unknown)=>["tool_use","tool_result"].includes(string(record(b).type));
    if(!blocks.some(tool) || !blocks.some(b=>record(b).type==="text"&&string(record(b).text).trim()))return [message];
    const lastText=blocks.reduce((last:number,b:unknown,index:number)=>record(b).type==="text"&&string(record(b).text).trim()?index:last,-1);
    const calls:HistoryMessage[]=blocks.flatMap((block,index)=>tool(block)?[{
      key:`${message.key}:tool:${index}`,role:record(block).type==="tool_result"?"tool":"assistant",
      timestamp:message.timestamp,model:message.model,content:[block],
      raw:{nativeMessageKey:message.key,nativeBlockIndex:index},
    }]:[]);
    return [...calls.filter(m=>Number(m.raw.nativeBlockIndex)<lastText),
      {...message,content:blocks.map(block=>tool(block)?{type:"text",text:""}:block)},
      ...calls.filter(m=>Number(m.raw.nativeBlockIndex)>lastText)];
  });
}
