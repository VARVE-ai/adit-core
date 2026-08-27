/** Conversation data sync followed by Git metadata sync for the same trigger. */

import type Database from "better-sqlite3";
import type { CloudClient } from "../http/client.js";
import type { CloudProjectContext } from "../project-context.js";
import { repositoryPayloads } from "../project-context.js";
import { syncLinkedGitMetadata, type GitSyncResult } from "../project-link/git-sync.js";
import { SyncEngine, type SyncResult } from "./engine.js";

export interface SyncCycleResult extends SyncResult {
  /** Null when no Event batch was uploaded, so Git was intentionally not checked. */
  git: GitSyncResult | null;
}

export async function runSyncCycle(options: {
  db: Database.Database;
  client: CloudClient;
  projectContext: CloudProjectContext;
  batchSize: number;
  serverUrl: string;
  cloudClientId: string;
  dataDir?: string;
}): Promise<SyncCycleResult> {
  const engine = new SyncEngine(options.db, options.client, {
    projectId: options.projectContext.localProjectId,
    projectName: options.projectContext.projectName,
    projectType: options.projectContext.projectType,
    repositories: repositoryPayloads(options.projectContext.repositories),
    remoteUrl: options.projectContext.remoteUrl,
    canonicalRepoKey: options.projectContext.canonicalRepoKey,
    batchSize: options.batchSize,
    serverUrl: options.serverUrl,
    cloudClientId: options.cloudClientId,
    dataDir: options.dataDir,
  });

  const sync = await engine.sync();
  if (sync.batches === 0) return { ...sync, git: null };

  const git = await syncLinkedGitMetadata(
    options.db,
    options.client,
    options.projectContext,
    options.serverUrl,
  );
  return { ...sync, git };
}
