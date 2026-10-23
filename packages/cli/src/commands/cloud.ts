import { LocalStore, resolveLocalProject, localLoginStartupEnabled } from "@varveai/adit-core";
import { clearSyncErrors } from "@varveai/adit-cloud";
import { LocalAccount } from "../local/account.js";
import { localRequest } from "./local-api.js";
import { daemonStatus } from "../local/daemon.js";
import type { LocalCloudJob } from "../local/cloud-sync.js";

function fail(error: unknown, json=false) { const message=error instanceof Error?error.message:String(error);if(json)console.log(JSON.stringify({ok:false,error:message}));else console.error(message);process.exitCode=1; }
export async function cloudLoginCommand(opts?: {server?:string;embedded?:boolean}): Promise<void> {
  const account=new LocalAccount();
  const cancel=()=>account.cancel();process.once("SIGINT",cancel);
  try {
    const attempt=await account.login(opts?.server);
    if(attempt?.status==="failed")throw new Error(attempt.error);
    console.log(`Open: ${attempt?.verificationUrl}\nCode: ${attempt?.userCode}`);
    while(account.status().attempt?.status==="pending")await new Promise(r=>setTimeout(r,250));
    const result=account.status();
    if(result.attempt?.status!=="done")throw new Error(result.attempt?.error||"Login cancelled");
    clearSyncErrors();console.log(`Logged in: ${result.account||"Cloud account"} (${result.server}). Saved encrypted in local.sqlite.`);
  } catch(error){fail(error);} finally{process.removeListener("SIGINT",cancel);account.cancel();}
}
export async function cloudAuthTokenCommand(token:string,opts?:{server?:string}):Promise<void>{
  try{const result=await new LocalAccount().loginWithToken(token,opts?.server);clearSyncErrors();console.log(`Logged in: ${result.account||"Cloud account"} (${result.server}). Saved encrypted in local.sqlite.`);}catch(error){fail(error);}
}
export async function cloudLogoutCommand():Promise<void>{try{await new LocalAccount().logout();console.log("Logged out. Confirmed upload history and project settings are preserved.");}catch(error){fail(error);}}
export async function cloudResetCredentialsCommand(opts?:{yes?:boolean}):Promise<void>{
  if(!opts?.yes){console.log("Run adit cloud auth reset --yes to clear the current Cloud login. Local history and confirmed upload boundaries are preserved.");process.exitCode=1;return;}
  await cloudLogoutCommand();
}
export async function cloudSyncCommand(opts?:{json?:boolean}):Promise<void>{
  try{
    const project=resolveLocalProject();
    const endpoint=`/workspaces/${encodeURIComponent(project.projectId)}/sync`;
    let job=await localRequest<LocalCloudJob>(endpoint,"POST",{});
    if(!opts?.json)console.log("Collecting new history and syncing to Cloud...");
    while(["queued","running"].includes(job.status)){await new Promise(r=>setTimeout(r,1000));job=await localRequest<LocalCloudJob>(endpoint);}
    console.log(opts?.json?JSON.stringify(job):`Cloud sync ${job.status}: ${job.events} events, ${job.commits} commits.`);
    if(job.error)console.error(job.error);
    if(job.status!=="done")process.exitCode=1;
  }catch(error){fail(error,opts?.json);}
}
export async function cloudStatusCommand(opts?:{json?:boolean}):Promise<void>{
  const store=new LocalStore();
  try{
    const account=new LocalAccount().status();
    let workspace;try{workspace=store.workspace(resolveLocalProject().projectId);}catch{}
    const daemon=await daemonStatus();
    const result={account,projectId:workspace?.id,enabled:workspace?.cloud.enabled??false,
      autoSync:!!workspace?.cloud.enabled&&workspace.cloud.mode==="automatic"&&localLoginStartupEnabled(store.directory),
      backgroundRunning:!!daemon,...(daemon&&workspace?{sync:await localRequest(`/workspaces/${encodeURIComponent(workspace.id)}/sync`)}:{})};
    console.log(JSON.stringify(result,null,opts?.json?undefined:2));
  }catch(error){fail(error,opts?.json);}finally{store.close();}
}
