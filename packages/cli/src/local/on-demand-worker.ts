import { Worker } from "node:worker_threads";

type WorkerReply = {
  id: number;
  result?: unknown;
  error?: unknown;
  status?: number;
};
type WorkerState = {
  worker: Worker;
  exited: Promise<void>;
  pending: Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >;
  idleTimer?: ReturnType<typeof setTimeout>;
  retiring: boolean;
};

export class OnDemandWorker {
  private state?: WorkerState;
  private retiring: Promise<void> = Promise.resolve();
  private id = 0;
  private stopped = false;

  constructor(
    private workerUrl: URL,
    private workerData: Record<string, unknown>,
    private unavailable: () => Error,
    private options: {
      idleTimeout?: number;
      taskError?: (message: WorkerReply) => Error;
    } = {},
  ) {}

  private startWorker(): WorkerState {
    const worker = new Worker(this.workerUrl, { workerData: this.workerData });
    let finish!: () => void;
    const state: WorkerState = {
      worker,
      exited: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      pending: new Map(),
      retiring: false,
    };
    this.state = state;
    worker.on("message", (message: WorkerReply) => {
      const pending = state.pending.get(message.id);
      if (!pending) return;
      state.pending.delete(message.id);
      this.scheduleRetirement(state);
      if (message.error)
        pending.reject(this.options.taskError?.(message) ?? this.unavailable());
      else pending.resolve(message.result);
    });
    const fail = () => {
      for (const pending of state.pending.values())
        pending.reject(this.unavailable());
      state.pending.clear();
    };
    worker.on("error", () => {
      this.retire(state, true);
      fail();
    });
    worker.on("exit", () => {
      clearTimeout(state.idleTimer);
      if (this.state === state) this.state = undefined;
      fail();
      finish();
    });
    return state;
  }

  private scheduleRetirement(state: WorkerState) {
    if (state.pending.size || state.retiring) return;
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(
      () => this.retire(state),
      this.options.idleTimeout ?? 0,
    );
    state.idleTimer.unref();
  }

  private retire(state: WorkerState, terminate = false) {
    if (state.retiring) return;
    state.retiring = true;
    clearTimeout(state.idleTimer);
    if (this.state === state) this.state = undefined;
    this.retiring = state.exited;
    if (terminate) void state.worker.terminate();
    else {
      try {
        state.worker.postMessage({ type: "close" });
      } catch {
        void state.worker.terminate();
      }
    }
  }

  async request<Result>(payload: Record<string, unknown>): Promise<Result> {
    if (this.stopped) throw this.unavailable();
    await this.retiring;
    if (this.stopped) throw this.unavailable();
    const state = this.state ?? this.startWorker();
    clearTimeout(state.idleTimer);
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      state.pending.set(id, {
        resolve: (result) => resolve(result as Result),
        reject,
      });
      try {
        state.worker.postMessage({ ...payload, id });
      } catch (error) {
        state.pending.delete(id);
        this.scheduleRetirement(state);
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
