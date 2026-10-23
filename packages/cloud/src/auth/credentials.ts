/** Cloud login belongs to the selected local.sqlite, never the legacy CLI JSON file. */
import { localDataDir, normalizeServerUrl } from "@varveai/adit-core";
import { randomUUID } from "node:crypto";
import {
  credentialDatabase,
  readCredential,
  writeCredential,
  sameCredential,
  activeCredentialLock,
  acquireCredentialLock,
  releaseCredentialLock,
} from "./credential-database.js";

export type CloudAuthFailureStage =
  | "refresh"
  | "request"
  | "auto-sync"
  | "status";

export interface CloudAuthFailure {
  /** ISO 8601 timestamp when the auth failure was observed */
  at: string;
  /** Part of the auth flow that failed */
  stage: CloudAuthFailureStage;
  /** Human-readable error message */
  message: string;
  /** HTTP status when available */
  status?: number;
  /** Server-provided reason/code when available */
  code?: string;
}

export interface CloudCredentials {
  /** Changes on every login; prevents a stale refresh from restoring a logged-out account. */
  credentialId?: string;
  accountId?: string;
  accountName?: string;
  accountEmail?: string;
  checkedAt?: string;
  reachable?: boolean;
  authStatus?: "valid" | "expired";
  /** Authentication type: "device" (default) or "token" (static JWT) */
  authType?: "device" | "token";
  /** JWT access token (1-hour expiry for device, static for token) */
  accessToken: string;
  /** Opaque refresh token (90-day expiry); empty string for token auth */
  refreshToken: string;
  /** Server-assigned client UUID */
  clientId: string;
  /** Access token expiration (ISO 8601); empty string for token auth (never expires) */
  expiresAt: string;
  /** Server URL these credentials belong to */
  serverUrl: string;
  /** Consecutive sync error count (circuit breaker) */
  syncErrorCount?: number;
  /** True when circuit breaker has tripped (sync disabled) */
  syncDisabled?: boolean;
  /** ISO 8601 timestamp of the first error in the current failure window */
  firstSyncErrorAt?: string;
  /** Most recent auth/refresh failure observed by auto-sync or CloudClient */
  lastAuthFailure?: CloudAuthFailure;
}

/** Read only the current data directory. Legacy credentials are never imported. */
export function loadCredentials(
  directory = localDataDir(),
): CloudCredentials | null {
  return credentialDatabase(directory, false, (db) =>
    readCredential(db, directory),
  );
}

/** Tokens are AES-GCM encrypted; the per-database key is protected by the OS. */
export function saveCredentials(
  creds: CloudCredentials,
  directory = localDataDir(),
  loginGeneration?: string,
): void {
  credentialDatabase(directory, true, (db) =>
    db.transaction(() => {
      if (loginGeneration) {
        const current = db.prepare("SELECT data FROM adit_local_settings WHERE key='cloud-login-generation'").get() as { data: string } | undefined;
        if (!current || JSON.parse(current.data) !== loginGeneration)
          throw new Error("Login cancelled or replaced. Please try again.");
      }
      writeCredential(db, directory, creds);
    }).immediate(),
  );
}

/** A conditional logout cannot remove a newer login made by another process. */
export function clearCredentials(
  directory = localDataDir(),
  expected?: CloudCredentials,
): void {
  credentialDatabase(directory, false, (db) =>
    db
      .transaction(() => {
        if (expected) {
          const current = readCredential(db, directory);
          if (!current || !sameCredential(current, expected)) return;
        }
        db.prepare("DELETE FROM adit_cloud_credentials WHERE id=1").run();
      })
      .immediate(),
  );
}

/** Invalidate pending CLI/page logins and clear the account in one transaction. */
export function logoutCredentials(directory = localDataDir()): CloudCredentials | null {
  return credentialDatabase(directory, true, db => db.transaction(() => {
    const current = readCredential(db,directory);
    const set = db.prepare("INSERT INTO adit_local_settings(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data");
    set.run("cloud-login-generation", JSON.stringify(randomUUID()));
    if (current) set.run("cloud-server", JSON.stringify({url:current.serverUrl}));
    db.prepare("DELETE FROM adit_cloud_credentials WHERE id=1").run();
    return current;
  }).immediate());
}

