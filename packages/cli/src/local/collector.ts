import { assertWorkspaceGit, assertSelectedRepositories, repositoryOriginUrl, workspaceGitStatus } from "@varveai/adit-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import {
  LocalStore,
  LocalStateError,
  canonicalDirectory,
  directoryAvailable,
  directoryUnavailable,
  analyticsSessions,
  LocalHistory,
  sourceDefinitions,
  sourceHomePaths,
  insideDirectory,
  isRetryableCollectionIssue,
  type LocalWorkspace,
  type SourceDefinition,
  type SourceScanProgress,
} from "@varveai/adit-core";
import type { scanHistoryInBackground } from "./collection-scan.js";

const exec = promisify(execFile);
export const localAssets = fileURLToPath(
  new URL("../../local-assets/", import.meta.url),
);
export const inside = insideDirectory;
export interface Provider extends SourceDefinition {
  enabled: boolean;
  homes: string[];
  version: number;
}
export interface Repository {
  path: string;
  count: number | null;
  error?: string;
  deferred?: string;
  skipReason?: "missing-git-email";
}
export interface CollectionJob {
  id: string;
  workspaceId: string;
  kind: "collect" | "discover";
  status: string;
  startedAt: string;
  endedAt?: string;
  progress?: { files: number; updated: number };
  error?: string;
  providers?: Record<string, number>;
  pending?: Record<string, number>;
  warnings?: string[];
  phase?: "git" | "sessions" | "inspection" | "analysis" | "achievements";
  activeRepository?:string;
  sourceProgress?:Record<string,SourceScanProgress>;
  repositoryProgress?:Record<string,{completed:number;total:number|null;matched:number;status:"queued"|"running"|"done"|"skipped"|"partial"}>;
  repositories?: Repository[];
}

const missingGitEmail = "请先为该仓库配置 Git user.email，才能只整理自己的提交";
async function authorEmail(path: string): Promise<string | null> {
  let email = "";
  try {
    const { stdout } = await exec("git", ["-C", path, "config", "--get", "user.email"], { windowsHide: true, timeout: 15000 });
    email = stdout.trim().toLowerCase();
  } catch (error) {
    // git config exits with 1 when the setting is absent. Other command
    // failures must still be reported, not mistaken for missing configuration.
    if ((error as { code?: number }).code !== 1) throw error;
  }
  return email || null;
}

export async function repositories(path: string): Promise<Repository[]> {
  const root = canonicalDirectory(path);
  const paths = [
    root,
    ...readdirSync(root, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith(".") &&
          e.name !== "node_modules",
      )
      .map((e) => join(root, e.name)),
  ];
  const result: Repository[] = [];
  for (const dir of paths) {
    if (!existsSync(join(dir, ".git"))) continue;
    if (!repositoryOriginUrl(dir)) continue;
    try {
      const email = await authorEmail(dir);
      if (!email) {
        result.push({ path: dir, count: null, skipReason: "missing-git-email" });
        continue;
      }
      const { stdout } = await exec(
        "git",
        ["-C", dir, "log", "--all", "--no-merges", "--format=%ae"],
        { windowsHide: true, timeout: 15000, maxBuffer: 32 * 1024 * 1024 },
      );
      result.push({ path: dir, count: stdout.split("\n").filter(value => value.trim().toLowerCase() === email).length });
    } catch {
      result.push({
        path: dir,
        count: null,
        error: "Unable to read Git history",
      });
    }
  }
  return result;
}

export class Collector {
  private queue: Promise<void> = Promise.resolve();
  private pending: CollectionJob[] = [];
  private draining = false;
  private activeJobs = new Map<string, CollectionJob>();
  private timer?: ReturnType<typeof setTimeout>;
  private abort = new AbortController();
  private stopping = false;
  private updatePaused = false;
  get busy() { return this.draining || this.activeJobs.size > 0; }
  pauseForUpdate(paused: boolean) {
    this.updatePaused = paused;
    if (paused) {
      for (const retry of this.retries.values()) clearTimeout(retry.timer);
      this.retries.clear();
    }
    this.schedule();
  }
  private retries = new Map<string, {attempt:number;timer?:ReturnType<typeof setTimeout>}>();
  readonly history: LocalHistory;
  nextAt: string | null = null;

