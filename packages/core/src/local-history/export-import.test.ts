import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, rmSync,mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalHistory } from "./archive.js";
import {exportZip} from "./export-files.js";

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),"adit-export-"));
  cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const db=new Database(":memory:");cleanup.push(()=>db.close());
  return {root,path:join(root,"conversations.json"),history:new LocalHistory(db)};
}
it("imports only ChatGPT's selected branch and makes repeated imports idempotent",async()=>{
  const f=fixture();
  writeFileSync(f.path,JSON.stringify([{conversation_id:"conversation",current_node:"a",mapping:{u:{id:"u",parent:null,message:{id:"u",author:{role:"user"},content:{parts:["prompt"]}}},a:{id:"a",parent:"u",message:{id:"a",create_time:1700000000,author:{role:"assistant"},content:{parts:["selected"]},metadata:{model_slug:"model"}}},b:{id:"b",parent:"u",message:{id:"b",author:{role:"assistant"},content:{parts:["discard"]}}}}}]));
  expect((await f.history.importExport(f.path,"chatgpt",f.root)).imported).toBe(1);
  expect((await f.history.importExport(f.path,"chatgpt",f.root)).counts.chatgpt).toBe(1);
  expect(f.history.session("chatgpt","conversation")?.messages.map(m=>m.key)).toEqual(["u","a"]);
  expect(f.history.session("chatgpt","conversation")?.messages[1]).toMatchObject({model:"model",timestamp:"2023-11-14T22:13:20.000Z"});
});
it("validates every Claude.ai conversation before writing any and preserves attachment metadata",async()=>{
  const f=fixture();
  const valid={uuid:"s",name:"title",chat_messages:[{uuid:"m",sender:"human",text:"prompt",attachments:[{file_name:"file.txt",extracted_content:"body"}]}]};
  writeFileSync(f.path,JSON.stringify([valid,{uuid:"bad"}]));
  await expect(f.history.importExport(f.path,"claude-ai",f.root)).rejects.toThrow("chat_messages");
  expect(f.history.session("claude-ai","s")).toBeUndefined();
  writeFileSync(f.path,JSON.stringify([valid]));
  await f.history.importExport(f.path,"claude-ai",f.root);
  expect(f.history.session("claude-ai","s")?.messages[0]).toMatchObject({role:"user",content:{attachments:[{file_name:"file.txt",extracted_content:"body"}]}});
});
it("rejects ChatGPT ancestry cycles without changing an existing imported session",async()=>{
  const f=fixture();
  writeFileSync(f.path,JSON.stringify([{id:"s",current_node:"a",mapping:{a:{id:"a",parent:"a"}}}]));
  await expect(f.history.importExport(f.path,"chatgpt",f.root)).rejects.toThrow("cycle");
  expect(f.history.counts(f.root)).toEqual({});
});
it("imports split export directories atomically and counts both files",async()=>{
  const f=fixture(),directory=join(f.root,"exports");mkdirSync(directory);
  writeFileSync(join(directory,"conversations-1.json"),JSON.stringify([{uuid:"one",chat_messages:[]}])) ;
  writeFileSync(join(directory,"conversations-2.json"),JSON.stringify([{uuid:"two",chat_messages:[]}])) ;
  expect((await f.history.importExport(directory,"claude-ai",f.root)).imported).toBe(2);
  writeFileSync(join(directory,"conversations-2.json"),"malformed");
  await expect(f.history.importExport(directory,"claude-ai",f.root)).rejects.toThrow("Invalid");
  expect(f.history.counts(f.root)).toEqual({"claude-ai":2});
});
it("validates ZIP member checksums and never extracts member paths",()=>{
  const data=Buffer.from("[]"),name=Buffer.from("nested/conversations.json");
  let crc=0xffffffff;for(const byte of data){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(local.length+name.length+data.length,16);
  const zip=Buffer.concat([local,name,data,central,name,end]);expect(exportZip(zip,"chatgpt")).toEqual([data]);
  zip[local.length+name.length]=1;expect(()=>exportZip(zip,"chatgpt")).toThrow("integrity");
});
