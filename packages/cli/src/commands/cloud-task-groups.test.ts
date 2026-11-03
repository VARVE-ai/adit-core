import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  options: vi.fn(),
  credentials: vi.fn(),
  context: vi.fn(),
}));
vi.mock("@varveai/adit-cloud", async (original) => ({
  ...(await original<typeof import("@varveai/adit-cloud")>()),
  loadCredentials: mocks.credentials,
  CloudClient: class {
    get = mocks.get;
    post = mocks.post;
    patch = mocks.patch;
    delete = mocks.delete;
    constructor(_url: string, _credentials: unknown, options: unknown) {
      mocks.options(options);
    }
  },
}));
vi.mock("./project-context.js", () => ({ loadProjectContext: mocks.context }));
import { CloudApiError } from "@varveai/adit-cloud";
import {
  cloudTaskGroupsCommand,
  registerCloudTaskGroupCommands,
  validateGroupOptions,
} from "./cloud-task-groups.js";
const groupId = "11111111-1111-4111-8111-111111111111",
  otherId = "22222222-2222-4222-8222-222222222222",
  taskId = "33333333-3333-4333-8333-333333333333";
const updatedAt = "2026-11-02T00:00:00.000Z",
  stale = "2026-11-01T00:00:00.000Z";
const result = () => JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0]);
beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  mocks.credentials.mockReturnValue({ serverUrl: "https://example.test" });
  mocks.context.mockReturnValue({ projectId: "local-project" });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});
describe("task group CLI and SDK", () => {
  it("rejects ambiguous scope, order, blank names and unrelated task versions before writes", () => {
    expect(() => validateGroupOptions("list", { team: groupId, personal: true })).toThrow();
    expect(() =>
      validateGroupOptions("reorder", { before: otherId, first: true }, groupId),
    ).toThrow();
    expect(() => validateGroupOptions("create", { name: "  " })).toThrow();
    expect(() =>
      validateGroupOptions(
        "move",
        { task: [taskId], taskVersion: [`${otherId}=${updatedAt}`] },
        groupId,
      ),
    ).toThrow();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("registers commands and creates a trimmed name in the explicit workspace without retrying writes", async () => {
    const tasks = new Command();
    registerCloudTaskGroupCommands(tasks);
    mocks.post.mockResolvedValue({ group: { id: groupId } });
    await tasks.parseAsync(
      ["groups", "create", "--name", " Sprint A ", "--project", "chosen", "--personal", "--json"],
      { from: "user" },
    );
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(
      "/api/cli/tasks/groups?localProjectId=chosen&scope=personal",
      { name: "Sprint A" },
    );
    expect(mocks.options).toHaveBeenCalledWith({ maxRetries: 0 });
  });
  it("follows every group page with the same scope, including other members' tasks", async () => {
    mocks.get
      .mockResolvedValueOnce({
        group: { id: groupId, updatedAt },
        tasks: [{ taskId, assigneeId: "other" }],
        total: 2,
        nextOffset: 1,
      })
      .mockResolvedValueOnce({
        group: { id: groupId, updatedAt },
        tasks: [{ taskId: otherId }],
        total: 2,
        nextOffset: null,
      });
    await cloudTaskGroupsCommand("show", { team: otherId, json: true }, groupId);
    expect(result().tasks).toHaveLength(2);
    expect(result().nextOffset).toBeNull();
    expect(mocks.get.mock.calls[1][0]).toContain(
      `localProjectId=local-project&teamId=${otherId}&offset=1`,
    );
  });
  it("reports an inconsistent paginated snapshot instead of a partial successful list", async () => {
    mocks.get
      .mockResolvedValueOnce({ group: { updatedAt }, tasks: [{ taskId }], total: 2, nextOffset: 1 })
      .mockResolvedValueOnce({ group: { updatedAt }, tasks: [], total: 1, nextOffset: null });
    await cloudTaskGroupsCommand("show", { json: true }, groupId);
    expect(result().ok).toBe(false);
    expect(process.exitCode).toBe(1);
  });
  it("passes explicit group and task versions unchanged and disables write retries", async () => {
    mocks.get.mockResolvedValue({ groups: [{ id: groupId, updatedAt }] });
    mocks.patch.mockResolvedValue({ group: { id: groupId } });
    await cloudTaskGroupsCommand(
      "update",
      { name: "Renamed", expectedUpdatedAt: stale, json: true },
      groupId,
    );
    expect(mocks.patch.mock.calls[0][1].expectedUpdatedAt).toBe(stale);
    mocks.post
      .mockResolvedValueOnce({
        tasks: [{ taskId, groupId: otherId, expectedUpdatedAt: updatedAt }],
      })
      .mockResolvedValueOnce({ changed: 1 });
    await cloudTaskGroupsCommand(
      "move",
      { task: [taskId], taskVersion: [`${taskId}=${stale}`], json: true },
      groupId,
    );
    expect(mocks.post.mock.calls.at(-1)![1]).toEqual({
      targetGroupId: groupId,
      tasks: [{ taskId, groupId: otherId, expectedUpdatedAt: stale }],
    });
    expect(mocks.options.mock.calls.every(([options]) => options.maxRetries === 0)).toBe(true);
  });
  it("does not remove a task that has moved away from the specified source", async () => {
    mocks.post.mockResolvedValue({
      tasks: [{ taskId, groupId: otherId, expectedUpdatedAt: updatedAt }],
    });
    await cloudTaskGroupsCommand("remove", { task: [taskId], json: true }, groupId);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(result().ok).toBe(false);
    expect(result().error).toContain("source group");
  });
  it("deletes the group with its version and preserves structured server conflicts", async () => {
    mocks.get.mockResolvedValue({ groups: [{ id: groupId, updatedAt }] });
    mocks.delete.mockRejectedValue(
      new CloudApiError("The group changed", 409, { code: "GROUP_VERSION_CONFLICT" }),
    );
    await cloudTaskGroupsCommand("delete", { json: true }, groupId);
    expect(mocks.delete.mock.calls[0][1]).toEqual({ expectedUpdatedAt: updatedAt });
    expect(result()).toMatchObject({ ok: false, status: 409, code: "GROUP_VERSION_CONFLICT" });
  });
});
