import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAdditionalSource } from "./additional-sources.js";
import { sourceFiles } from "./sources.js";
import { LocalHistory } from "./archive.js";
import { readDatabaseProvider } from "./database-providers.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
it("discovers Crush registry projects outside the source root and reads committed WAL without writing the source", async () => {
  const root = mkdtempSync(join(tmpdir(), "adit-crush-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "config"), data = join(root, "external-data"), workspace = join(root, "work");
  for (const dir of [config, data, workspace]) mkdirSync(dir);
  const path = join(data, "crush.db"), source = new Database(path);
  cleanup.push(() => source.close());
  source.pragma("journal_mode=WAL");
  source.pragma("wal_autocheckpoint=0");
  source.exec("CREATE TABLE sessions(id TEXT,title TEXT,parent_session_id TEXT); CREATE TABLE messages(id TEXT,session_id TEXT,role TEXT,parts TEXT,created_at INTEGER)");
  source.prepare("INSERT INTO sessions VALUES (?,?,?)").run("s", "Title", null);
  source.prepare("INSERT INTO messages VALUES (?,?,?,?,?)").run("m", "s", "assistant", JSON.stringify([{type:"text",data:{text:"hello"}}]), 1700000000);
  const registry = join(config, "projects.json");
  writeFileSync(registry, JSON.stringify({projects:[{path:workspace,data_dir:data}]}));
  expect(await Array.fromAsync(sourceFiles("crush", config))).toEqual([registry]);
  const sessions = await readAdditionalSource(registry, "crush");
  expect(sessions[0].cwd).toBe(workspace);
  expect(sessions[0].messages[0].timestamp).toBe("2023-11-14T22:13:20.000Z");
  const archiveDB = new Database(":memory:");
  cleanup.push(() => archiveDB.close());
  expect((await new LocalHistory(archiveDB).scan(workspace,[{id:"crush",paths:[config]}])).counts.crush).toBe(1);
  expect(source.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({n:1});
  expect(await Array.fromAsync(sourceFiles("crush", path))).toEqual([path]);
});
it("rejects malformed Crush registry paths instead of assigning sessions to a guessed workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "adit-crush-invalid-"));
  cleanup.push(() => rmSync(root, {recursive:true,force:true}));
  const path = join(root,"projects.json");
  writeFileSync(path, JSON.stringify({projects:[{path:"relative",data_dir:"relative"}]}));
  await expect(readAdditionalSource(path,"crush")).rejects.toThrow("absolute");
});

it.each(["hermes","augure-desktop"])("preserves %s reasoning and native totals without inventing cwd", (provider) => {
  const root=mkdtempSync(join(tmpdir(),"adit-hermes-"));
  cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,"state.db"), db=new Database(path);
  cleanup.push(()=>db.close());
  db.exec("CREATE TABLE sessions(id TEXT,title TEXT,parent_session_id TEXT,input_tokens INTEGER); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,tool_calls TEXT,reasoning TEXT,timestamp TEXT)");
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?)").run("s","title","parent",100);
  db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?)").run(1,"s","assistant","answer","[]","reasoning","2026-01-01T00:00:00Z");
  const [result]=readDatabaseProvider(path,provider);
  expect(result.cwd).toBe("");
  expect(result.metadata).toMatchObject({usage:{input_tokens:100},continuationOf:"parent"});
  expect(result.messages[0]).toMatchObject({timestamp:"2026-01-01T00:00:00.000Z",content:{reasoning:"reasoning"}});
  expect(result.messages[0].usage).toBeUndefined();
});

it("keeps Goose hidden records out while retaining tools and native model metadata",()=>{
  const root=mkdtempSync(join(tmpdir(),"adit-goose-"));
  cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,"sessions.db"),db=new Database(path);
  cleanup.push(()=>db.close());
  db.exec("CREATE TABLE sessions(id TEXT,working_dir TEXT,model_config_json TEXT,parent_session_id TEXT); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content_json TEXT,metadata_json TEXT,created_timestamp TEXT)");
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?)").run("s",root,JSON.stringify({model_name:"goose-model"}),"p");
  const insert=db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?)");
  insert.run(1,"s","user",JSON.stringify([{type:"text",text:"hidden"}]),JSON.stringify({userVisible:false}),"2026-01-01T00:00:00Z");
  insert.run(2,"s","assistant",JSON.stringify([{type:"toolRequest",id:"call",toolCall:{name:"read"}}]),"{}","2026-01-01T00:00:01Z");
  const [result]=readDatabaseProvider(path,"goose");
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0].model).toBe("goose-model");
  expect(result.messages[0].content).toMatchObject([{type:"toolRequest"}]);
  expect(result.relationship).toBe("subagent");
});

it("preserves Forge context message and tool wrappers with per-response usage",()=>{
  const root=mkdtempSync(join(tmpdir(),"adit-forge-"));
  cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,".forge.db"),db=new Database(path);
  cleanup.push(()=>db.close());
  db.exec("CREATE TABLE conversations(conversation_id TEXT,title TEXT,context TEXT,metrics TEXT)");
  db.prepare("INSERT INTO conversations VALUES (?,?,?,?)").run("s","title",JSON.stringify({messages:[{message:{text:{role:"system",content:`<current_working_directory>${root}</current_working_directory>`}}},{message:{text:{role:"assistant",content:"answer",model:"m"}},usage:{prompt_tokens:10}},{message:{tool:{call_id:"call",output:"result"}}}]}),"{}");
  const [result]=readDatabaseProvider(path,"forge");
  expect(result.cwd).toBe(root);
  expect(result.messages[1].usage).toEqual({prompt_tokens:10});
  expect(result.messages[2]).toMatchObject({role:"tool",content:{call_id:"call",output:"result"}});
});
it("archives sessions without cwd as unassigned, retaining an explicit assignment across rescans",async()=>{
  const root=mkdtempSync(join(tmpdir(),"adit-unassigned-"));
  cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,"source"),workspace=join(root,"workspace");mkdirSync(source);mkdirSync(workspace);
  const db=new Database(join(source,"state.db"));cleanup.push(()=>db.close());
  db.exec("CREATE TABLE sessions(id TEXT); CREATE TABLE messages(session_id TEXT,role TEXT,content TEXT)");
  db.prepare("INSERT INTO sessions VALUES (?)").run("s");db.prepare("INSERT INTO messages VALUES (?,?,?)").run("s","user","hello");
  const archiveDB=new Database(":memory:");cleanup.push(()=>archiveDB.close());
  const history=new LocalHistory(archiveDB),sources=[{id:"hermes",paths:[source]}];
  expect((await history.scan(workspace,sources)).counts).toEqual({});
  expect(history.unassigned()).toEqual([{provider:"hermes",id:"s",title:"s",messages:1}]);
  history.assign("hermes","s",workspace);
  expect(history.unassigned()).toEqual([]);
  expect((await history.scan(workspace,sources)).counts.hermes).toBe(1);
  expect((await history.scan(workspace,sources,{preview:true})).counts.hermes).toBe(1);
  expect(history.session("hermes","s")?.cwd).toBe("");
});
