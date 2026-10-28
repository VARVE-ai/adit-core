import { expect, it } from "vitest";
import { parseEvener, parseTau } from "./semantic-jsonl.js";

it("selects Tau's active leaf, retaining model and tool results only on that branch", () => {
  const result = parseTau([
    {type:"session_info",cwd:"D:/work",title:"session"},
    {type:"message",id:"u",message:{role:"user",content:"ask"}},
    {type:"message",id:"discard",parent_id:"u",message:{role:"assistant",content:"other branch"}},
    {type:"model_change",id:"model",parent_id:"u",model:"model-b"},
    {type:"message",id:"a",parent_id:"model",message:{role:"assistant",content:[{type:"toolCall",id:"call",name:"read"}],usage:{input:4,output:2}}},
    {type:"message",id:"t",parent_id:"a",message:{role:"toolResult",toolCallId:"call",content:"result"}},
    {type:"leaf",entry_id:"t"},
  ], "thread.jsonl");
  expect(result.messages.map(m => m.key)).toEqual(["u","a","t"]);
  expect(result.messages[1]).toMatchObject({model:"model-b",parentKey:"u",usage:{input:4,output:2}});
  expect(result.messages[2].role).toBe("tool");
});
it("rejects Tau cycles and ambiguous identities", () => {
  expect(() => parseTau([{type:"session_info"},{type:"message",id:"a",parent_id:"a"},{type:"leaf",entry_id:"a"}],"s.jsonl")).toThrow("cycle");
  expect(() => parseTau([{type:"session_info"},{id:"a"},{id:"a"},{type:"leaf",entry_id:"a"}],"s.jsonl")).toThrow("ambiguous");
});
it("keeps Evener initial context separate from human input and tracks model switches and native usage", () => {
  const result = parseEvener([
    {kind:"HEADER",format_version:2,session_id:"s",working_dir:"D:/work",model:"first",system_prompt:"rules",task:"initial"},
    {kind:"USER_INPUT",message:{content:[{kind:"text",text:"hello"}]}},
    {kind:"MODEL_SWITCH",model_switch:{new_model:"second"}},
    {kind:"ASSISTANT",stable_turn_id:"turn",message:{content:[{kind:"thinking",thinking:{text:"reason"}}]},usage:{input_tokens:10,cache_read_tokens:3}},
  ],"s.transcript.jsonl",{id:"s",parent_session_id:"parent",is_subagent:true});
  expect(result.messages[0].role).toBe("system");
  expect(result.messages[2].role).toBe("user");
  expect(result.messages.at(-1)).toMatchObject({model:"second",key:"turn",usage:{input_tokens:10,cache_read_tokens:3}});
  expect(result).toMatchObject({parentId:"parent",relationship:"subagent"});
  expect(() => parseEvener([{format_version:1,session_id:"s"}],"s.transcript.jsonl")).toThrow("v2");
});
