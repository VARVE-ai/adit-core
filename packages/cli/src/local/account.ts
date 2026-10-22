import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  LocalStateError,
  LocalStore,
  localDataDir,
  normalizeServerUrl,
} from "@varveai/adit-core";
import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  requestDeviceCode,
  pollForToken,
  DEFAULT_SERVER_URL,
  CloudClient,
  CloudAuthError,
  CloudNetworkError,
  isTokenExpired,
  updateCloudAccountMetadata,
} from "@varveai/adit-cloud";
import { CLI_VERSION } from "../version.js";

interface CloudAccountUser {
  id?: string;
  name?: string | null;
  email?: string | null;
}

function accountMetadata(user?: CloudAccountUser) {
  return {
    accountId: user?.id,
    accountName: user?.name ?? undefined,
    accountEmail: user?.email ?? undefined,
  };
}

export class LocalAccount {
  constructor(private readonly directory = localDataDir()) {}
  private preferredServer(): string {
    const store = new LocalStore(this.directory);
    try {
      return store.get("cloud-server", { url: "" }).url || process.env.ADIT_CLOUD_URL || DEFAULT_SERVER_URL;
    } finally {
      store.close();
    }
  }
  private rememberServer(serverUrl: string): void {
    const store = new LocalStore(this.directory);
    try {
      store.set("cloud-server", { url: serverUrl });
    } finally {
      store.close();
    }
  }
  private loginServer(server?: string): string {
    const serverUrl = normalizeServerUrl(server || this.status().server);
    try {
      const url = new URL(serverUrl);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new Error();
    } catch {
      throw new LocalStateError("Enter a valid Cloud server URL.");
    }
    const existing = loadCredentials(this.directory);
    if (existing && existing.serverUrl !== serverUrl)
      throw new LocalStateError("Disconnect the current server before changing servers", 409);
    this.rememberServer(serverUrl);
    return serverUrl;
  }
  private controller?: AbortController;
  private tokenAttempt?: symbol;
  private attempt?: {
    id: string;
    status: string;
    userCode?: string;
    verificationUrl?: string;
    expiresAt?: string;
    error?: string;
  };
  status() {
    const c = loadCredentials(this.directory);
    return {
      connected: !!c,
      server: c?.serverUrl ?? this.preferredServer(),
      auth: c
        ? c.authStatus === "expired" ||
          c.lastAuthFailure?.status === 401 ||
          c.lastAuthFailure?.status === 403 ||
          isTokenExpired(c)
          ? "expired"
          : "valid"
        : "disconnected",
      account: c?.accountName || c?.accountEmail,
      checkedAt: c?.checkedAt,
      reachable: c?.reachable ?? null,
      attempt: this.attempt,
    };
  }
  async check() {
    const c = loadCredentials(this.directory);
    if (!c)
      return {
        ...this.status(),
        reachable: null,
        checkedAt: new Date().toISOString(),
      };
    const checkedAt = new Date().toISOString();
    try {
      const data = await new CloudClient(c.serverUrl, c, {
        timeoutMs: 5000,
        maxRetries: 0,
        credentialsDirectory: this.directory,
      }).get<{ user?: CloudAccountUser }>(
        "/api/sync/status",
      );
      updateCloudAccountMetadata(
        {
          checkedAt,
          reachable: true,
          authStatus: "valid",
          ...(data.user ? accountMetadata(data.user) : {}),
        },
        c,
        this.directory,
      );
    } catch (error) {
      updateCloudAccountMetadata(
        {
          checkedAt,
          reachable:
            error instanceof CloudAuthError && error.status !== undefined,
          ...(error instanceof CloudAuthError
            ? { authStatus: "expired" as const }
            : {}),
        },
        c,
        this.directory,
      );
    }
    return this.status();
  }

