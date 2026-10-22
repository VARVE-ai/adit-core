/**
 * Tests for cloud credential management — circuit breaker logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { LocalStore } from "@varveai/adit-core";
import { protectCredentialKey } from "./credential-protection.js";

/**
 * Isolate the data directory explicitly, including built core dependencies.
 */
const tempHome = join(
  tmpdir(),
  `adit-creds-test-${randomBytes(8).toString("hex")}`,
);

vi.mock("../auth/credential-protection.js", () => ({
  protectCredentialKey: vi.fn((_id: string, key: Buffer) => ({
    scheme: "test",
    value: key.toString("base64"),
  })),
  unprotectCredentialKey: (key: { value: string }) =>
    Buffer.from(key.value, "base64"),
}));
beforeEach(() => vi.stubEnv("ADIT_LOCAL_DATA_DIR", join(tempHome, ".adit")));
afterEach(() => {
  // tempHome is a generated test-owned absolute path under the OS temp directory.
  rmSync(tempHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  incrementSyncErrors,
  clearSyncErrors,
  isSyncDisabled,
  isTokenExpired,
  recordAuthFailure,
  clearAuthFailure,
  withCredentialsRefreshLock,
  updateCloudAccountMetadata,
  type CloudCredentials,
} from "./credentials.js";

function makeCreds(
  overrides: Partial<CloudCredentials> = {},
): CloudCredentials {
  return {
    authType: "token",
    accessToken: "test-token",
    refreshToken: "",
    clientId: "test-client",
    expiresAt: "",
    serverUrl: "http://localhost:3000",
    ...overrides,
  };
}

describe("Circuit Breaker", () => {
  beforeEach(() => {
    mkdirSync(join(tempHome, ".adit"), { recursive: true });
    // Start with valid credentials
    saveCredentials(makeCreds());
  });


  it("is not disabled initially", () => {
    expect(isSyncDisabled()).toBe(false);
  });

  it("increments error count without disabling below threshold", () => {
    incrementSyncErrors(5);
    incrementSyncErrors(5);
    incrementSyncErrors(5);

    const creds = loadCredentials();
    expect(creds?.syncErrorCount).toBe(3);
    expect(creds?.syncDisabled).toBe(false);
    expect(isSyncDisabled()).toBe(false);
  });

  it("disables sync at threshold (5 errors)", () => {
    for (let i = 0; i < 5; i++) {
      incrementSyncErrors(5);
    }

    expect(isSyncDisabled()).toBe(true);
    const creds = loadCredentials();
    expect(creds?.syncErrorCount).toBe(5);
    expect(creds?.syncDisabled).toBe(true);
  });

  it("clearSyncErrors resets counter and re-enables sync", () => {
    for (let i = 0; i < 5; i++) {
      incrementSyncErrors(5);
    }
    expect(isSyncDisabled()).toBe(true);

    clearSyncErrors();

    expect(isSyncDisabled()).toBe(false);
    const creds = loadCredentials();
    expect(creds?.syncErrorCount).toBe(0);
    expect(creds?.syncDisabled).toBe(false);
    expect(creds?.firstSyncErrorAt).toBeUndefined();
  });

  it("records firstSyncErrorAt on first error", () => {
    const before = Date.now();
    incrementSyncErrors(5);
    const after = Date.now();

    const creds = loadCredentials();
    expect(creds?.firstSyncErrorAt).toBeDefined();
    const errorTime = new Date(creds!.firstSyncErrorAt!).getTime();
    expect(errorTime).toBeGreaterThanOrEqual(before);
    expect(errorTime).toBeLessThanOrEqual(after);
  });

  it("preserves firstSyncErrorAt across consecutive errors within window", () => {
    incrementSyncErrors(5);
    const creds1 = loadCredentials();
    const firstErrorAt = creds1?.firstSyncErrorAt;

    incrementSyncErrors(5);
    const creds2 = loadCredentials();

    expect(creds2?.firstSyncErrorAt).toBe(firstErrorAt);
    expect(creds2?.syncErrorCount).toBe(2);
  });

  it("auto-resets breaker when error window has expired", () => {
    // Simulate 5 errors that happened 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    saveCredentials(
      makeCreds({
        syncErrorCount: 5,
        syncDisabled: true,
        firstSyncErrorAt: twoHoursAgo,
      }),
    );

    // isSyncDisabled should auto-reset because window expired
    expect(isSyncDisabled()).toBe(false);

    // Credentials should be cleaned up
    const creds = loadCredentials();
    expect(creds?.syncErrorCount).toBe(0);
    expect(creds?.syncDisabled).toBe(false);
  });

  it("stays disabled when errors are within the window", () => {
    // Simulate 5 errors that happened 30 minutes ago
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    saveCredentials(
      makeCreds({
        syncErrorCount: 5,
        syncDisabled: true,
        firstSyncErrorAt: thirtyMinAgo,
      }),
    );

    expect(isSyncDisabled()).toBe(true);
  });

  it("resets error count when new error is outside the window", () => {
    // Simulate old errors from 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    saveCredentials(
      makeCreds({
        syncErrorCount: 4,
        syncDisabled: false,
        firstSyncErrorAt: twoHoursAgo,
      }),
    );

    // New error should reset window — count starts from 1
    incrementSyncErrors(5);

    const creds = loadCredentials();
    expect(creds?.syncErrorCount).toBe(1);
    expect(creds?.syncDisabled).toBe(false);
    // firstSyncErrorAt should be updated to now
    const errorTime = new Date(creds!.firstSyncErrorAt!).getTime();
    expect(Date.now() - errorTime).toBeLessThan(5000);
  });

  it("returns false from incrementSyncErrors when no credentials", () => {
    clearCredentials();
    expect(incrementSyncErrors(5)).toBe(false);
  });

  it("clearSyncErrors is a no-op when no credentials", () => {
    clearCredentials();
    // Should not throw
    clearSyncErrors();
  });
});

