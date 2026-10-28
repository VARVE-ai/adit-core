import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalStore, loadConfig, writeProjectManifest } from "@varveai/adit-core";
import { resolveCloudProjectContext } from "./project-context.js";
vi.mock("@varveai/adit-engine",()=>({getRemoteUrl:vi.fn(async()=>"https://github.com/test/repo.git")}));
let root:string,store:LocalStore;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"adit-link-registry-"));vi.stubEnv("ADIT_LOCAL_DATA_DIR",join(root,"state"));store=new LocalStore();});
afterEach(()=>{store.close();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});
it("refreshes shared selection, preserves excluded identities, and never rereads old manifests",async()=>{
 const repo=join(root,"repo");mkdirSync(join(repo,"api"),{recursive:true});mkdirSync(join(repo,"web"));
 writeProjectManifest(repo,{schemaVersion:3,projectId:"original",repositories:[{relativePath:"api",repositoryId:"original-api"},{relativePath:"web",repositoryId:"original-web"}],createdAt:"2026-01-01",updatedAt:"2026-01-01"});
 const w=store.saveWorkspace({path:repo,repositories:[join(repo,"api"),join(repo,"web")]});const config=loadConfig(repo);
 store.saveWorkspace({version:w.version,repositories:[join(repo,"web")]},w.id);writeFileSync(join(repo,".adit","project.json"),"broken old manifest");
 const result=await resolveCloudProjectContext(config);
 expect(result).toMatchObject({localProjectId:"original",remoteUrl:null,canonicalRepoKey:null});
 expect(result.repositories).toMatchObject([{localRepositoryId:"original-web",canonicalRepoKey:"github:test/repo"}]);
 expect(result.registration?.repositories).toEqual(expect.arrayContaining([expect.objectContaining({localRepositoryId:"original-api",included:false}),expect.objectContaining({localRepositoryId:"original-web",included:true})]));
});
it("does not silently register an unadopted or merged old project",()=>{
 const repo=join(root,"repo");mkdirSync(repo);writeProjectManifest(repo,{schemaVersion:3,projectId:"old",mergedIntoProjectId:"parent",repositories:[{relativePath:"."}],createdAt:"2026-01-01",updatedAt:"2026-01-01"});
 expect(()=>loadConfig(repo)).toThrow(/adit init/);expect(()=>store.saveWorkspace({path:repo})).toThrow(/parent/);expect(store.workspaces()).toEqual([]);
});
