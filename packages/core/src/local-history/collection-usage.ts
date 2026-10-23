import {record,string} from "./types.js";

const count=(v:unknown):number|undefined=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0?v:undefined;
/** Explicit native mappings only. Cumulative status counters are not request usage. */
export function collectedUsage(provider:string,metadata:Record<string,unknown>):Record<string,unknown>[]|undefined {
  const events=Array.isArray(metadata.usageEvents)?metadata.usageEvents.map(record):[];
  if(["roocode","kilo-legacy"].includes(provider)) {
    const m=record(metadata.metadata);
    if(![m.tokensIn,m.tokensOut,m.cacheReads,m.cacheWrites,m.totalCost].some(v=>typeof v==="number"))return;
    return [{model:m.apiConfigName,input_tokens:count(m.tokensIn),output_tokens:count(m.tokensOut),cache_read_tokens:count(m.cacheReads),cache_write_tokens:count(m.cacheWrites),cost:m.totalCost,adit_input_semantics:"excludes_cache"}];
  }
  if(provider==="junie")return events.flatMap(e=>(Array.isArray(e.modelUsage)?e.modelUsage:[]).map(value=>{
    const u=record(value);return {model:u.model,input_tokens:count(u.inputTokens),output_tokens:count(u.outputTokens),cache_read_tokens:count(u.cacheInputTokens),cache_write_tokens:count(u.cacheCreateTokens),cost:u.cost,adit_input_semantics:"excludes_cache"};
  }));
  if(provider==="visualstudio-copilot")return events.map(e=>{
    const integer=(v:unknown)=>typeof v==="string"&&/^\d+$/.test(v)?count(Number(v)):count(v);
    return {...e,input_tokens:integer(e.input_tokens),output_tokens:integer(e.output_tokens)};
  });
  if(provider==="muse") {
    const usage=new Map<string,Record<string,unknown>>();
    events.forEach((row,i)=>{
      const event=record(record(row.payload).event),u=record(event.usage);
      if(!Object.keys(u).length)return;
      const read=count(u.cache_read_tokens??u.cached_tokens),write=count(u.cache_write_tokens),input=count(u.input_tokens);
      usage.set(String(row.sequence??i),{...u,model:event.model,input_tokens:input!==undefined&&read!==undefined&&write!==undefined?Math.max(0,input-read-write):input,
        cache_read_tokens:read,cache_write_tokens:write,adit_input_semantics:read!==undefined&&write!==undefined?"excludes_cache":"unknown"});
    });return [...usage.values()];
  }
  if(provider==="poolside") {
    const usage=new Map<string,Record<string,unknown>>();
    for(const row of events) {
      const u=record(row.tool_call_inference_end);
      if(!row.step_id || !Object.keys(u).length)continue;
      usage.set(string(row.step_id),{...u,model:row.collectedModel,cache_read_tokens:count(u.cache_read_input_tokens),cache_write_tokens:count(u.cache_write_input_tokens),timestamp:row.timestamp,adit_input_semantics:"excludes_cache"});
    }return [...usage.values()];
  }
}

export function kimiUsage(value:unknown):Record<string,unknown>|undefined {
  const u=record(value);
  if(![u.inputOther,u.output,u.inputCacheRead,u.inputCacheCreation].some(v=>count(v)!==undefined))return;
  return {input_tokens:count(u.inputOther),output_tokens:count(u.output),cache_read_tokens:count(u.inputCacheRead),cache_write_tokens:count(u.inputCacheCreation),adit_input_semantics:"excludes_cache"};
}
