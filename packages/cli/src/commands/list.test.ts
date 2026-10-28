import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalStore } from "@varveai/adit-core";
import { createHistorySchema } from "../../../core/src/local-history/schema.js";
import { StructuredHistory } from "../../../core/src/local-history/structured-store.js";
import { listCommand } from "./list.js";
import { searchCommand } from "./search.js";
import { showCommand } from "./show.js";
import { exportSessionCommand } from "./export.js";
import { promptCommand } from "./diff.js";
let root:string,repo:string,store:LocalStore,history:StructuredHistory,log:ReturnType<typeof vi.spyOn>;
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),"adit-native-commands-"));repo=join(root,"repo");mkdirSync(repo);vi.stubEnv("ADIT_LOCAL_DATA_DIR",join(root,"state"));vi.spyOn(process,"cwd").mockReturnValue(repo);
 store=new LocalStore();createHistorySchema(store.db);store.saveWorkspace({path:repo,providers:["codex","claude"]});history=new StructuredHistory(store.db);
 log=vi.spyOn(console,"log").mockImplementation(()=>{});vi.spyOn(console,"error").mockImplementation(()=>{});vi.stubGlobal("fetch",vi.fn(()=>{throw new Error("No Cloud calls allowed");}));process.exitCode=0;
});
afterEach(()=>{store.close();vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();process.exitCode=0;rmSync(root,{recursive:true,force:true});});
it("lists, searches and reads exact native turns without old DB or Cloud access",async()=>{
 history.write({provider:"codex",id:"native",cwd:repo,messages:[{key:"p",role:"user",content:"team model plan",raw:{}},{key:"a",role:"assistant",content:"implemented plan",raw:{},finalReply:true}]});
 await listCommand();expect(JSON.parse(String(log.mock.calls.at(-1)![0])).items[0].id).toBe("native");
 await searchCommand("team model");expect(JSON.parse(String(log.mock.calls.at(-1)![0])).total).toBe(1);
 await showCommand("native");const shown=JSON.parse(String(log.mock.calls.at(-1)![0]));const turn=shown.turns[0];expect(turn.prompt).toBe("team model plan");
 await promptCommand(turn.id);expect(JSON.parse(String(log.mock.calls.at(-1)![0])).prompt).toBe("team model plan");
 await showCommand("legacy-event-id");expect(process.exitCode).toBe(1);expect(existsSync(join(repo,".adit"))).toBe(false);expect(fetch).not.toHaveBeenCalled();
});
it("exports all pages and complete long replies, retaining unanswered turns",async()=>{
 const long="A development explanation. ".repeat(2000);
 const messages=Array.from({length:10},(_,i)=>[{key:`p${i}`,role:"user",content:`question ${i}`,raw:{}},{key:`a${i}`,role:"assistant",content:i===0?long:`answer ${i}`,raw:{},finalReply:true}]).flat();messages.push({key:"last",role:"user",content:"unfinished question",raw:{}});
 history.write({provider:"codex",id:"native",cwd:repo,messages});const output=join(root,"export.json");await exportSessionCommand("native",{output});
 expect(process.exitCode).toBe(0);const result=JSON.parse(readFileSync(output,"utf8"));expect(result.turns).toHaveLength(11);expect(result.turns[0].events[0].text).toBe(long);expect(result.turns[10].prompt).toBe("unfinished question");
 expect(existsSync(join(repo,".adit"))).toBe(false);expect(fetch).not.toHaveBeenCalled();
});
