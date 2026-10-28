import { it, expect, vi, beforeEach, afterEach } from "vitest";
const mocks=vi.hoisted(()=>({request:vi.fn(),project:vi.fn()}));
vi.mock("./local-api.js",()=>({localRequest:mocks.request}));
vi.mock("./legacy-hook-cleanup.js",()=>({cleanupLegacyHooks:()=>({errors:[],changed:[]})}));
vi.mock("@varveai/adit-core",async()=>({...await import("../../../core/src/index.js"),resolveLocalProject:mocks.project}));
import { projectUninstallCommand } from "./project.js";
beforeEach(()=>{process.exitCode=0;vi.clearAllMocks();vi.spyOn(console,"log").mockImplementation(()=>{});mocks.project.mockReturnValue({projectId:"one",projectRoot:"/fixture"});});
afterEach(()=>{vi.restoreAllMocks();process.exitCode=0;});
it("uses the authenticated shared deletion preview and version guard",async()=>{
 mocks.request.mockImplementation(async(path:string,method?:string)=>path.endsWith("deletion-preview")?{sessions:2}:method==="DELETE"?{ok:true}:{id:"one",version:7});
 await projectUninstallCommand({yes:true});expect(mocks.request).toHaveBeenCalledWith("/workspaces/one/deletion-preview");expect(mocks.request).toHaveBeenCalledWith("/workspaces/one","DELETE",{version:7});
});
it("does not delete without explicit confirmation",async()=>{mocks.request.mockResolvedValue({id:"one",version:7});await projectUninstallCommand({});expect(mocks.request.mock.calls.some(c=>c[1]==="DELETE")).toBe(false);});
