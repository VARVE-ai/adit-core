import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalInspection, LocalWorkspace } from "@varveai/adit-core";
import { OnDemandWorker } from "./on-demand-worker.js";
import { InspectionService } from "./inspection-service.js";
import { AchievementService } from "./achievement-service.js";
import { OverviewService } from "./overview-service.js";

type TestWorker = {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => boolean;
};
const { workers, construction } = vi.hoisted(() => ({
  workers: [] as TestWorker[],
  construction: { fail: false },
}));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      constructor() {
        super();
        if (construction.fail) throw new Error("spawn failed");
        workers.push(this);
      }
      postMessage = vi.fn();
      terminate = vi.fn(async () => {
        this.emit("exit", 1);
        return 1;
      });
    },
  };
});

const services: { close: () => Promise<void> }[] = [];
const workspace = { id: "workspace", version: 1 } as LocalWorkspace;
function service(options: ConstructorParameters<typeof OnDemandWorker>[3] = {}) {
  const instance = new OnDemandWorker(
    new URL("./fixture-worker.js", import.meta.url),
    { path: "state" },
    () => new Error("Worker unavailable"),
    options,
  );
  services.push(instance);
  return instance;
}
async function flush() {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const worker of workers) worker.emit("exit", 0);
  await Promise.all(services.splice(0).map((instance) => instance.close()));
  workers.length = 0;
  construction.fail = false;
  vi.useRealTimers();
});

