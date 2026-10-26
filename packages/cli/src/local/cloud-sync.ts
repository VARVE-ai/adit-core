import { assertWorkspaceGit } from "@varveai/adit-core";
import { randomUUID } from "node:crypto";
import { LocalStore, LocalStateError, localLoginStartupEnabled, projectUploadRepositories } from "@varveai/adit-core";
import { CloudClient, loadCredentials, collectDefaultBranch, collectRemoteBranchSnapshot, type UpgradeNotice } from "@varveai/adit-cloud";
import { CloudProjection, createCloudSyncSchema, syncKey, type CloudBaseline, type CloudEvent, type CloudSession } from "./cloud-projection.js";
import type { Collector } from "./collector.js";
import { getRemoteUrl, runGit } from "@varveai/adit-engine";
import { cloudPending, type CloudPending } from "./cloud-pending.js";
import { sendLocalRuntimeReport } from "./cloud-runtime-report.js";
import { localCommitBranches, type CommitBranch } from "./commit-branches.js";

export interface LocalCloudJob {
  id:string; workspaceId:string; kind:"cloud-sync"; status:"queued"|"running"|"done"|"partial"|"failed";
  startedAt:string; endedAt?:string; events:number; commits:number; error?:string; warnings:string[];
  serverProjectId?:string;
  upgrade?:UpgradeNotice; runtimeReportError?:string;
}
type Transport = Pick<CloudClient,"get"|"post">;

