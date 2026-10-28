import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { LocalStore, loadConfig, writeProjectManifest, projectUploadRepositories } from "@varveai/adit-core";
import { applyProjectDeletionPolicy } from "./project-deletion-policy.js";
let root:string,repo:string,store:LocalStore;
const policy={localProjectId:"old",projectDeleted:false,deletionOperationId:null,deletedAt:null,deletedRepositories:[{deletionOperationId:"remove-api",localRepositoryId:"api-id",relativePath:"api",deletedAt:"2026-10-01"}]};
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"adit-policy-registry-"));repo=join(root,"repo");mkdirSync(join(repo,"api"),{recursive:true});mkdirSync(join(repo,"web"));vi.stubEnv("ADIT_LOCAL_DATA_DIR",join(root,"state"));store=new LocalStore();writeProjectManifest(repo,{schemaVersion:3,projectId:"old",repositories:[{relativePath:"api",repositoryId:"api-id"},{relativePath:"web",repositoryId:"web-id"}],createdAt:"2026-01-01",updatedAt:"2026-01-01"});store.saveWorkspace({path:repo,repositories:[join(repo,"api"),join(repo,"web")]});});
afterEach(()=>{store.close();vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});
it("stores tombstones globally, retains local history selection and preserves old files",async()=>{
 const before=readFileSync(join(repo,".adit","project.json"),"utf8");await applyProjectDeletionPolicy(repo,policy);const w=store.workspace("old");
 expect(w.repositoryPolicies?.api.cloudDeletionOperationId).toBe("remove-api");expect(projectUploadRepositories(store.db,w).map(r=>r.relativePath)).toEqual(["web"]);expect(loadConfig(repo).repositories).toHaveLength(2);
 expect(readFileSync(join(repo,".adit","project.json"),"utf8")).toBe(before);await applyProjectDeletionPolicy(repo,policy);expect(store.workspace("old").version).toBe(w.version);
});
it("does not apply another project or repository identity's deletion",async()=>{
 await expect(applyProjectDeletionPolicy(repo,{...policy,localProjectId:"other"})).rejects.toThrow(/does not match/);
 await applyProjectDeletionPolicy(repo,{...policy,deletedRepositories:[{...policy.deletedRepositories[0],localRepositoryId:"older-repository"}]});
 expect(projectUploadRepositories(store.db,store.workspace("old"))).toHaveLength(2);
});
it("blocks whole-project uploads while retaining local repositories",async()=>{
 await applyProjectDeletionPolicy(repo,{...policy,projectDeleted:true,deletedAt:"2026-10-02"});expect(loadConfig(repo).cloudDeletedAt).toBe("2026-10-02");expect(projectUploadRepositories(store.db,store.workspace("old"))).toEqual([]);expect(loadConfig(repo).repositories).toHaveLength(2);
});
