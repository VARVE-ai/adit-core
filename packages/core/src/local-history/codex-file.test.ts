import {afterEach,expect,it} from "vitest";
import {mkdtempSync,writeFileSync,appendFileSync,rmSync,mkdirSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import Database from "better-sqlite3";
import {LocalHistory} from "./archive.js";
import {codexFileRows} from "./codex-file.js";
import {sourceFiles} from "./sources.js";
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"adit-stream-"));roots.push(root);return root;}
it("collects a Codex source beyond 128 MiB without loading its whole transcript",async()=>{
 const root=fixture(),path=join(root,"rollout-large.jsonl");writeFileSync(path,JSON.stringify({type:"session_meta",payload:{id:"large",cwd:root}})+"\n");const record=JSON.stringify({type:"diagnostic",padding:"x".repeat(1024*1024)})+"\n";for(let i=0;i<129;i++)appendFileSync(path,record);
 appendFileSync(path,JSON.stringify({type:"response_item",payload:{type:"message",role:"user",content:"last message"}})+"\n");expect(statSync(path).size).toBeGreaterThan(128*1024*1024);
 const db=new Database(":memory:");try{const history=new LocalHistory(db),result=await history.scan(root,[{id:"codex",paths:[root]}]);expect(result.errors).toEqual([]);expect(result.counts).toEqual({codex:1});expect(history.session("codex","large")?.messages).toMatchObject([{content:"last message"}]);}finally{db.close();}
});
it("ignores only an unfinished final record and reports malformed complete records",()=>{
 const root=fixture(),path=join(root,"rollout-tail.jsonl");writeFileSync(path,'{"type":"session_meta","payload":{"id":"s"}}\n{"type":');expect([...codexFileRows(path)]).toHaveLength(1);appendFileSync(path,"invalid}\n");expect(()=>[...codexFileRows(path)]).toThrow("line 2");
});
it("discovers Cursor's direct database without descending into unrelated extension directories",async()=>{
 const root=fixture(),path=join(root,"state.vscdb");writeFileSync(path,"");mkdirSync(join(root,...Array(15).fill("extension-cache")),{recursive:true});const paths=[];for await(const file of sourceFiles("cursor-ide",root))paths.push(file);expect(paths).toEqual([path]);const explicit=[];for await(const file of sourceFiles("cursor-ide",path))explicit.push(file);expect(explicit).toEqual([path]);
});
it("updates complete Cursor composers while retaining an unfinished composer's previous archive",async()=>{
 const root=fixture(),path=join(root,"state.vscdb"),source=new Database(path),db=new Database(":memory:");
 try{
  source.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY,value TEXT)");
  const set=(key:string,value:unknown)=>source.prepare("INSERT OR REPLACE INTO cursorDiskKV VALUES (?,?)").run(key,JSON.stringify(value));
  for(const id of ["complete","unfinished"]){set(`composerData:${id}`,{workspaceIdentifier:{uri:{fsPath:root}},fullConversationHeadersOnly:[{bubbleId:"u",type:1}]});set(`bubbleId:${id}:u`,{type:1,text:"original"});}
  const history=new LocalHistory(db),sources=[{id:"cursor-ide",paths:[root]}];
  expect((await history.scan(root,sources)).counts).toEqual({"cursor-ide":2});
  set("bubbleId:complete:u",{type:1,text:"updated"});set("bubbleId:unfinished:u",{type:1,text:""});
  const result=await history.scan(root,sources);expect(result.errors).toHaveLength(1);expect(result.updated).toBe(1);
  expect(history.session("cursor-ide","complete")?.messages[0].content).toBe("updated");
  expect(history.session("cursor-ide","unfinished")?.messages[0].content).toBe("original");
  expect((await history.scan(root,sources)).errors).toHaveLength(1);
  expect(history.session("cursor-ide","unfinished")?.messages[0].content).toBe("original");
 }finally{source.close();db.close();}
});