  constructor(readonly store: LocalStore, private analyze?: (workspace:LocalWorkspace,job?:CollectionJob)=>Promise<void>, private evaluateAchievements?: (workspace:LocalWorkspace, sourceErrors:number)=>Promise<void>, private inspect?: (workspace:LocalWorkspace)=>Promise<void>, private backgroundScan?: typeof scanHistoryInBackground) {
    this.history = new LocalHistory(store.db);
    for (const job of store.jobs<CollectionJob>().reverse()) {
      if (!["collect", "discover"].includes(job.kind)) continue;
      // Saved job summaries from the previous build classified missing config
      // as an error. Keep the history, correcting only that classification.
      if (job.repositories?.some(repo => repo.error === missingGitEmail)) {
        for (const repo of job.repositories) if (repo.error === missingGitEmail) {
          delete repo.error;
          repo.skipReason = "missing-git-email";
        }
        job.error = job.error?.split("; ").filter(message => message !== missingGitEmail).join("; ") || undefined;
        if (!job.error && ["partial", "failed"].includes(job.status)) job.status = "done";
        store.job(job);
        if (job.kind === "collect" && job.status === "done" && store.workspaces().some(w => w.id === job.workspaceId)) store.markStarted(job.workspaceId);
      }
      if (["running", "queued"].includes(job.status)) {
        store.job({
          ...job,
          status: "interrupted",
          endedAt: new Date().toISOString(),
        });
      }
      const workspace = job.kind === "collect" ? store.workspaces().find(w => w.id === job.workspaceId) : undefined;
      const path = workspace?.path ?? (job.kind === "discover" ? job.workspaceId : undefined);
      if (path && job.repositories && ["done", "partial", "failed"].includes(job.status))
        this.rememberRepositories(path, job.repositories, job.kind === "discover");
    }
  }

  repositoryInfo(workspace: LocalWorkspace): Repository[] {
    return this.store.get<Repository[]>(this.repositoryInfoKey(workspace.path), []);
  }
  private repositoryInfoKey(path: string): string {
    return `repository-info:${process.platform === "win32" ? path.toLowerCase() : path}`;
  }
  private rememberRepositories(path: string, repositories: Repository[], replace = false): void {
    const key = this.repositoryInfoKey(path);
    const previous = replace ? [] : this.store.get<Repository[]>(key, []);
    this.store.set(key, [...new Map([...previous, ...repositories].map(r => [r.path, r])).values()]);
  }

  async providers(): Promise<Provider[]> {
    return sourceDefinitions().map((def) => {
      const config = this.store.provider(def.id);
      const paths = [
        ...def.paths,
        ...config.homes.flatMap((home) => sourceHomePaths(def.id,home)),
      ];
      return {
        ...def,
        ...config,
        paths: [...new Set(paths)],
        enabled: def.supported && config.enabled,
      };
    });
  }

  async validateProviders(ids: string[]): Promise<void> {
    const providers = await this.providers();
    if (ids.some((id) => !providers.some((p) => p.id === id && p.supported)))
      throw new LocalStateError("Unsupported provider");
  }

