import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CloudAuthError,
  CloudClient,
  CloudNetworkError,
  loadCredentials,
  saveCredentials,
  clearCredentials,
  pollForToken,
  requestDeviceCode,
} from "@varveai/adit-cloud";
import { LocalAccount } from "./account.js";

vi.mock("@varveai/adit-cloud", async () => ({
  ...(await import("../../../cloud/src/index.js")),
  requestDeviceCode: vi.fn(),
  pollForToken: vi.fn(),
}));
vi.mock("../../../cloud/src/auth/credential-protection.js", () => ({
  protectCredentialKey: (_id: string, key: Buffer) => ({
    scheme: "test",
    value: key.toString("base64"),
  }),
  unprotectCredentialKey: (key: { value: string }) =>
    Buffer.from(key.value, "base64"),
}));

let directory: string;
const credentials = () => ({
  accessToken: "test-access",
  refreshToken: "test-refresh",
  clientId: "test-client",
  expiresAt: "2099-01-01T00:00:00.000Z",
  serverUrl: "https://cloud.example.test",
});
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "adit-account-test-"));
  vi.stubEnv("ADIT_LOCAL_DATA_DIR", directory);
  saveCredentials(credentials());
  vi.mocked(requestDeviceCode).mockResolvedValue({
    deviceCode: "device",
    userCode: "code",
    verificationUrl: "https://cloud.example.test/authorize",
    expiresAt: "2099-01-01",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  // directory is a test-owned absolute path created by mkdtempSync.
  rmSync(directory, { recursive: true, force: true });
});

it("does not contact Cloud without a connected account", async () => {
  clearCredentials();
  const get = vi.spyOn(CloudClient.prototype, "get");
  expect(await new LocalAccount().check()).toMatchObject({
    connected: false,
    auth: "disconnected",
    reachable: null,
  });
  expect(get).not.toHaveBeenCalled();
});

it("verifies a Cloud device token and saves the server device ID in the selected database", async () => {
  const preview = join(directory, "token-preview");
  const get = vi
    .spyOn(CloudClient.prototype, "get")
    .mockResolvedValue({ clientId: "cloud-device", user: { id: "user-1", name: "Test account", email: "test@example.test" } });
  const result = await new LocalAccount(preview).loginWithToken(
    "  adit_test_device_token  ",
    "https://cloud.example.test/",
  );
  expect(get).toHaveBeenCalledWith("/api/sync/status");
  expect(loadCredentials(preview)).toMatchObject({
    authType: "token",
    accessToken: "adit_test_device_token",
    refreshToken: "",
    expiresAt: "",
    clientId: "cloud-device",
    accountId: "user-1",
    accountName: "Test account",
    accountEmail: "test@example.test",
    reachable: true,
    authStatus: "valid",
  });
  expect(loadCredentials()?.accessToken).toBe("test-access");
  expect(result).toMatchObject({
    connected: true,
    auth: "valid",
    reachable: true,
    account: "Test account",
  });
  expect(JSON.stringify(result)).not.toContain("adit_test_device_token");
  expect(requestDeviceCode).not.toHaveBeenCalled();
  expect(new LocalAccount(preview).status().connected).toBe(true);
});

it.each(["", "ghp_wrong_service", "adit_has spaces", null])(
  "rejects malformed device tokens before connecting: %s",
  async (token) => {
    const get = vi.spyOn(CloudClient.prototype, "get");
    await expect(new LocalAccount().loginWithToken(token)).rejects.toThrow(
      "Paste the device token",
    );
    expect(get).not.toHaveBeenCalled();
  },
);

