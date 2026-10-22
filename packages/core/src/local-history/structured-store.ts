import {createHash} from "node:crypto";
import type Database from "better-sqlite3";
import {record,string,type HistoryMessage,type HistorySession} from "./types.js";
import {hasCodexPromptContext,promptSummary} from "./prompt-summary.js";
import {applyTranscriptEdits,isHistoryPrompt as isPrompt} from "./transcript-edits.js";

const encode=(value:unknown)=>value === undefined ? null : JSON.stringify(value);
const decode=(value:string|null)=>value === null ? undefined : JSON.parse(value);
export const historyKey=(...parts:unknown[])=>createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const time=(value?:string)=>value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const text=(value:unknown):string=>typeof value === "string" ? value : Array.isArray(value) ? value.map(text).filter(Boolean).join("\n") : string(record(value).text) || string(record(value).content);
const optional=(value:unknown)=>typeof value === "string" && value ? value : null;
const integer=(value:unknown):number|null=>typeof value === "number" && Number.isSafeInteger(value) && value>=0 ? value : null;
function numberAt(value:Record<string,unknown>,...fields:string[]):number|null {
  for(const field of fields) { const found=integer(value[field]); if(found!==null)return found; }
  return null;
}
function sum(...values:(number|null)[]):number|null {
  if(values.some(value=>value===null))return null;
  return integer(values.reduce<number>((total,value)=>total+value!,0));
}

/** All list/analytics fields are columns. Original payloads remain per-message evidence only. */
export class StructuredHistory {
  constructor(readonly db:Database.Database) {}

  /** Refresh only affected display summaries, without replacing transcripts or invalidating attribution. */
  refreshCodexPromptSummaries():number {
    const sessions=this.db.prepare("SELECT provider,id,first_prompt FROM adit_history_sessions WHERE provider IN ('codex','traex','augure-code') AND first_prompt IS NOT NULL").all() as {provider:string;id:string;first_prompt:string}[];
    const affected=sessions.filter(s=>hasCodexPromptContext(s.provider,s.first_prompt));
    if(!affected.length)return 0;
    const messages=this.db.prepare("SELECT content_json FROM adit_history_messages WHERE provider=? AND session_id=? AND role='user' ORDER BY ordinal");
    const update=this.db.prepare("UPDATE adit_history_sessions SET first_prompt=? WHERE provider=? AND id=?");
    return this.db.transaction(()=>{
      for(const session of affected) {
        let summary:string|null=null;
        for(const row of messages.iterate(session.provider,session.id) as Iterable<{content_json:string|null}>) {
          summary=promptSummary(session.provider,decode(row.content_json));
          if(summary)break;
        }
        update.run(summary,session.provider,session.id);
      }
      return affected.length;
    })();
  }

  read(provider:string,id:string):HistorySession|undefined {
    const session=this.db.prepare("SELECT * FROM adit_history_sessions WHERE provider=? AND id=?").get(provider,id) as Record<string,unknown>|undefined;
    if(!session)return;
    const rows=this.db.prepare(`SELECT m.*,o.raw_usage_json FROM adit_history_messages m
      LEFT JOIN adit_history_usage_observations o ON o.message_id=m.id
      WHERE m.provider=? AND m.session_id=? ORDER BY m.ordinal`).all(provider,id) as Record<string,unknown>[];
    const messages=rows.map(row=>({
      ...JSON.parse(row.extra_json as string),key:row.source_key,role:row.role,
      ...(row.source_timestamp!==null?{timestamp:row.source_timestamp}:{}),
      ...(row.model!==null?{model:row.model}:{}),...(row.effort!==null?{effort:row.effort}:{}),
      ...(row.parent_key!==null?{parentKey:row.parent_key}:{}),
      ...(row.content_json!==null?{content:decode(row.content_json as string)}:{}),
      ...(row.raw_usage_json!==null?{usage:decode(row.raw_usage_json as string)}:{}),
      raw:JSON.parse(row.raw_json as string),
    })) as HistoryMessage[];
    return {...JSON.parse(session.extra_json as string),id,provider,cwd:session.cwd as string,
      ...(session.parent_id!==null?{parentId:session.parent_id as string}:{}),
      ...(session.relationship!==null?{relationship:session.relationship as HistorySession["relationship"]}:{}),
      ...(session.metadata_json!==null?{metadata:decode(session.metadata_json as string)}:{}),messages};
  }

  write(session:HistorySession):void {
    this.db.transaction(()=>this.replace(applyTranscriptEdits(this.db,session)))();
  }