  active(id: string, kind: string): CollectionJob | undefined {
    return this.activeJobs.get(`${kind}:${id}`);
  }
  jobs():CollectionJob[] {
    return this.store.jobs<CollectionJob>().map(job=>job.kind==="collect"&&["running","queued"].includes(job.status)
      ? {...job,repositoryProgress:this.repositoryProgress(job)}:job);
  }
  job(id: string): CollectionJob {
    const row = this.store.db.prepare("SELECT data FROM adit_local_jobs WHERE id=?").get(id) as {data:string}|undefined;
    if (!row) throw new LocalStateError("Job not found",404);
    const job = JSON.parse(row.data) as CollectionJob;
    return job.kind === "collect" && ["running","queued"].includes(job.status)
      ? {...job,repositoryProgress:this.repositoryProgress(job)} : job;
  }
  private repositoryProgress(job:CollectionJob):NonNullable<CollectionJob["repositoryProgress"]> {
    const rows=this.store.db.prepare(`SELECT repository,count(*) AS completed,sum(matched) AS matched FROM (
      SELECT c.repository,c.sha,max(c.submit_session_id IS NOT NULL) AS matched
      FROM adit_attribution_commits c JOIN adit_attribution_runs r ON r.id=c.run_id
      JOIN adit_local_commits g ON g.repository=c.repository AND g.sha=c.sha
      WHERE r.workspace_id=? AND r.status IN ('done','running') GROUP BY c.repository,c.sha
    ) GROUP BY repository`).all(job.workspaceId) as {repository:string;completed:number;matched:number}[];
    const result:NonNullable<CollectionJob["repositoryProgress"]>={};
    for(const repo of job.repositories||[]) {
      const row=rows.find(r=>r.repository===repo.path),completed=row?.completed||0,total=repo.count;
      const active=["queued","running"].includes(job.status);
      const status=repo.skipReason?"skipped":repo.error?"partial":active&&job.phase==="git"&&job.activeRepository===repo.path?"running"
        :total!==null&&completed>=total?"done":!active?"partial":job.phase==="analysis"&&job.activeRepository===repo.path?"running":"queued";
      result[repo.path]={completed,total,matched:row?.matched||0,status};
    }
    return result;
  }
  async waitFor(id: string): Promise<void> {
    while (this.active(id, "collect")) await this.queue;
    const job = this.store.jobs<CollectionJob>().find(j => j.workspaceId === id && j.kind === "collect");
    if (job && ["failed", "interrupted"].includes(job.status)) throw new Error(job.error || "Local collection failed");
  }
  discover(path: string): CollectionJob {
    return this.enqueue(canonicalDirectory(path), "discover");
  }
  collect(id: string): CollectionJob {
    const w = this.store.workspace(id);
    if (!directoryAvailable(w.path)) throw new LocalStateError(directoryUnavailable,409);
    assertWorkspaceGit(w.path);
    assertSelectedRepositories(w.path, w.repositories);
    if (!w.providers.length && !w.repositories.length)
      throw new LocalStateError("Select at least one source or repository");
    return this.enqueue(id, "collect");
  }
  collectAll(): CollectionJob[] {
    return this.store.workspaces()
      .filter(w => w.started && workspaceGitStatus(w.path).available && w.repositories.length)
      .map(w => this.collect(w.id));
  }
  private enqueue(id: string, kind: "collect" | "discover"): CollectionJob {
    if (this.updatePaused) throw new LocalStateError("ADIT is updating. Please try again shortly.", 503);
    if (this.stopping) throw new LocalStateError("Collection is stopping", 409);
    const active = this.active(id, kind);
    if (active) return active;
    if(kind==="collect"){
      const retry=this.retries.get(id);
      if(retry){clearTimeout(retry.timer);this.retries.set(id,{attempt:retry.attempt});}
    }
    const job: CollectionJob = {
      id: randomUUID(),
      workspaceId: id,
      kind,
      status: "queued",
      startedAt: new Date().toISOString(),
    };
    if(kind==="collect") {
      const workspace=this.store.workspace(id);
      job.phase="sessions";
      job.sourceProgress=Object.fromEntries(workspace.providers.map(provider=>{
        const enabled=this.store.provider(provider).enabled;
        return [provider,{completed:0,total:enabled?null:0,status:enabled?"queued" as const:"skipped" as const}];
      }));
      job.repositories=workspace.repositories.map(path=>({path,count:null}));
    }
    this.store.job(job);
    this.activeJobs.set(`${kind}:${id}`, job);
    this.pending.push(job);
    if (!this.draining) {
      if(this.timer)clearTimeout(this.timer);
      this.nextAt=null;
      this.draining = true;
      this.queue = this.queue.then(async () => {
        try {
          while (this.pending.length) {
            const jobs = this.pending.splice(0);
            const collect = jobs.filter(j => j.kind === "collect");
            if (collect.length) await this.runBatch(collect);
            for (const discovery of jobs.filter(j => j.kind === "discover")) await this.run(discovery);
          }
        } finally { this.draining = false; this.schedule(); }
      });
    }
    return job;
  }

