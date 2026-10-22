import { Worker } from "node:worker_threads";
import {
  LocalStateError,
  type LocalWorkspace,
  type OverviewData,
} from "@varveai/adit-core";

export class OverviewService {
  private worker: Worker;
  private id = 0;
  private pending = new Map<
    number,
    { resolve: (data: OverviewData) => void; reject: (error: Error) => void }
  >();
  private failed = false;
  constructor(
    path: string,
    workerUrl = new URL("./overview-worker.js", import.meta.url),
  ) {
    this.worker = new Worker(workerUrl, { workerData: { path } });
    this.worker.on("message", (message) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(new LocalStateError(message.error, message.status));
      else pending.resolve(message.result);
    });
    const fail = () => {
      this.failed = true;
      for (const pending of this.pending.values())
        pending.reject(
          new LocalStateError("Overview calculation unavailable", 503),
        );
      this.pending.clear();
    };
    this.worker.on("error", fail);
    this.worker.on("exit", fail);
  }
  query(
    workspace: LocalWorkspace,
    options: Record<string, unknown>,
  ): Promise<OverviewData> {
    if (this.failed)
      return Promise.reject(
        new LocalStateError("Overview calculation unavailable", 503),
      );
    if (this.pending.size >= 8)
      return Promise.reject(
        new LocalStateError("Overview is busy; please retry", 429),
      );
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, workspace, options });
    });
  }
  async close() {
    await this.worker.terminate();
  }
}
