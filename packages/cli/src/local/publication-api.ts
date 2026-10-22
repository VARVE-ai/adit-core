import { LocalSharing, LocalPrDescriptions, LocalStateError, type LocalStore, type LocalPrices, type PrOptions, type ShareOptions, type PrScope } from "@varveai/adit-core";
import { createHash, randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { GistPublisher } from "./gist-publisher.js";
import { LocalSecrets } from "./secrets.js";
import { prRepositoryRefs, readPrTemplate, resolvePrScope } from "./pr-scope.js";

export class PublicationApi {
  readonly sharing: LocalSharing;
  readonly pr: LocalPrDescriptions;
  private publisher: GistPublisher;
  private scopes = new Map<string, { workspaceId: string; scope: PrScope; expires: number }>();
  private workers = new Set<Worker>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private activeWorkspaces = new Map<string, number>();
  busy(workspaceId: string) { return (this.activeWorkspaces.get(workspaceId) || 0) > 0; }
  forget(workspaceId: string) { for (const [key,entry] of this.scopes) if (entry.workspaceId===workspaceId) this.scopes.delete(key); }
  constructor(private store: LocalStore, prices: LocalPrices, private background = false) {
    this.sharing = new LocalSharing(store.db, prices); this.pr = new LocalPrDescriptions(store.db);
    this.publisher = new GistPublisher(this.sharing, new LocalSecrets(store.directory));
    store.db.prepare("UPDATE adit_shares SET status='publish_unknown' WHERE status='publishing'").run();
    // A process can stop after the result transaction commits but before it answers HTTP.
    store.db.exec(`UPDATE adit_pr_description_jobs SET status='done',result_id=id,finished_at=coalesce(finished_at,created_at)
      WHERE status='running' AND id IN (SELECT id FROM adit_pr_descriptions WHERE status='ready');
      UPDATE adit_pr_description_jobs SET status='failed',error='Publication processing was interrupted'
      WHERE status='running';`);
  }
  private work(kind: string, workspaceId: string, input: unknown, fallback: () => unknown): Promise<any> {
    this.activeWorkspaces.set(workspaceId,(this.activeWorkspaces.get(workspaceId)||0)+1);
    // Serialize snapshot writes while keeping parsing and rendering off the HTTP event loop.
    const task = this.queue.then(() => {
      if (this.closed) throw new LocalStateError("Local service is shutting down", 503);
      if (!this.background) return fallback();
      return new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./publication-worker.js", import.meta.url), { workerData: { directory: this.store.directory, kind, workspaceId, input } });
        this.workers.add(worker);
        let answered = false;
        worker.once("message", result => { answered = true; result.error ? reject(new LocalStateError(result.error, result.status)) : resolve(result.value); });
        worker.once("error", reject);
        worker.once("exit", () => { this.workers.delete(worker); if (!answered) reject(new LocalStateError("Publication processing was interrupted", 503)); });
      });
    });
    const tracked=task.finally(()=>{ const count=(this.activeWorkspaces.get(workspaceId)||1)-1; if(count)this.activeWorkspaces.set(workspaceId,count); else this.activeWorkspaces.delete(workspaceId); });
    this.queue = tracked.catch(() => {}); return tracked;
  }
  async close() { this.closed = true; await Promise.all([...this.workers].map(w => w.terminate())); await this.queue; }
  async route(method: string, route: string, url: URL, input: Record<string, unknown>): Promise<{ value: unknown; status?: number } | null> {
    if (!/^\/(?:shares|share-drafts|pr-descriptions|pr-scopes|pr-refs|pr-description-jobs)(?:\/|$)/.test(route)) return null;
    const workspace = this.store.workspace(String(url.searchParams.get("workspaceId") || input.workspaceId || ""));
    const respond = (value: unknown, status = 200) => ({ value, status });
    const id = route.split("/")[2];
    if (route === "/shares" && method === "GET") return respond(this.sharing.list(workspace, Number(url.searchParams.get("offset") || 0), url.searchParams.get("cursor")));
    if (route === "/share-drafts" && method === "POST") return respond({ ...await this.work("share-create", workspace.id, input, () => this.sharing.create(workspace, String(input.provider || ""), String(input.sessionId || ""), { title: input.title as string | undefined, options: input.options as Partial<ShareOptions> })), gistConfigured: new LocalSecrets(this.store.directory).configured(workspace.id) }, 201);
    if (/^\/(shares|share-drafts)\/[^/]+$/.test(route) && method === "GET") return respond({ ...this.sharing.read(workspace, id), gistConfigured: new LocalSecrets(this.store.directory).configured(workspace.id) });
    if (/^\/share-drafts\/[^/]+$/.test(route) && method === "PATCH") return respond({ ...await this.work("share-update", workspace.id, { ...input, id }, () => this.sharing.update(workspace, id, { title: input.title as string | undefined, options: input.options as Partial<ShareOptions> })), gistConfigured: new LocalSecrets(this.store.directory).configured(workspace.id) });
    if (/^\/share-drafts\/[^/]+\/publish$/.test(route) && method === "POST") return respond(await this.publisher.publish(workspace, id, { version: String(input.version || ""), digest: String(input.digest || ""), idempotencyKey: String(input.idempotencyKey || "") }));
    if (route === "/pr-refs" && method === "POST") return respond(await prRepositoryRefs(workspace, String(input.repository || "")));
    if (route === "/pr-scopes/resolve" && method === "POST") {
      const scope = await resolvePrScope(workspace, input as { repository: string; head?: string; base?: string; commits?: string[] });
      this.store.workspace(workspace.id); // It may have been deleted while Git was running.
      const scopeId = randomUUID();
      for (const [key, entry] of this.scopes) if (entry.expires < Date.now()) this.scopes.delete(key);
      this.scopes.set(scopeId, { workspaceId: workspace.id, scope, expires: Date.now() + 30 * 60000 });
      return respond({ scopeId, scope });
    }
    if (route === "/pr-descriptions" && method === "GET") return respond(this.pr.list(workspace, Number(url.searchParams.get("offset") || 0), url.searchParams.get("cursor")));
    if (/^\/pr-descriptions\/[^/]+$/.test(route) && method === "GET") return respond(this.pr.read(workspace, id));
    if (route === "/pr-descriptions" && method === "POST") {
      const saved = this.scopes.get(String(input.scopeId || ""));
      if (!saved || saved.workspaceId !== workspace.id || saved.expires < Date.now()) throw new LocalStateError("Resolve the commit range again before generating", 409);
      const options = (input.options || {}) as Partial<PrOptions>;
      const template = options.detail === "project-template" ? await readPrTemplate(saved.scope.repository, options.template) : undefined;
      this.store.workspace(workspace.id);
      const requestKey = input.idempotencyKey === undefined ? randomUUID() : String(input.idempotencyKey);
      if (!/^[\w-]{8,100}$/.test(requestKey)) throw new LocalStateError("Invalid generation request");
      const digest = createHash("sha256").update(JSON.stringify({ scope: saved.scope, options, template })).digest("hex");
      const previous = this.store.db.prepare("SELECT id,status,request_digest FROM adit_pr_description_jobs WHERE workspace_id=? AND request_key=?").get(workspace.id, requestKey) as { id: string; status: string; request_digest: string } | undefined;
      if (previous) {
        if (previous.request_digest !== digest) throw new LocalStateError("Generation request belongs to different options", 409);
        return respond({ jobId: previous.id, status: previous.status }, previous.status === "running" ? 202 : 200);
      }
      const key = randomUUID();
      this.store.db.prepare("INSERT INTO adit_pr_description_jobs(id,workspace_id,request_key,request_digest,status,created_at) VALUES (?,?,?,?,'running',?)").run(key, workspace.id, requestKey, digest, Date.now());
      void this.work("pr", workspace.id, { scope: saved.scope, options, template, jobId: key }, () => this.pr.generate(workspace, saved.scope, options, template, key))
        .then(result => { this.store.db.prepare("UPDATE adit_pr_description_jobs SET status='done',result_id=?,finished_at=? WHERE id=?").run(result.id, Date.now(), key); })
        .catch(e => { this.store.db.prepare("UPDATE adit_pr_description_jobs SET status='failed',error=?,finished_at=? WHERE id=?").run(e instanceof Error ? e.message : "Description generation failed", Date.now(), key); });
      return respond({ jobId: key, status: "running" }, 202);
    }
    if (/^\/pr-description-jobs\/[^/]+$/.test(route) && method === "GET") {
      const job = this.store.db.prepare("SELECT status,result_id,error FROM adit_pr_description_jobs WHERE workspace_id=? AND id=?").get(workspace.id, id) as { status: string; result_id: string | null; error: string | null } | undefined;
      if (!job) throw new LocalStateError("Generation job not found", 404);
      return respond({ status: job.status, ...(job.result_id ? { result: this.pr.read(workspace, job.result_id) } : {}), ...(job.error ? { error: job.error } : {}) });
    }
    throw new LocalStateError("Publication endpoint not found", 404);
  }
}
