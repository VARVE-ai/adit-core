import type { LocalStore, LocalWorkspace } from "@varveai/adit-core";
import type { CloudPending } from "./cloud-pending.js";
import { createCloudPendingSchema, pendingRevision } from "./cloud-pending-schema.js";
import { OnDemandWorker } from "./on-demand-worker.js";

export type CloudPendingStatus = (CloudPending | {
  state: "computing" | "failed"; sessions: null; commits: null;
}) & { refreshing?: boolean; error?: string };

type Snapshot = {
  identity: string;
  revision: number;
  value?: CloudPending;
  sessions: [string, { key: string; pending: boolean }][];
  running: boolean;
  retryAt: number;
  error?: string;
};

export class CloudPendingService {
  private snapshots = new Map<string, Snapshot>();
  private worker: OnDemandWorker;
  private stopped = false;

  constructor(private store: LocalStore, workerUrl = new URL("./cloud-pending-worker.js", import.meta.url)) {
    createCloudPendingSchema(store.db);
    this.worker = new OnDemandWorker(workerUrl, { path: store.dbPath }, () => new Error("Pending count unavailable"), { idleTimeout: 1000 });
  }

  read(workspace: LocalWorkspace, scope: string): CloudPendingStatus {
    const identity = JSON.stringify([scope, workspace.version, workspace.path, workspace.providers, workspace.repositories, workspace.repositoryPolicies]);
    let snapshot = this.snapshots.get(workspace.id);
    if (snapshot?.identity !== identity) {
      snapshot = { identity, revision: -1, sessions: [], running: false, retryAt: 0 };
      this.snapshots.set(workspace.id, snapshot);
    }
    const revision = pendingRevision(this.store.db);
    if (!snapshot.running && !this.stopped && snapshot.revision !== revision && Date.now() >= snapshot.retryAt) {
      this.refresh(workspace, scope, snapshot);
    }
    if (snapshot.error) return { ...(snapshot.value ?? { state: "failed", sessions: null, commits: null }), error: snapshot.error };
    if (!snapshot.value) return { state: "computing", sessions: null, commits: null };
    return snapshot.running ? { ...snapshot.value, refreshing: true } : snapshot.value;
  }

  private refresh(workspace: LocalWorkspace, scope: string, snapshot: Snapshot) {
    snapshot.running = true;
    snapshot.error = undefined;
    void this.worker.request<{ revision: number; value: CloudPending; sessions: Snapshot["sessions"] }>({
      workspace, scope, sessions: snapshot.sessions,
    }).then(result => {
      if (this.snapshots.get(workspace.id) !== snapshot || this.stopped) return;
      snapshot.revision = result.revision;
      snapshot.value = result.value;
      snapshot.sessions = result.sessions;
      snapshot.retryAt = 0;
    }).catch(() => {
      if (this.snapshots.get(workspace.id) !== snapshot || this.stopped) return;
      snapshot.error = "Pending count unavailable";
      snapshot.retryAt = Date.now() + 30_000;
    }).finally(() => { snapshot.running = false; });
  }

  forget(id: string) { this.snapshots.delete(id); }

  async close() {
    this.stopped = true;
    this.snapshots.clear();
    await this.worker.close();
  }
}