  private async runBatch(jobs: CollectionJob[]): Promise<void> {
    // Recheck at execution time as directories can disappear after enqueueing.
    jobs = jobs.filter(job => {
      const workspace=this.store.workspace(job.workspaceId);
      let git = workspaceGitStatus(workspace.path);
      try { assertSelectedRepositories(workspace.path,workspace.repositories); }
      catch(error) { git={available:false,error:error instanceof Error?error.message:String(error)}; }
      if (git.available) return true;
      job.status="interrupted"; job.error=git.error; job.endedAt=new Date().toISOString();
      this.store.job(job);this.activeJobs.delete(`collect:${job.workspaceId}`);return false;
    });
    if (!jobs.length) return;
    try {
      this.abort.signal.throwIfAborted();
      const workspaces = jobs.map(job => this.store.workspace(job.workspaceId));
      const providers = (await this.providers()).filter(p => p.enabled && workspaces.some(w => w.providers.includes(p.id)));
      for (const provider of providers) {
        if (["aider", "visualstudio-copilot"].includes(provider.id))
          provider.paths.push(...workspaces.filter(w => w.providers.includes(provider.id)).map(w => provider.id === "aider" ? w.path : join(w.path, ".vs")));
        provider.paths = [...new Set(provider.paths)];
      }
      const unchanged = (id?: string) => {
        this.abort.signal.throwIfAborted();
        for (const workspace of workspaces)
          if (this.store.workspace(workspace.id).version !== workspace.version) throw new Error("Settings changed; retry with the saved selection");
        if (id && this.store.provider(id).version !== providers.find(p => p.id === id)!.version)
          throw new Error("Source settings changed; retry with the saved selection");
      };
      for (const job of jobs) { job.status = "running"; this.store.job(job); }
      let lastProgress=0;
      const result = this.backgroundScan
        ? await this.backgroundScan({directory:this.store.directory,path:workspaces[0].path,workspace:workspaces[0],workspaces,sources:providers,job:jobs[0],jobs},this.abort.signal)
        : await this.history.scan(workspaces[0].path, providers, {
          scopes:workspaces, signal:this.abort.signal, beforeSource:unchanged,
          sourceProgress:(scope,provider,progress)=>{
            for(const job of jobs)if(workspaces.find(w=>w.id===job.workspaceId)?.path===scope){job.sourceProgress ??={};job.sourceProgress[provider]=progress;}
            if(progress.status!=="running"||Date.now()-lastProgress>=250){lastProgress=Date.now();for(const job of jobs)this.store.job(job);}
          },
          progress:(files,updated) => {
            if(Date.now()-lastProgress<250)return;
            lastProgress=Date.now();
            for(const job of jobs){job.progress={files,updated};this.store.job(job);}
          },
        });
      unchanged();
      const repos = new Map<string, Repository>();
      for (let index=0;index<jobs.length;index++) await this.run(jobs[index], {result,workspace:workspaces[index],repos});
    } catch (error) {
      for (const job of jobs) {
        if (!["running", "queued"].includes(job.status)) continue;
        const latest=this.store.jobs<CollectionJob>().find(saved=>saved.id===job.id);
        if(latest?.sourceProgress)job.sourceProgress=latest.sourceProgress;
        const retryable=isRetryableCollectionIssue(error)&&!this.stopping;
        job.status = retryable?"partial":"interrupted";
        job.error = retryable?undefined:error instanceof Error ? error.message : "Collection interrupted";
        if(retryable){
          job.warnings=[error instanceof Error?error.message:String(error)];
          for(const progress of Object.values(job.sourceProgress||{}))if(!["done","skipped"].includes(progress.status))progress.status="partial";
          this.retryLater(job.workspaceId);
        }
        job.endedAt = new Date().toISOString();
        this.store.job(job);
        this.activeJobs.delete(`collect:${job.workspaceId}`);
      }
    }
  }

