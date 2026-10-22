import { parentPort, workerData } from "node:worker_threads";
import { LocalStore, LocalAnalytics, LocalSharing, LocalPrDescriptions } from "@varveai/adit-core";
const { directory, workspaceId, kind, input } = workerData;
let store: LocalStore | undefined, analytics: LocalAnalytics | undefined;
try {
  store = new LocalStore(directory); analytics = new LocalAnalytics(store.db);
  const workspace = store.workspace(workspaceId);
  const value = kind === "pr" ? new LocalPrDescriptions(store.db).generate(workspace, input.scope, input.options, input.template, input.jobId)
    : kind === "share-create" ? new LocalSharing(store.db, analytics.prices).create(workspace, input.provider, input.sessionId, input)
    : new LocalSharing(store.db, analytics.prices).update(workspace, input.id, input);
  parentPort?.postMessage({ value });
} catch (error) {
  const busy = /^SQLITE_(BUSY|LOCKED)/.test(String((error as { code?: string })?.code || ""));
  parentPort?.postMessage({ error: busy ? "The local database is busy. Try again shortly." : error instanceof Error ? error.message : "Publication failed", status: busy ? 503 : (error as { status?: number })?.status || 400 });
} finally { await analytics?.prices.close(); store?.close(); }
