/**
 * Auto-sync trigger — coordinated sync after stable hook events.
 *
 * Called from the hooks system via dynamic import. Fully fail-open:
 * any error is swallowed so it never blocks the AI agent.
 *
 * Sync is triggered when any of the following is true:
 * - The number of unsynced events meets the configured threshold
 *   (ADIT_CLOUD_SYNC_THRESHOLD, default 10). Only events count toward
 *   the threshold; session records and diffs ride along in the batch
 *   once a sync is triggered. Environment snapshots remain local. OR
 * - More than syncTimeoutHours (default 2h) have elapsed since
 *   the last successful sync (ADIT_CLOUD_SYNC_TIMEOUT_HOURS).
 *
 * The time-based trigger is checked first using the already-loaded
 * sync_state row (single PK lookup), skipping the events COUNT query
 * when the timeout has elapsed.
 *
 * Once a conversation batch succeeds, linked repositories get an incremental
 * Git metadata refresh. Project documents are never uploaded here.
 * Failed syncs are picked up on a later trigger.
 */

import type Database from "better-sqlite3";
import { getSyncState, loadConfig } from "@varveai/adit-core";
import { loadCloudConfig, DEFAULT_SERVER_URL } from "../config.js";
import {
  loadCredentials,
  credentialsFromEnvToken,
  incrementSyncErrors,
  clearSyncErrors,
  isSyncDisabled,
  recordAuthFailure,
  type CloudCredentials,
} from "../auth/credentials.js";
import { CloudClient } from "../http/client.js";
import { CloudNetworkError, CloudAuthError } from "../http/errors.js";
import { runSyncCycle } from "./sync-cycle.js";
import { countUnsyncedEvents } from "./serializer.js";
import { hasPendingTokenUsage } from "./token-usage.js";
import { resolveCloudProjectContext } from "../project-context.js";

/**
 * Trigger a sync cycle if credentials exist and the unsynced Event
 * count meets the threshold (or the time trigger fires).
 *
 * The hook awaits this function so the database stays open for the complete
 * Event → Session/Diff → Git cycle.
 *
 * Precondition checks (in order):
 * 1. Valid credentials present (client is authenticated)
 * 2. Resolve server URL: env var takes priority, falls back to credentials
 * 3. Auto-sync not explicitly disabled (ADIT_CLOUD_AUTO_SYNC !== "false")
 * 4. Time-based trigger: >syncTimeoutHours since last sync (skips count)
 * 5. Count-based trigger: unsynced event count >= syncThreshold
 *
 * If any check fails, the function returns silently. Failed events
 * remain unsynced and will be retried on the next trigger.
 */
