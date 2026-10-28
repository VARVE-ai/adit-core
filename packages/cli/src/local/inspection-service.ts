import { LocalInspection, type LocalWorkspace } from "@varveai/adit-core";
import { OnDemandWorker } from "./on-demand-worker.js";
export class InspectionService {
  get available() {
    return !this.stopped;
  }
  private worker?: OnDemandWorker;
  private queue: Promise<void> = Promise.resolve();
  private active = new Map<string, Promise<void>>();
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
      this.worker = new OnDemandWorker(
        new URL("./inspection-worker.js", import.meta.url),
        { path },
        () => new Error("Inspection unavailable"),
      );
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
      if (this.worker) {
        try {
          await this.worker.request<void>({
            runId: id,
            workspace,
            force: trigger === "manual",
          });
        } catch (error) {
          if (!this.stopped)
            this.inspection.db
              .prepare(
                "UPDATE adit_history_secret_scan_runs SET status='failed',finished_at=? WHERE id=? AND status IN ('queued','running','indexing')",
              )
              .run(Date.now(), id);
          throw error;
        }
      } else await this.inspection.run(workspace, id, trigger === "manual");
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
    await this.worker?.close();
    await this.queue;
    this.inspection.db
      .prepare(
        "UPDATE adit_history_secret_scan_runs SET status='interrupted',finished_at=? WHERE status IN ('queued','running','indexing')",
      )
      .run(Date.now());
  }
}
