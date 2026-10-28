import {afterEach,expect,it} from "vitest";
import Database from "better-sqlite3";
import {createHistorySchema} from "./schema.js";
import {StructuredHistory} from "./structured-store.js";
import {session} from "./provider-common.js";
import {collectedUsage,kimiUsage} from "./collection-usage.js";

const dbs:Database.Database[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();});
it.each([
  ["junie",{usageEvents:[{modelUsage:[{model:"a",inputTokens:60,outputTokens:20,cacheInputTokens:30,cacheCreateTokens:10}]}]}],
  ["roocode",{metadata:{apiConfigName:"a",tokensIn:60,tokensOut:20,cacheReads:30,cacheWrites:10},usageEvents:[{tokensIn:50},{tokensIn:60}]}],
  ["kilo-legacy",{metadata:{apiConfigName:"a",tokensIn:60,tokensOut:20,cacheReads:30,cacheWrites:10}}],
  ["muse",{usageEvents:[{sequence:1,payload:{event:{model:"a",usage:{input_tokens:100,output_tokens:20,cache_read_tokens:30,cache_write_tokens:10}}}},{sequence:1,payload:{event:{model:"a",usage:{input_tokens:100,output_tokens:20,cache_read_tokens:30,cache_write_tokens:10}}}}]}],
  ["poolside",{usageEvents:[{step_id:"s",collectedModel:"a",tool_call_inference_end:{input_tokens:60,output_tokens:20,cache_read_input_tokens:30,cache_write_input_tokens:10}},{step_id:"s",collectedModel:"a",tool_call_inference_end:{input_tokens:60,output_tokens:20,cache_read_input_tokens:30,cache_write_input_tokens:10}}]}],
] as const)("stores %s native usage once with its cache semantics",(provider,metadata)=>{
  const db=new Database(":memory:");dbs.push(db);createHistorySchema(db);const store=new StructuredHistory(db);
  const snapshot=session(provider,"s","D:/fixture",[],metadata);store.write(snapshot);store.write(snapshot);
  expect(db.prepare("SELECT model,input_total_tokens,uncached_input_tokens,cache_read_tokens,cache_write_tokens,output_tokens FROM adit_history_usage_entries WHERE ledger_role='canonical'").all()).toEqual([{model:"a",input_total_tokens:100,uncached_input_tokens:60,cache_read_tokens:30,cache_write_tokens:10,output_tokens:20}]);
});
it("retains absent cache buckets as unknown and does not turn Kimi cumulative status into request usage",()=>{
  expect(collectedUsage("antigravity",{usageEvents:[{protobuf:"opaque"}]})).toBeUndefined();
  expect(kimiUsage({context_tokens:100,output_tokens:20})).toBeUndefined();
  expect(kimiUsage({inputOther:10,output:2})).toEqual({input_tokens:10,output_tokens:2,cache_read_tokens:undefined,cache_write_tokens:undefined,adit_input_semantics:"excludes_cache"});
  expect(collectedUsage("visualstudio-copilot",{usageEvents:[{spanId:"span",input_tokens:"100",output_tokens:"20"}]})).toEqual([{spanId:"span",input_tokens:100,output_tokens:20}]);
});
