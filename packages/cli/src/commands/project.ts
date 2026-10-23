import { resolveLocalProject } from "@varveai/adit-core";
import { localRequest } from "./local-api.js";
import { cleanupLegacyHooks } from "./legacy-hook-cleanup.js";
export async function projectUninstallCommand(opts?:{yes?:boolean;json?:boolean}):Promise<void>{try{
 const project=resolveLocalProject();const path=`/workspaces/${encodeURIComponent(project.projectId)}`;
 const workspace=await localRequest(path);const preview=await localRequest(path+"/deletion-preview");
 if(!opts?.yes){console.log(JSON.stringify({projectId:project.projectId,preview,message:"Removes this project's local ADIT data only. Cloud data is retained. Run adit uninstall --yes to confirm."},null,2));process.exitCode=1;return;}
 const cleanup=cleanupLegacyHooks(project.projectRoot);if(cleanup.errors.length)throw new Error(cleanup.errors.join("; "));
 await localRequest(path,"DELETE",{version:workspace.version});console.log(JSON.stringify({ok:true,projectId:project.projectId,cloudDeleted:false}));
}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}}
