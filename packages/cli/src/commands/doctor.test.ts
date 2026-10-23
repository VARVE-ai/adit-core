import { it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "@varveai/adit-core";
import { doctorCommand } from "./doctor.js";
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();process.exitCode=0;});
it("diagnoses shared storage and cleans old hooks without installing replacements",async()=>{
 const root=mkdtempSync(join(tmpdir(),"adit-doctor-native-")),repo=join(root,"repo");mkdirSync(join(repo,".git"),{recursive:true});
 vi.stubEnv("ADIT_LOCAL_DATA_DIR",join(root,"state"));vi.spyOn(process,"cwd").mockReturnValue(repo);
 const store=new LocalStore();store.saveWorkspace({path:repo,providers:["codex"]});store.close();
 mkdirSync(join(repo,".codex"));const file=join(repo,".codex","hooks.json");writeFileSync(file,JSON.stringify({hooks:{Stop:[{command:"adit-hook stop"},{command:"user-hook"}]}}));
 const log=vi.spyOn(console,"log").mockImplementation(()=>{});
 try{await doctorCommand({fix:true});expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({git:{available:true},legacyHooks:{cleaned:true,errors:[]}});expect(readFileSync(file,"utf8")).not.toContain("adit-hook");expect(readFileSync(file,"utf8")).toContain("user-hook");expect(existsSync(join(repo,".adit"))).toBe(false);}finally{rmSync(root,{recursive:true,force:true});}
});
