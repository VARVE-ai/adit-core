import {afterEach,expect,it} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {readProjectRecords} from "./project-records.js";
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function root(){const dir=mkdtempSync(join(tmpdir(),"adit-records-"));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function write(path:string,value:unknown){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==="string"?value:JSON.stringify(value));}
const lines=(...rows:unknown[])=>rows.map(r=>JSON.stringify(r)).join("\n")+"\n";
it("reads Reasonix metadata and raw reasoning/tool content without fabricated usage",async()=>{
  const path=join(root(),"s.jsonl");write(path,lines({role:"assistant",content:"answer",reasoning_content:"reason",tool_calls:[{id:"call",name:"read",arguments:"{}"}]}));write(`${path}.meta`,{id:"s",workspace_root:"D:/work",model:"m",topic_title:"Title"});
  const [result]=await readProjectRecords(path,"reasonix");expect(result).toMatchObject({id:"s",cwd:"D:/work",metadata:{title:"Title"}});expect(result.messages[0]).toMatchObject({model:"m",content:{reasoning:"reason"}});expect(result.messages[0].usage).toBeUndefined();
});
it("reads Cortex split history while retaining metadata and native blocks",async()=>{
  const path=join(root(),"s.json");write(path,{session_id:"s",working_directory:"D:/work",title:"Title"});write(path.replace(".json",".history.jsonl"),lines({id:"u",role:"user",content:[{type:"text",text:"prompt"}],user_sent_time:"2026-01-01T00:00:00Z"}));const [result]=await readProjectRecords(path,"cortex");expect(result.messages[0]).toMatchObject({key:"u",timestamp:"2026-01-01T00:00:00.000Z"});
});
it("keeps WorkBuddy function calls/results in order and reads generated titles",async()=>{
  const path=join(root(),"project/s.jsonl");write(path,lines({type:"ai-title",aiTitle:"Title"},{type:"message",role:"user",cwd:"D:/work",content:"prompt"},{type:"function_call",callId:"call",name:"read",arguments:{}},{type:"function_call_result",callId:"call",output:"result"}));const [result]=await readProjectRecords(path,"workbuddy");expect(result.messages.map(m=>m.role)).toEqual(["user","assistant","tool"]);expect(result.metadata?.title).toBe("Title");
});
it("reads CodeBuddy manifest references, nested JSON strings and the workspace envelope",async()=>{
  const path=join(root(),"history/work/s/index.json");write(path,{messages:[{id:"u"},{id:"a"}]});write(join(dirname(path),"messages/u.json"),{role:"user",message:JSON.stringify({content:[{type:"text",text:"<user_info>Workspace Folder: D:/work</user_info><user_query>prompt</user_query>"}]})});write(join(dirname(path),"messages/a.json"),{role:"assistant",message:{content:[{type:"thinking",text:"reason"}]},extra:JSON.stringify({modelId:"m"})});const [result]=await readProjectRecords(path,"codebuddy");expect(result).toMatchObject({id:"work:s",cwd:"D:/work"});expect(result.messages[1].model).toBe("m");
});
