import {
  LocalStateError,
  type LocalWorkspace,
  type OverviewData,
} from "@varveai/adit-core";
import { OnDemandWorker } from "./on-demand-worker.js";

export class OverviewService {
  private worker: OnDemandWorker;
  private pending = 0;
  constructor(
    path: string,
    workerUrl = new URL("./overview-worker.js", import.meta.url),
  ) {
    this.worker = new OnDemandWorker(
      workerUrl,
      { path },
      () => new LocalStateError("Overview calculation unavailable", 503),
      {
        idleTimeout: 10_000,
        taskError: (message) =>
          new LocalStateError(String(message.error), message.status),
      },
    );
  }
  query(
    workspace: LocalWorkspace,
    options: Record<string, unknown>,
  ): Promise<OverviewData> {
    if (this.pending >= 8)
      return Promise.reject(
        new LocalStateError("Overview is busy; please retry", 429),
      );
    this.pending++;
    return this.worker
      .request<OverviewData>({ workspace, options })
      .finally(() => {
        this.pending--;
      });
  }
  async close() {
    await this.worker.close();
  }
}