describe("Token expiry diagnostics", () => {
  it("stores and loads a canonical server URL", () => {
    mkdirSync(join(tempHome, ".adit"), { recursive: true });
    saveCredentials(makeCreds({ serverUrl: " http://localhost:3000/// " }));

    expect(loadCredentials()?.serverUrl).toBe("http://localhost:3000");
  });

  it("treats missing or invalid device expiresAt as expired", () => {
    expect(
      isTokenExpired(
        makeCreds({ authType: "device", refreshToken: "r", expiresAt: "" }),
      ),
    ).toBe(true);
    expect(
      isTokenExpired(
        makeCreds({
          authType: "device",
          refreshToken: "r",
          expiresAt: "not-a-date",
        }),
      ),
    ).toBe(true);
  });

  it("does not expire static token credentials", () => {
    expect(
      isTokenExpired(makeCreds({ authType: "token", expiresAt: "" })),
    ).toBe(false);
  });

  it("records and clears last auth failure", () => {
    mkdirSync(join(tempHome, ".adit"), { recursive: true });
    saveCredentials(makeCreds());

    recordAuthFailure({
      stage: "refresh",
      message: "refresh failed",
      status: 401,
      code: "token_revoked",
    });

    const failed = loadCredentials();
    expect(failed?.lastAuthFailure?.stage).toBe("refresh");
    expect(failed?.lastAuthFailure?.code).toBe("token_revoked");

    clearAuthFailure();
    expect(loadCredentials()?.lastAuthFailure).toBeUndefined();
  });
});

