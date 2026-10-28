import { Worker } from "node:worker_threads";
import type { LocalWorkspace } from "@varveai/adit-core";
import type {CollectionJob} from "./collector.js";
type PendingAnalysis = { resolve: () => void; reject: (error: Error) => void };
type AnalysisWorker = {
  worker: Worker;
  exited: Promise<void>;
  pending: Map<number, PendingAnalysis>;
};
export class AttributionService {
  private state?: AnalysisWorker;
  private retiring: Promise<void> = Promise.resolve();
  private id = 0;
  private stopped = false;
  constructor(
    private directory: string,
    private workerUrl = new URL("./attribution-worker.js", import.meta.url),
    private needed: (workspace: LocalWorkspace) => boolean = () => true,
  ) {}
  private startWorker(): AnalysisWorker {
    const worker = new Worker(
      this.workerUrl,
      { workerData: { directory: this.directory } },
    );
    let finish!: () => void;
    const state: AnalysisWorker = {
      worker,
      exited: new Promise<void>(resolve => { finish = resolve; }),
      pending: new Map(),
    };
    this.state = state;
    worker.on("message", ({ id, error }) => {
      const entry = state.pending.get(id);
      if (!entry) return;
      state.pending.delete(id);
      if (!state.pending.size) this.retire(state);
      if (error) entry.reject(new Error(error));
      else entry.resolve();
    });
    const fail = () => {
      for (const entry of state.pending.values())
        entry.reject(new Error("提交分析服务已停止"));
      state.pending.clear();
    };
    worker.on("error", () => {
      this.retire(state, true);
      fail();
    });
    worker.on("exit", () => {
      if (this.state === state) this.state = undefined;
      fail();
      finish();
    });
    return state;
  }
  private retire(state: AnalysisWorker, terminate = false) {
    if (this.state === state) this.state = undefined;
    this.retiring = state.exited;
    if (terminate) void state.worker.terminate();
    else {
      try { state.worker.postMessage({ type: "close" }); }
      catch { void state.worker.terminate(); }
    }
  }
  async analyze(workspace: LocalWorkspace,job?:CollectionJob): Promise<void> {
    if (this.stopped) throw new Error("提交分析服务不可用");
    await this.retiring;
    if (this.stopped) throw new Error("提交分析服务不可用");
    if (!this.needed(workspace)) return;
    const state = this.state ?? this.startWorker();
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      state.pending.set(id, { resolve, reject });
      try { state.worker.postMessage({ id, workspace, job }); }
      catch (error) {
        state.pending.delete(id);
        if (!state.pending.size) this.retire(state);
        reject(error);
      }
    });
  }
  async close() {
    this.stopped = true;
    if (this.state) this.retire(this.state, true);
    await this.retiring;
  }
}
