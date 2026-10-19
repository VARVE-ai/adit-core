import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  LocalStore,
  LocalStateError,
  canonicalDirectory,
  LocalHistory,
  sourceDefinitions,
  sourceHomePaths,
  insideDirectory,
  type LocalWorkspace,
  type SourceDefinition,
} from "@varveai/adit-core";

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
  repositories?: Repository[];
}

const missingGitEmail = "请先为该仓库配置 Git user.email，才能只整理自己的提交";
async function authorEmail(path: string): Promise<string> {
  let email = "";
  try {
    const { stdout } = await exec("git", ["-C", path, "config", "--get", "user.email"], { windowsHide: true, timeout: 15000 });
    email = stdout.trim().toLowerCase();
  } catch { /* Missing identity must never fall back to all authors. */ }
  if (!email) throw new Error(missingGitEmail);
  return email;
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
    try {
      const email = await authorEmail(dir);
      const { stdout } = await exec(
        "git",
        ["-C", dir, "log", "--all", "--no-merges", "--format=%ae"],
        { windowsHide: true, timeout: 15000, maxBuffer: 32 * 1024 * 1024 },
      );
      result.push({ path: dir, count: stdout.split("\n").filter(value => value.trim().toLowerCase() === email).length });
    } catch (error) {
      result.push({
        path: dir,
        count: null,
        error: error instanceof Error && error.message === missingGitEmail ? missingGitEmail : "Unable to read Git history",
      });
    }
  }
  return result;
}

export class Collector {
  private queue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private abort = new AbortController();
  private stopping = false;
  readonly history: LocalHistory;
  nextAt: string | null = null;

  constructor(readonly store: LocalStore, private analyze?: (workspace:LocalWorkspace)=>Promise<void>) {
    this.history = new LocalHistory(store.db);
    for (const job of store.jobs<CollectionJob>())
      if (["running", "queued"].includes(job.status)) {
        store.job({
          ...job,
          status: "interrupted",
          endedAt: new Date().toISOString(),
        });
      }
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
    return this.store
      .jobs<CollectionJob>()
      .find(
        (j) =>
          j.workspaceId === id &&
          j.kind === kind &&
          ["running", "queued"].includes(j.status),
      );
  }
  discover(path: string): CollectionJob {
    return this.enqueue(canonicalDirectory(path), "discover");
  }
  collect(id: string): CollectionJob {
    const w = this.store.workspace(id);
    if (!w.providers.length && !w.repositories.length)
      throw new LocalStateError("Select at least one source or repository");
    return this.enqueue(id, "collect");
  }
  private enqueue(id: string, kind: "collect" | "discover"): CollectionJob {
    if (this.stopping) throw new LocalStateError("Collection is stopping", 409);
    const active = this.active(id, kind);
    if (active) return active;
    const job: CollectionJob = {
      id: randomUUID(),
      workspaceId: id,
      kind,
      status: "queued",
      startedAt: new Date().toISOString(),
    };
    this.store.job(job);
    this.queue = this.queue.then(() => this.run(job)).catch(() => {});
    return job;
  }

