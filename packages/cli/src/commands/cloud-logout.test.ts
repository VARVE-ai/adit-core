import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ loadCredentials: vi.fn(), clearCredentials: vi.fn(), loadConfig: vi.fn(), openDatabase: vi.fn(), closeDatabase: vi.fn(), clearSyncState: vi.fn(), existsSync: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
vi.mock("@varveai/adit-core", () => ({ ...mocks, normalizeServerUrl: (url: string) => url }));
vi.mock("@varveai/adit-cloud", () => ({ ...mocks }));
vi.mock("./project-initialization.js", () => ({ loadInitializedProjectConfig: vi.fn() }));
vi.mock("../local/daemon.js", () => ({ startDaemon: vi.fn(), daemonStatus: vi.fn() }));
import { cloudLogoutCommand } from "./cloud.js";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
  vi.spyOn(console, "log").mockImplementation(() => {});
  mocks.loadCredentials.mockReturnValue({ serverUrl: "http://cloud.test", authType: "device", refreshToken: "test-refresh" });
  mocks.loadConfig.mockReturnValue({ dbPath: "/nonexistent/adit.sqlite" });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("clears credentials outside initialized projects", async () => {
  mocks.existsSync.mockReturnValue(false);
  await cloudLogoutCommand();
  expect(mocks.clearCredentials).toHaveBeenCalledOnce();
  expect(mocks.openDatabase).not.toHaveBeenCalled();
});
it("clears credentials even when the project is corrupt and remote revocation fails", async () => {
  vi.mocked(fetch).mockRejectedValue(new Error("offline"));
  mocks.loadConfig.mockImplementation(() => { throw new Error("corrupt manifest"); });
  await cloudLogoutCommand();
  expect(mocks.clearCredentials).toHaveBeenCalledOnce();
});
it("closes the database and clears credentials after sync cleanup fails", async () => {
  const db = {};
  mocks.existsSync.mockReturnValue(true);
  mocks.openDatabase.mockReturnValue(db);
  mocks.clearSyncState.mockImplementation(() => { throw new Error("busy database"); });
  await cloudLogoutCommand();
  expect(mocks.closeDatabase).toHaveBeenCalledWith(db);
  expect(mocks.clearCredentials).toHaveBeenCalledOnce();
});
it("static-token logout clears the local login without trying to refresh or revoke a nonexistent refresh token", async () => {
  mocks.loadCredentials.mockReturnValue({ serverUrl: "http://cloud.test", authType: "token" });
  await cloudLogoutCommand();
  expect(fetch).not.toHaveBeenCalled();
  expect(mocks.clearCredentials).toHaveBeenCalledOnce();
});