  async login(server?: string) {
    if (this.tokenAttempt)
      throw new LocalStateError("A login is already in progress", 409);
    if (this.attempt?.status === "pending") return this.attempt;
    const serverUrl = this.loginServer(server);
    const attempt = (this.attempt = {
      id: randomUUID(),
      status: "pending",
    } as NonNullable<typeof this.attempt>);
    this.controller?.abort();
    const controller = (this.controller = new AbortController());
    try {
      const store = new LocalStore(this.directory);
      let clientId: string;
      try {
        clientId = store.identity("client");
      } finally {
        store.close();
      }
      const code = await requestDeviceCode(
        serverUrl,
        {
          machineId: createHash("sha256")
            .update(`${hostname()}-${clientId}`)
            .digest("hex")
            .slice(0, 32),
          platform: `${process.platform}-${process.arch}`,
          aditVersion: CLI_VERSION,
          displayName: hostname(),
        },
        AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      );
      if (this.attempt !== attempt || attempt.status !== "pending")
        return this.attempt;
      const verification = new URL(code.verificationUrl);
      if (!["https:", "http:"].includes(verification.protocol))
        throw new Error("Invalid authorization URL");
      Object.assign(attempt, {
        userCode: code.userCode,
        verificationUrl: code.verificationUrl,
        expiresAt: code.expiresAt,
      });
      void pollForToken(
        serverUrl,
        code.deviceCode,
        5000,
        300000,
        controller.signal,
      )
        .then((tokens) => {
          if (this.attempt !== attempt || attempt.status !== "pending") return;
          saveCredentials(
            {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              clientId: tokens.clientId,
              expiresAt:
                tokens.expiresAt ??
                new Date(Date.now() + 3600000).toISOString(),
              serverUrl,
              ...accountMetadata(tokens.user),
              checkedAt: new Date().toISOString(),
              reachable: true,
              authStatus: "valid",
            },
            this.directory,
          );
          attempt.status = "done";
        })
        .catch((error) => {
          if (this.attempt === attempt && attempt.status === "pending") {
            attempt.status = "failed";
            attempt.error =
              error instanceof Error &&
              /secure Cloud credential storage/.test(error.message)
                ? "Unable to save login securely. Unlock your operating system credential storage and retry."
                : "Authorization failed, expired or was denied. Please retry.";
          }
        });
      return attempt;
    } catch {
      if (controller.signal.aborted) return attempt;
      attempt.status = "failed";
      attempt.error = "Unable to request device authorization";
      return attempt;
    }
  }
  async loginWithToken(input: unknown, server?: string) {
    if (
      typeof input !== "string" ||
      !/^adit_[A-Za-z0-9_-]+$/.test(input.trim()) ||
      input.length > 8192
    )
      throw new LocalStateError(
        "Paste the device token generated in Cloud (adit_...).",
      );
    if (this.tokenAttempt || this.attempt?.status === "pending")
      throw new LocalStateError("A login is already in progress", 409);
    const serverUrl = this.loginServer(server);
    const existing = loadCredentials(this.directory);
    const attempt = (this.tokenAttempt = Symbol());
    const credentials = {
      authType: "token" as const,
      accessToken: input.trim(),
      refreshToken: "",
      clientId: "",
      expiresAt: "",
      serverUrl,
    };
    try {
      let status: { clientId?: string; user?: CloudAccountUser };
      try {
        status = await new CloudClient(serverUrl, credentials, {
          credentialsDirectory: this.directory,
          timeoutMs: 5000,
          maxRetries: 0,
        }).get("/api/sync/status");
      } catch (error) {
        // Do not return upstream response bodies, which may echo a credential.
        if (error instanceof CloudAuthError)
          throw new LocalStateError(
            "The device token is invalid or its device has been removed. Generate a new token in Cloud.",
          );
        if (error instanceof CloudNetworkError)
          throw new LocalStateError(
            "Unable to reach Cloud. Check the server address and try again.",
            502,
          );
        throw new LocalStateError(
          "Unable to verify the device token. Please try again.",
          502,
        );
      }
      if (
        this.tokenAttempt !== attempt ||
        (loadCredentials(this.directory)?.credentialId ?? null) !==
          (existing?.credentialId ?? null)
      )
        throw new LocalStateError(
          "Login cancelled or the account changed. Please try again.",
          409,
        );
      if (
        !status ||
        typeof status.clientId !== "string" ||
        !status.clientId.trim()
      )
        throw new LocalStateError(
          "Cloud did not return a device ID. The token was not saved.",
          502,
        );
      saveCredentials(
        {
          ...credentials,
          clientId: status.clientId,
          ...accountMetadata(status.user),
          checkedAt: new Date().toISOString(),
          reachable: true,
          authStatus: "valid",
        },
        this.directory,
      );
      this.attempt = undefined;
      return this.status();
    } finally {
      if (this.tokenAttempt === attempt) this.tokenAttempt = undefined;
    }
  }
  cancel(): void {
    this.tokenAttempt = undefined;
    if (this.attempt) this.attempt.status = "cancelled";
    this.controller?.abort();
  }
  async logout() {
    this.cancel();
    const c = loadCredentials(this.directory);
    if (c) this.rememberServer(c.serverUrl);
    if (c) clearCredentials(this.directory, c);
    if (c?.refreshToken && c.authType !== "token") {
      await fetch(`${normalizeServerUrl(c.serverUrl)}/api/auth/token/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: c.refreshToken }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
    return this.status();
  }
}
