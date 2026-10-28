import { Worker } from "node:worker_threads";
import type { LocalHistory, LocalWorkspace } from "@varveai/adit-core";
import type { CollectionJob, Provider } from "./collector.js";

export type CollectionScanRequest = {
  directory: string;
  path: string;
  workspace?: LocalWorkspace;
  workspaces?: LocalWorkspace[];
  sources: Provider[];
  job: CollectionJob;
  jobs?: CollectionJob[];
};
export type CollectionScanResult = Awaited<ReturnType<LocalHistory["scan"]>>;

/** One worker per scan; wait for its SQLite connection to close before continuing. */
export function scanHistoryInBackground(
  request: CollectionScanRequest,
  signal: AbortSignal,
  workerUrl = new URL("./collection-worker.js", import.meta.url),
): Promise<CollectionScanResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: request });
    let result: CollectionScanResult | undefined;
    let failure: Error | undefined;
    const cancel = () => {
      void worker.terminate();
    };
    signal.addEventListener("abort", cancel, { once: true });
    worker.on("message", (message) => {
      if (message.error) failure = new Error(message.error);
      else result = message.result;
    });
    worker.on("error", (error) => {
      failure =
        error instanceof Error ? error : new Error("Collection worker failed");
    });
    worker.on("exit", (code) => {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) reject(new Error("Collection interrupted"));
      else if (failure) reject(failure);
      else if (code !== 0 || !result)
        reject(new Error("Collection worker stopped before completing"));
      else resolve(result);
    });
    if (signal.aborted) cancel();
  });
}
