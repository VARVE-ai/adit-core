import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { LocalStore, normalizeServerUrl } from "@varveai/adit-core";
import type { CloudCredentials } from "./credentials.js";
import {
  protectCredentialKey,
  unprotectCredentialKey,
} from "./credential-protection.js";

type Db = LocalStore["db"];
type Row = Record<string, any>;
const keys = new Map<string, Buffer>();
export function credentialDatabase<T>(
  directory: string,
  write: boolean,
  fn: (db: Db) => T,
): T | null {
  if (!write && !existsSync(join(directory, "local.sqlite"))) return null;
  const store = new LocalStore(directory);
  try {
    if (write)
      store.db.exec(`
      CREATE TABLE IF NOT EXISTS adit_cloud_credentials (
        id INTEGER PRIMARY KEY CHECK(id=1), credential_id TEXT NOT NULL, auth_type TEXT NOT NULL,
        server_url TEXT NOT NULL, client_id TEXT NOT NULL, expires_at TEXT NOT NULL,
        access_token_encrypted TEXT NOT NULL, refresh_token_encrypted TEXT NOT NULL,
        account_id TEXT, account_name TEXT, account_email TEXT, checked_at TEXT, reachable INTEGER, auth_status TEXT,
        sync_error_count INTEGER NOT NULL DEFAULT 0, sync_disabled INTEGER NOT NULL DEFAULT 0, first_sync_error_at TEXT,
        failure_at TEXT, failure_stage TEXT, failure_message TEXT, failure_status INTEGER, failure_code TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS adit_cloud_credential_keys (id TEXT PRIMARY KEY, scheme TEXT NOT NULL, protected_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS adit_cloud_auth_locks (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, pid INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    `);
    else if (
      !store.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='adit_cloud_credentials'",
        )
        .get()
    )
      return null;
    return fn(store.db);
  } finally {
    store.close();
  }
}