  private replace(session:HistorySession):void {
    const {id,provider,cwd,parentId,relationship,metadata,messages,...extra}=session;
    if(new Set(messages.map(m=>m.key)).size!==messages.length)throw new Error("Duplicate native message identity in collected session");
    const digests=messages.map(message=>historyKey(message));
    const previous=this.db.prepare(`SELECT m.id,m.ordinal,d.digest FROM adit_history_messages m
      LEFT JOIN adit_history_message_digests d ON d.message_id=m.id
      WHERE m.provider=? AND m.session_id=? ORDER BY m.ordinal`).all(provider,id) as {id:string;ordinal:number;digest:string|null}[];
    let prefix=0;
    while(prefix<messages.length && prefix<previous.length && previous[prefix].ordinal===prefix && previous[prefix].digest===digests[prefix])prefix++;
    if(prefix===messages.length && previous.length>prefix && prefix>0)prefix--;
    // Rebuild only the affected turn and subsequent turns. Completed earlier turns retain
    // their blocks, FTS rows, tool evidence, usage/prices and identifiers.
    if(prefix<messages.length && !isPrompt(messages[prefix]))
      while(prefix>0 && !isPrompt(messages[prefix]))prefix--;
    const prefixTurns=messages.slice(0,prefix).filter(isPrompt).length;
    const times=messages.map(m=>time(m.timestamp)).filter((value):value is number=>value!==null);
    const title=string(metadata?.title) || null;
    let firstPrompt:string|null=null;
    for(const message of messages)if(isPrompt(message)) {
      firstPrompt=promptSummary(provider,message.content);
      if(firstPrompt)break;
    }
    this.db.prepare(`INSERT INTO adit_history_sessions
      (provider,id,cwd,parent_id,relationship,title,first_prompt,started_at,last_activity_at,message_count,user_prompt_count,metadata_json,extra_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,id) DO UPDATE SET
      cwd=excluded.cwd,parent_id=excluded.parent_id,relationship=excluded.relationship,title=excluded.title,first_prompt=excluded.first_prompt,
      started_at=excluded.started_at,last_activity_at=excluded.last_activity_at,message_count=excluded.message_count,
      user_prompt_count=excluded.user_prompt_count,metadata_json=excluded.metadata_json,extra_json=excluded.extra_json,
      transcript_revision=adit_history_sessions.transcript_revision+1`).run(
        provider,id,cwd,parentId??null,relationship??null,title,firstPrompt,times.length?times.reduce((a,b)=>Math.min(a,b)):null,
        times.length?times.reduce((a,b)=>Math.max(a,b)):null,messages.length,messages.filter(isPrompt).length,encode(metadata),encode(extra));
    this.db.prepare("DELETE FROM adit_history_usage_observations WHERE provider=? AND session_id=? AND message_id IS NULL").run(provider,id);
    this.db.prepare("DELETE FROM adit_history_messages WHERE provider=? AND session_id=? AND ordinal>=?").run(provider,id,prefix);
    this.db.prepare("DELETE FROM adit_history_turns WHERE provider=? AND session_id=? AND ordinal>?").run(provider,id,prefixTurns);
    this.db.prepare("DELETE FROM adit_history_relations WHERE provider=? AND session_id=?").run(provider,id);
    if(parentId)this.db.prepare("INSERT INTO adit_history_relations VALUES (?,?,?,?)").run(provider,id,parentId,relationship||"unknown");

    let turn:string|null=null,turnOrdinal=prefixTurns;
    const turns=new Map<string,{prompt:string;last:string;start:number|null;end:number|null;previous:{id:string;at:number}|null;duration:number;missing:boolean}>();
    const calls=new Map<string,string>();
    const usageGroups=new Map<string,{entry:string;weight:number}>();
    for(const call of this.db.prepare("SELECT id,source_call_id FROM adit_history_tool_calls WHERE provider=? AND session_id=? ORDER BY occurred_at,call_index").all(provider,id) as {id:string;source_call_id:string|null}[])
      if(call.source_call_id)calls.set(call.source_call_id,call.id);
    // Reconcile retained request groups before appending: an old suffix may have
    // superseded an earlier usage observation and can now have been removed.
    const retained=this.db.prepare(`SELECT e.*,o.raw_usage_json,o.request_id,o.response_id FROM adit_history_usage_entries e
      JOIN adit_history_usage_observations o ON o.id=e.id JOIN adit_history_messages m ON m.id=e.message_id
      WHERE e.provider=? AND e.session_id=? ORDER BY m.ordinal`).all(provider,id) as Record<string,unknown>[];
    const ledger=this.db.prepare("UPDATE adit_history_usage_entries SET ledger_role=?,exclusion_reason=? WHERE id=? AND (ledger_role<>? OR exclusion_reason IS NOT ?)");
    for(const entry of retained) {
      const raw=JSON.parse(entry.raw_usage_json as string);
      const weight=[entry.input_reported_tokens,entry.output_tokens,entry.cache_read_tokens,entry.cache_write_tokens,entry.reasoning_tokens,numberAt(raw,"total_tokens","totalTokens","totalTokenCount")].filter(value=>value!==null).length;
      const key=entry.request_id||entry.response_id?JSON.stringify([entry.request_id,entry.response_id]):entry.id as string;
      const old=usageGroups.get(key);
      let role=weight?"canonical":"observation",reason:string|null=weight?null:"unrecognized_usage_fields";
      if(old && weight<old.weight){role="superseded";reason="same_native_request";}
      else {
        if(old)ledger.run("superseded","same_native_request",old.entry,"superseded","same_native_request");
        usageGroups.set(key,{entry:entry.id as string,weight});
      }
      ledger.run(role,reason,entry.id,role,reason);
    }
    const insertMessage=this.db.prepare(`INSERT INTO adit_history_messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertBlock=this.db.prepare("INSERT INTO adit_history_blocks VALUES (?,?,?,?,?,?)");
    for(const [ordinal,message] of messages.entries()) {
      if(ordinal<prefix)continue;
      const mid=historyKey(provider,id,message.key),occurred=time(message.timestamp);
      if(isPrompt(message)) {
        turn=historyKey(provider,id,"turn",message.key);turnOrdinal++;
        turns.set(turn,{prompt:mid,last:mid,start:occurred,end:occurred,previous:occurred!==null?{id:mid,at:occurred}:null,duration:0,missing:occurred===null});
        this.db.prepare("INSERT INTO adit_history_turns VALUES (?,?,?,?,?,?,?,?,?,?)").run(turn,provider,id,mid,mid,turnOrdinal,occurred,occurred,null,"incomplete");
      }
      if(turn) {
        const state=turns.get(turn)!;state.last=mid;
        if(occurred!==null) {
          state.end=occurred;
          if(state.previous && state.previous.id!==mid && occurred>=state.previous.at) {
            const duration=Math.min(occurred-state.previous.at,300_000);state.duration+=duration;
            this.db.prepare("INSERT INTO adit_history_work_intervals VALUES (?,?,?,?,?,?,?)").run(
              historyKey(turn,state.previous.id,mid),turn,state.previous.id,mid,state.previous.at,occurred,duration);
          } else if(state.previous && state.previous.id!==mid)state.missing=true;
          state.previous={id:mid,at:occurred};
        } else state.missing=true;
      }
      const wire=record(message.raw),payload=record(wire.payload),native=record(wire.message);
      const request=optional(wire.requestId ?? wire.request_id ?? payload.request_id ?? native.request_id);
      const response=optional(native.id ?? payload.response_id ?? wire.response_id);
      const {key,role,timestamp,model,effort,content,usage,parentKey,raw,...messageExtra}=message;
      insertMessage.run(mid,provider,id,key,ordinal,role,parentKey??null,turn,occurred,timestamp??null,model??null,effort??null,
        request,response,encode(content),encode(raw),encode(messageExtra));
      this.db.prepare("INSERT INTO adit_history_message_digests VALUES (?,?)").run(mid,digests[ordinal]);
      const blocks=Array.isArray(content)?content:[content];
      const toolNodes:Record<string,unknown>[]=[];
      for(const [index,block] of blocks.entries()) {
        const data=record(block),kind=string(data.type)||string(data.kind)||(typeof block==="string"?"text":"structured");
        const body=text(block)||string(data.thinking)||null;
        insertBlock.run(historyKey(mid,index),mid,index,kind,body,encode(block));
        if(["tool_use","tool_result","toolCall","toolResult","function_call","function_call_output","custom_tool_call","custom_tool_call_output"].includes(kind))toolNodes.push(data);
      }
      if(["function_call","function_call_output","custom_tool_call","custom_tool_call_output"].includes(string(payload.type)))toolNodes.push(payload);
      const contentRecord=record(content);
      for(const node of [wire,contentRecord,native]) {
        if(Array.isArray(node.tool_calls))for(const call of node.tool_calls)toolNodes.push({...record(call),type:"function_call"});
        if(Object.keys(record(node.toolFormerData)).length)toolNodes.push({...record(node.toolFormerData),type:"function_call"});
      }
      if(role==="tool" && !toolNodes.length)toolNodes.push({type:"tool_result",tool_use_id:wire.tool_call_id??contentRecord.tool_call_id??wire.toolCallId,content});
      const seenNodes=new Set<string>();
      for(const [index,node] of toolNodes.entries()) {
        const type=string(node.type),nativeId=optional(node.call_id??node.tool_use_id??node.toolCallId??node.tool_call_id??node.id);
        const signature=JSON.stringify([type,nativeId,node]);if(seenNodes.has(signature))continue;seenNodes.add(signature);
        const toolId=historyKey(mid,"tool",index),fn=record(node.function);
        if(type.includes("result")||type.endsWith("_output")) {
          const value=node.output??node.content??node.result;
          this.db.prepare("INSERT INTO adit_history_tool_results VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
            toolId,mid,nativeId?calls.get(nativeId)??null:null,provider,id,nativeId,index,occurred,
            node.is_error===true?"failed":"unknown",integer(node.exit_code),text(value)||null,encode(value));
        } else {
          const args=node.input??node.arguments??node.rawArgs??fn.arguments;
          let input=record(args);if(typeof args==="string")try{input=record(JSON.parse(args));}catch{/* Native custom tool inputs may be plain text. */}
          const name=optional(node.name??fn.name),command=optional(input.command??input.cmd),path=optional(input.file_path??input.path);
          this.db.prepare("INSERT INTO adit_history_tool_calls VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
            toolId,mid,provider,id,turn,index,nativeId,name,command,path,optional(input.cwd??input.workdir),occurred,"unknown",encode(args));
          if(nativeId)calls.set(nativeId,toolId);
          const written=input.new_string??input.newText??input.content;
          if(path && typeof written==="string" && /edit|write/i.test(name||""))
            this.db.prepare("INSERT INTO adit_history_edit_evidence VALUES (?,?,?,?,?,?,?,?,?,?)").run(
              toolId,toolId,provider,id,turn,path,occurred,"native_write",written,historyKey(written));
          if(command && /(?:^|[;&|\s])git\s+(?:-[^\s]+\s+)*commit(?:\s|$)/.test(command))
            this.db.prepare("INSERT INTO adit_history_commit_operations VALUES (?,?,?,?,?,?,?,?)").run(toolId,toolId,provider,id,turn,occurred,command,"observed");
        }
      }
      if(usage!==undefined)this.usage(session,mid,turn,message.key,usage,model??null,request,response,occurred,"message",usageGroups);
    }
    // Results can precede their calls in native container order. Resolve against collected identities afterwards.
    for(const [nativeId,toolId] of calls)
      this.db.prepare("UPDATE adit_history_tool_results SET tool_call_id=? WHERE provider=? AND session_id=? AND source_call_id=? AND tool_call_id IS NULL").run(toolId,provider,id,nativeId);
    for(const [tid,state] of turns)
      this.db.prepare("UPDATE adit_history_turns SET last_message_id=?,ended_at=?,work_duration_ms=?,duration_status=? WHERE id=?").run(
        state.last,state.end,state.start===null?null:state.duration,state.missing?"partial":"observed",tid);
    const sessionUsage=metadata?.usage;
    if(Array.isArray(sessionUsage))for(const [index,value] of sessionUsage.entries()) {
      const entry=record(value);
      this.usage(session,null,null,`session:${index}`,entry,optional(entry.model??metadata?.model),null,null,null,"session",usageGroups);
    }
    else if(sessionUsage && typeof sessionUsage==="object")this.usage(session,null,null,"session",record(sessionUsage),
      optional(metadata?.model),null,null,null,"session",usageGroups);
  }

  private usage(session:HistorySession,messageId:string|null,turnId:string|null,key:string,usage:Record<string,unknown>,model:string|null,
    request:string|null,response:string|null,occurred:number|null,scope:string,groups:Map<string,{entry:string;weight:number}>):void {
    const provider=session.provider,id=session.id,oid=historyKey(provider,id,"usage",key);
    this.db.prepare("INSERT INTO adit_history_usage_observations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      oid,provider,id,messageId,turnId,key,scope,"transcript",model,request,response,occurred,encode(usage));
    const reported=numberAt(usage,"input_tokens","inputTokens","prompt_tokens","promptTokens","input","inputTokenCount","promptTokenCount","accumulated_input_tokens");
    const output=numberAt(usage,"output_tokens","outputTokens","completion_tokens","completionTokens","output","outputTokenCount","candidatesTokenCount","accumulated_output_tokens");
    const read=numberAt(usage,"cache_read_input_tokens","cached_input_tokens","cache_read_tokens","cacheReadTokens","cacheRead","cachedContentTokenCount","accumulated_cache_read_tokens")
      ??numberAt(record(usage.cache),"read")
      ??numberAt(record(usage.prompt_tokens_details),"cached_tokens")??numberAt(record(usage.input_tokens_details),"cached_tokens");
    const write=numberAt(usage,"cache_creation_input_tokens","cache_write_input_tokens","cache_write_tokens","cacheWriteTokens","cacheWrite","accumulated_cache_write_tokens")??numberAt(record(usage.cache),"write");
    const cache=record(usage.cache_creation);
    const write5=numberAt(cache,"ephemeral_5m_input_tokens"),write1h=numberAt(cache,"ephemeral_1h_input_tokens");
    const reasoning=numberAt(usage,"reasoning_output_tokens","reasoning_tokens","reasoningTokens","reasoning")??numberAt(record(usage.completion_tokens_details),"reasoning_tokens");
    const reportedTotal=numberAt(usage,"total_tokens","totalTokens","totalTokenCount");
    const semantic=["claude","qoder","iflow","pi","omp","omo","prime-agent","stepcode","opencode","kilo","mimocode","icodemate","zcode"].includes(provider)?"excludes_cache":
      ["codex","traex","augure-code","gemini","deepseek"].includes(provider)?"includes_cache":"unknown";
    let inputTotal:number|null=null,uncached:number|null=null;
    if(semantic==="excludes_cache") {uncached=reported;inputTotal=sum(reported,read,write);}
    else if(semantic==="includes_cache") {inputTotal=reported;uncached=reported!==null&&read!==null?integer(reported-read):null;}
    const derivedTotal=sum(inputTotal,output),conflictingTotal=reportedTotal!==null&&derivedTotal!==null&&reportedTotal!==derivedTotal;
    const total=conflictingTotal?null:reportedTotal??derivedTotal;
    const recognized=[reported,output,read,write,reasoning,reportedTotal].some(value=>value!==null);
    const weight=[reported,output,read,write,reasoning,reportedTotal].filter(value=>value!==null).length;
    const nativeGroup=request||response?JSON.stringify([request,response]):null;
    let ledger=recognized?"canonical":"observation",reason=recognized?null:"unrecognized_usage_fields";
    if(scope==="session" && groups.size){ledger="observation";reason="session_total_may_overlap_message_usage";}
    if(scope==="message"&&nativeGroup) {
      const previous=groups.get(nativeGroup);
      if(previous) {
        if(weight>=previous.weight)this.db.prepare("UPDATE adit_history_usage_entries SET ledger_role='superseded',exclusion_reason='same_native_request' WHERE id=?").run(previous.entry);
        else {ledger="superseded";reason="same_native_request";}
      }
      if(!previous||weight>=previous.weight)groups.set(nativeGroup,{entry:oid,weight});
    } else if(scope==="message")groups.set(oid,{entry:oid,weight});
    const cost=typeof usage.cost==="number"?usage.cost:record(usage.cost).total;
    const costMicros=typeof cost==="number"&&cost>=0?integer(Math.round(cost*1_000_000)):null;
    this.db.prepare(`INSERT INTO adit_history_usage_entries
      (id,provider,session_id,message_id,turn_id,model,occurred_at,scope,dedup_key,ledger_role,exclusion_reason,input_semantics,
      input_reported_tokens,input_total_tokens,uncached_input_tokens,cache_read_tokens,cache_write_tokens,cache_write_5m_tokens,cache_write_1h_tokens,
      output_tokens,reasoning_tokens,total_tokens,provider_cost_microusd,completeness)
      VALUES (${Array(24).fill("?").join(",")})`).run(
        oid,provider,id,messageId,turnId,model,occurred,scope,key,ledger,reason,semantic,reported,inputTotal,uncached,read,write,write5,write1h,
        output,reasoning,total,costMicros,inputTotal!==null&&uncached!==null&&output!==null&&!conflictingTotal?"complete":recognized?"partial":"unknown");
  }
}
