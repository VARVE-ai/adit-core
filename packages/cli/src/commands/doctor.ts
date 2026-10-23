import { LocalStore,resolveLocalProject,workspaceGitStatus,sourceDefinitions } from "@varveai/adit-core";
import { cleanupLegacyHooks } from "./legacy-hook-cleanup.js";
export async function doctorCommand(opts?:{fix?:boolean;json?:boolean}):Promise<void>{let store:LocalStore|undefined;try{
 const project=resolveLocalProject();store=new LocalStore();const workspace=store.workspace(project.projectId);const git=workspaceGitStatus(workspace.path);
 const cleanup=cleanupLegacyHooks(workspace.path,!opts?.fix);const integrity=store.db.pragma("quick_check(1)");
 const result={projectId:workspace.id,storage:store.dbPath,git,integrity,nativeSources:sourceDefinitions().filter(d=>workspace.providers.includes(d.id)).map(d=>({id:d.id,supported:d.supported})),legacyHooks:{...cleanup,cleaned:!!opts?.fix}};
 console.log(JSON.stringify(result,null,2));if(!git.available||cleanup.errors.length)process.exitCode=1;
}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}finally{store?.close();}}