  private async run(job: CollectionJob): Promise<void> {
    if (this.stopping) {
      this.store.job({
        ...job,
        status: "interrupted",
        endedAt: new Date().toISOString(),
      });
      return;
    }
    job.status = "running";
    this.store.job(job);
    try {
      const workspace =
        job.kind === "collect"
          ? this.store.workspace(job.workspaceId)
          : undefined;
      const path = workspace?.path ?? job.workspaceId;
      const providers = (await this.providers()).filter(
        (p) => p.enabled && (!workspace || workspace.providers.includes(p.id)),
      );
      for(const provider of providers)if(provider.id === "aider" && workspace)provider.paths=[...provider.paths,workspace.path];
      for(const provider of providers)if(provider.id === "visualstudio-copilot" && workspace)provider.paths=[...provider.paths,join(workspace.path,".vs")];
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
      const result = await this.history.scan(path, providers, {
        preview: !workspace,
        signal: this.abort.signal,
        beforeSource: unchanged,
        progress: (files, updated) => {
          job.progress = { files, updated };
          this.store.job(job);
        },
      });
      unchanged();
      job.providers = result.counts;
      job.repositories = await repositories(path);
      if (workspace) {
        job.repositories = job.repositories.filter((r) =>
          workspace.repositories.includes(r.path),
        );
        for (const repo of job.repositories) {
          unchanged();
          await this.indexGit(repo);
        }
      }
      const errors = [
        ...result.errors,
        ...job.repositories.flatMap((r) => (r.error ? [r.error] : [])),
      ];
      if(workspace&&this.analyze){
        unchanged();
        try{await this.analyze(workspace);}catch(error){errors.push(error instanceof Error?error.message:'提交分析失败');}
      }
      const success =
        result.updated > 0 ||
        Object.keys(result.counts).length > 0 ||
        job.repositories.some((r) => !r.error);
      job.status = errors.length ? (success ? "partial" : "failed") : "done";
      job.error = errors.length
        ? [...new Set(errors)].slice(0, 8).join("; ")
        : undefined;
      if (workspace && job.status === "done") {
        this.store.markStarted(workspace.id);
        this.schedule();
      }
    } catch (error) {
      job.status = "interrupted";
      job.error =
        error instanceof Error ? error.message : "Collection interrupted";
    } finally {
      job.endedAt = new Date().toISOString();
      this.store.job(job);
    }
  }

  private async indexGit(repo: Repository): Promise<void> {
    try {
      const ownEmail = await authorEmail(repo.path);
      const { stdout } = await exec(
        "git",
        ["-C", repo.path, "log", "--all", "--no-merges", "-z", "--format=%H%x00%T%x00%P%x00%aI%x00%an%x00%ae%x00%cI%x00%cn%x00%ce%x00%B"],
        {
          windowsHide: true,
          timeout: 60000,
          maxBuffer: 32 * 1024 * 1024,
          signal: this.abort.signal,
        },
      );
      const {stdout:files}=await exec("git",["-C",repo.path,"log","--all","--no-merges","--numstat","-z","--format=%x1e%H%x00"],{
        windowsHide:true,timeout:60000,maxBuffer:64*1024*1024,signal:this.abort.signal,
      });
      const save = this.store.db.prepare("INSERT OR REPLACE INTO adit_local_commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
      const saveParent=this.store.db.prepare("INSERT INTO adit_local_commit_parents VALUES (?,?,?,?)");
      const saveFile=this.store.db.prepare("INSERT INTO adit_local_commit_files VALUES (?,?,?,?,?,?,?,?)");
      this.store.db.transaction(() => {
        this.store.db.prepare("DELETE FROM adit_local_commits WHERE repository=?").run(repo.path);
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
        repo.count = owned.size;
        delete repo.error;
      })();
    } catch (error) {
      repo.count = null;
      repo.error = error instanceof Error && error.message === missingGitEmail ? missingGitEmail : "Git indexing failed";
    }
  }

  schedule(initial = false): void {
    if (this.timer) clearTimeout(this.timer);
    const config = this.store.schedule();
    const eligible = this.store
      .workspaces()
      .filter(
        (w) => w.started && (w.providers.length || w.repositories.length),
      );
    if (!config.enabled || !eligible.length || this.stopping) {
      this.nextAt = null;
      return;
    }
    const delay = initial ? 1000 : config.interval * 60000;
    this.nextAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => {
      for (const w of this.store
        .workspaces()
        .filter(
          (w) => w.started && (w.providers.length || w.repositories.length),
        ))
        this.collect(w.id);
      this.schedule();
    }, delay);
  }
  async close(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    this.abort.abort();
    await this.queue;
  }
  snapshot(w: LocalWorkspace): Record<string, number> {
    return this.history.counts(w.path, w.providers);
  }
}
