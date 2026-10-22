import {afterEach,expect,it} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import Database from "better-sqlite3";
import {LocalStore} from "@varveai/adit-core";
import {cleanupProjectFiles} from "./project-cleanup.js";
let root:string,store:LocalStore;
afterEach(()=>{store?.close();if(root)rmSync(root,{recursive:true,force:true});});
function setup(){
  root=mkdtempSync(join(tmpdir(),"adit-project-cleanup-"));
  store=new LocalStore(join(root,"state"));
  const path=join(root,"project");mkdirSync(join(path,".adit"),{recursive:true});
  const w=store.saveWorkspace({path,providers:[],repositories:[]});
  const runtime=join(store.directory,"runtime",w.id);mkdirSync(runtime,{recursive:true});
  writeFileSync(join(runtime,"preview.png"),"owned");writeFileSync(join(path,"source.ts"),"keep");
  writeFileSync(join(path,".adit","project.json"),"identity");return {w,runtime};
}
it("removes only the project's legacy history and runtime, preserving shared history and identity files",()=>{
  const {w,runtime}=setup(),path=join(w.path,".adit","adit.sqlite");
  const db=new Database(path);
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,project_id TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id),parent_event_id TEXT REFERENCES events(id));
    CREATE TABLE diffs(event_id TEXT REFERENCES events(id));
    CREATE TABLE env_snapshots(session_id TEXT REFERENCES sessions(id));
    CREATE TABLE session_platform_aliases(session_id TEXT REFERENCES sessions(id));
    CREATE TABLE project_link_cache(project_id TEXT);
    CREATE TABLE sync_state(server_url TEXT,last_synced_event_id TEXT);`);
  db.prepare("INSERT INTO sessions VALUES ('owned',?),('shared','another')").run(w.id);
  db.exec("INSERT INTO events VALUES ('one','owned',NULL),('two','shared',NULL); INSERT INTO diffs VALUES ('one'); INSERT INTO env_snapshots VALUES ('owned'); INSERT INTO session_platform_aliases VALUES ('owned'); INSERT INTO sync_state VALUES ('local','one'),('other','two')");
  db.prepare("INSERT INTO project_link_cache VALUES (?),('another')").run(w.id);db.close();
  cleanupProjectFiles(store,w);
  const after=new Database(path);
  try {
    expect(after.prepare("SELECT id FROM sessions").all()).toEqual([{id:"shared"}]);
    expect(after.prepare("SELECT id FROM events").all()).toEqual([{id:"two"}]);
    expect(after.prepare("SELECT * FROM sync_state").all()).toEqual([{server_url:"other",last_synced_event_id:"two"}]);
    expect(after.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }finally{after.close();}
  expect(existsSync(runtime)).toBe(false);expect(readFileSync(join(w.path,"source.ts"),"utf8")).toBe("keep");
  expect(readFileSync(join(w.path,".adit","project.json"),"utf8")).toBe("identity");
});
it("refuses a runtime junction before deleting any outside file",()=>{
  const {w,runtime}=setup();rmSync(runtime,{recursive:true,force:true});
  const outside=join(root,"outside");mkdirSync(outside);writeFileSync(join(outside,"keep"),"keep");
  symlinkSync(outside,runtime,process.platform==="win32"?"junction":"dir");
  expect(()=>cleanupProjectFiles(store,w)).toThrow("symbolic links");
  expect(readFileSync(join(outside,"keep"),"utf8")).toBe("keep");
});