  private async run(job: CollectionJob, shared?: {result:Awaited<ReturnType<LocalHistory["scan"]>>;workspace:LocalWorkspace;repos:Map<string,Repository>}): Promise<void> {
    if (this.stopping) {
      this.store.job({
        ...job,
        status: "interrupted",
        endedAt: new Date().toISOString(),
      });
      this.activeJobs.delete(`${job.kind}:${job.workspaceId}`);
      return;
    }
    if(shared?.result.sourceProgress)job.sourceProgress={...job.sourceProgress,...shared.result.sourceProgress[shared.workspace.path]};
    job.status = "running";
    this.store.job(job);
    try {
      const workspace =
        job.kind === "collect"
          ? shared?.workspace ?? this.store.workspace(job.workspaceId)
          : undefined;
      const path = workspace?.path ?? job.workspaceId;
      if (workspace) assertWorkspaceGit(path);
      if(!workspace) {
        job.phase="git";this.store.job(job);
        job.repositories=await repositories(path);
        this.rememberRepositories(path,job.repositories,true);
        job.phase="sessions";this.store.job(job);
      }
      const providers = (await this.providers()).filter(
        (p) => p.enabled && (!workspace || workspace.providers.includes(p.id)),
      );
      for(const provider of providers)if(provider.id === "aider")provider.paths=[...provider.paths,path];
      for(const provider of providers)if(provider.id === "visualstudio-copilot")provider.paths=[...provider.paths,join(path,".vs")];
      const unchanged = (id?: string) => {
        this.abort.signal.throwIfAborted();
        if (
          workspace &&
          this.store.workspace(workspace.id).version !== workspace.version
        )
          throw new Error("Settings changed; retry with the saved selection");
        if (id) {
          const old = providers.find((p) => p.id === id)!;
          if (this.store.provider(id).version !== old.version)
            throw new Error(
              "Source settings changed; retry with the saved selection",
            );
        }
      };
      const result = shared?.result ?? (this.backgroundScan
        ? await this.backgroundScan({ directory: this.store.directory, path, workspace, sources: providers, job }, this.abort.signal)
        : await this.history.scan(path, providers, {
        preview: !workspace,
        signal: this.abort.signal,
        beforeSource: unchanged,
        progress: (files, updated) => {
          job.progress = { files, updated };
          this.store.job(job);
        },
      }));
      job.progress = { files: result.scanned, updated: result.updated };
      unchanged();
      job.providers = workspace ? this.snapshot(workspace) : result.counts;
      job.pending = result.pending;
      job.repositories = workspace ? workspace.repositories.map(path => ({path,count:null})) : job.repositories!;
      if (workspace) {
        job.phase="git";this.store.job(job);
        for (const repo of job.repositories) {
          unchanged();
          job.activeRepository=repo.path;this.store.job(job);
          const key=canonicalDirectory(repo.path);
          const cached=shared?.repos.get(key);
          if(cached)Object.assign(repo,cached);
          else { await this.indexGit(repo); shared?.repos.set(key,{...repo}); }
          this.store.job(job);
        }
        job.activeRepository=undefined;
      }
      this.rememberRepositories(path, job.repositories, !workspace);
      const sourceErrors = [
        ...result.errors.filter(error => !workspace || workspace.providers.some(provider => error.startsWith(`${provider}:`))),
        ...job.repositories.flatMap((r) => (r.error ? [r.error] : [])),
      ];
      const errors=[...sourceErrors];
      const warnings=[...(result.deferred||[]).filter(error=>!workspace||workspace.providers.some(provider=>error.startsWith(`${provider}:`))),
        ...job.repositories.flatMap(repo=>repo.deferred?[repo.deferred]:[])];
      const fingerprint=workspace ? this.processingFingerprint(workspace,sourceErrors) : undefined;
      const checkpoint=workspace ? this.store.db.prepare("SELECT fingerprint FROM adit_local_collection_checkpoints WHERE workspace_id=?").get(workspace.id) as {fingerprint:string}|undefined : undefined;
      const processChanges=!!workspace && checkpoint?.fingerprint!==fingerprint;
      let processed=true;
      const processingIssue=(message:string,error:unknown)=>{
        processed=false;
        const code=(error as {code?:string}|null)?.code;
        const detail=`${message}: ${error instanceof Error?error.message:String(error)}`;
        if(["EACCES","EPERM","ENOSPC","EROFS","SQLITE_CORRUPT","SQLITE_NOTADB","SQLITE_FULL","SQLITE_READONLY","SQLITE_IOERR"].includes(code||""))errors.push(detail);
        else warnings.push(detail);
      };
      if(workspace && processChanges && this.inspect) {
        job.phase="inspection";this.store.job(job);
        unchanged();
        try { await this.inspect(workspace); }
        catch(error) { processingIssue("History inspection failed; previous results retained",error); }
      }
      if(workspace&&processChanges&&this.analyze){
        job.phase="analysis";this.store.job(job);
        unchanged();
        try{await this.analyze(workspace,job);}catch(error){processingIssue("Commit analysis pending; previous results retained",error);}
      }
      if (workspace && processChanges && this.evaluateAchievements) {
        job.phase="achievements";this.store.job(job);
        unchanged();
        try { await this.evaluateAchievements(workspace, errors.length); }
        catch(error) { processingIssue("Achievement evaluation failed; previous results retained",error); }
      }
      const success =
        Object.keys(job.providers).length > 0 ||
        job.repositories.some((r) => !r.error);
      job.status = errors.length ? (success ? "partial" : "failed") : warnings.length?"partial":"done";
      job.warnings=warnings.length?[...new Set(warnings)].slice(0,8):undefined;
      job.error = errors.length
        ? [...new Set(errors)].slice(0, 8).join("; ")
        : undefined;
      if (workspace) {
        unchanged();
        if(processed && this.processingFingerprint(workspace,sourceErrors)===fingerprint)
          this.store.db.prepare(`INSERT INTO adit_local_collection_checkpoints VALUES (?,?) ON CONFLICT(workspace_id)
            DO UPDATE SET fingerprint=excluded.fingerprint`).run(workspace.id,fingerprint);
        this.store.markStarted(workspace.id);
        if(warnings.length)this.retryLater(workspace.id);
        else this.retries.delete(workspace.id);
      }
    } catch (error) {
      const retryable=job.kind==="collect"&&isRetryableCollectionIssue(error)&&!this.stopping;
      job.status = retryable?"partial":"interrupted";
      job.error = retryable?undefined:error instanceof Error ? error.message : "Collection interrupted";
      if(retryable){job.warnings=[error instanceof Error?error.message:String(error)];this.retryLater(job.workspaceId);}
    } finally {
      job.endedAt = new Date().toISOString();
      if(job.kind==="collect")job.repositoryProgress=this.repositoryProgress(job);
      this.store.job(job);
      this.activeJobs.delete(`${job.kind}:${job.workspaceId}`);
    }
  }

