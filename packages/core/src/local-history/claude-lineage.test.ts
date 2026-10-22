import {expect,it} from "vitest";
import {claudeBranches} from "./claude-lineage.js";
import {parseClaude} from "./parsers.js";
const user=(id:string,parent?:string)=>({type:"user",uuid:id,parentUuid:parent,sessionId:"s",cwd:"D:/work",message:{content:id}});
const assistant=(id:string,parent:string)=>({type:"assistant",uuid:id,parentUuid:parent,sessionId:"s",cwd:"D:/work",message:{content:id}});
it("uses the latest retry branch for a short gap instead of duplicating a session",()=>{
 const result=claudeBranches([user("u"),assistant("first","u"),assistant("retry","u")],"s.jsonl");
 expect(result).toHaveLength(1);expect(result[0].messages.map(m=>m.key)).toEqual(["u","retry"]);
});
it("splits a genuine fork at its own first message without copying parent usage into the child",()=>{
 const result=claudeBranches([user("u"),assistant("a","u"),user("u2","a"),user("u3","u2"),user("u4","u3"),user("u5","u4"),assistant("fork","u")],"s.jsonl");
 expect(result).toHaveLength(2);
 expect(result.find(s=>s.id==="s-fork")).toMatchObject({parentId:"s",relationship:"fork",messages:[{key:"fork"}]});
 expect(result.find(s=>s.id==="s")?.messages.map(m=>m.key)).toEqual(["u","a","u2","u3","u4","u5"]);
});
it("coalesces streamed assistant blocks before interpreting sibling UUIDs as branches",()=>{
 const rows=[user("u"),{...assistant("a","u"),message:{id:"response",content:[{type:"text",text:"first"}]}},{...assistant("b","u"),message:{id:"response",content:[{type:"text",text:"second"}],usage:{input_tokens:5}}},user("next","b")];
 const [result]=claudeBranches(rows,"s.jsonl");expect(result.messages[1].content).toEqual([{type:"text",text:"first"},{type:"text",text:"second"}]);expect(result.messages[1].usage).toEqual({input_tokens:5});expect(result.messages[2].parentKey).toBe("a");
});
it("rejects disconnected cycles even if another branch is readable",()=>{
 expect(()=>claudeBranches([user("u"),user("cycle1","cycle2"),user("cycle2","cycle1")],"s.jsonl")).toThrow("cycle");
});
it.each(["", "workflows/wf-one/"])("keeps child identity separate from the parent in a %s subagent path",directory=>{
 const [child]=claudeBranches([user("u"),assistant("a","u")],`/projects/s/subagents/${directory}agent-one.jsonl`);
 expect(child).toMatchObject({id:"s:agent-one",parentId:"s",relationship:"subagent"});
 expect(child.messages.map(m=>m.key)).toEqual(["u","a"]);
 const [other]=claudeBranches([user("u")],`/projects/s/subagents/${directory}agent-two.jsonl`);
 expect(other.id).toBe("s:agent-two");
});
it("links child forks to the child's own identity instead of the main session",()=>{
 const rows=[user("u"),assistant("a","u"),user("u2","a"),user("u3","u2"),user("u4","u3"),user("u5","u4"),assistant("fork","u")];
 const result=claudeBranches(rows,"/projects/s/subagents/workflows/wf/agent-one.jsonl");
 expect(result).toHaveLength(2);
 expect(result.find(s=>s.relationship==="fork")).toMatchObject({id:"s:agent-one-fork",parentId:"s:agent-one",messages:[{key:"fork"}]});
 expect(result.find(s=>s.relationship==="subagent")).toMatchObject({id:"s:agent-one",parentId:"s"});
});
it("preserves message order when system and attachment records interrupt ancestry",()=>{
 const rows=[user("u"),{type:"attachment",uuid:"attachment",parentUuid:"u"},assistant("a","attachment"),{type:"system",uuid:"system",parentUuid:"a"},user("next","system"),assistant("reply","next")];
 const result=claudeBranches(rows,"s.jsonl");
 expect(result).toHaveLength(1);
 expect(result[0].messages.map(m=>m.key)).toEqual(["u","a","next","reply"]);
 expect(result[0].messages[1]).toMatchObject({parentKey:"attachment",raw:{parentUuid:"attachment"}});
 expect(result[0].messages[2]).toMatchObject({parentKey:"system",raw:{parentUuid:"system"}});
 expect(result[0].parentId).toBeUndefined();
});
it.each([
 ["multiple roots",[user("u"),assistant("a","u"),user("next"),assistant("reply","next")]],
 ["missing parent",[user("u"),assistant("a","u"),user("next","missing"),assistant("reply","next")]],
 ["shared missing parent",[user("u","missing"),assistant("a","missing"),user("next","a"),assistant("reply","next")]],
] as const)("keeps %s in one session without inventing forks",(_name,rows)=>{
 const result=claudeBranches([...rows],"s.jsonl");
 expect(result).toHaveLength(1);
 expect(result[0].messages.map(m=>m.key)).toEqual(["u","a","next","reply"]);
});
it("keeps the basic parser conservative when lineage has not been resolved",()=>{
 const text=[user("u"),assistant("a","u"),assistant("b","u")].map(row=>JSON.stringify(row)).join("\n")+"\n";
 expect(()=>parseClaude(text,"s.jsonl")).toThrow("lineage handling");
});