/** Check if the access token has expired (with 60s safety margin) */
export function isTokenExpired(creds: CloudCredentials): boolean {
  // Static tokens never expire
  if (creds.authType === "token") return false;
  if (!creds.expiresAt) return true;
  const expiresAt = new Date(creds.expiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return true;
  const safetyMarginMs = 60_000; // Refresh 60s before actual expiry
  return Date.now() >= expiresAt - safetyMarginMs;
}

/** Atomic metadata update, always based on the latest token pair. */
function tryLockedCredentialsUpdate(
  mutate: (creds: CloudCredentials) => CloudCredentials | null,
  directory = localDataDir(),
  expected?: CloudCredentials,
  alreadyLocked = false,
): boolean {
  try {
    return (
      credentialDatabase(directory, false, (db) =>
        db
          .transaction(() => {
            if (!alreadyLocked && activeCredentialLock(db)) return false;
            const current = readCredential(db, directory);
            if (!current || (expected && !sameCredential(current, expected)))
              return false;
            const next = mutate(current);
            if (!next) return false;
            writeCredential(db, directory, next);
            return true;
          })
          .immediate(),
      ) ?? false
    );
  } catch {
    return false;
  }
}

export type CloudAccountMetadata = Pick<
  CloudCredentials,
  | "accountId"
  | "accountName"
  | "accountEmail"
  | "checkedAt"
  | "reachable"
  | "authStatus"
>;
export function updateCloudAccountMetadata(
  metadata: CloudAccountMetadata,
  expected: CloudCredentials,
  directory = localDataDir(),
): boolean {
  return tryLockedCredentialsUpdate(
    (creds) => ({ ...creds, ...metadata }),
    directory,
    expected,
  );
}

/** Record the most recent auth failure for diagnostics in `adit cloud status`. */
export function recordAuthFailure(
  failure: Omit<CloudAuthFailure, "at"> & { at?: string },
  directory = localDataDir(),
  expected?: CloudCredentials,
): void {
  tryLockedCredentialsUpdate(
    (creds) => withAuthFailure(creds, failure),
    directory,
    expected,
  );
}

/**
 * Unlocked variant for callers that already hold the credentials refresh
 * lock (e.g. CloudClient.refreshToken error paths). Calling the locked
 * variant there would fail to acquire the lock and silently skip.
 */
export function recordAuthFailureUnlocked(
  failure: Omit<CloudAuthFailure, "at"> & { at?: string },
  directory = localDataDir(),
  expected?: CloudCredentials,
): void {
  tryLockedCredentialsUpdate(
    (creds) => withAuthFailure(creds, failure),
    directory,
    expected,
    true,
  );
}

function withAuthFailure(
  creds: CloudCredentials,
  failure: Omit<CloudAuthFailure, "at"> & { at?: string },
): CloudCredentials {
  return {
    ...creds,
    lastAuthFailure: {
      ...failure,
      at: failure.at ?? new Date().toISOString(),
    },
  };
}

/** Clear the stored auth failure after a successful authenticated request. */
export function clearAuthFailure(
  directory = localDataDir(),
  expected?: CloudCredentials,
): void {
  tryLockedCredentialsUpdate(
    (creds) =>
      creds.lastAuthFailure ? { ...creds, lastAuthFailure: undefined } : null,
    directory,
    expected,
  );
}

/** Serialize refresh across CLI, hooks and local web processes in this database. */
export async function withCredentialsRefreshLock<T>(
  fn: () => Promise<T>,
  directory = localDataDir(),
): Promise<T> {
  for (let attempt = 0; attempt < 160; attempt++) {
    const owner = acquireCredentialLock(directory);
    if (owner) {
      try {
        return await fn();
      } finally {
        releaseCredentialLock(directory, owner);
      }
    }
    await sleep(Math.min(50 + attempt * 25, 250));
  }
  throw new Error("Timed out waiting for cloud credential refresh lock");
}

/**
 * Create in-memory credentials from the ADIT_AUTH_TOKEN env var.
 * Returns null if the env var is not set.
 */
export function credentialsFromEnvToken(
  serverUrl: string,
  clientId: string,
): CloudCredentials | null {
  const token = process.env.ADIT_AUTH_TOKEN;
  if (!token) return null;
  return {
    authType: "token",
    accessToken: token,
    refreshToken: "",
    clientId,
    expiresAt: "",
    serverUrl: normalizeServerUrl(serverUrl),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default circuit breaker window in milliseconds (1 hour) */
const CIRCUIT_BREAKER_WINDOW_MS = 60 * 60 * 1000;

/**
 * Increment the sync error counter in stored credentials.
 *
 * The circuit breaker uses a time-windowed approach: errors are only
 * counted within a rolling window (default 1 hour). If the first error
 * in the current window is older than the window, the counter resets
 * before incrementing. This ensures that transient outages don't
 * permanently disable auto-sync.
 *
 * Returns true if sync is now disabled (threshold reached within window).
 */
export function incrementSyncErrors(
  threshold = 5,
  directory = localDataDir(),
  expected?: CloudCredentials,
): boolean {
  let disabled = false;

  tryLockedCredentialsUpdate(
    (creds) => {
      const now = new Date().toISOString();
      let count = creds.syncErrorCount ?? 0;
      let firstErrorAt = creds.firstSyncErrorAt ?? now;

      // If the first error is outside the window, reset the counter
      const elapsed = Date.now() - new Date(firstErrorAt).getTime();
      if (elapsed > CIRCUIT_BREAKER_WINDOW_MS) {
        count = 0;
        firstErrorAt = now;
      }

      count += 1;
      disabled = count >= threshold;

      return {
        ...creds,
        syncErrorCount: count,
        syncDisabled: disabled,
        firstSyncErrorAt: firstErrorAt,
      };
    },
    directory,
    expected,
  );

  return disabled;
}

/** Reset sync error counter and re-enable sync. */
export function clearSyncErrors(
  directory = localDataDir(),
  expected?: CloudCredentials,
): void {
  tryLockedCredentialsUpdate(
    (creds) => {
      if (!creds.syncErrorCount && !creds.syncDisabled) return null;
      return {
        ...creds,
        syncErrorCount: 0,
        syncDisabled: false,
        firstSyncErrorAt: undefined,
      };
    },
    directory,
    expected,
  );
}

/**
 * Check if sync has been disabled by the circuit breaker.
 *
 * If the breaker is tripped but the error window has expired (>1 hour
 * since the first error), automatically resets the breaker and returns
 * false — giving auto-sync another chance.
 */
export function isSyncDisabled(directory = localDataDir()): boolean {
  const creds = loadCredentials(directory);
  if (creds?.syncDisabled !== true) return false;

  // Auto-reset if the error window has expired
  const firstErrorAt = creds.firstSyncErrorAt;
  if (firstErrorAt) {
    const elapsed = Date.now() - new Date(firstErrorAt).getTime();
    if (elapsed > CIRCUIT_BREAKER_WINDOW_MS) {
      clearSyncErrors(directory, creds);
      return false;
    }
  }

  return true;
}
