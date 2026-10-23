import { LocalStore, loadConfig, workspaceGitStatus, analyticsSessions } from "@varveai/adit-core";
import { daemonStatus } from "../local/daemon.js";
export async function statusCommand(_opts?:{json?:boolean}):Promise<void>{
 let store:LocalStore|undefined;
 try{const config=loadConfig();store=new LocalStore();const workspace=store.workspace(config.projectId);
 const hasHistory=!!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='adit_history_sessions'").get();
 console.log(JSON.stringify({projectId:workspace.id,name:workspace.name,path:workspace.path,storage:store.dbPath,git:workspaceGitStatus(workspace.path),started:workspace.started,
 nativeSources:workspace.providers,sessions:hasHistory?analyticsSessions(store.db,workspace).length:0,cloud:workspace.cloud,backgroundRunning:!!await daemonStatus()},null,2));
 }catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}finally{store?.close();}
}
