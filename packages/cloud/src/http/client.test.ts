import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const tempHome = join(tmpdir(), `adit-client-test-${randomBytes(8).toString("hex")}`);

vi.mock("../auth/credential-protection.js", () => ({
  protectCredentialKey: (_id: string, key: Buffer) => ({ scheme: "test", value: key.toString("base64") }),
  unprotectCredentialKey: (key: { value: string }) => Buffer.from(key.value, "base64"),
}));
beforeEach(() => vi.stubEnv("ADIT_LOCAL_DATA_DIR", join(tempHome, ".adit")));
afterEach(() => {
  // tempHome is a generated test-owned absolute path under the OS temp directory.
  rmSync(tempHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

import { CloudClient } from "./client.js";
import { CloudAuthError } from "./errors.js";
import { loadCredentials, saveCredentials, clearCredentials, type CloudCredentials } from "../auth/credentials.js";

function makeCreds(overrides: Partial<CloudCredentials> = {}): CloudCredentials {
  return {
    authType: "device",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    clientId: "client-1",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    serverUrl: "http://cloud.test",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "Content-Type": "application/json" },
  });
}

describe("CloudClient token refresh", () => {
  it("preserves multipart files and the fetch-generated boundary when replaying after token refresh", async () => {
    const credentials = makeCreds({ expiresAt: new Date(Date.now() + 3600000).toISOString() });
    saveCredentials(credentials);
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ error: "Invalid token", code: "invalid_or_expired_token" }, 401))
      .mockResolvedValueOnce(jsonResponse({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ attachment: { id: "image-1" } }));
    const body = new FormData();
    body.append("file", new File(["GIF89a"], "reference.gif", { type: "image/gif" }));
    const client = new CloudClient("http://cloud.test", credentials, { maxRetries: 0 });
    await expect(client.postForm("/api/cli/tasks/task-1/attachments", body)).resolves.toEqual({ attachment: { id: "image-1" } });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
    for (const index of [0, 2]) {
      const init = vi.mocked(fetch).mock.calls[index][1]!;
      expect(init.body).toBe(body);
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).has("content-type")).toBe(false);
      expect(new Headers(init.headers).get("authorization")).toBe(index === 0 ? "Bearer old-access" : "Bearer new-access");
    }
    expect(await (body.get("file") as File).text()).toBe("GIF89a");
  });

  beforeEach(() => {
    mkdirSync(join(tempHome, ".adit"), { recursive: true });
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();

  });

  it("computes expiresAt when refresh response only returns expiresIn", async () => {
    const before = Date.now();
    const credentials = makeCreds();
    saveCredentials(credentials);

    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        accessToken: "new-access",
        refreshToken: "new-refresh",
        clientId: "client-1",
        expiresIn: 3600,
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const client = new CloudClient("http://cloud.test", credentials);
    await client.get("/api/test");

    const saved = loadCredentials();
    expect(saved?.accessToken).toBe("new-access");
    expect(saved?.refreshToken).toBe("new-refresh");
    expect(new Date(saved!.expiresAt).getTime()).toBeGreaterThanOrEqual(before + 3_590_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns refreshed credentials for non-HTTP transports", async () => {
    const credentials = makeCreds();
    saveCredentials(credentials);

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      clientId: "client-1",
      expiresIn: 3600,
    }));

    const client = new CloudClient("http://cloud.test", credentials);
    const fresh = await client.getFreshCredentials();

    expect(fresh.accessToken).toBe("new-access");
    expect(fresh.refreshToken).toBe("new-refresh");
    expect(loadCredentials()?.accessToken).toBe("new-access");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("records auth failure when refresh response lacks expiry metadata", async () => {
    const credentials = makeCreds();
    saveCredentials(credentials);

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    }));

    const client = new CloudClient("http://cloud.test", credentials);
    await expect(client.get("/api/test")).rejects.toBeInstanceOf(CloudAuthError);

    const saved = loadCredentials();
    expect(saved?.lastAuthFailure?.stage).toBe("refresh");
    expect(saved?.lastAuthFailure?.code).toBe("malformed_refresh_response");
  });

  it("reuses credentials refreshed by another process instead of rotating twice", async () => {
    const original = makeCreds();
    saveCredentials(original);
    const alreadyRefreshed = makeCreds({
      ...original,
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    saveCredentials(alreadyRefreshed);

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ok: true }));

    const client = new CloudClient("http://cloud.test", original);
    await client.get("/api/test");

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(fetch).mock.calls[0];
    expect(String(call[0])).toBe("http://cloud.test/api/test");
    expect((call[1]?.headers as Record<string, string>).Authorization).toBe("Bearer fresh-access");
  });
  for (const authType of ["device", "token"] as const) {
    it("explains device deletion for " + authType + " uploads", async () => {
      const credentials = makeCreds({ authType, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      saveCredentials(credentials);
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ code: "client_deleted" }, 403));
      const client = new CloudClient("http://cloud.test", credentials);
      await expect(client.post("/api/sync/push", {})).rejects.toThrow("Device has been unlinked");
      expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
      expect(loadCredentials()?.lastAuthFailure?.code).toBe("client_deleted");
    });
  }
  it("explains device deletion when its access token has already expired", async () => {
    const credentials = makeCreds();
    saveCredentials(credentials);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: "client_deleted" }, 403));
    await expect(new CloudClient("http://cloud.test", credentials).post("/api/sync/push", {})).rejects.toThrow("Device has been unlinked");
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  });

  const future = () => new Date(Date.now() + 3_600_000).toISOString();
  async function settle<T>(pending: Promise<T>): Promise<T> {
    const outcome = pending.then((value) => ({ value }), (error) => ({ error }));
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(10_000);
    const result = await outcome;
    if ("error" in result) throw result.error;
    return result.value;
  }

  it("reports a permission denial as an API error carrying the server's reason", async () => {
    const credentials = makeCreds({ expiresAt: future() });
    saveCredentials(credentials);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: "Only the responsible member can manage tasks" }, 403));
    const client = new CloudClient("http://cloud.test", credentials, { maxRetries: 0 });
    await expect(client.patch("/api/cli/tasks/task-1", { patch: {} })).rejects.toMatchObject({ name: "CloudApiError", status: 403, body: { error: "Only the responsible member can manage tasks" } });
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    expect(loadCredentials()?.lastAuthFailure).toBeUndefined();
  });

  it("keeps a 403 with an auth code as an auth failure with its status and code", async () => {
    const credentials = makeCreds({ expiresAt: future() });
    saveCredentials(credentials);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: "Linked device is inactive", code: "client_inactive" }, 403));
    const client = new CloudClient("http://cloud.test", credentials, { maxRetries: 0 });
    await expect(client.get("/api/cli/tasks")).rejects.toMatchObject({ name: "CloudAuthError", status: 403, code: "client_inactive" });
    expect(loadCredentials()?.lastAuthFailure?.code).toBe("client_inactive");
  });

  it("retries once after refreshing a rejected token even with a zero retry budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const credentials = makeCreds({ expiresAt: future() });
      saveCredentials(credentials);
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse({ error: "Invalid token", code: "invalid_or_expired_token" }, 401))
        .mockResolvedValueOnce(jsonResponse({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 }))
        .mockResolvedValueOnce(jsonResponse({ task: { id: "task-1" } }));
      const client = new CloudClient("http://cloud.test", credentials, { maxRetries: 0 });
      await expect(settle(client.patch("/api/cli/tasks/task-1", { patch: { progressState: "done" } }))).resolves.toEqual({ task: { id: "task-1" } });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
      const retry = vi.mocked(fetch).mock.calls[2];
      expect(String(retry[0])).toBe("http://cloud.test/api/cli/tasks/task-1");
      expect((retry[1]?.headers as Record<string, string>).Authorization).toBe("Bearer new-access");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a rate-limited write after Retry-After even with a zero retry budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const credentials = makeCreds({ expiresAt: future() });
      saveCredentials(credentials);
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Slow down" }), { status: 429, statusText: "Too Many Requests", headers: { "Retry-After": "1", "Content-Type": "application/json" } }))
        .mockResolvedValueOnce(jsonResponse({ task: { id: "task-1" } }));
      const client = new CloudClient("http://cloud.test", credentials, { maxRetries: 0 });
      await expect(settle(client.patch("/api/cli/tasks/task-1", { patch: { progressState: "done" } }))).resolves.toEqual({ task: { id: "task-1" } });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on persistent rate limiting with the real status instead of a network error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const credentials = makeCreds({ expiresAt: future() });
      saveCredentials(credentials);
      vi.mocked(fetch).mockImplementation(async () => jsonResponse({ error: "Slow down" }, 429));
      const client = new CloudClient("http://cloud.test", credentials, { maxRetries: 0 });
      await expect(settle(client.get("/api/cli/tasks"))).rejects.toMatchObject({ name: "CloudApiError", status: 429, body: { error: "Slow down" } });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  for (const action of ["logout", "replace"] as const) {
    it(`does not write late refresh results after ${action}`, async () => {
      const credentials = makeCreds(); saveCredentials(credentials);
      let finish!: (response: Response) => void;
      vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const pending = new CloudClient("http://cloud.test", credentials).getFreshCredentials();
      const rejected = expect(pending).rejects.toThrow("Cloud account changed");
      clearCredentials();
      if (action === "replace") saveCredentials(makeCreds({ accessToken: "replacement" }));
      finish(jsonResponse({ accessToken: "late-access", refreshToken: "late-refresh", expiresIn: 3600 }));
      await rejected;
      expect(loadCredentials()?.accessToken ?? null).toBe(action === "replace" ? "replacement" : null);
      expect(loadCredentials()?.lastAuthFailure).toBeUndefined();
    });
  }

  it("serializes concurrent refreshes and rotates only once", async () => {
    const credentials = makeCreds(); saveCredentials(credentials);
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ accessToken: "fresh", refreshToken: "rotated", expiresIn: 3600 }));
    const clients = [new CloudClient("http://cloud.test", { ...credentials }), new CloudClient("http://cloud.test", { ...credentials })];
    const fresh = await Promise.all(clients.map(client => client.getFreshCredentials()));
    expect(fresh.map(c => c.accessToken)).toEqual(["fresh", "fresh"]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps in-memory token failures separate from the saved login", async () => {
    saveCredentials(makeCreds({ authType: "token", accessToken: "saved" }));
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ code: "invalid_token" }, 401));
    const client = new CloudClient("http://cloud.test", makeCreds({ authType: "token", accessToken: "env-token" }));
    await expect(client.get("/api/test")).rejects.toBeInstanceOf(CloudAuthError);
    expect(loadCredentials()?.lastAuthFailure).toBeUndefined();
    expect(loadCredentials()?.accessToken).toBe("saved");
  });

  it("uses the explicitly selected credential database for refresh", async () => {
    const other = join(tempHome, "preview"), credentials = makeCreds();
    saveCredentials(makeCreds({ accessToken: "default-login" }));
    saveCredentials(credentials, other);
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ accessToken: "preview-refreshed", refreshToken: "rotated", expiresIn: 3600 }));
    await new CloudClient("http://cloud.test", credentials, { credentialsDirectory: other }).getFreshCredentials();
    expect(loadCredentials(other)?.accessToken).toBe("preview-refreshed");
    expect(loadCredentials()?.accessToken).toBe("default-login");
  });

});
