/**
 * `adit cloud` — Cloud sync commands.
 *
 * Subcommands:
 *   login             — Authenticate via device code flow
 *   logout            — Clear stored credentials
 *   sync              — Push conversation records, then linked Git metadata
 *   status            — Show sync state and unsynced count
 *   auth reset        — Force-clear all credentials and sync state
 */

import {
  loadConfig,
  openDatabase,
  closeDatabase,
  normalizeServerUrl,
} from "@varveai/adit-core";
import { existsSync } from "node:fs";
import {
  loadCloudConfig,
  loadCredentials,
  saveCredentials,
  clearCredentials,
  isTokenExpired,
  requestDeviceCode,
  pollForToken,
  CloudClient,
  runSyncCycle,
  countUnsyncedEvents,
  CloudAuthError,
  CloudNetworkError,
  CloudApiError,
  clearSyncErrors,
  isSyncDisabled,
  DEFAULT_SERVER_URL,
  resolveCloudProjectContext,
} from "@varveai/adit-cloud";
import type { DeviceAuthOptions } from "@varveai/adit-cloud";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { basename } from "node:path";
import { CLI_VERSION } from "../version.js";
import { loadInitializedProjectConfig } from "./project-initialization.js";
import {
  dim,
  formatCount,
  formatDuration,
  formatRow,
  inTone,
  joinParts,
  localDate,
  localDateTime,
  localMoment,
  localTime,
  marks,
  plural,
  printEnd,
  printError,
  printLine,
  printRows,
  printTitle,
  printTransient,
  rowLabelWidth,
  shortId,
  stateWord,
  strong,
  type Row,
} from "./cli-style.js";

function serverHost(serverUrl: string): string {
  try {
    return new URL(serverUrl).host || serverUrl;
  } catch {
    return serverUrl;
  }
}

/** Rows shown after every login: what being logged in uploads, and how to stop it. */
function uploadDisclosureRows(): Row[] {
  return [
    {
      label: "Uploads",
      value: [
        "conversation events, sessions and code diffs, automatically (as recorded, not redacted)",
        "git metadata for linked projects, after each sync",
        `project documents only when you run ${strong("adit cloud link")}`,
      ].join("\n"),
    },
    { label: "Opt out", value: `ADIT_CLOUD_AUTO_SYNC=false, or ${strong("adit cloud logout")}` },
  ];
}

/**
 * `adit cloud login` — Interactive device authorization flow.
 *
 * `embedded` renders the rows inside an already open block (adit init)
 * instead of opening a block of its own.
 */
