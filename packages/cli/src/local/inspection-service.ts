import { Worker } from "node:worker_threads";
import { LocalInspection, type LocalWorkspace } from "@varveai/adit-core";
export class InspectionService {
  get available() {
    return !this.stopped;
  }
  private worker?: Worker;
  private queue: Promise<void> = Promise.resolve();
  private active = new Map<string, Promise<void>>();
  private pending = new Map<
    string,
    { resolve: () => void; reject: () => void }
  >();
  private stopped = false;
  constructor(
    readonly inspection: LocalInspection,
    path?: string,
  ) {
    inspection.db
      .prepare(
        "UPDATE adit_history_secret_scan_runs SET status='interrupted',finished_at=? WHERE status IN ('queued','running','indexing')",
      )
      .run(Date.now());
    if (path) {
      this.worker = new Worker(
        new URL("./inspection-worker.js", import.meta.url),
        { workerData: { path } },
      );
      this.worker.on("message", ({ id, error }) => {
        const p = this.pending.get(id);
        this.pending.delete(id);
        if (error) p?.reject();
        else p?.resolve();
      });
      const fail = () => {
        this.stopped = true;
        for (const p of this.pending.values()) p.reject();
        this.pending.clear();
        inspection.db
          .prepare(
            "UPDATE adit_history_secret_scan_runs SET status='failed',finished_at=? WHERE status IN ('queued','running','indexing')",
          )
          .run(Date.now());
      };
      this.worker.on("error", fail);
      this.worker.on("exit", () => {
        if (!this.stopped) fail();
      });
    }
  }
  start(workspace: LocalWorkspace, trigger = "manual"): Promise<void> {
    if (this.stopped)
      return Promise.reject(new Error("Inspection unavailable"));
    const existing = this.active.get(workspace.id);
    // Repeated button clicks coalesce. Collection after an active scan checks its new revision afterwards.
    if (existing)
      return trigger === "collection"
        ? existing.then(() => this.start(workspace, trigger))
        : existing;
    const id = this.inspection.start(workspace, trigger);
    const promise = this.queue.then(async () => {
      if (this.stopped) return;
      if (this.worker)
        await new Promise<void>((resolve, reject) => {
          this.pending.set(id, {
            resolve,
            reject: () => reject(new Error("Inspection unavailable")),
          });
          this.worker!.postMessage({
            id,
            workspace,
            force: trigger === "manual",
          });
        });
      else await this.inspection.run(workspace, id, trigger === "manual");
    });
    this.active.set(workspace.id, promise);
    this.queue = promise.catch(() => {});
    void promise
      .finally(() => {
        if (this.active.get(workspace.id) === promise)
          this.active.delete(workspace.id);
      })
      .catch(() => {});
    return promise;
  }
  async close() {
    this.stopped = true;
    this.inspection.db
      .prepare(
        "UPDATE adit_history_secret_scan_runs SET cancel_requested=1 WHERE status IN ('queued','running','indexing')",
      )
      .run();
    if (this.worker) {
      await this.worker.terminate();
      for (const p of this.pending.values()) p.resolve();
      this.pending.clear();
    }
    await this.queue;
    this.inspection.db
      .prepare(
        "UPDATE adit_history_secret_scan_runs SET status='interrupted',finished_at=? WHERE status IN ('queued','running','indexing')",
      )
      .run(Date.now());
  }
}