function encryptionKey(db: Db, directory: string, create: boolean): Buffer {
  let row = db
    .prepare("SELECT * FROM adit_cloud_credential_keys LIMIT 1")
    .get() as Row | undefined;
  if (!row && create) {
    row = db
      .transaction(() => {
        const existing = db
          .prepare("SELECT * FROM adit_cloud_credential_keys LIMIT 1")
          .get() as Row | undefined;
        if (existing) return existing;
        const id = randomUUID(),
          key = randomBytes(32),
          protectedKey = protectCredentialKey(id, key);
        db.prepare("INSERT INTO adit_cloud_credential_keys VALUES(?,?,?)").run(
          id,
          protectedKey.scheme,
          protectedKey.value,
        );
        keys.set(`${resolve(directory)}:${id}:${protectedKey.value}`, key);
        return {
          id,
          scheme: protectedKey.scheme,
          protected_key: protectedKey.value,
        };
      })
      .immediate();
  }
  if (!row) throw new Error("Cloud credential encryption key is missing");
  const cacheKey = `${resolve(directory)}:${row.id}:${row.protected_key}`;
  let key = keys.get(cacheKey);
  if (!key) {
    key = unprotectCredentialKey({
      scheme: row.scheme,
      value: row.protected_key,
    });
    keys.set(cacheKey, key);
  }
  return key;
}
function seal(value: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
function open(value: string, key: Buffer, aad: string): string {
  try {
    const data = Buffer.from(value, "base64"),
      cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([
      cipher.update(data.subarray(28)),
      cipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Unable to decrypt the saved Cloud credentials");
  }
}
export function readCredential(
  db: Db,
  directory: string,
): CloudCredentials | null {
  const r = db
    .prepare("SELECT * FROM adit_cloud_credentials WHERE id=1")
    .get() as Row | undefined;
  if (!r) return null;
  const key = encryptionKey(db, directory, false),
    aad = `${r.credential_id}:${r.server_url}:${r.client_id}`;
  return {
    credentialId: r.credential_id,
    authType: r.auth_type,
    serverUrl: r.server_url,
    clientId: r.client_id,
    expiresAt: r.expires_at,
    accessToken: open(r.access_token_encrypted, key, aad + ":access"),
    refreshToken: open(r.refresh_token_encrypted, key, aad + ":refresh"),
    accountId: r.account_id ?? undefined,
    accountName: r.account_name ?? undefined,
    accountEmail: r.account_email ?? undefined,
    accountImage: r.account_image ?? undefined,
    checkedAt: r.checked_at ?? undefined,
    reachable: r.reachable == null ? undefined : !!r.reachable,
    authStatus: r.auth_status ?? undefined,
    syncErrorCount: r.sync_error_count,
    syncDisabled: !!r.sync_disabled,
    firstSyncErrorAt: r.first_sync_error_at ?? undefined,
    ...(r.failure_at
      ? {
          lastAuthFailure: {
            at: r.failure_at,
            stage: r.failure_stage,
            message: r.failure_message,
            ...(r.failure_status == null ? {} : { status: r.failure_status }),
            ...(r.failure_code == null ? {} : { code: r.failure_code }),
          },
        }
      : {}),
  };
}
export function writeCredential(
  db: Db,
  directory: string,
  creds: CloudCredentials,
): void {
  if (!(db.prepare("PRAGMA table_info(adit_cloud_credentials)").all() as { name: string }[]).some((column) => column.name === "account_image"))
    db.exec("ALTER TABLE adit_cloud_credentials ADD COLUMN account_image TEXT");
  const server = normalizeServerUrl(creds.serverUrl),
    id = creds.credentialId || randomUUID();
  const key = encryptionKey(db, directory, true),
    aad = `${id}:${server}:${creds.clientId}`;
  const access = seal(creds.accessToken, key, aad + ":access"),
    refresh = seal(creds.refreshToken, key, aad + ":refresh");
  db.transaction(() => {
    const current = db
      .prepare(
        "SELECT credential_id,created_at FROM adit_cloud_credentials WHERE id=1",
      )
      .get() as Row | undefined;
    if (creds.credentialId && current?.credential_id !== creds.credentialId)
      throw new Error("Cloud account changed. Please sign in again.");
    const failure = creds.lastAuthFailure;
    const values: Row = {
      id: 1,
      credential_id: id,
      auth_type: creds.authType || "device",
      server_url: server,
      client_id: creds.clientId,
      expires_at: creds.expiresAt,
      access_token_encrypted: access,
      refresh_token_encrypted: refresh,
      account_id: creds.accountId,
      account_name: creds.accountName,
      account_email: creds.accountEmail,
      account_image: creds.accountImage,
      checked_at: creds.checkedAt,
      reachable: creds.reachable === undefined ? null : +creds.reachable,
      auth_status: creds.authStatus,
      sync_error_count: creds.syncErrorCount || 0,
      sync_disabled: +!!creds.syncDisabled,
      first_sync_error_at: creds.firstSyncErrorAt,
      failure_at: failure?.at,
      failure_stage: failure?.stage,
      failure_message: failure?.message,
      failure_status: failure?.status,
      failure_code: failure?.code,
      created_at:
        current?.credential_id === id ? current.created_at : Date.now(),
      updated_at: Date.now(),
    };
    const fields = Object.keys(values);
    db.prepare(
      `INSERT INTO adit_cloud_credentials (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${fields
        .filter((k) => k !== "id")
        .map((k) => `${k}=excluded.${k}`)
        .join(",")}`,
    ).run(...fields.map((k) => values[k] ?? null));
    creds.credentialId = id;
  }).immediate();
}

export function sameCredential(
  a: CloudCredentials,
  b: CloudCredentials,
): boolean {
  return (
    a.serverUrl === normalizeServerUrl(b.serverUrl) &&
    a.clientId === b.clientId &&
    (b.credentialId
      ? a.credentialId === b.credentialId
      : a.accessToken === b.accessToken && a.refreshToken === b.refreshToken)
  );
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
export function activeCredentialLock(db: Db): boolean {
  const row = db
    .prepare("SELECT pid FROM adit_cloud_auth_locks WHERE id=1")
    .get() as { pid: number } | undefined;
  if (!row) return false;
  if (alive(row.pid)) return true;
  db.prepare("DELETE FROM adit_cloud_auth_locks WHERE id=1").run();
  return false;
}
export function acquireCredentialLock(directory: string): string | null {
  return credentialDatabase(directory, true, (db) =>
    db
      .transaction(() => {
        if (activeCredentialLock(db)) return null;
        const owner = randomUUID();
        db.prepare("INSERT INTO adit_cloud_auth_locks VALUES(1,?,?,?)").run(
          owner,
          process.pid,
          Date.now() + 30000,
        );
        return owner;
      })
      .immediate(),
  );
}
export function releaseCredentialLock(directory: string, owner: string): void {
  credentialDatabase(directory, false, (db) =>
    db
      .prepare("DELETE FROM adit_cloud_auth_locks WHERE id=1 AND owner=?")
      .run(owner),
  );
}