describe("on-demand worker lifecycle", () => {
  it("starts lazily, drains pending requests and closes gracefully", async () => {
    const instance = service();
    expect(workers).toHaveLength(0);
    const first = instance.request({ task: "first" });
    const second = instance.request({ task: "second" });
    await flush();
    expect(workers).toHaveLength(1);
    const worker = workers[0];
    expect(worker.postMessage.mock.calls).toEqual([
      [{ task: "first", id: 1 }],
      [{ task: "second", id: 2 }],
    ]);
    worker.emit("message", { id: 2, result: "second result" });
    await expect(second).resolves.toBe("second result");
    await vi.advanceTimersByTimeAsync(1);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    worker.emit("message", { id: 999 });
    worker.emit("message", { id: 1, result: "first result" });
    await expect(first).resolves.toBe("first result");
    await vi.advanceTimersByTimeAsync(1);
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "close" });
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("waits for graceful exit before opening a replacement worker", async () => {
    const instance = service();
    const first = instance.request({});
    await flush();
    workers[0].emit("message", { id: 1 });
    await first;
    await vi.advanceTimersByTimeAsync(1);
    const next = instance.request({});
    await flush();
    expect(workers).toHaveLength(1);
    workers[0].emit("exit", 0);
    await flush();
    expect(workers).toHaveLength(2);
    workers[1].emit("message", { id: 2, result: "reopened" });
    await expect(next).resolves.toBe("reopened");
  });

  it("reuses brief idle windows without closing a busy worker", async () => {
    const instance = service({ idleTimeout: 10_000 });
    const first = instance.request({});
    await flush();
    const worker = workers[0];
    worker.emit("message", { id: 1 });
    await first;
    await vi.advanceTimersByTimeAsync(9_000);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    const next = instance.request({});
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(workers).toHaveLength(1);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    worker.emit("message", { id: 2 });
    await next;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "close" });
  });

  it("reports task errors without failing other requests", async () => {
    const instance = service({
      taskError: (message) => new Error(String(message.error)),
    });
    const failed = instance.request({});
    const rejected = expect(failed).rejects.toThrow("calculation failed");
    const next = instance.request({});
    await flush();
    workers[0].emit("message", { id: 1, error: "calculation failed" });
    await rejected;
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0].postMessage).toHaveBeenCalledTimes(2);
    workers[0].emit("message", { id: 2 });
    await next;
  });

  it.each(["error", "exit"])(
    "rejects pending work on worker %s and permits a retry",
    async (event) => {
      const instance = service();
      const first = instance.request({});
      const second = instance.request({});
      const rejected = Promise.all([
        expect(first).rejects.toThrow("Worker unavailable"),
        expect(second).rejects.toThrow("Worker unavailable"),
      ]);
      await flush();
      workers[0].emit(event, event === "error" ? new Error("crash") : 1);
      await rejected;
      const next = instance.request({});
      await flush();
      expect(workers).toHaveLength(2);
      workers[1].emit("message", { id: 3 });
      await next;
    },
  );

  it("does not disrupt pending work when one request cannot be cloned", async () => {
    const instance = service();
    const first = instance.request({});
    await flush();
    workers[0].postMessage.mockImplementationOnce(() => {
      throw new Error("clone failed");
    });
    await expect(instance.request({})).rejects.toThrow("clone failed");
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    expect(workers[0].postMessage).not.toHaveBeenCalledWith({ type: "close" });
    workers[0].emit("message", { id: 1 });
    await first;
  });

  it("releases an idle worker after an uncloneable request", async () => {
    const instance = service();
    const first = instance.request({});
    await flush();
    workers[0].emit("message", { id: 1 });
    await first;
    workers[0].postMessage.mockImplementationOnce(() => {
      throw new Error("clone failed");
    });
    await expect(instance.request({})).rejects.toThrow("clone failed");
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0].postMessage).toHaveBeenLastCalledWith({ type: "close" });
  });

  it("recovers from synchronous startup failures", async () => {
    const instance = service();
    construction.fail = true;
    await expect(instance.request({})).rejects.toThrow("spawn failed");
    construction.fail = false;
    const next = instance.request({});
    await flush();
    workers[0].emit("message", { id: 1 });
    await next;
  });

  it("terminates when the graceful close message cannot be sent", async () => {
    const instance = service();
    const first = instance.request({});
    await flush();
    workers[0].emit("message", { id: 1 });
    await first;
    workers[0].postMessage.mockImplementationOnce(() => {
      throw new Error("port closed");
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects pending work and refuses new requests after shutdown", async () => {
    const instance = service();
    const pending = instance.request({});
    const rejected = expect(pending).rejects.toThrow("Worker unavailable");
    await flush();
    await instance.close();
    await rejected;
    await instance.close();
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    await expect(instance.request({})).rejects.toThrow("Worker unavailable");
  });

  it("does not spawn queued requests when shutdown begins during retirement", async () => {
    const instance = service();
    const first = instance.request({});
    await flush();
    workers[0].emit("message", { id: 1 });
    await first;
    await vi.advanceTimersByTimeAsync(1);
    const next = instance.request({});
    const rejected = expect(next).rejects.toThrow("Worker unavailable");
    const closing = instance.close();
    workers[0].emit("exit", 0);
    await closing;
    await rejected;
    expect(workers).toHaveLength(1);
  });

  it("does not create workers when closed before first dispatch", async () => {
    const instance = service();
    const pending = instance.request({});
    const rejected = expect(pending).rejects.toThrow("Worker unavailable");
    await instance.close();
    await rejected;
    expect(workers).toHaveLength(0);
  });
});

