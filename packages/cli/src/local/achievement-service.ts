import { Worker } from "node:worker_threads";
import type { LocalWorkspace } from "@varveai/adit-core";
export class AchievementService {
  private worker: Worker;
  private id = 0;
  private stopped = false;
  private pending = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private scopes = new Map<string, Promise<void>>();
  constructor(path: string) {
    this.worker = new Worker(
      new URL("./achievement-worker.js", import.meta.url),
      { workerData: { path } },
    );
    this.worker.on("message", ({ id, error }) => {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve();
    });
    const fail = () => {
      this.stopped = true;
      for (const p of this.pending.values())
        p.reject(new Error("Achievement evaluation unavailable"));
      this.pending.clear();
    };
    this.worker.on("error", fail);
    this.worker.on("exit", fail);
  }
  evaluate(workspace: LocalWorkspace, sourceErrors = 0): Promise<void> {
    if (this.stopped)
      return Promise.reject(new Error("Achievement evaluation unavailable"));
    // Identical requests coalesce; subsequent collection calls evaluate their new facts after completion.
    const key = workspace.id + ":" + workspace.version + ":" + sourceErrors;
    const active = this.scopes.get(key);
    if (active)
      return active.then(() => this.evaluate(workspace, sourceErrors));
    const promise = new Promise<void>((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, workspace, sourceErrors });
    });
    this.scopes.set(key, promise);
    void promise
      .finally(() => {
        if (this.scopes.get(key) === promise) this.scopes.delete(key);
      })
      .catch(() => {});
    return promise;
  }
  async close() {
    this.stopped = true;
    await this.worker.terminate();
  }
}
