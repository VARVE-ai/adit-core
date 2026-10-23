import { afterEach, expect, it, vi } from "vitest";
import { repositoryChoices, sourceChoices, waitForInitJob } from "./init-discovery.js";
import { localRequest } from "./local-api.js";
import type { CollectionJob, Provider } from "../local/collector.js";
vi.mock("./local-api.js",()=>({localRequest:vi.fn()}));
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.clearAllMocks();});
it("uses project metadata counts, preserves existing selections and labels pending or disabled sources",()=>{
 const providers=["empty","pending","found","disabled"].map(id=>({id,name:id,enabled:id!=="disabled",supported:true})) as Provider[];
 const job={providers:{found:7,disabled:8},pending:{pending:1}} as unknown as CollectionJob;
 const choices=sourceChoices(providers,job);
 expect(choices.filter(c=>c.checked).map(c=>c.id)).toEqual(["found"]);
 expect(choices.find(c=>c.id==="pending")).toMatchObject({checked:false,detail:expect.stringContaining("directory will be confirmed")});
 expect(choices.find(c=>c.id==="disabled")).toMatchObject({disabled:true,checked:false});
 expect(sourceChoices(providers,job,{providers:["empty"]} as any).filter(c=>c.checked).map(c=>c.id)).toEqual(["empty"]);
 const repos=repositoryChoices("/project",[{path:"/project",count:2},{path:"/project/no-email",count:null,skipReason:"missing-git-email"}]);
 expect(repos.map(c=>c.checked)).toEqual([true,false]);expect(repos[1].detail).toContain("will be skipped");
});
it("polls one saved background job through completion without querying page state or launching a second collection",async()=>{
 vi.useFakeTimers();vi.spyOn(console,"log").mockImplementation(()=>{});
 const job={id:"job",kind:"collect",workspaceId:"workspace",status:"queued"} as CollectionJob;
 vi.mocked(localRequest).mockResolvedValueOnce({...job,status:"running",phase:"analysis"}).mockResolvedValueOnce({...job,status:"done"});
 const result=waitForInitJob(job);await vi.runAllTimersAsync();expect((await result).status).toBe("done");
 expect(vi.mocked(localRequest).mock.calls).toEqual([["/jobs/job"],["/jobs/job"]]);
});
it("reports interruption instead of displaying organizing complete",async()=>{
 vi.spyOn(console,"log").mockImplementation(()=>{});
 await expect(waitForInitJob({id:"job",kind:"collect",status:"interrupted",error:"Settings changed"} as CollectionJob)).rejects.toThrow("Settings changed");
 expect(console.log).not.toHaveBeenCalledWith("Organizing complete.");
});
