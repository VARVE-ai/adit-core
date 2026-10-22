import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
const mocks = vi.hoisted(() => ({ get: vi.fn(), credentials: vi.fn(), config: vi.fn() }));
vi.mock("@varveai/adit-cloud", async original => ({ ...await original<typeof import("@varveai/adit-cloud")>(),
  loadCredentials: mocks.credentials, CloudClient: class { get = mocks.get; } }));
vi.mock("./project-context.js", () => ({ loadProjectContext: mocks.config }));
import { cloudMemoriesCommand, memoryQueryOptions, registerCloudMemoryCommands } from "./cloud-memories.js";

beforeEach(() => {
  vi.clearAllMocks(); process.exitCode = undefined;
  mocks.credentials.mockReturnValue({ serverUrl: "http://example.test", accessToken: "test" });
  mocks.config.mockReturnValue({ projectId: "local-project" });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });
describe("memory CLI", () => {
  it("requires an explicit memory scope and never attaches a project to personal memory", () => {
    expect(() => memoryQueryOptions("show", {})).toThrow(/scope/);
    expect(() => memoryQueryOptions("show", { scope: "personal", project: "p" })).toThrow(/does not take/);
    expect(memoryQueryOptions("show", { scope: "personal" }).project).toBeUndefined();
    expect(mocks.config).not.toHaveBeenCalled();
  });
  it("resolves the local project only for project queries and fails instead of choosing another", () => {
    expect(memoryQueryOptions("show", { scope: "project" }).project).toBe("local-project");
    mocks.config.mockReturnValue(null);
    expect(() => memoryQueryOptions("show", { scope: "project" })).toThrow(/Settings/);
    expect(memoryQueryOptions("show", { scope: "project", project: "explicit" }).project).toBe("explicit");
  });
  it("queries history with exact scope and version without a write request", async () => {
    mocks.get.mockResolvedValue({ scope: "project", project: { id: "p", name: "ADIT" }, history: [], nextOffset: null });
    await cloudMemoriesCommand("history", { scope: "project", project: "p", version: "2", json: true });
    const url = new URL(mocks.get.mock.calls[0][0], "http://test");
    expect(url.pathname).toBe("/api/cli/memories");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ action: "history", scope: "project", project: "p", version: "2" });
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0]).history).toEqual([]);
  });
  it("registers search and evidence commands with pagination", async () => {
    mocks.get.mockResolvedValue({ scope: "personal", project: null, entries: [] });
    const command = new Command(); registerCloudMemoryCommands(command);
    await command.parseAsync(["memories", "search", "documentation", "--scope", "personal", "--offset", "20", "--json"], { from: "user" });
    expect(mocks.get.mock.calls[0][0]).toContain("q=documentation");
    expect(mocks.get.mock.calls[0][0]).toContain("offset=20");
  });
  it("rejects invalid versions and limits before a network request", async () => {
    await cloudMemoriesCommand("show", { scope: "personal", version: "1.5", json: true });
    expect(process.exitCode).toBe(1); expect(mocks.get).not.toHaveBeenCalled();
    expect(() => memoryQueryOptions("history", { scope: "personal", limit: "101" })).toThrow(/limit/);
  });
});
