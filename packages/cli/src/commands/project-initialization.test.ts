import { it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "@varveai/adit-core";
import { loadInitializedProjectConfig } from "./project-initialization.js";
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();process.exitCode=0;});
it("requires explicit registration and ignores legacy path overrides after registration",()=>{
 const root=mkdtempSync(join(tmpdir(),"adit-guard-native-")),repo=join(root,"repo");mkdirSync(repo);
 vi.stubEnv("ADIT_LOCAL_DATA_DIR",join(root,"state"));vi.stubEnv("ADIT_DB_PATH",join(root,"forbidden.sqlite"));
 vi.spyOn(console,"error").mockImplementation(()=>{});const store=new LocalStore();
 try{expect(loadInitializedProjectConfig("status",repo)).toBeNull();const w=store.saveWorkspace({path:repo});
 mkdirSync(join(repo,".adit"));writeFileSync(join(repo,".adit","project.json"),"damaged old file");
 expect(loadInitializedProjectConfig("status",repo)).toMatchObject({projectId:w.id,dbPath:store.dbPath,captureEnv:false});
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