  private processingFingerprint(workspace: LocalWorkspace, sourceErrors: string[]): string {
    const digest=createHash("sha256").update(JSON.stringify([1,workspace.path,workspace.providers,workspace.repositories,[...new Set(sourceErrors)].sort()]));
    for(const row of analyticsSessions(this.store.db,workspace).sort((a,b)=>a.provider.localeCompare(b.provider)||a.id.localeCompare(b.id)))
      digest.update(JSON.stringify([row.provider,row.id,row.transcript_revision,row.cwd]));
    for(const repo of [...workspace.repositories].sort())
      for(const row of this.store.db.prepare("SELECT repository,sha FROM adit_local_commits WHERE repository=? ORDER BY sha").iterate(repo))digest.update(JSON.stringify(row));
    return digest.digest("hex");
  }

  private async indexGit(repo: Repository): Promise<void> {
    delete repo.deferred;
    try {
      const ownEmail = await authorEmail(repo.path);
      if (!ownEmail) {
        repo.count = null;
        repo.skipReason = "missing-git-email";
        delete repo.error;
        return;
      }
      const git = async (...args:string[]) => (await exec("git",["-C",repo.path,...args],{
        windowsHide:true,timeout:60000,maxBuffer:64*1024*1024,signal:this.abort.signal,
      })).stdout;
      const refs = async () => {
        const branches=await git("for-each-ref","--format=%(refname) %(objectname)");
        let head="";try{head=await git("rev-parse","--verify","HEAD");}catch{/* Unborn repository. */}
        const shallow=(await git("rev-parse","--git-path","shallow")).trim();
        const shallowPath=resolve(repo.path,shallow);
        return JSON.stringify([branches,head,existsSync(shallowPath)?readFileSync(shallowPath,"utf8"):""]);
      };
      const stamp=await refs();
      const old=this.store.db.prepare("SELECT identity,refs,commit_count FROM adit_local_git_checkpoints WHERE repository=?").get(repo.path) as {identity:string;refs:string;commit_count:number}|undefined;
      const known=new Set((this.store.db.prepare("SELECT sha FROM adit_local_commits WHERE repository=?").all(repo.path) as {sha:string}[]).map(row=>row.sha));
      if(old?.identity===ownEmail && old.refs===stamp && old.commit_count===known.size){repo.count=known.size;delete repo.error;return;}
      // Reachability is cheap metadata. Diff/body reads are restricted to missing own commits.
      const identities=await git("log","--all","--no-merges","--format=%H%x00%ae");
      const reachable=new Set(identities.split("\n").filter(Boolean).filter(line=>line.slice(line.indexOf("\0")+1).trim().toLowerCase()===ownEmail).map(line=>line.slice(0,line.indexOf("\0"))));
      const added=[...reachable].filter(sha=>!known.has(sha));
      let stdout="",files="";
      for(let start=0;start<added.length;start+=64){
        const batch=added.slice(start,start+64);
        stdout+=await git("show","--no-patch","-z","--format=%H%x00%T%x00%P%x00%aI%x00%an%x00%ae%x00%cI%x00%cn%x00%ce%x00%B",...batch,"--");
        files+=await git("show","--no-ext-diff","--no-textconv","--numstat","-z","--format=%x1e%H%x00",...batch,"--");
      }
      if(await refs()!==stamp || await authorEmail(repo.path)!==ownEmail)throw new Error("Git changed while reading; retry on the next collection");
      const save = this.store.db.prepare("INSERT INTO adit_local_commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
      const saveParent=this.store.db.prepare("INSERT INTO adit_local_commit_parents VALUES (?,?,?,?)");
      const saveFile=this.store.db.prepare("INSERT INTO adit_local_commit_files VALUES (?,?,?,?,?,?,?,?)");
      this.store.db.transaction(() => {
        for(const sha of known)if(!reachable.has(sha))this.store.db.prepare("DELETE FROM adit_local_commits WHERE repository=? AND sha=?").run(repo.path,sha);
        const owned = new Set<string>();
        const indexed=Date.now(),fields=stdout.split("\0");
        for(let offset=0;offset+9<fields.length;offset+=10) {
          const [sha,tree,parents,authored,author,email,committed,committer,committerEmail,body]=fields.slice(offset,offset+10);
          const key=sha.trim();if(!key)continue;
          if(email.trim().toLowerCase()!==ownEmail)continue;
          owned.add(key);
          save.run(repo.path,key,tree,Number.isFinite(Date.parse(authored))?Date.parse(authored):null,author,email,
            Number.isFinite(Date.parse(committed))?Date.parse(committed):null,committer,committerEmail,body.split("\n")[0],body,indexed);
          for(const [ordinal,parent] of parents.split(" ").filter(Boolean).entries())saveParent.run(repo.path,key,parent,ordinal);
        }
        for(const section of files.split("\x1e").slice(1)) {
          const entries=section.split("\0"),sha=entries.shift()!.trim();let ordinal=0;
          if(!owned.has(sha))continue;
          for(let index=0;index<entries.length;index++) {
            const entry=entries[index].replace(/^\n/,""),match=/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(entry);
            if(!match)continue;
            let path=match[3],old:string|null=null;
            if(!path){old=entries[++index];path=entries[++index];if(path===undefined)throw new Error("Incomplete Git rename record");}
            saveFile.run(repo.path,sha,ordinal++,old,path,match[1]==="-"?null:Number(match[1]),match[2]==="-"?null:Number(match[2]),Number(match[1]==="-"));
          }
        }
        this.store.db.prepare("INSERT INTO adit_local_repositories VALUES (?,?) ON CONFLICT(path) DO UPDATE SET indexed_at=excluded.indexed_at").run(repo.path,indexed);
        if(owned.size!==added.length)throw new Error("Incomplete Git commit batch");
        this.store.db.prepare(`INSERT INTO adit_local_git_checkpoints VALUES (?,?,?,?) ON CONFLICT(repository)
          DO UPDATE SET identity=excluded.identity,refs=excluded.refs,commit_count=excluded.commit_count`).run(repo.path,ownEmail,stamp,reachable.size);
        repo.count = reachable.size;
        delete repo.error;
      })();
    } catch(error) {
      repo.count = null;
      if(isRetryableCollectionIssue(error)){delete repo.error;repo.deferred=error instanceof Error?error.message:String(error);}
      else repo.error = "Git indexing failed";
    }
  }

  private retryLater(id:string):void {
    if(this.stopping)return;
    const previous=this.retries.get(id);
    if(previous?.timer||previous&&previous.attempt>=3)return;
    const attempt=(previous?.attempt||0)+1;
    const timer=setTimeout(()=>{
      this.retries.set(id,{attempt});
      const workspace=this.store.workspaces().find(workspace=>workspace.id===id);
      if(!workspace||!workspaceGitStatus(workspace.path).available||!workspace.repositories.length)return;
      try{this.collect(id);}catch{}
    },attempt*5000);
    timer.unref();
    this.retries.set(id,{attempt,timer});
  }

  schedule(initial = false): void {
    if (this.timer) clearTimeout(this.timer);
    if(this.draining){this.nextAt=null;return;}
    const config = this.store.schedule();
    const eligible = this.store
      .workspaces()
      .filter(
        (w) => w.started && (w.providers.length || w.repositories.length),
      );
    if (!config.enabled || !eligible.length || this.stopping || this.updatePaused) {
      this.nextAt = null;
      return;
    }
    const delay = initial ? 1000 : config.interval * 60000;
    this.nextAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => {
      this.collectAll();
      if(!this.draining)this.schedule();
    }, delay);
  }
  async close(): Promise<void> {
    this.stopping = true;
    for(const retry of this.retries.values())clearTimeout(retry.timer);
    this.retries.clear();
    clearTimeout(this.timer);
    this.abort.abort();
    await this.queue;
  }
  snapshot(w: LocalWorkspace): Record<string, number> {
    const counts: Record<string,number> = {};
    for (const s of analyticsSessions(this.store.db,w)) if (!s.parent_id || s.relationship === "fork")
      counts[s.provider]=(counts[s.provider] || 0)+1;
    return counts;
  }
}
