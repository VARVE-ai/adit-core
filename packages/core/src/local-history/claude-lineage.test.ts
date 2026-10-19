import {expect,it} from "vitest";
import {claudeBranches} from "./claude-lineage.js";
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
