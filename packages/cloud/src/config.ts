/**
 * Cloud sync configuration.
 *
 * Loaded from environment variables with sensible defaults.
 * Cloud sync is entirely optional — when serverUrl is null,
 * all cloud features are disabled.
 */

import { normalizeServerUrl } from "@varveai/adit-core";

export interface CloudConfig {
  /** Cloud server URL (e.g., "https://adit-cloud.varve.ai") */
  serverUrl: string | null;
  /** Whether cloud sync is enabled */
  enabled: boolean;
  /** Auto-sync after hook events (fire-and-forget) */
  autoSync: boolean;
  /** Max records per sync batch (server limit: 500) */
  batchSize: number;
  /** Minimum unsynced events before auto-sync triggers (default: 10) */
  syncThreshold: number;
  /** Hours since last successful sync before auto-sync triggers regardless of count (default: 2) */
  syncTimeoutHours: number;
}

/** Default cloud server URL */
export const DEFAULT_SERVER_URL = "https://adit-cloud.varve.ai";

/** Load cloud configuration from environment variables */
export function loadCloudConfig(): CloudConfig {
  const configuredServerUrl = process.env.ADIT_CLOUD_URL;
  const serverUrl = configuredServerUrl
    ? normalizeServerUrl(configuredServerUrl)
    : null;

  // Cloud is enabled unless explicitly disabled via env var.
  // When ADIT_CLOUD_ENABLED is not set, enabled is true — actual
  // activation depends on credentials existing (checked by auto-sync).
  const enabled = process.env.ADIT_CLOUD_ENABLED !== "false";

  // Auto-sync is enabled by default when credentials exist.
  // Only disabled when explicitly set to "false".
  const autoSync = process.env.ADIT_CLOUD_AUTO_SYNC !== "false";

  return {
    serverUrl,
    enabled,
    autoSync,
    batchSize: Math.min(
      parseInt(process.env.ADIT_CLOUD_BATCH_SIZE ?? "500", 10) || 500,
      500, // Server hard limit
    ),
    syncThreshold: parseSyncThreshold(
      process.env.ADIT_CLOUD_SYNC_THRESHOLD,
    ),
    syncTimeoutHours: parseSyncTimeoutHours(
      process.env.ADIT_CLOUD_SYNC_TIMEOUT_HOURS,
    ),
  };
}

function parseSyncTimeoutHours(raw: string | undefined): number {
  const DEFAULT = 2;
  if (raw === undefined) return DEFAULT;
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT;
  return parsed;
}

function parseSyncThreshold(raw: string | undefined): number {
  const DEFAULT = 10;
  if (raw === undefined) return DEFAULT;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return DEFAULT;
  return Math.max(parsed, 1);
}