it.each([
  new CloudAuthError("upstream echoes adit_secret", { status: 401 }),
  new CloudNetworkError("network includes adit_secret"),
])(
  "does not replace an existing login or echo credentials on failed verification",
  async (error) => {
    const old = loadCredentials();
    vi.spyOn(CloudClient.prototype, "get").mockRejectedValue(error);
    let failure: unknown;
    try {
      await new LocalAccount().loginWithToken("adit_secret");
    } catch (e) {
      failure = e;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("adit_secret");
    expect(loadCredentials()).toEqual(old);
  },
);

it("does not save a token when Cloud omits its device ID", async () => {
  vi.spyOn(CloudClient.prototype, "get").mockResolvedValue({});
  await expect(new LocalAccount().loginWithToken("adit_test")).rejects.toThrow(
    "device ID",
  );
  expect(loadCredentials()?.accessToken).toBe("test-access");
});

it("does not let token verification restore a login after logout", async () => {
  let finish!: (value: unknown) => void;
  vi.spyOn(CloudClient.prototype, "get").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
  const account = new LocalAccount();
  const pending = account.loginWithToken("adit_test");
  const rejected = expect(pending).rejects.toThrow("Login cancelled");
  await account.logout();
  finish({ clientId: "device" });
  await rejected;
  expect(loadCredentials()).toBeNull();
});

it("requires disconnecting before token login to a different server", async () => {
  const get = vi.spyOn(CloudClient.prototype, "get");
  await expect(
    new LocalAccount().loginWithToken("adit_test", "https://another.test"),
  ).rejects.toThrow("Disconnect the current server");
  expect(get).not.toHaveBeenCalled();
});

it("persists a successful check without fabricating the missing account name", async () => {
  vi.spyOn(CloudClient.prototype, "get").mockResolvedValue({
    auth: { valid: true },
  });
  const result = await new LocalAccount().check();
  expect(result).toMatchObject({
    connected: true,
    auth: "valid",
    reachable: true,
  });
  expect(result.account).toBeUndefined();
  expect(result.checkedAt).toBeTruthy();
  expect(new LocalAccount().status()).toMatchObject({
    checkedAt: result.checkedAt,
    reachable: true,
  });
});

it("persists rejected authorization across account service restarts", async () => {
  vi.spyOn(CloudClient.prototype, "get").mockRejectedValue(
    new CloudAuthError("Unauthorized", { status: 401 }),
  );
  expect(await new LocalAccount().check()).toMatchObject({
    connected: true,
    auth: "expired",
    reachable: true,
  });
  expect(new LocalAccount().status().auth).toBe("expired");
});

it("does not report a network timeout as a successful connection", async () => {
  vi.spyOn(CloudClient.prototype, "get").mockRejectedValue(
    new CloudNetworkError("Timed out"),
  );
  expect(await new LocalAccount().check()).toMatchObject({ reachable: false });
});

it("uses the server directory even when the process default contains another login", async () => {
  const preview = join(directory, "preview");
  const account = new LocalAccount(preview);
  expect(account.status().connected).toBe(false);
  vi.mocked(pollForToken).mockResolvedValue({
    ...credentials(),
    accessToken: "preview-access",
    user: { id: "preview-user", name: "Preview account", email: "preview@example.test" },
  });
  await account.login("https://cloud.example.test");
  await vi.waitFor(() => expect(account.status().attempt?.status).toBe("done"));
  expect(loadCredentials(preview)?.accessToken).toBe("preview-access");
  expect(account.status().account).toBe("Preview account");
  expect(loadCredentials(preview)?.accountId).toBe("preview-user");
  expect(loadCredentials()?.accessToken).toBe("test-access");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  await account.logout();
  expect(loadCredentials(preview)).toBeNull();
  expect(new LocalAccount(preview).status().server).toBe("https://cloud.example.test");
  expect(loadCredentials()?.accessToken).toBe("test-access");
});

it("refreshes the account name and falls back to email when the name is removed", async () => {
  const get = vi.spyOn(CloudClient.prototype, "get").mockResolvedValue({
    user: { id: "user-1", name: "Account name", email: "user@example.test" },
  });
  const account = new LocalAccount();
  expect((await account.check()).account).toBe("Account name");
  get.mockResolvedValue({ user: { id: "user-1", name: null, email: "user@example.test" } });
  expect((await account.check()).account).toBe("user@example.test");
  expect(loadCredentials()?.accountName).toBeUndefined();
});

it("remembers a selected server after a failed login and restart without changing another directory", async () => {
  const preview = join(directory, "server-preview");
  vi.mocked(requestDeviceCode).mockRejectedValue(new Error("offline"));
  await new LocalAccount(preview).login("http://localhost:3000/");
  expect(new LocalAccount(preview).status()).toMatchObject({ connected: false, server: "http://localhost:3000" });
  expect(new LocalAccount().status().server).toBe("https://cloud.example.test");
});

it("does not save late authorization results after cancellation", async () => {
  clearCredentials();
  let finish!: (value: ReturnType<typeof credentials>) => void;
  vi.mocked(pollForToken).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const account = new LocalAccount();
  await account.login("https://cloud.example.test");
  account.cancel();
  finish(credentials());
  await Promise.resolve();
  expect(loadCredentials()).toBeNull();
});

it("does not erase a new login while the old remote logout is pending", async () => {
  let finish!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const logout = new LocalAccount().logout();
  expect(loadCredentials()).toBeNull();
  saveCredentials({ ...credentials(), accessToken: "new-login" });
  finish(new Response("{}"));
  await logout;
  expect(loadCredentials()?.accessToken).toBe("new-login");
});

it("does not write a late check result to a replacement account", async () => {
  let finish!: (value: unknown) => void;
  vi.spyOn(CloudClient.prototype, "get").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const check = new LocalAccount().check();
  saveCredentials({ ...credentials(), accessToken: "new-login" });
  finish({ user: { email: "old@example.test" } });
  await check;
  expect(loadCredentials()?.accountEmail).toBeUndefined();
  expect(loadCredentials()?.checkedAt).toBeUndefined();
});