describe("background services", () => {
  function inspectionService(path: string | undefined = "state") {
    const run = vi.fn();
    let scans = 0;
    const inspection = {
      db: { prepare: vi.fn(() => ({ run })) },
      start: vi.fn(() => `scan-${++scans}`),
      run: vi.fn().mockResolvedValue(undefined),
    };
    const instance = new InspectionService(
      inspection as unknown as LocalInspection,
      path,
    );
    services.push(instance);
    return { instance, inspection, run };
  }

  it("preserves inspection coalescing and runs follow-up collection before retiring", async () => {
    const { instance, inspection } = inspectionService();
    expect(workers).toHaveLength(0);
    const manual = instance.start(workspace);
    expect(instance.start(workspace)).toBe(manual);
    const collection = instance.start(workspace, "collection");
    await flush();
    expect(inspection.start).toHaveBeenCalledTimes(1);
    expect(workers[0].postMessage).toHaveBeenLastCalledWith({
      id: 1,
      runId: "scan-1",
      workspace,
      force: true,
    });
    workers[0].emit("message", { id: 1 });
    await manual;
    await flush();
    expect(inspection.start).toHaveBeenCalledTimes(2);
    expect(workers).toHaveLength(1);
    expect(workers[0].postMessage).toHaveBeenLastCalledWith({
      id: 2,
      runId: "scan-2",
      workspace,
      force: false,
    });
    workers[0].emit("message", { id: 2 });
    await collection;
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0].postMessage).toHaveBeenLastCalledWith({ type: "close" });
  });

  it("marks a crashed inspection run failed and allows the queued workspace to retry", async () => {
    const { instance, inspection, run } = inspectionService();
    const first = instance.start(workspace);
    const rejected = expect(first).rejects.toThrow("Inspection unavailable");
    const nextWorkspace = { ...workspace, id: "next" };
    const next = instance.start(nextWorkspace, "collection");
    await flush();
    workers[0].emit("error", new Error("crash"));
    await rejected;
    await flush();
    expect(instance.available).toBe(true);
    expect(inspection.db.prepare).toHaveBeenLastCalledWith(
      expect.stringContaining("WHERE id=?"),
    );
    expect(run).toHaveBeenLastCalledWith(expect.any(Number), "scan-1");
    expect(workers).toHaveLength(2);
    workers[1].emit("message", { id: 2 });
    await next;
  });

  it("keeps in-process inspection available without a worker path", async () => {
    const { instance, inspection } = inspectionService("");
    await instance.start(workspace, "collection");
    expect(workers).toHaveLength(0);
    expect(inspection.run).toHaveBeenCalledWith(workspace, "scan-1", false);
  });

  it("cancels inspection shutdown without marking the run failed", async () => {
    const { instance, inspection } = inspectionService();
    const pending = instance.start(workspace);
    const rejected = expect(pending).rejects.toThrow("Inspection unavailable");
    await flush();
    await instance.close();
    await rejected;
    expect(instance.available).toBe(false);
    expect(inspection.db.prepare.mock.calls.map(([sql]) => sql).join(" ")).not.toContain(
      "status='failed'",
    );
    await expect(instance.start(workspace)).rejects.toThrow("Inspection unavailable");
  });

  it("preserves subsequent achievement evaluations and retires after the queue drains", async () => {
    const instance = new AchievementService("state");
    services.push(instance);
    expect(workers).toHaveLength(0);
    const first = instance.evaluate(workspace, 1);
    const next = instance.evaluate(workspace, 1);
    await flush();
    expect(workers[0].postMessage).toHaveBeenCalledTimes(1);
    workers[0].emit("message", { id: 1 });
    await first;
    await flush();
    expect(workers).toHaveLength(1);
    expect(workers[0].postMessage).toHaveBeenLastCalledWith({
      id: 2,
      workspace,
      sourceErrors: 1,
    });
    workers[0].emit("message", { id: 2 });
    await next;
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0].postMessage).toHaveBeenLastCalledWith({ type: "close" });
  });

  it("preserves overview backpressure, validation errors and idle recycling", async () => {
    const instance = new OverviewService("state");
    services.push(instance);
    expect(workers).toHaveLength(0);
    const queries = Array.from({ length: 8 }, () => instance.query(workspace, {}));
    await expect(instance.query(workspace, {})).rejects.toMatchObject({ status: 429 });
    await flush();
    expect(workers).toHaveLength(1);
    for (let id = 1; id <= 8; id++)
      workers[0].emit("message", { id, result: { summary: { sessions: id } } });
    await Promise.all(queries);
    const invalid = instance.query(workspace, { range: "bad" });
    const rejected = expect(invalid).rejects.toMatchObject({
      message: "Invalid range",
      status: 400,
    });
    await flush();
    workers[0].emit("message", { id: 9, error: "Invalid range", status: 400 });
    await rejected;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(workers[0].postMessage).toHaveBeenCalledTimes(9);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0].postMessage).toHaveBeenLastCalledWith({ type: "close" });
    workers[0].emit("exit", 0);
    const next = instance.query(workspace, {});
    await flush();
    expect(workers).toHaveLength(2);
    workers[1].emit("message", { id: 10, result: { summary: { sessions: 42 } } });
    await expect(next).resolves.toMatchObject({ summary: { sessions: 42 } });
  });
});
