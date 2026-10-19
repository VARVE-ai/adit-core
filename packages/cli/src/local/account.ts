import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  LocalStateError,
  getLocalClientId,
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
  isTokenExpired,
  clearSyncErrors,
} from "@varveai/adit-cloud";
import { CLI_VERSION } from "../version.js";

export class LocalAccount {
  private controller?: AbortController;
  private attempt?: {
    id: string;
    status: string;
    userCode?: string;
    verificationUrl?: string;
    expiresAt?: string;
    error?: string;
  };
  status() {
    const c = loadCredentials();
    return {
      connected: !!c,
      server: c?.serverUrl ?? process.env.ADIT_CLOUD_URL ?? DEFAULT_SERVER_URL,
      auth: c ? (isTokenExpired(c) ? "expired" : "valid") : "disconnected",
      attempt: this.attempt,
    };
  }
  async check() {
    const c = loadCredentials();
    if (!c)
      return {
        ...this.status(),
        reachable: null,
        checkedAt: new Date().toISOString(),
      };
    try {
      const data = await new CloudClient(c.serverUrl, c, {
        timeoutMs: 5000,
        maxRetries: 0,
      }).get<{
        client?: { displayName?: string };
        user?: { email?: string; name?: string };
      }>("/api/sync/status");
      return {
        ...this.status(),
        reachable: true,
        account: data.user?.email ?? data.user?.name,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        ...this.status(),
        ...(error instanceof CloudAuthError ? { auth: "expired" } : {}),
        reachable:
          error instanceof CloudAuthError && error.status !== undefined,
        checkedAt: new Date().toISOString(),
      };
    }
  }
  async login(server?: string) {
    if (this.attempt?.status === "pending") return this.attempt;
    const serverUrl = normalizeServerUrl(server || this.status().server);
    const existing = loadCredentials();
    if (existing && existing.serverUrl !== serverUrl)
      throw new LocalStateError(
        "Disconnect the current server before changing servers",
        409,
      );
    const attempt = (this.attempt = {
      id: randomUUID(),
      status: "pending",
    } as NonNullable<typeof this.attempt>);
    this.controller?.abort();
    const controller = (this.controller = new AbortController());
    try {
      const code = await requestDeviceCode(
        serverUrl,
        {
          machineId: createHash("sha256")
            .update(`${hostname()}-${getLocalClientId()}`)
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
          saveCredentials({
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            clientId: tokens.clientId,
            expiresAt:
              tokens.expiresAt ?? new Date(Date.now() + 3600000).toISOString(),
            serverUrl,
          });
          clearSyncErrors();
          attempt.status = "done";
        })
        .catch(() => {
          if (this.attempt === attempt && attempt.status === "pending") {
            attempt.status = "failed";
            attempt.error =
              "Authorization failed, expired or was denied. Please retry.";
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
  cancel(): void {
    if (this.attempt) this.attempt.status = "cancelled";
    this.controller?.abort();
  }
  async logout() {
    this.cancel();
    const c = loadCredentials();
    try {
      if (c?.refreshToken && c.authType !== "token")
        await fetch(
          `${normalizeServerUrl(c.serverUrl)}/api/auth/token/revoke`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ refreshToken: c.refreshToken }),
            signal: AbortSignal.timeout(5000),
          },
        ).catch(() => {});
    } finally {
      clearCredentials();
    }
    return this.status();
  }
}