export async function triggerAutoSync(
  db: Database.Database,
  _projectId: string,
  options?: { projectRoot?: string },
): Promise<void> {
  const cloudConfig = loadCloudConfig();

  // 0. Circuit breaker — skip if too many consecutive failures
  if (isSyncDisabled()) return;

  // 1. Check credentials exist — credentials are the implicit opt-in.
  //    ADIT_AUTH_TOKEN env var takes priority over stored credentials
  //    (enables CI/CD and headless use without writing credentials first).
  let credentials: CloudCredentials | null = null;
  if (process.env.ADIT_AUTH_TOKEN) {
    const serverUrl = cloudConfig.serverUrl ?? DEFAULT_SERVER_URL;
    // Prefer stored credentials' clientId (set by `auth-token` verification)
    // over the local config clientId, since the server assigns its own UUID.
    const stored = loadCredentials();
    const clientId = stored?.clientId ?? loadConfig().clientId;
    credentials = credentialsFromEnvToken(serverUrl, clientId);
  }
  if (!credentials) {
    credentials = loadCredentials();
  }
  if (!credentials) return;

  // 2. Resolve server URL: env var takes priority, fall back to credentials
  const serverUrl = cloudConfig.serverUrl ?? credentials.serverUrl;
  if (!serverUrl) return;

  // 2a. If env var specifies a different server than credentials, skip
  //     (single-server binding: don't send credentials to wrong server)
  if (cloudConfig.serverUrl && credentials.serverUrl !== cloudConfig.serverUrl) {
    return;
  }

  // 3. Auto-sync is enabled by default when credentials exist.
  //    Only skip if explicitly disabled via ADIT_CLOUD_AUTO_SYNC=false
  //    or ADIT_CLOUD_ENABLED=false.
  if (process.env.ADIT_CLOUD_AUTO_SYNC === "false") return;
  if (process.env.ADIT_CLOUD_ENABLED === "false") return;

  // 3b. Resolve the project once — the SAME config drives both the trigger
  //     decision and the actual upload, so the two can never disagree about
  //     which project this is. A damaged or un-migrated project never syncs.
  let projectConfig: ReturnType<typeof loadConfig>;
  try {
    projectConfig = options?.projectRoot ? loadConfig(options.projectRoot) : loadConfig();
  } catch {
    return;
  }
  if (projectConfig.initialization !== "initialized") return;
  const projectId = projectConfig.projectId;

  // 4. Check sync triggers.
  const syncState = getSyncState(db, serverUrl);

  // 4a. Time-based trigger: if more than syncTimeoutHours since last successful sync,
  //     skip the events COUNT and trigger sync directly. Only applies when we
  //     have a previous sync timestamp (first sync uses count-based).
  const timeoutMs = cloudConfig.syncTimeoutHours * 60 * 60 * 1000;
  const timeTriggered =
    syncState?.lastSyncedAt != null &&
    Date.now() - new Date(syncState.lastSyncedAt).getTime() > timeoutMs;

  // 4b. Count-based trigger: only run the count if time didn't trigger.
  if (!timeTriggered) {
    const unsyncedCount = countUnsyncedEvents(
      db,
      syncState?.lastSyncedEventId ?? null,
      projectId,
    );

    if (unsyncedCount < cloudConfig.syncThreshold && !hasPendingTokenUsage(db, {
      projectId, serverUrl, cloudClientId: credentials.clientId,
    })) {
      return;
    }
  }

  // 5. Attempt sync — CloudClient handles token refresh, retries,
  //    and reachability internally. Network errors are caught below.
  try {
    const projectContext = await resolveCloudProjectContext(projectConfig);
    // Tight budget: the hook process is hard-killed after 10s, so a dead
    // request must not eat the whole window in backoff loops.
    const client = new CloudClient(serverUrl, credentials, {
      timeoutMs: 5_000,
      maxRetries: 1,
    });
    const result = await runSyncCycle({
      db,
      client,
      projectContext,
      batchSize: cloudConfig.batchSize,
      serverUrl,
      cloudClientId: credentials.clientId,
      dataDir: projectConfig.dataDir,
    });
    if (process.env.ADIT_DEBUG && result.git?.failures.length) {
      for (const failure of result.git.failures) {
        process.stderr.write(
          `[adit-cloud] git sync failed for ${failure.relativePath}: ${failure.message}\n`,
        );
      }
    }
    clearSyncErrors();
  } catch (error) {
    // Track consecutive failures — disable sync after threshold
    const disabled = incrementSyncErrors();
    if (error instanceof CloudAuthError) {
      recordAuthFailure({
        stage: "auto-sync",
        message: error.message,
      });
    }

    // Fail silently — this is fire-and-forget.
    // CloudNetworkError: server unreachable, will retry next trigger
    // CloudAuthError: credentials invalid, user needs to re-login
    // Any other error: unexpected, but still fail-open
    if (process.env.ADIT_DEBUG) {
      const msg =
        error instanceof CloudNetworkError
          ? `[adit-cloud] auto-sync skipped: server unreachable — ${error.message}`
          : error instanceof CloudAuthError
            ? `[adit-cloud] auto-sync skipped: auth failed — ${error.message}`
            : `[adit-cloud] auto-sync failed: ${error instanceof Error ? error.message : String(error)}`;
      process.stderr.write(msg + "\n");
      if (disabled) {
        process.stderr.write(
          "[adit-cloud] auto-sync disabled after repeated failures. Run 'adit cloud sync' to re-enable.\n",
        );
      }
    }
  }
}
