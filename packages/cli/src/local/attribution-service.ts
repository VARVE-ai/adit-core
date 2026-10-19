import { Worker } from "node:worker_threads";
import type { LocalWorkspace } from "@varveai/adit-core";
export class AttributionService {
  private worker: Worker;
  private id = 0;
  private failed = false;
  private pending = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  constructor(directory: string) {
    this.worker = new Worker(
      new URL("./attribution-worker.js", import.meta.url),
      { workerData: { directory } },
    );
    this.worker.on("message", ({ id, error }) => {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (error) entry.reject(new Error(error));
      else entry.resolve();
    });
    const fail = () => {
      this.failed = true;
      for (const p of this.pending.values())
        p.reject(new Error("提交分析服务已停止"));
      this.pending.clear();
    };
    this.worker.on("error", fail);
    this.worker.on("exit", fail);
  }
  analyze(workspace: LocalWorkspace): Promise<void> {
    if (this.failed) return Promise.reject(new Error("提交分析服务不可用"));
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, workspace });
    });
  }
  async close() {
    await this.worker.terminate();
  }
}
