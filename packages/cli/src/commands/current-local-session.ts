import Database from "better-sqlite3";
import { join } from "node:path";
import { analyticsSessions, localDataDir, resolveLocalProject, LocalStateError, type LocalWorkspace, type LocalStore } from "@varveai/adit-core";
import { CloudApiError, loadCredentials } from "@varveai/adit-cloud";
import { syncKey, type CloudBaseline } from "../local/cloud-projection.js";
import { cloudPending } from "../local/cloud-pending.js";
import type { CurrentSessionDeps, CurrentSessionReport } from "./cloud-history.js";

/** Read-only adapter for the native-history store. Never initializes the old .adit DB. */
export async function currentLocalSession(deps: CurrentSessionDeps, platformSessionId: string | null, platform: string | null, directory=localDataDir()): Promise<CurrentSessionReport | undefined> {
  const base:CurrentSessionReport={state:"notRecorded",platformSessionId,platform,inferred:false,project:null,session:null,local:null,cloud:null,candidates:[],hint:"No session has been collected in this project yet. Organize it in ADIT Local."};
  let project;
  try { project=resolveLocalProject({path:deps.cwd,directory}); }
  catch(error) {
    if(error instanceof LocalStateError && error.status===404)return {...base,state:"notInitialized",hint:error.message};
    throw error;
  }
  if(project.source!=="registry")return undefined;
  base.project={id:project.projectId,root:project.projectRoot};
  const db=new Database(join(directory,"local.sqlite"),{readonly:true,fileMustExist:true});
  let cloudId:string|null=null;
  try {
    const has=(table:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if(!has("adit_history_sessions"))return base;
    const row=db.prepare("SELECT data FROM adit_local_workspaces WHERE id=?").get(project.projectId) as {data:string};
    const workspace=JSON.parse(row.data) as LocalWorkspace;
    const physical=analyticsSessions(db,workspace).filter(s=>s.relationship!=="subagent");
    const sessions=[...new Map(physical.map(s=>{const members=physical.filter(p=>p.provider===s.provider&&p.conversation_id===s.conversation_id);
      const first=members.find(p=>p.id===s.conversation_id)||s;
      return [`${s.provider}\0${s.conversation_id}`,{...first,last_activity_at:Math.max(...members.map(p=>p.last_activity_at??0))||null}] as const;
    })).values()].sort((a,b)=>(b.last_activity_at??b.started_at??0)-(a.last_activity_at??a.started_at??0)||a.id.localeCompare(b.id));
    const credentials=loadCredentials(directory);
    const scope=credentials?.accountId && credentials.serverUrl===deps.serverUrl ? syncKey(deps.serverUrl,credentials.accountId,workspace.id) : null;
    const mapping=(s:typeof sessions[number])=>scope&&has("adit_local_cloud_sessions")?(db.prepare("SELECT cloud_id FROM adit_local_cloud_sessions WHERE scope=? AND provider=? AND native_id=?").get(scope,s.provider,s.id) as {cloud_id:string}|undefined)?.cloud_id??null:null;
    const describe=(s:typeof sessions[number])=>({id:mapping(s)||s.id,nativeId:s.id,cloudId:mapping(s),platform:s.provider,startedAt:s.started_at===null?"":new Date(s.started_at).toISOString(),lastEventAt:s.last_activity_at===null?null:new Date(s.last_activity_at).toISOString()});
    const matches=platformSessionId?sessions.filter(s=>(!platform||s.provider===platform||platform==="claude-code"&&s.provider==="claude")&&(s.id===platformSessionId||mapping(s)===platformSessionId||physical.some(p=>p.provider===s.provider&&p.conversation_id===s.id&&p.id===platformSessionId))):[];
    const recent=sessions.filter(s=>(s.last_activity_at??s.started_at??0)>=(deps.now?.getTime()??Date.now())-86400000);
    base.candidates=(platformSessionId&&matches.length?matches:recent.length?recent:sessions.slice(0,1)).slice(0,5).map(describe);
    if(matches.length>1||!platformSessionId&&recent.length>1)return {...base,state:"ambiguous",hint:"Several collected sessions match. Select the session by ID."};
    const selected=platformSessionId?matches[0]:recent[0]??sessions[0];
    if(!selected)return {...base,hint:"The current session has not been collected in this project. Run local collection, then retry."};
    base.state="resolved";base.session=describe(selected);base.inferred=!platformSessionId;cloudId=base.session.cloudId!;
    const saved=scope&&has("adit_local_cloud_scopes")?db.prepare("SELECT baseline FROM adit_local_cloud_scopes WHERE id=?").get(scope) as {baseline:string}|undefined:undefined;
    const pending=saved?cloudPending({db} as LocalStore,workspace,scope!,JSON.parse(saved.baseline) as CloudBaseline):undefined;
    const last=scope&&has("adit_local_cloud_receipts")?db.prepare("SELECT max(confirmed_at) at FROM adit_local_cloud_receipts WHERE scope=?").get(scope) as {at:number|null}:undefined;
    base.local={unsyncedEvents:null,pendingSessions:pending?.sessions??null,lastSyncedAt:last?.at?new Date(last.at).toISOString():null};
    base.hint=base.inferred?"No session ID came from the environment; this is the latest collected session in the project.":"";
  } finally {db.close();}
  base.cloud={status:deps.cloud?(cloudId?"ready":"notSynced"):"skipped",analysis:null,title:null,error:null};
  if(deps.cloud&&cloudId)try {
    const detail=await deps.cloud(cloudId);
    base.cloud={status:"ready",analysis:detail.session.analysis,title:detail.session.title,error:null};
  } catch(error) {
    base.cloud={status:error instanceof CloudApiError&&error.status===404?"notSynced":"unreachable",analysis:null,title:null,error:error instanceof Error?error.message:String(error)};
  }
  if(!cloudId)base.hint+=" This session has no Cloud mapping yet. Run 'adit cloud sync' in this project before using Cloud session links.";
  return base;
}