export class LocalCloudSync {
  private active=new Map<string,Promise<void>>();
  private jobs=new Map<string,LocalCloudJob>();
  private pendingCache=new Map<string,{key:string;value:CloudPending}>();
  private stopped=false;
  private timer?:ReturnType<typeof setInterval>;
  constructor(readonly store:LocalStore,private collector:Pick<Collector,"collect"|"waitFor">,
    private transport?: (credentials:NonNullable<ReturnType<typeof loadCredentials>>)=>Transport) {
    createCloudSyncSchema(store);
    for(const job of store.jobs<LocalCloudJob>()) if(job.kind==="cloud-sync" && ["queued","running"].includes(job.status))
      store.job({...job,status:"failed",endedAt:new Date().toISOString(),error:"Sync was interrupted. Retry to continue from confirmed records."});
    for(const row of store.db.prepare("SELECT key,data FROM adit_local_settings WHERE key LIKE 'cloud-job:%'").all() as {key:string;data:string}[]) {
      const job=JSON.parse(row.data) as LocalCloudJob;
      if(["queued","running"].includes(job.status))store.set(row.key,{...job,status:"failed",endedAt:new Date().toISOString(),error:"Sync was interrupted. Retry to continue from confirmed records."});
    }
  }
  statuses() {
    const credentials=loadCredentials(this.store.directory);
    return new Map(this.store.workspaces().map(w=>[w.id,this.status(w.id,credentials)]));
  }
  forget(id:string) {
    if(this.active.has(id))throw new LocalStateError("Wait for this project's background tasks to finish before deleting it.",409);
    this.jobs.delete(id);this.pendingCache.delete(id);
  }
  status(id:string,credentials=loadCredentials(this.store.directory)) {
    const accountKey=credentials?syncKey(credentials.serverUrl,credentials.accountId??credentials.clientId):"disconnected";
    const saved=this.store.get<LocalCloudJob|null>(`cloud-job:${accountKey}:${id}`,null);
    const workspace=this.store.workspace(id);
    return {...saved,pending:this.pending(workspace,credentials),nextAt:workspace.cloud.enabled&&workspace.cloud.mode==="automatic"&&localLoginStartupEnabled(this.store.directory)
      ?new Date((saved?Date.parse(saved.startedAt):Date.now())+workspace.cloud.interval*60_000).toISOString():null};
  }
  private pending(workspace:ReturnType<LocalStore["workspace"]>,credentials:ReturnType<typeof loadCredentials>):CloudPending {
    if(!workspace.cloud.enabled)return {state:"disabled",sessions:null,commits:null};
    if(!credentials)return {state:"disconnected",sessions:null,commits:null};
    if(!credentials.accountId)return {state:"uninitialized",sessions:null,commits:null};
    const scope=syncKey(credentials.serverUrl,credentials.accountId,workspace.id);
    // data_version covers collection-worker writes; total_changes covers receipts / edits on this connection.
    const key=JSON.stringify([scope,workspace.version,this.store.db.pragma("data_version",{simple:true}),
      (this.store.db.prepare("SELECT total_changes() n").get() as {n:number}).n]);
    const cached=this.pendingCache.get(workspace.id);
    if(cached?.key===key)return cached.value;
    const row=this.store.db.prepare("SELECT baseline FROM adit_local_cloud_scopes WHERE id=?").get(scope) as {baseline:string}|undefined;
    const value:CloudPending=row?cloudPending(this.store,workspace,scope,JSON.parse(row.baseline))
      :{state:"uninitialized",sessions:null,commits:null};
    this.pendingCache.set(workspace.id,{key,value});
    return value;
  }
  start(id:string):LocalCloudJob {
    if(this.stopped)throw new LocalStateError("Cloud sync is stopping",409);
    const workspace=this.store.workspace(id);
    assertWorkspaceGit(workspace.path);
    if(workspace.cloudDeletedAt)throw new LocalStateError("This project was deleted from Cloud. Review its identity in Settings.",409);
    if(!workspace.cloud.enabled)throw new LocalStateError("Enable Cloud storage for this directory first.",409);
    if(this.active.has(id))return this.jobs.get(id)!;
    const credentials=loadCredentials(this.store.directory);
    if(!credentials)throw new LocalStateError("Connect a Cloud account first.",401);
    const job:LocalCloudJob={id:randomUUID(),workspaceId:id,kind:"cloud-sync",status:"queued",startedAt:new Date().toISOString(),events:0,commits:0,warnings:[]};
    const accountKey=syncKey(credentials.serverUrl,credentials.accountId??credentials.clientId);
    const save=()=>{this.store.job(job);this.store.set(`cloud-job:${accountKey}:${id}`,job);};
    this.jobs.set(id,job);save();
    const client=this.transport?.(credentials)??new CloudClient(credentials.serverUrl,credentials,{credentialsDirectory:this.store.directory,timeoutMs:30000,maxRetries:1});
    const unchanged=()=>{
      const current=loadCredentials(this.store.directory);
      if(this.stopped||current?.credentialId!==credentials.credentialId||current?.serverUrl!==credentials.serverUrl||this.store.workspace(id).version!==workspace.version)
        throw new LocalStateError("Account or directory settings changed. Retry to continue safely.",409);
    };
    const task=Promise.resolve().then(async()=>{
      try {
        job.status="running";save();
        // Every entry point uses the same incremental collection and local analysis first.
        this.collector.collect(id);
        await this.collector.waitFor(id);
        const collected=this.store.jobs<{workspaceId:string;kind:string;status:string;error?:string}>().find(j=>j.workspaceId===id&&j.kind==="collect");
        if(collected?.status==="partial")job.warnings.push(collected.error||"Local collection is incomplete; only available records can be synced.");
        unchanged();
        const identity=await client.get<CloudBaseline>(`/api/sync/local?${new URLSearchParams({localProjectId:workspace.id})}`);
        if(identity.schemaVersion!==1||!identity.accountId)throw new Error("This Cloud server does not support local history sync yet.");
        job.serverProjectId=identity.serverProjectId;
        const scope=syncKey(credentials.serverUrl,identity.accountId,workspace.id);
        const found=this.store.db.prepare("SELECT baseline FROM adit_local_cloud_scopes WHERE id=?").get(scope) as {baseline:string}|undefined;
        let baseline:CloudBaseline;
        const cached:CloudBaseline|undefined=found?JSON.parse(found.baseline):undefined;
        const needsSessionBoundaries=!!cached?.sessions.some(session=>session.lastEventAt===undefined);
        if(cached&&!needsSessionBoundaries)baseline=cached;
        else {
          baseline=identity;
          const cursors=new Set<string>();
          while(baseline.nextCursor) {
            unchanged();
            if(cursors.has(baseline.nextCursor))throw new Error("Cloud returned a repeated history cursor");
            cursors.add(baseline.nextCursor);
            const page=await client.get<CloudBaseline>(`/api/sync/local?${new URLSearchParams({localProjectId:workspace.id,cursor:baseline.nextCursor})}`);
            if(page.accountId!==identity.accountId)throw new Error("Cloud account changed during history lookup");
            baseline.sessions.push(...page.sessions);
            if(page.knownCommits)baseline.knownCommits=[...(baseline.knownCommits??[]),...page.knownCommits];
            baseline.nextCursor=page.nextCursor;
          }
          unchanged();
          if(baseline.sessions.some(session=>session.lastEventAt===undefined ||
            session.lastEventAt!==null&&!Number.isFinite(Date.parse(session.lastEventAt))))
            throw new Error("Update the Cloud server before syncing historical sessions: per-session sync boundaries are unavailable.");
          if(cached) {
            baseline={...cached,sessions:cached.sessions.map(session=>{
              const current=baseline.sessions.find(candidate=>candidate.id===session.id);
              if(!current)throw new Error("A historical session is missing from Cloud; its sync boundary could not be verified.");
              const limit=cached.before?Date.parse(cached.before):Infinity;
              return {...session,lastEventAt:current.lastEventAt===null?null:new Date(Math.min(Date.parse(current.lastEventAt!),limit)).toISOString()};
            })};
          }
          this.store.db.transaction(()=>{
            this.store.db.prepare("INSERT INTO adit_local_cloud_scopes VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET baseline=excluded.baseline")
              .run(scope,workspace.id,JSON.stringify(baseline));
            if(needsSessionBoundaries)this.store.db.prepare("UPDATE adit_local_cloud_sessions SET revision=0 WHERE scope=?").run(scope);
          })();
        }
        const projection=new CloudProjection(this.store,workspace,scope,baseline);
        const commitBranches:CommitBranch[]=[];
        for(const repository of projectUploadRepositories(this.store.db,workspace)) {
          try {
            const branches=await localCommitBranches(this.store,repository);
            commitBranches.push(...branches);
            for(const branch of branches)projection.commitBranches.set(`${branch.localRepositoryId}:${branch.sha}`,branch.branch);
          } catch {
            job.warnings.push(`Unable to resolve commit branches for ${repository.relativePath}; existing branch information is preserved.`);
          }
        }
        const repositories=await Promise.all(projectUploadRepositories(this.store.db,workspace).map(async r=>{
          let repositoryUrl=await getRemoteUrl(r.path).catch(()=>null);
          if(repositoryUrl?.includes("://")) { try {const url=new URL(repositoryUrl);url.username="";url.password="";repositoryUrl=url.toString();}catch{repositoryUrl=null;} }
          const checkpoint=this.store.db.prepare("SELECT refs,identity FROM adit_local_git_checkpoints WHERE repository=?").get(r.path) as {refs:string;identity:string}|undefined;
          const branches:{name:string;headSha:string}[]=[];
          if(checkpoint) {
            const [refs]=JSON.parse(checkpoint.refs) as string[];
            for(const line of refs.split("\n")) {
              const match=/^refs\/heads\/(.+) ([a-f0-9]{40,64})$/.exec(line.trim());
              if(match)branches.push({name:match[1],headSha:match[2]});
            }
          }
          const [defaultBranch,authorName]=await Promise.all([
            collectDefaultBranch(r.path).catch(()=>null),
            runGit(["config","user.name"],{cwd:r.path}).then(result=>result.exitCode===0?result.stdout.trim():"").catch(()=>""),
          ]);
          let remoteBranchSnapshot:{branches:{name:string;headSha:string}[]}|undefined;
          if(repositoryUrl) {
            try {
              const snapshot=await collectRemoteBranchSnapshot(r.path);
              remoteBranchSnapshot={branches:snapshot.branches.map(({name,headSha})=>({name,headSha}))};
            } catch {
              job.warnings.push(`Unable to refresh remote branches for ${r.relativePath}; Cloud keeps its previous branch snapshot.`);
            }
          }
          return {localRepositoryId:r.localRepositoryId,relativePath:r.relativePath,displayName:r.displayName??r.relativePath,repositoryUrl:repositoryUrl??null,
            ...(remoteBranchSnapshot?{remoteBranchSnapshot}:{}),
            ...(defaultBranch?{defaultBranch}:{}),...(authorName?{gitAuthorName:authorName}:{}),
            ...(checkpoint?{branches,gitAuthorEmail:checkpoint.identity}: {})};
        }));
        const repositoryKey=syncKey(workspace.name,repositories);
        let registered=projection.receipt("repositories",repositoryKey)&&!repositories.some(r=>r.remoteBranchSnapshot);
        const push=async(sessions:CloudSession[],events:CloudEvent[],commits:Record<string,any>[]=[],branchUpdates:CommitBranch[]=[])=>{
          unchanged();
          const payload={schemaVersion:1,localProjectId:workspace.id,projectName:workspace.name,
            repositories:registered?repositories.map(({branches,remoteBranchSnapshot,gitAuthorEmail,gitAuthorName,defaultBranch,...r})=>r):repositories,sessions,events,commits,
            ...(branchUpdates.length?{commitBranches:branchUpdates}:{})};
          if(Buffer.byteLength(JSON.stringify(payload))>8_000_000)throw new Error("A conversation turn exceeds the Cloud batch limit; it remains pending.");
          const ack=await client.post<{schemaVersion:number;accountId:string;serverProjectId?:string;eventIds:string[];commitIds:string[];commitBranchIds?:string[]}>("/api/sync/local",payload);
          if(ack.schemaVersion!==1||ack.accountId!==identity.accountId||!Array.isArray(ack.eventIds)||!Array.isArray(ack.commitIds))throw new Error("Cloud did not acknowledge the uploaded records");
          const expectedEvents=events.map(e=>e.id),expectedCommits=commits.map(c=>`${c.localRepositoryId}:${c.sha}`);
          if(expectedEvents.some(id=>!ack.eventIds.includes(id))||expectedCommits.some(id=>!ack.commitIds.includes(id)))throw new Error("Cloud did not acknowledge every record; retry to continue.");
          if(branchUpdates.some(branch=>!ack.commitBranchIds?.includes(`${branch.localRepositoryId}:${branch.sha}`)))throw new Error("Cloud did not acknowledge commit branch updates; update Cloud and retry.");
          // Persist only the exact requested and acknowledged identities, never a batch-time cursor.
          projection.confirm("event",expectedEvents);projection.confirm("commit",expectedCommits);
          projection.confirm("commit-branch",branchUpdates.map(branch=>syncKey(branch)));
          projection.confirm("repositories",[repositoryKey]);registered=true;
          job.serverProjectId=ack.serverProjectId;job.events+=events.length;job.commits+=commits.length;save();
        };
        for(const {source,session} of projection.sessions()) {
          for(const events of projection.sessionBatches(source,session!)) await push([session!],events);
        }
        for(const item of projection.commitBatches())await push(item.sessions,item.events,[item.commit]);
        const branchUpdates=commitBranches.filter(branch=>!projection.receipt("commit-branch",syncKey(branch)));
        for(let offset=0;offset<branchUpdates.length;offset+=100)await push([],[],[],branchUpdates.slice(offset,offset+100));
        if(!registered)await push([],[]);
        unchanged();
        Object.assign(job,await sendLocalRuntimeReport(this.store,workspace,credentials));
        job.warnings=[...new Set([...job.warnings,...projection.warnings])];job.status=job.warnings.length?"partial":"done";
      } catch(error) {job.status="failed";job.error=error instanceof Error?error.message:"Cloud sync failed";}
      finally {job.endedAt=new Date().toISOString();save();this.active.delete(id);}
    });
    this.active.set(id,task);return job;
  }
  async wait(id:string) {await this.active.get(id);return this.jobs.get(id);}
  schedule() {
    if(this.timer)return;
    this.timer=setInterval(()=>{
      if(this.stopped||process.env.ADIT_CLOUD_AUTO_SYNC==="false"||process.env.ADIT_CLOUD_ENABLED==="false"||!localLoginStartupEnabled(this.store.directory)||!loadCredentials(this.store.directory))return;
      for(const w of this.store.workspaces())if(w.started&&w.cloud.enabled&&w.cloud.mode==="automatic"&&!this.active.has(w.id)) {
        const status=this.status(w.id);
        if(!status.startedAt||Date.now()-Date.parse(status.startedAt)>=w.cloud.interval*60_000) {
          try{this.start(w.id);}catch{/* Retry on the next scheduled tick after settings/account recovery. */}
        }
      }
    },15000);this.timer.unref();
  }
  async close(){this.stopped=true;clearInterval(this.timer);await Promise.allSettled(this.active.values());}
}
