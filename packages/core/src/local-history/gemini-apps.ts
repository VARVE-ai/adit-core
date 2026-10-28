import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { createHash } from "node:crypto";
import { HistoryFormatError } from "./types.js";
import { message, session } from "./provider-common.js";
type Node=DefaultTreeAdapterTypes.Node;
function children(node:Node):Node[]{return "childNodes" in node ? node.childNodes : [];}
function attr(node:Node,name:string){return "attrs" in node ? node.attrs.find(a=>a.name===name)?.value || "" : "";}
function tag(node:Node){return "tagName" in node ? node.tagName : "";}
function find(node:Node,predicate:(node:Node)=>boolean):Node|undefined{if(predicate(node))return node;for(const child of children(node)){const result=find(child,predicate);if(result)return result;}}
function hasClass(node:Node,value:string){return attr(node,"class").split(/\s+/).includes(value);}
function visible(node:Node):string{
  if(["script","style","template","noscript"].includes(tag(node)))return "";
  if("value" in node)return node.value;
  if(tag(node)==="br")return "\n";
  const text=children(node).map(visible).join("");
  return ["p","div","li","pre","h3"].includes(tag(node)) ? `\n${text}\n` : text;
}
function clean(value:string){return value.replace(/[^\S\n]+/g," ").replace(/ *\n */g,"\n").replace(/\n{3,}/g,"\n\n").trim();}
export function parseGeminiAppsHTML(text:string,workspace:string){
  const doc=parse(text),html=find(doc,n=>tag(n)==="html"), title=find(doc,n=>tag(n)==="title");
  if(html && attr(html,"lang") && !/^en(?:-|$)/i.test(attr(html,"lang")))throw new HistoryFormatError("Unsupported Gemini Apps Takeout locale");
  if(!title || !/^(?:My Activity|My Activity History)$/i.test(clean(visible(title))))throw new HistoryFormatError("Expected Gemini Apps My Activity HTML");
  const cells:Node[]=[];
  const walk=(node:Node)=>{if(hasClass(node,"outer-cell")){cells.push(node);return;}for(const child of children(node))walk(child);};walk(doc);
  const occurrences=new Map<string,number>();
  const result=[];
  for(const cell of cells){
    const header=find(cell,n=>hasClass(n,"header-cell"));if(!header)continue;
    const heading=find(header,n=>tag(n)==="h3");if(!heading || clean(visible(heading)).toLowerCase()!=="gemini apps")continue;
    const label=find(header,n=>tag(n)==="p");if(!label || clean(visible(label)).toLowerCase()!=="prompted")continue;
    const match=clean(visible(header)).match(/\b([A-Za-z]{3} \d{1,2}, \d{4}, \d{1,2}:\d{2}:\d{2})\s*(AM|PM)\s+([A-Z]+(?:[+-]\d{1,2}:?\d{2})?)/);
    if(!match)throw new HistoryFormatError("Unsupported Gemini Apps activity timestamp");
    const zones:Record<string,string>={UTC:"+0000",GMT:"+0000",PST:"-0800",PDT:"-0700",MST:"-0700",MDT:"-0600",CST:"-0600",CDT:"-0500",EST:"-0500",EDT:"-0400"};
    const zone=zones[match[3]] || (/^GMT[+-]\d{2}:?\d{2}$/.test(match[3]) ? match[3].slice(3).replace(":","") : "");
    const ts=zone ? new Date(`${match[1]} ${match[2]} ${zone}`) : new Date(NaN);
    if(!Number.isFinite(ts.getTime()))throw new HistoryFormatError("Unsupported Gemini Apps timestamp zone");
    const content=find(cell,n=>hasClass(n,"content-cell"));
    const payload=content ? clean(visible(content)) : "";
    if(!payload)throw new HistoryFormatError("Gemini Apps activity prompt is missing");
    const timestamp=ts.toISOString(),occurrence=occurrences.get(timestamp)||0;occurrences.set(timestamp,occurrence+1);
    const id=createHash("sha256").update(`${timestamp}\0${occurrence}`).digest("hex");
    result.push(session("gemini-apps",id,workspace,[message({id:"prompt",role:"user",content:payload,timestamp},0)],{attribution:"explicit-import"}));
  }
  if(!result.length)throw new HistoryFormatError("No Gemini Apps Prompted activity records found");
  return result;
}