export async function cloudLoginCommand(opts?: {
  server?: string;
  embedded?: boolean;
}): Promise<void> {
  const serverUrl = normalizeServerUrl(
    opts?.server ?? process.env.ADIT_CLOUD_URL ?? DEFAULT_SERVER_URL,
  );
  const config = loadConfig();
  const embedded = opts?.embedded === true;
  const fail = (reason: string, hint?: string) => {
    if (embedded) printLine(`${marks.fail} ${reason}${hint ? dim(` · ${hint}`) : ""}`, { stream: "stderr" });
    else printError("login", reason, hint);
    process.exitCode = 1;
  };

  // Single-server binding: reject login if already bound to a different server
  const existingCredentials = loadCredentials();
  if (existingCredentials && existingCredentials.serverUrl !== serverUrl) {
    fail(
      `already logged in to ${existingCredentials.serverUrl}`,
      `a client connects to one cloud server at a time; run ${strong("adit cloud auth reset")} first, then retry`,
    );
    return;
  }

  if (!embedded) printTitle("Login", serverHost(serverUrl));

  // Build machine identifier (deterministic per-machine)
  const machineId = createHash("sha256")
    .update(`${hostname()}-${config.clientId}`)
    .digest("hex")
    .substring(0, 32);

  const authOptions: DeviceAuthOptions = {
    machineId,
    platform: `${process.platform}-${process.arch}`,
    aditVersion: CLI_VERSION,
    displayName: hostname(),
  };

  const labels = rowLabelWidth([{ label: "Approval" }, ...uploadDisclosureRows()]);
  try {
    // Step 1: Request device code
    const deviceCode = await requestDeviceCode(serverUrl, authOptions);

    printRows([
      { label: "Open", value: strong(deviceCode.verificationUrl) },
      { label: "Code", value: strong(deviceCode.userCode) },
    ], labels);
    printTransient(formatRow({ label: "Approval", value: dim("waiting for approval in the browser · press Ctrl+C to cancel") }, labels), { keepInPlain: true });

    // Step 2: Poll for approval
    const started = Date.now();
    const tokenResponse = await pollForToken(
      serverUrl,
      deviceCode.deviceCode,
    );

    // Step 3: Save credentials
    const expiresAt = new Date(
      Date.now() + 60 * 60 * 1000, // 1 hour from now
    ).toISOString();

    saveCredentials({
      accessToken: tokenResponse.accessToken,
      refreshToken: tokenResponse.refreshToken,
      clientId: tokenResponse.clientId,
      expiresAt: tokenResponse.expiresAt ?? expiresAt,
      serverUrl,
    });

    // Reset any error state from previous sync failures
    clearSyncErrors();

    printRows([{ label: "Approval", value: joinParts([stateWord("approved"), formatDuration(Date.now() - started)]) }], labels);
    printLine();
    printRows(uploadDisclosureRows(), labels);
    const done = joinParts([hostname(), `client ${shortId(tokenResponse.clientId, 8)}`, "saved to ~/.adit/cloud-credentials.json"]);
    if (embedded) printLine(`${marks.ok} logged in ${dim("·")} ${done}`);
    else printEnd(`${marks.ok} Logged in ${dim("·")} ${done}`);
  } catch (error) {
    if (error instanceof CloudApiError) {
      fail(`login failed: ${error.message}`, `run ${strong("adit cloud login")} to try again`);
    } else if (error instanceof CloudNetworkError) {
      fail(`cannot reach ${serverUrl}: ${error.message}`, "check your network connection, then retry");
    } else {
      fail(`login failed: ${error instanceof Error ? error.message : String(error)}`, `run ${strong("adit cloud login")} to try again`);
    }
  }
}

/**
 * `adit cloud logout` — Clear stored credentials.
 */
