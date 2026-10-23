import { resolveLocalProject, LocalStateError, findGitRoot } from "@varveai/adit-core";
import { cleanupLegacyHooks } from "./legacy-hook-cleanup.js";
function cleanupRoot(): string {
  try { return resolveLocalProject().projectRoot; }
  catch (error) { if (!(error instanceof LocalStateError) || error.status !== 404) throw error; }
  return findGitRoot(process.cwd()) ?? process.cwd();
}
function retired(){console.error("Collection hooks are retired. Run adit init, then organize native history in adit server. Cloud Agent relay hooks are managed by their launch commands.");process.exitCode=1;}
export async function pluginInstallCommand(_platform?:string,_opts?:{json?:boolean}):Promise<void>{retired();}
export async function pluginUninstallCommand(_platform?:string,opts?:{json?:boolean;all?:boolean;clean?:boolean}):Promise<void>{
 if(opts?.clean){console.error("--clean is retired. Use adit uninstall for project-scoped local data deletion.");process.exitCode=1;return;}
 try{console.log(JSON.stringify(cleanupLegacyHooks(cleanupRoot())));}catch(error){console.error(String(error));process.exitCode=1;}
}
export async function pluginListCommand(_opts?:{json?:boolean}):Promise<void>{try{console.log(JSON.stringify(cleanupLegacyHooks(cleanupRoot(),true)));}catch(error){console.error(String(error));process.exitCode=1;}}
export async function pluginValidateCommand(_platform?:string,opts?:{json?:boolean}):Promise<void>{await pluginListCommand(opts);}
export async function uninstallInstalledPlatformHooks(projectRoot:string){const result=cleanupLegacyHooks(projectRoot);return {uninstalled:result.changed,errors:result.errors};}
