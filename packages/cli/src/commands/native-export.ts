import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { LocalWorkspace, SessionTurn, SessionEvent } from "@varveai/adit-core";
import type { LocalHistoryReader } from "../local/history-reader.js";

export function completeTurn(reader:LocalHistoryReader,w:LocalWorkspace,provider:string,id:string,turnId:string):SessionTurn {
  const turn=reader.browser.turn(w,provider,id,turnId,"normal");
  let offset=turn.nextOffset;
  while(offset!==null){const page=reader.browser.turn(w,provider,id,turnId,"normal",offset);turn.events.push(...page.events);offset=page.nextOffset;}
  const edit=reader.browser.editTurn(w,provider,id,turnId);
  turn.prompt=edit.blocks.filter(b=>b.kind==="prompt").map(b=>b.text).join("\n\n");turn.promptTruncated=false;
  completeEvents(reader,w,provider,id,turn.events);
  turn.nextOffset=null;return turn;
}
export function completeEvents(reader:LocalHistoryReader,w:LocalWorkspace,provider:string,id:string,events:SessionEvent[]) {
  for(const event of events)if(event.truncated || event.kind === "tool"){
    const kind=event.kind==="tool"?"tool":"text";
    let at=0,text="";
    do{const page=reader.browser.content(w,provider,id,event.id,kind,at);text+=page.text;if(page.nextOffset===null)break;at=page.nextOffset;}while(true);
    event.text=text;event.truncated=false;
  }
}
export function writeNativeExport(value:unknown,opts:{output?:string;gzip?:boolean;format?:string}) {
  const result=value as {turns?:SessionTurn[];session?:{title?:string}};
  const format=opts.format??"json";
  if(!["json","jsonl","markdown"].includes(format))throw new Error("Use json, jsonl or markdown.");
  const text=format==="jsonl"?(result.turns??[value]).map(v=>JSON.stringify(v)).join("\n")+"\n"
    :format==="markdown"?`# ${result.session?.title??"Conversation"}\n\n`+(result.turns??[]).map(t=>`## ${t.ordinal}\n\n${t.prompt}\n\n${t.events.map(e=>e.text).join("\n\n")}`).join("\n\n")
    :JSON.stringify(value,null,2)+"\n";
  if(opts.gzip&&!opts.output)throw new Error("Use --output with --gzip.");
  if(opts.output){writeFileSync(opts.output,opts.gzip?gzipSync(text):text);console.log(`Exported to ${opts.output}`);}else console.log(text);
}
