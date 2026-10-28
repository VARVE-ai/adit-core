import type { LocalWorkspace } from "@varveai/adit-core";
import { OnDemandWorker } from "./on-demand-worker.js";
export class AchievementService {
  private worker: OnDemandWorker;
  private scopes = new Map<string, Promise<void>>();
  constructor(path: string) {
    this.worker = new OnDemandWorker(
      new URL("./achievement-worker.js", import.meta.url),
      { path },
      () => new Error("Achievement evaluation unavailable"),
      { taskError: (message) => new Error(String(message.error)) },
    );
  }
  evaluate(workspace: LocalWorkspace, sourceErrors = 0): Promise<void> {
    // Identical requests coalesce; subsequent collection calls evaluate their new facts after completion.
    const key = workspace.id + ":" + workspace.version + ":" + sourceErrors;
    const active = this.scopes.get(key);
    if (active)
      return active.then(() => this.evaluate(workspace, sourceErrors));
    const promise = this.worker.request<void>({ workspace, sourceErrors });
    this.scopes.set(key, promise);
    void promise
      .finally(() => {
        if (this.scopes.get(key) === promise) this.scopes.delete(key);
      })
      .catch(() => {});
    return promise;
  }
  async close() {
    await this.worker.close();
  }
}
