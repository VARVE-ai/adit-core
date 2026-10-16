/** Conversation data sync followed by Git metadata sync for the same trigger. */

import type Database from "better-sqlite3";
import { normalizeServerUrl } from "@varveai/adit-core";
import type { CloudClient } from "../http/client.js";
import type { CloudProjectContext } from "../project-context.js";
import { repositoryPayloads } from "../project-context.js";
import { syncLinkedGitMetadata, type GitSyncResult } from "../project-link/git-sync.js";
import { SyncEngine, type SyncResult } from "./engine.js";
import type { RuntimeReport, UpgradeNotice } from "./runtime-report.js";

export interface SyncCycleResult extends SyncResult {
  /** Null when the caller chose not to inspect Git without a new Event batch. */
  git: GitSyncResult | null;
  upgrade?: UpgradeNotice;
  runtimeReportError?: string;
}

export async function runSyncCycle(options: {
  db: Database.Database;
  client: CloudClient;
  projectContext: CloudProjectContext;
  batchSize: number;
  serverUrl: string;
  cloudClientId: string;
  dataDir?: string;
  /** Manual syncs inspect Git even when conversation data is already current. */
  syncGitWhenNoBatches?: boolean;
  /** Manual commands bypass the hourly remote branch check cooldown. */
  forceRemoteBranchCheck?: boolean;
  collectRuntimeReport?: () => Promise<RuntimeReport>;
  runtimeClient?: Pick<CloudClient, "post">;
}): Promise<SyncCycleResult> {
  const serverUrl = normalizeServerUrl(options.serverUrl);
  // Init changes must reach Cloud even when there are no new events or no
  // selected repositories. The server applies each saved revision once.
  if (options.projectContext.registration) {
    await options.client.post("/api/project-link/registration", options.projectContext.registration);
  }
  const engine = new SyncEngine(options.db, options.client, {
    projectId: options.projectContext.localProjectId,
    projectName: options.projectContext.projectName,
    projectType: options.projectContext.projectType,
    repositories: repositoryPayloads(options.projectContext.repositories),
    remoteUrl: options.projectContext.remoteUrl,
    canonicalRepoKey: options.projectContext.canonicalRepoKey,
    batchSize: options.batchSize,
    serverUrl,
    cloudClientId: options.cloudClientId,
    dataDir: options.dataDir,
  });

  const sync = await engine.sync();
  const git = sync.batches === 0 && !options.syncGitWhenNoBatches ? null : await syncLinkedGitMetadata(
    options.db,
    options.client,
    options.projectContext,
    serverUrl,
    { forceRemoteBranchCheck: options.forceRemoteBranchCheck },
  );
  const result: SyncCycleResult = { ...sync, git };
  // Optional diagnostics run after business data and never fail its sync.
  if (options.collectRuntimeReport && options.runtimeClient) {
    try {
      const report = await options.collectRuntimeReport();
      const response = await options.runtimeClient.post<{ upgrade: UpgradeNotice }>("/api/sync/runtime", report);
      if (response?.upgrade) result.upgrade = response.upgrade;
    } catch {
      result.runtimeReportError = "Version and diagnostic report was not uploaded. It will retry on the next sync.";
    }
  }
  return result;
}
