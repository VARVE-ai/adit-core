import {record, string, type HistoryMessage} from "./types.js";

// Normalize only native envelopes at the start of a text block. Quoted tags in
// ordinary prose are user content. Keep the untouched payload in message.raw.
function peel(text: string, tags: string[]): {text:string; stripped:boolean} {
  let rest=text.trimStart(),stripped=false;
  for (;;) {
    const tag=tags.find(tag=>rest.startsWith(`<${tag}>`));
    if(!tag)break;
    const end=rest.indexOf(`</${tag}>`);
    if(end<0)break;
    rest=rest.slice(end+tag.length+3).trimStart();stripped=true;
  }
  return {text:rest,stripped};
}

export function claudeUserMessage(message:HistoryMessage):HistoryMessage|null {
  if(message.role!=="user")return message;
  const raw=message.raw;
  if(raw.isCompactSummary===true)return {...message,role:"system",contextKind:"compaction"};
  if(raw.isMeta===true)return null;
  if(Array.isArray(message.content)) {
    let real=false,system=false,command=false;
    const content=message.content.map(block=>{
      const b=record(block);
      if(typeof block!=="string" && !["text","input_text"].includes(string(b.type))){real=true;return block;}
      const parsed=claudeUserMessage({...message,content:typeof block==="string"?block:string(b.text)});
      if(parsed?.role==="system")system=true;
      const text=parsed?.role==="user"?string(parsed.content):"";
      if(text.trim())real=true;
      command ||= !!parsed?.previewExcluded;
      return typeof block==="string"?text:{...b,text};
    });
    if(!real)return system?{...message,role:"system"}:null;
    const results=["tool_result","toolResult","function_call_output","custom_tool_call_output"];
    if(content.some(b=>results.includes(string(record(b).type))) && content.every(b=>results.includes(string(record(b).type)) ||
      (typeof b==="string"?!b.trim():["text","input_text"].includes(string(record(b).type))&&!string(record(b).text).trim())))
      return {...message,role:"tool",content};
    return {...message,content,previewExcluded:command||undefined};
  }
  const blocks=Array.isArray(message.content)?message.content:[message.content];
  const text=blocks.map(b=>typeof b==="string"?b:string(record(b).text)).filter(Boolean).join("\n").trim();
  if(!text)return message; // Images and tool results remain intact.
  let value=text;
  const peeled=peel(value,["system-reminder","ide_opened_file","ide_selection"]);
  if(peeled.stripped && !peeled.text)return {...message,role:"system"};
  if(peeled.stripped)value=peeled.text;
  if(/^(?:This session is being continued|<local-command-caveat>|\[Request interrupted|<task-notification>|<cross-session-message(?:\s|>)|Stop hook feedback:)/.test(value))
    return {...message,role:"system"};
  if(/^<local-command-(?:stdout|stderr)>/.test(value))return null;
  let command=false;
  if(/^<command-(?:name|message)>/.test(value) && !value.replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g,"").trim()) {
    const name=/<command-name>([\s\S]*?)<\/command-name>/.exec(value)?.[1] ?? /<command-message>([\s\S]*?)<\/command-message>/.exec(value)?.[1];
    if(!name?.trim())return null;
    const args=/<command-args>([\s\S]*?)<\/command-args>/.exec(value)?.[1].trim();
    value=`/${name.trim().replace(/^\//,"")}${args?` ${args}`:""}`;command=true;
  }
  if(value===text && !command)return /^\/[\w-]+(?:\s|$)/.test(value)?{...message,previewExcluded:true}:message;
  // Preserve attachments/tool blocks when native context shares a user record.
  const rest=blocks.filter(b=>typeof b!=="string" && !["text","input_text"].includes(string(record(b).type)));
  return {...message,content:rest.length?[{type:"text",text:value},...rest]:value,previewExcluded:command || undefined};
}

function codexText(text:string):string {
  let value=text.trimStart();
  if(/^<goal_context>|^<codex_internal_context\b[^>]*\bsource\s*=\s*["']goal["']|^<subagent_notification>|^<turn_aborted>/.test(value))return "";
  for (;;) {
    const previous=value;
    if(/^# AGENTS\.md[^\r\n]*(?:\r?\n)+\s*<INSTRUCTIONS>/.test(value))value=value.slice(value.indexOf("<INSTRUCTIONS>"));
    const cleaned=peel(value,["INSTRUCTIONS","environment_context","skill","recommended_plugins"]);
    value=cleaned.text;
    if(value===previous)break;
  }
  return value;
}

export function codexUserContent(content:unknown):{content:unknown;system:boolean} {
  const input=Array.isArray(content)?content:[content];
  const output:unknown[]=[];
  let real=false;
  for(const block of input) {
    const b=record(block);
    if(typeof block==="string" || ["input_text","text"].includes(string(b.type))) {
      const original=typeof block==="string"?block:string(b.text),clean=codexText(original);
      if(clean)real=true;
      output.push(typeof block==="string"?clean:{...b,text:clean});
    } else {output.push(block);real=true;}
  }
  return {content:Array.isArray(content)?output:output[0]??"",system:!real};
}
