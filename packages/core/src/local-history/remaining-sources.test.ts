import {afterEach,expect,it} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import Database from "better-sqlite3";
import {LocalHistory} from "./archive.js";
import {readAntigravity,wireFields} from "./antigravity.js";
import {readVisualStudio} from "./visualstudio.js";
import {sourceDefinitions} from "./sources.js";
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"adit-remaining-"));roots.push(root);return root;}
function put(path:string,value:unknown){writeFileSync(path,JSON.stringify(value));}
it("registers all 74 automatic sources exactly once; three web exports are separate imports",()=>{
 const definitions=sourceDefinitions(fixture(),{});expect(definitions).toHaveLength(74);expect(new Set(definitions.map(d=>d.id)).size).toBe(74);
});
it("collects OTLP batched and rotated Visual Studio spans without replaying their input history",async()=>{
 const root=fixture();const span=(id:string,attrs:Record<string,string>)=>({spanId:id,startTimeUnixNano:"1700000000000000000",attributes:Object.entries({"gen_ai.conversation.id":"conversation",...attrs}).map(([key,stringValue])=>({key,value:{stringValue}}))});
 const first=span("a",{"gen_ai.input.messages":JSON.stringify([{role:"user",parts:[{type:"text",content:"question"}]}]),"gen_ai.output.messages":JSON.stringify([{role:"assistant",parts:[{type:"text",content:"answer"}]}]),"gen_ai.response.model":"native-model","gen_ai.usage.output_tokens":"7"});
 const path=join(root,"1_VSGitHubCopilot_traces.jsonl");put(path,{resourceSpans:[{scopeSpans:[{spans:[first]}]}]});put(join(root,"2_VSGitHubCopilot_traces.jsonl"),first);
 const sessions=await readVisualStudio(path);expect(sessions).toHaveLength(1);expect(sessions[0].messages).toHaveLength(2);expect(sessions[0].messages[1]).toMatchObject({model:"native-model",timestamp:"2023-11-14T22:13:20.000Z"});expect(sessions[0].cwd).toBe("");
 const db=new Database(":memory:");try{const history=new LocalHistory(db);const result=await history.scan(root,[{id:"visualstudio-copilot",paths:[root]}]);expect(result.errors).toEqual([]);expect(history.unassigned()).toHaveLength(1);}finally{db.close();}
});
it("keeps a newer Antigravity DB when a trajectory sidecar has fewer raw steps",async()=>{
 const root=fixture();mkdirSync(join(root,"conversations"));const path=join(root,"conversations","session.db");const db=new Database(path);db.exec("CREATE TABLE steps(idx INTEGER,step_type INTEGER,step_payload BLOB)");const insert=db.prepare("INSERT INTO steps VALUES(?,?,?)");insert.run(0,14,Buffer.from([8,14,18,5,...Buffer.from("hello")]));insert.run(1,15,Buffer.from([8,15,18,5,...Buffer.from("reply")]));db.close();
 put(join(root,"conversations","session.trajectory.json"),{steps:[{userInput:{userResponse:"stale"}}]});
 const [result]=await readAntigravity(path,"antigravity");expect(result.messages.map(m=>m.content)).toEqual(["hello","reply"]);expect(result.metadata?.fidelity).toBe("heuristic");
 put(join(root,"conversations","session.trajectory.json"),{steps:[{userInput:{userResponse:"hello"}},{plannerResponse:{thinking:"reason",response:"reply"},runCommand:{cwd:root}}]});
 expect((await readAntigravity(path,"antigravity"))[0]).toMatchObject({cwd:root,metadata:{fidelity:"trajectory"}});
 expect(await readAntigravity(join(root,"conversations","session.trajectory.json"),"antigravity")).toEqual([]);
});
it("rejects malformed protobuf lengths instead of treating truncated bytes as a complete session",()=>{
 expect(()=>wireFields(Buffer.from([18,127,1]))).toThrow("length");expect(()=>wireFields(Buffer.from([0]))).toThrow("field");
});
