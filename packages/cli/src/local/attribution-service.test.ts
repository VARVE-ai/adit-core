import { afterEach, expect, it, vi } from "vitest";
import type { LocalWorkspace } from "@varveai/adit-core";
import { AttributionService } from "./attribution-service.js";

type TestWorker = {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => boolean;
};
const { workers } = vi.hoisted(() => ({ workers: [] as TestWorker[] }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { Worker: class extends EventEmitter {
    constructor() { super(); workers.push(this); }
    postMessage = vi.fn();
    terminate = vi.fn(async () => { this.emit("exit", 1); return 1; });
  } };
});

const services: AttributionService[] = [];
const workspace = { id: "workspace" } as LocalWorkspace;
function service(needed?: (workspace: LocalWorkspace) => boolean) {
  const instance = new AttributionService("state", undefined, needed);
  services.push(instance);
  return instance;
}
afterEach(async () => {
  for (const worker of workers) worker.emit("exit", 0);
  await Promise.all(services.splice(0).map(instance => instance.close()));
  workers.length = 0;
});

it("does not create an analysis worker until the metadata check finds pending work", async () => {
  const needed = vi.fn(() => false);
  const instance = service(needed);
  await instance.analyze(workspace);
  expect(needed).toHaveBeenCalledWith(workspace);
  expect(workers).toHaveLength(0);
  needed.mockReturnValue(true);
  const pending = instance.analyze(workspace);
  await Promise.resolve();
  expect(workers).toHaveLength(1);
  workers[0].emit("message", { id: 1 });
  await pending;
  workers[0].emit("exit", 0);
  needed.mockReturnValue(false);
  await instance.analyze(workspace);
  expect(workers).toHaveLength(1);
});

it("starts lazily, drains all pending analyses and waits for idle exit before restarting", async () => {
  const instance = service();
  expect(workers).toHaveLength(0);
  const first = instance.analyze(workspace), second = instance.analyze(workspace);
  await Promise.resolve();
  expect(workers).toHaveLength(1);
  const worker = workers[0];
  worker.emit("message", { id: 2 });
  await second;
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  worker.emit("message", { id: 999 });
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  worker.emit("message", { id: 1 });
  await first;
  expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "close" });
  expect(worker.terminate).not.toHaveBeenCalled();
  const next = instance.analyze(workspace);
  await Promise.resolve();
  expect(workers).toHaveLength(1);
  worker.emit("exit", 0);
  await Promise.resolve();
  expect(workers).toHaveLength(2);
  workers[1].emit("message", { id: 3 });
  await next;
});

it("reports analysis errors and permits subsequent work after graceful exit", async () => {
  const instance = service();
  const failed = instance.analyze(workspace);
  const rejection = expect(failed).rejects.toThrow("analysis failed");
  await Promise.resolve();
  workers[0].emit("message", { id: 1, error: "analysis failed" });
  await rejection;
  expect(workers[0].postMessage).toHaveBeenLastCalledWith({ type: "close" });
  workers[0].emit("exit", 0);
  const next = instance.analyze(workspace);
  await Promise.resolve();
  workers[1].emit("message", { id: 2 });
  await next;
});

it.each(["error", "exit"])("rejects queued work on worker %s and starts a fresh worker on retry", async event => {
  const instance = service();
  const first = instance.analyze(workspace), second = instance.analyze(workspace);
  const rejected = Promise.all([expect(first).rejects.toThrow("已停止"), expect(second).rejects.toThrow("已停止")]);
  await Promise.resolve();
  workers[0].emit(event, event === "error" ? new Error("crash") : 1);
  await rejected;
  const next = instance.analyze(workspace);
  await Promise.resolve();
  expect(workers).toHaveLength(2);
  workers[1].emit("message", { id: 3 });
  await next;
});

it("rejects only an uncloneable request without interrupting other queued work", async () => {
  const instance = service();
  const first = instance.analyze(workspace);
  await Promise.resolve();
  workers[0].postMessage.mockImplementationOnce(() => { throw new Error("clone failed"); });
  await expect(instance.analyze(workspace)).rejects.toThrow("clone failed");
  expect(workers[0].terminate).not.toHaveBeenCalled();
  workers[0].emit("message", { id: 1 });
  await first;
});

it("closes active work and refuses new requests after service shutdown", async () => {
  const instance = service();
  const pending = instance.analyze(workspace);
  const rejected = expect(pending).rejects.toThrow("已停止");
  await Promise.resolve();
  await instance.close();
  await rejected;
  expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  await expect(instance.analyze(workspace)).rejects.toThrow("不可用");
});

it("does not start queued requests when shutdown begins during idle retirement", async () => {
  const instance = service();
  const first = instance.analyze(workspace);
  await Promise.resolve();
  workers[0].emit("message", { id: 1 });
  await first;
  const next = instance.analyze(workspace);
  const rejected = expect(next).rejects.toThrow("不可用");
  const closing = instance.close();
  workers[0].emit("exit", 0);
  await closing;
  await rejected;
  expect(workers).toHaveLength(1);
});