export async function cloudLogoutCommand(): Promise<void> {
  const credentials = loadCredentials();

  if (!credentials) {
    console.log("Not logged in to any cloud server.");
    return;
  }

  try {
    // Revoke directly: refreshing here would rotate the token before revoking the old value.
    if (credentials.authType !== "token" && credentials.refreshToken) {
      try {
        await fetch(normalizeServerUrl(credentials.serverUrl) + "/api/auth/token/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: credentials.refreshToken }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // Remote availability must never prevent local logout.
      }
    }
    try {
      const config = loadConfig();
      if (existsSync(config.dbPath)) {
        const db = openDatabase(config.dbPath);
        try {
          const { clearSyncState } = await import("@varveai/adit-core");
          clearSyncState(db, credentials.serverUrl);
        } finally {
          closeDatabase(db);
        }
      }
    } catch {
      // Missing or corrupt projects do not prevent local logout.
    }
  } finally {
    clearCredentials();
  }
  console.log("Logged out. Credentials cleared.");
}

/**
 * `adit cloud sync` — Push conversation records, then linked Git metadata.
 */
export async function cloudSyncCommand(opts?: {
  json?: boolean;
}): Promise<void> {
  const cloudConfig = loadCloudConfig();
  const credentials = loadCredentials();

  if (!credentials) {
    const msg =
      "Not logged in. Run 'adit cloud login' or 'adit cloud login --token <jwt>' first.";
    if (opts?.json) {
      console.log(JSON.stringify({ error: msg }));
    } else {
      printError("sync", "not logged in to adit-cloud", `run ${strong("adit cloud login")} (or ${strong("adit cloud login --token <jwt>")}) first`);
    }
    process.exitCode = 1;
    return;
  }

  // Re-enable sync if circuit breaker was tripped (manual sync = user intent)
  if (isSyncDisabled()) {
    clearSyncErrors();
  }

  const serverUrl = cloudConfig.serverUrl ?? credentials.serverUrl;
  const config = loadInitializedProjectConfig("adit cloud sync");
  if (!config) return;

  if (!opts?.json) {
    printTitle("Sync", serverHost(serverUrl));
    printTransient(dim("pushing conversation records, then linked git metadata…"));
  }

  const started = Date.now();
  const db = openDatabase(config.dbPath);
  try {
    const client = new CloudClient(serverUrl, credentials);
    const projectContext = await resolveCloudProjectContext(config);
    const result = await runSyncCycle({
      db,
      client,
      projectContext,
      batchSize: cloudConfig.batchSize,
      serverUrl,
      cloudClientId: credentials.clientId,
      dataDir: config.dataDir,
      syncGitWhenNoBatches: true,
      forceRemoteBranchCheck: true,
    });

    if (opts?.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const rows: Row[] = [{
        label: "Conversations",
        value: result.batches === 0
          ? dim("nothing to push")
          : joinParts([
              `${formatCount(result.accepted)} accepted`,
              `${formatCount(result.duplicates)} duplicates`,
              result.conflicts.length > 0 ? inTone("warning", `${result.conflicts.length} conflicts`) : "0 conflicts",
              plural(result.batches, "batch", "batches"),
            ]),
      }];
      let problems = 0;
      let uploaded = result.batches > 0;
      if (result.git) {
        const git = result.git;
        const unchanged = git.skips.filter((skip) => skip.reason === "unchanged").length;
        const notLinked = git.skips.filter((skip) => skip.reason === "not-linked").length;
        uploaded ||= git.repositoriesUpdated > 0;
        rows.push({
          label: "Git metadata",
          value: git.repositoriesUpdated > 0
            ? joinParts([
                `${plural(git.repositoriesUpdated, "repository", "repositories")} updated`,
                `${formatCount(git.commitsUploaded)} commits`,
                `${formatCount(git.branchesUploaded)} branches`,
                unchanged > 0 ? `${unchanged} unchanged` : null,
                notLinked > 0 ? `${notLinked} not linked` : null,
              ])
            : joinParts([
                unchanged > 0 ? `${plural(unchanged, "repository", "repositories")} unchanged` : null,
                notLinked > 0 ? `${notLinked} not linked` : null,
                "nothing to upload",
              ]),
        });
        printRows(rows);
        for (const skip of git.skips) {
          if (skip.reason === "not-linked") {
            problems += 1;
            printLine(`${marks.warn} ${skip.relativePath} not linked · ${skip.message}`, { stream: "stderr" });
          }
        }
        for (const failure of git.failures) {
          problems += 1;
          printLine(`${marks.fail} git sync failed for ${failure.relativePath} · ${failure.message}`, { stream: "stderr" });
        }
        for (const warning of git.warnings) {
          problems += 1;
          printLine(`${marks.warn} remote branch check for ${warning.relativePath} · ${warning.message}; kept the last good snapshot`, { stream: "stderr" });
        }
      } else {
        printRows(rows);
      }

      const elapsed = formatDuration(Date.now() - started);
      if (problems > 0) {
        printEnd(`${marks.warn} Synced with ${plural(problems, "problem")} · ${elapsed}`);
      } else if (uploaded) {
        printEnd(`${marks.ok} Synced ${dim("·")} ${joinParts([result.newSyncCursor ? `cursor ${shortId(result.newSyncCursor)}` : null, elapsed])}`);
      } else {
        printEnd(`${marks.ok} Already up to date ${dim(`· checked ${localTime(new Date().toISOString())}`)}`);
      }
    }
  } catch (error) {
    const msg =
      error instanceof CloudAuthError
        ? `Authentication failed: ${error.message}. Run 'adit cloud login' to re-authenticate.`
        : error instanceof CloudNetworkError
          ? `Network error: ${error.message}`
          : `Sync failed: ${error instanceof Error ? error.message : String(error)}`;

    if (opts?.json) {
      console.log(JSON.stringify({ error: msg }));
    } else if (error instanceof CloudAuthError) {
      printError("sync", `authentication failed: ${error.message}`, `run ${strong("adit cloud login")}, then retry`);
    } else if (error instanceof CloudNetworkError) {
      printError("sync", `network error: ${error.message}`, "check your connection and retry; auto-sync also retries on its own");
    } else {
      printError("sync", `sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

/**
 * `adit cloud status` — Show sync state and unsynced record count.
 */
export async function cloudStatusCommand(opts?: {
  json?: boolean;
}): Promise<void> {
  const cloudConfig = loadCloudConfig();
  const credentials = loadCredentials();
  const config = loadInitializedProjectConfig("adit cloud status");
  if (!config) return;

  const status: Record<string, unknown> = {
    serverUrl: cloudConfig.serverUrl,
    enabled: cloudConfig.enabled,
    autoSync: cloudConfig.autoSync,
    loggedIn: credentials !== null,
  };

  if (credentials) {
    const accessTokenExpired = isTokenExpired(credentials);
    status.authType = credentials.authType ?? "device";
    status.clientId = credentials.clientId;
    status.accessToken = credentials.authType === "token"
      ? { status: "static", expired: false }
      : {
          status: accessTokenExpired ? "expired" : "valid",
          expired: accessTokenExpired,
          expiresAt: credentials.expiresAt || null,
        };
    status.tokenExpired = accessTokenExpired;
    status.lastAuthFailure = credentials.lastAuthFailure ?? null;
  }

  // Check server reachability
  const serverUrl = cloudConfig.serverUrl ?? credentials?.serverUrl;
  if (serverUrl && credentials) {
    try {
      const client = new CloudClient(serverUrl, credentials);
      const params = new URLSearchParams();
      if (config.projectId) params.set("projectId", config.projectId);
      const statusPath = params.toString()
        ? `/api/sync/status?${params.toString()}`
        : "/api/sync/status";
      const refreshTokenStatus = await client.getRefreshTokenStatus();
      status.refreshToken = refreshTokenStatus;
      const remoteStatus = await client.get<{
        lastSyncedEventId: string | null;
        syncVersion: number;
        lastSyncedAt: string | null;
        projectCursors?: Record<string, {
          lastSyncedEventId: string | null;
          lastSyncedAt: string | null;
        }>;
      }>(statusPath);
      status.serverOnline = true;
      status.authVerified = true;
      status.remoteStatus = remoteStatus;
    } catch (error) {
      status.serverOnline = false;
      status.authVerified = false;
      status.serverError =
        error instanceof CloudNetworkError
          ? `unreachable — ${error.cause?.message ?? error.message}`
          : error instanceof CloudAuthError
            ? `auth failed — ${error.message}`
            : error instanceof CloudApiError
              ? `server error — ${error.status} ${error.message}`
              : `error — ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // Count unsynced records
  try {
    const db = openDatabase(config.dbPath);
    try {
      const { getSyncState } = await import("@varveai/adit-core");
      const syncState = getSyncState(
        db,
        cloudConfig.serverUrl ?? credentials?.serverUrl ?? "",
      );

      status.syncState = syncState
        ? {
            lastSyncedEventId: syncState.lastSyncedEventId,
            lastSyncedAt: syncState.lastSyncedAt,
            syncVersion: syncState.syncVersion,
          }
        : null;

      const unsyncedCount = countUnsyncedEvents(
        db,
        syncState?.lastSyncedEventId ?? null,
        config.projectId,
      );
      status.unsyncedRecords = unsyncedCount;
    } finally {
      closeDatabase(db);
    }
  } catch {
    status.unsyncedRecords = "unknown";
  }

  if (opts?.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  const effectiveServerUrl = cloudConfig.serverUrl ?? credentials?.serverUrl ?? null;
  const now = new Date().toISOString();
  const rows: Row[] = [];
  const unsynced = status.unsyncedRecords;

  if (credentials) {
    const authType = credentials.authType ?? "device";
    const accessStatus = status.accessToken as { status: string; expiresAt?: string | null } | undefined;
    const refreshStatus = status.refreshToken as {
      valid?: boolean;
      reason?: string;
      expiresAt?: string;
      client?: { displayName?: string | null } | null;
    } | undefined;
    rows.push({
      label: "Account",
      value: joinParts([authType, refreshStatus?.client?.displayName ?? null, `client ${shortId(credentials.clientId, 8)}`]),
    });
    if (authType === "token") {
      rows.push({ label: "Token", value: `static ${dim("· never expires")}` });
    } else {
      const access = accessStatus?.status ?? (isTokenExpired(credentials) ? "expired" : "valid");
      rows.push({
        label: "Token",
        value: joinParts([
          stateWord(access),
          accessStatus?.expiresAt ? `${access === "expired" ? "expired" : "expires"} ${localMoment(accessStatus.expiresAt, now)}` : null,
          refreshStatus
            ? refreshStatus.valid
              ? `refresh until ${localDate(refreshStatus.expiresAt ?? null)}`
              : inTone("invalid", `refresh token invalid${refreshStatus.reason ? ` (${refreshStatus.reason})` : ""}`)
            : dim("refresh not checked"),
        ]),
      });
    }
    if (credentials.lastAuthFailure) {
      rows.push({
        label: "Last failure",
        value: inTone("warning", `${localDateTime(credentials.lastAuthFailure.at)} · ${credentials.lastAuthFailure.stage} · ${credentials.lastAuthFailure.message}`),
      });
    }
  }
  if (status.serverOnline === false) {
    rows.push({ label: "Server", value: `${stateWord("offline")} ${dim(`· ${String(status.serverError ?? "")}`)}` });
  }
  if (!cloudConfig.enabled || !cloudConfig.autoSync) {
    rows.push({ label: "Auto-sync", value: `off ${dim(!cloudConfig.enabled ? "(ADIT_CLOUD_ENABLED=false)" : "(ADIT_CLOUD_AUTO_SYNC=false)")}` });
  }

  rows.push({ label: "Project", value: joinParts([strong(basename(config.projectRoot)), config.projectId]) });

  const syncState = status.syncState as {
    lastSyncedEventId: string | null;
    lastSyncedAt: string | null;
    syncVersion: number;
  } | null;
  rows.push({
    label: "Last sync",
    value: syncState?.lastSyncedAt
      ? joinParts([localDateTime(syncState.lastSyncedAt), `version ${syncState.syncVersion}`])
      : "never",
  });

  // Show the remote cursor only when it differs from the local one.
  const remoteStatus = status.remoteStatus as {
    lastSyncedEventId: string | null;
    projectCursors?: Record<string, { lastSyncedEventId: string | null }>;
  } | undefined;
  if (remoteStatus) {
    const localCursor = syncState?.lastSyncedEventId ?? null;
    const projectEntry = config.projectId ? remoteStatus.projectCursors?.[config.projectId] : undefined;
    const remoteCursor = projectEntry !== undefined ? projectEntry.lastSyncedEventId : remoteStatus.lastSyncedEventId;
    if (localCursor !== remoteCursor) {
      rows.push({
        label: "Cursor",
        value: inTone("warning", `local ${localCursor ? shortId(localCursor) : "none"} · server ${remoteCursor ? shortId(remoteCursor) : "none"} (${projectEntry !== undefined ? "project" : "global"})`),
      });
    }
  }

  rows.push({
    label: "Unsynced",
    value: typeof unsynced === "number"
      ? unsynced > 0 ? inTone("unsynced", plural(unsynced, "record")) : "0 records"
      : String(unsynced ?? "unknown"),
  });

  printTitle(
    "Cloud",
    effectiveServerUrl ? serverHost(effectiveServerUrl) : "no server configured",
    !credentials ? "not logged in" : status.serverOnline === true ? stateWord("online") : status.serverOnline === false ? stateWord("offline") : null,
  );
  printRows(rows);

  if (!credentials) {
    printEnd(`${marks.skip} Not logged in · run ${strong("adit cloud login")}`);
  } else if (status.serverOnline === false) {
    printEnd(`${marks.warn} Server not reachable · auto-sync resumes when it is back; retry now with ${strong("adit cloud sync")}`);
  } else if (typeof unsynced === "number" && unsynced > 0) {
    printEnd(`${marks.warn} ${plural(unsynced, "record")} pending · run ${strong("adit cloud sync")}`);
  } else {
    printEnd(`${marks.ok} In sync`);
  }
}

/**
 * `adit cloud login --token <token>` — Authenticate with a static JWT token.
 *
 * Server URL: ADIT_CLOUD_URL env > DEFAULT_SERVER_URL.
 */
export async function cloudAuthTokenCommand(
  token: string,
  opts?: { server?: string },
): Promise<void> {
  const serverUrl =
    opts?.server ?? process.env.ADIT_CLOUD_URL ?? DEFAULT_SERVER_URL;
  const config = loadConfig();

  printTitle("Login", serverHost(serverUrl), "static token");
  const rows: Row[] = [];

  // If device (login) credentials already exist, warn but allow override
  const existingCredentials = loadCredentials();
  if (existingCredentials && existingCredentials.authType !== "token") {
    rows.push({ label: "Replaced", value: "the previous device login" });
  }

  // Save credentials with local clientId initially
  const credentials = {
    authType: "token" as const,
    accessToken: token,
    refreshToken: "",
    clientId: config.clientId,
    expiresAt: "",
    serverUrl,
  };
  saveCredentials(credentials);

  // Verify token against the server and retrieve server-assigned clientId
  let verified = false;
  try {
    const client = new CloudClient(serverUrl, credentials);
    const status = await client.get<{ clientId: string }>(
      "/api/sync/status",
    );
    verified = true;
    if (status.clientId && status.clientId !== config.clientId) {
      // Update with server-assigned clientId
      saveCredentials({ ...credentials, clientId: status.clientId });
      rows.push({ label: "Token", value: joinParts([stateWord("valid"), `client ${shortId(status.clientId, 8)} (assigned by the server)`]) });
    } else {
      rows.push({ label: "Token", value: joinParts([stateWord("valid"), `client ${shortId(config.clientId, 8)}`]) });
    }
  } catch (error) {
    // Token saved but verification failed — still usable, warn user
    const reason = error instanceof CloudAuthError
      ? `rejected: ${error.message}; the token may be invalid`
      : error instanceof CloudNetworkError
        ? `could not reach ${serverUrl} to verify it`
        : "verification failed";
    rows.push({ label: "Token", value: inTone("warning", `${reason} · saved anyway`) });
  }

  // Reset any error state from previous sync failures
  clearSyncErrors();

  const disclosure = uploadDisclosureRows();
  const labels = rowLabelWidth([...rows, ...disclosure]);
  printRows(rows, labels);
  printLine();
  printRows(disclosure, labels);
  printEnd(
    verified
      ? `${marks.ok} Logged in with a static token ${dim("· saved to ~/.adit/cloud-credentials.json")}`
      : `${marks.warn} Token saved but not verified ${dim("· saved to ~/.adit/cloud-credentials.json")}`,
  );
}

/**
 * `adit cloud auth reset` — Force-clear all credentials and sync state.
 *
 * Unlike logout, this does not attempt to revoke the token on the server.
 * It simply wipes all local credential and sync state, allowing the client
 * to connect to any cloud server again.
 */
export async function cloudResetCredentialsCommand(opts?: {
  yes?: boolean;
}): Promise<void> {
  const credentials = loadCredentials();

  if (!credentials) {
    console.log("No credentials stored. Nothing to reset.");
    return;
  }

  if (!opts?.yes) {
    console.log(
      `This will remove all stored credentials for ${credentials.serverUrl}.`,
    );
    console.log("Local sync state will also be cleared.");
    console.log(
      "You will need to run 'adit cloud login' to reconnect to any server.",
    );
    console.log();
    console.log("Run with --yes to confirm.");
    process.exitCode = 1;
    return;
  }

  // Clear local sync state
  const config = loadConfig();
  try {
    if (!existsSync(config.dbPath)) return;
    const db = openDatabase(config.dbPath);
    try {
      const { clearSyncState } = await import("@varveai/adit-core");
      clearSyncState(db, credentials.serverUrl);
    } finally {
      closeDatabase(db);
    }
  } catch {
    // Database may not exist yet
  }

  clearCredentials();
  console.log("Credentials and sync state cleared.");
  console.log("You can now connect to any cloud server with 'adit cloud login'.");
}
