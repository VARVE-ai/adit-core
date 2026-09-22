import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), credentials: vi.fn(), config: vi.fn() }));
vi.mock("@varveai/adit-cloud", async (original) => ({ ...await original<typeof import("@varveai/adit-cloud")>(), loadCredentials: mocks.credentials, CloudClient: class { get = mocks.get; patch = mocks.patch; } }));
vi.mock("./project-initialization.js", () => ({ loadInitializedProjectConfig: mocks.config }));
import { CloudApiError } from "@varveai/adit-cloud";
import { cloudTasksCommand, registerCloudTaskCommands, taskDueDate, taskPatchFromOptions } from "./cloud-tasks.js";

const taskId = "a1111111-1111-4111-8111-111111111111";
const updatedAt = "2026-09-22T01:00:00.000Z";
beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  mocks.credentials.mockReturnValue({ serverUrl: "https://cloud.example", accessToken: "private" });
  mocks.config.mockReturnValue({ projectId: "local-project" });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

describe("cloud task commands", () => {
  it("uses the current local project and preserves real task IDs and pagination", async () => {
    const result = { tasks: [{ taskId, title: "Fix upload" }], total: 60, nextOffset: 50 };
    mocks.get.mockResolvedValue(result);
    const cloud = new Command();
    registerCloudTaskCommands(cloud);
    await cloud.parseAsync(["tasks", "list", "--json"], { from: "user" });
    expect(mocks.get).toHaveBeenCalledWith("/api/cli/tasks?localProjectId=local-project&state=unfinished&offset=0&limit=50");
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toEqual(result);
  });

  it("preserves current project identity even when selecting a team", async () => {
    mocks.get.mockResolvedValue({ tasks: [], total: 0, nextOffset: null });
    await cloudTasksCommand("list", { team: taskId, json: true });
    expect(mocks.config).toHaveBeenCalledWith("adit cloud tasks list");
    expect(mocks.get.mock.calls[0][0]).toContain(`teamId=${taskId}`);
    expect(mocks.get.mock.calls[0][0]).toContain("localProjectId=local-project");
  });

  it("scopes always includes the current project and never calls account-wide discovery", async () => {
    const result = { project: { id: "project", localProjectId: "local-project", name: "Test project" }, teams: [] };
    mocks.get.mockResolvedValue(result);
    const cloud = new Command();
    registerCloudTaskCommands(cloud);
    await cloud.parseAsync(["tasks", "scopes", "--json"], { from: "user" });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith("/api/cli/tasks/scopes?localProjectId=local-project");
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toEqual(result);
  });

  it("does not fall back to account-wide teams when project initialization is missing", async () => {
    mocks.config.mockReturnValue(null);
    await cloudTasksCommand("scopes", { json: true });
    await cloudTasksCommand("list", { team: taskId, json: true });
    expect(mocks.get).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("preserves only server-provided project team candidates on ambiguity", async () => {
    const body = { error: "Choose a linked team", code: "TEAM_SELECTION_REQUIRED", project: { name: "Test project" }, teams: [{ id: taskId, name: "Linked team" }] };
    mocks.get.mockRejectedValueOnce(new CloudApiError(body.error, 400, body));
    await cloudTasksCommand("list", { json: true });
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toMatchObject({ ...body, ok: false });
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("supports personal scope and explicit project IDs without reading an unrelated cwd", async () => {
    mocks.get.mockResolvedValue({ tasks: [], total: 0, nextOffset: null });
    await cloudTasksCommand("list", { project: "chosen-project", personal: true, json: true, offset: "50" });
    expect(mocks.config).not.toHaveBeenCalled();
    expect(mocks.get).toHaveBeenCalledWith("/api/cli/tasks?localProjectId=chosen-project&scope=personal&state=unfinished&offset=50&limit=50");
  });

  it("returns resource URLs without fetching their content", async () => {
    mocks.get.mockResolvedValue({ task: { taskId }, prd: null, resources: [{ url: "https://private.example/resource" }] });
    await cloudTasksCommand("context", { json: true }, taskId);
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(`/api/cli/tasks/${taskId}/context`);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("reads a current version before updating when no version was supplied", async () => {
    mocks.get.mockResolvedValue({ task: { taskId, updatedAt } });
    mocks.patch.mockResolvedValue({ task: { taskId, progressState: "done" } });
    await cloudTasksCommand("update", { state: "done", json: true }, taskId);
    expect(mocks.patch).toHaveBeenCalledExactlyOnceWith(`/api/cli/tasks/${taskId}`, { patch: { progressState: "done" }, expectedUpdatedAt: updatedAt });
  });

  it("does not overwrite or retry a conflict using a fresh version", async () => {
    mocks.patch.mockRejectedValue(new CloudApiError("Changed", 409));
    await cloudTasksCommand("update", { due: "2026-09-30", expectedUpdatedAt: updatedAt, json: true }, taskId);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toMatchObject({ ok: false, status: 409 });
  });

  it("validates scope, dates and empty patches without mutating tasks", async () => {
    expect(taskDueDate("2028-02-29")).toBe("2028-02-29T00:00:00.000Z");
    expect(() => taskDueDate("2026-02-29")).toThrow();
    expect(() => taskPatchFromOptions({ due: "2026-09-30", clearDue: true })).toThrow();
    expect(() => taskPatchFromOptions({})).toThrow();
    await cloudTasksCommand("list", { team: taskId, personal: true, json: true });
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("requires login and never substitutes task titles for IDs", async () => {
    mocks.credentials.mockReturnValue(null);
    await cloudTasksCommand("show", { json: true }, taskId);
    expect(process.exitCode).toBe(1);
    expect(mocks.get).not.toHaveBeenCalled();
    await cloudTasksCommand("update", { state: "done", json: true }, "Fix upload");
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});
