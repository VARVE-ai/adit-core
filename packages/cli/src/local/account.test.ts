import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CloudAuthError,
  CloudClient,
  CloudNetworkError,
  isTokenExpired,
  loadCredentials,
} from "@varveai/adit-cloud";
import { LocalAccount } from "./account.js";

vi.mock("@varveai/adit-cloud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@varveai/adit-cloud")>()),
  loadCredentials: vi.fn(),
  isTokenExpired: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(loadCredentials).mockReturnValue({
    accessToken: "test-access",
    refreshToken: "test-refresh",
    clientId: "test-client",
    expiresAt: "2099-01-01T00:00:00.000Z",
    serverUrl: "https://cloud.example.test",
  });
  vi.mocked(isTokenExpired).mockReturnValue(false);
});
afterEach(() => vi.restoreAllMocks());

it("does not contact Cloud without a connected account", async () => {
  vi.mocked(loadCredentials).mockReturnValue(null);
  const get = vi.spyOn(CloudClient.prototype, "get");
  expect(await new LocalAccount().check()).toMatchObject({
    connected: false,
    auth: "disconnected",
    reachable: null,
  });
  expect(get).not.toHaveBeenCalled();
});

it("reports a successful check without fabricating the missing account name", async () => {
  vi.spyOn(CloudClient.prototype, "get").mockResolvedValue({
    auth: { valid: true },
  });
  const result = await new LocalAccount().check();
  expect(result).toMatchObject({
    connected: true,
    auth: "valid",
    reachable: true,
  });
  expect(result).not.toHaveProperty("account", expect.any(String));
  expect(result.checkedAt).toBeTruthy();
});

it("distinguishes rejected authorization from an unreachable service", async () => {
  vi.spyOn(CloudClient.prototype, "get").mockRejectedValue(
    new CloudAuthError("Unauthorized", { status: 401 }),
  );
  expect(await new LocalAccount().check()).toMatchObject({
    connected: true,
    auth: "expired",
    reachable: true,
  });
});

it("does not report a network timeout as a successful connection", async () => {
  vi.spyOn(CloudClient.prototype, "get").mockRejectedValue(
    new CloudNetworkError("Timed out"),
  );
  expect(await new LocalAccount().check()).toMatchObject({ reachable: false });
});