describe("database credentials", () => {
  it("keeps structured metadata and ciphertext, never plaintext tokens", () => {
    const creds = makeCreds({
      accessToken: "sensitive-test-access-token",
      refreshToken: "sensitive-test-refresh-token",
      accountId: "user-1",
      accountEmail: "test@example.test",
    });
    saveCredentials(creds);
    const directory = join(tempHome, ".adit"),
      store = new LocalStore(directory);
    try {
      const row = store.db
        .prepare("SELECT * FROM adit_cloud_credentials")
        .get() as Record<string, unknown>;
      expect(row.account_id).toBe("user-1");
      expect(row.account_email).toBe("test@example.test");
      expect(row.access_token_encrypted).not.toBe(creds.accessToken);
      expect(row.refresh_token_encrypted).not.toBe(creds.refreshToken);
      for (const file of ["local.sqlite", "local.sqlite-wal"]) {
        const path = join(directory, file);
        if (!existsSync(path)) continue;
        const data = readFileSync(path);
        expect(data.includes(Buffer.from(creds.accessToken))).toBe(false);
        expect(data.includes(Buffer.from(creds.refreshToken))).toBe(false);
      }
    } finally {
      store.close();
    }
    expect(loadCredentials()).toMatchObject(creds);
  });

  it("never imports, overwrites or deletes the old CLI JSON", () => {
    const directory = join(tempHome, ".adit"),
      legacy = join(directory, "cloud-credentials.json");
    mkdirSync(directory, { recursive: true });
    const contents = JSON.stringify(makeCreds({ accessToken: "legacy-login" }));
    writeFileSync(legacy, contents);
    expect(loadCredentials()).toBeNull();
    saveCredentials(makeCreds());
    clearCredentials();
    expect(readFileSync(legacy, "utf8")).toBe(contents);
    expect(loadCredentials()).toBeNull();
  });

  it("isolates accounts, diagnostics and refresh locks by directory", async () => {
    const first = join(tempHome, "first"),
      second = join(tempHome, "second");
    saveCredentials(makeCreds({ accessToken: "first-token" }), first);
    saveCredentials(makeCreds({ accessToken: "second-token" }), second);
    await withCredentialsRefreshLock(async () => {
      await withCredentialsRefreshLock(async () => {
        expect(loadCredentials(second)?.accessToken).toBe("second-token");
      }, second);
      recordAuthFailure({ stage: "request", message: "denied" }, first);
      recordAuthFailure({ stage: "request", message: "offline" }, second);
      expect(loadCredentials(first)?.lastAuthFailure).toBeUndefined();
      expect(loadCredentials(second)?.lastAuthFailure?.message).toBe("offline");
    }, first);
    clearCredentials(first);
    expect(loadCredentials(second)?.accessToken).toBe("second-token");
  });

  it("cannot restore deleted credentials or overwrite a newer login", () => {
    const old = makeCreds();
    saveCredentials(old);
    clearCredentials();
    expect(() => saveCredentials(old)).toThrow("Cloud account changed");
    const newer = makeCreds({ accessToken: "new-login" });
    saveCredentials(newer);
    expect(() => saveCredentials(old)).toThrow("Cloud account changed");
    clearCredentials(undefined, old);
    recordAuthFailure({ stage: "request", message: "stale" }, undefined, old);
    updateCloudAccountMetadata({ accountEmail: "stale@example.test" }, old);
    expect(loadCredentials()?.accessToken).toBe("new-login");
    expect(loadCredentials()?.lastAuthFailure).toBeUndefined();
    expect(loadCredentials()?.accountEmail).toBeUndefined();
  });

  it("updates metadata without rolling back rotated tokens", () => {
    const old = makeCreds();
    saveCredentials(old);
    saveCredentials({ ...old, accessToken: "rotated" });
    updateCloudAccountMetadata(
      { checkedAt: "2026-10-21T00:00:00Z", reachable: true },
      old,
    );
    expect(loadCredentials()).toMatchObject({
      accessToken: "rotated",
      reachable: true,
    });
  });

  it("fails closed when OS secure storage is unavailable", () => {
    vi.mocked(protectCredentialKey).mockImplementationOnce(() => {
      throw new Error("Unable to access secure Cloud credential storage");
    });
    expect(() => saveCredentials(makeCreds())).toThrow(
      "secure Cloud credential storage",
    );
    expect(loadCredentials()).toBeNull();
    expect(existsSync(join(tempHome, ".adit", "cloud-credentials.json"))).toBe(
      false,
    );
  });

  it("recovers a refresh lock abandoned by a dead process", async () => {
    saveCredentials(makeCreds());
    const store = new LocalStore();
    try {
      store.db
        .prepare(
          "INSERT INTO adit_cloud_auth_locks VALUES(1,'dead',2147483647,0)",
        )
        .run();
    } finally {
      store.close();
    }
    await expect(
      withCredentialsRefreshLock(async () => "acquired"),
    ).resolves.toBe("acquired");
  });
});
