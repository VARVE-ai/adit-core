import { Command } from "commander";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  postForm: vi.fn(),
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
    postForm = mocks.postForm;
    patch = mocks.patch;
    delete = mocks.delete;
    constructor(_url: string, _credentials: unknown, options: unknown) {
      mocks.options(options);
    }
  },
}));
vi.mock("./project-context.js", () => ({ loadProjectContext: mocks.context }));
import { registerCloudBlueprintCommands, prepareBlueprintInput } from "./cloud-blueprints.js";
import { registerCloudTaskModuleCommands } from "./cloud-task-modules.js";
const a = "11111111-1111-4111-8111-111111111111",
  b = "22222222-2222-4222-8222-222222222222",
  task = "33333333-3333-4333-8333-333333333333";
const version = "2026-11-12T00:00:00.000Z";
let directory: string;
const result = () => JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0]);
const modules = () => {
  const command = new Command();
  registerCloudTaskModuleCommands(command);
  return command;
};
const blueprints = () => {
  const command = new Command();
  registerCloudBlueprintCommands(command);
  return command;
};
beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  directory = mkdtempSync(join(tmpdir(), "adit-blueprint-test-"));
  mocks.credentials.mockReturnValue({ serverUrl: "https://example.test" });
  mocks.context.mockReturnValue({ projectId: "current-project" });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(directory, { recursive: true, force: true });
});
it("uploads real text and multi-module tasks with explicit scope and request identity; no write retries", async () => {
  const input = join(directory, "blueprint.json"),
    file = join(directory, "requirements.md");
  const manifest = {
    title: "Booking",
    modules: [{ name: "Billing" }, { name: "Emails" }],
    tasks: [{ title: "Notify", modules: ["Billing", "Emails"] }],
  };
  writeFileSync(input, JSON.stringify(manifest));
  writeFileSync(file, "# Requirements\n\nFull body 尾部");
  mocks.post.mockResolvedValue({
    blueprint: { id: a },
    tasks: [{ taskId: task }],
    attachments: [{ id: b }],
    reused: false,
  });
  mocks.postForm.mockResolvedValue({
    attachment: { id: b, displayName: "requirements.md", parseStatus: "ready", parseError: null },
  });
  await blueprints().parseAsync(
    [
      "blueprints",
      "upload",
      "--input",
      input,
      "--file",
      file,
      "--project",
      "chosen",
      "--personal",
      "--request-id",
      a,
      "--json",
    ],
    { from: "user" },
  );
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/api/cli/blueprints", {
    ...manifest,
    localProjectId: "chosen",
    scope: "personal",
    teamId: undefined,
    clientRequestId: a,
    attachments: [],
  });
  expect(mocks.postForm.mock.calls[0][0]).toBe(`/api/cli/blueprints/${a}/attachments`);
  expect(await mocks.postForm.mock.calls[0][1].get("file").text()).toBe(
    "# Requirements\n\nFull body 尾部",
  );
  expect(result().clientRequestId).toBe(a);
  expect(mocks.options).toHaveBeenCalledWith({ maxRetries: 0 });
});
it("creates a blueprint from only its name without generating optional content", async () => {
  const input = join(directory, "blueprint.json");
  writeFileSync(input, JSON.stringify({ title: "  减肥 App  " }));
  mocks.post.mockResolvedValue({
    blueprint: { id: a, title: "减肥 App" },
    tasks: [],
    attachments: [],
    reused: false,
  });
  await blueprints().parseAsync(
    ["blueprints", "upload", "--input", input, "--request-id", b, "--json"],
    { from: "user" },
  );
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/api/cli/blueprints", {
    title: "减肥 App",
    attachments: [],
    localProjectId: "current-project",
    teamId: undefined,
    scope: undefined,
    clientRequestId: b,
  });
  expect(result()).toMatchObject({
    blueprint: { id: a, title: "减肥 App" },
    tasks: [],
    attachments: [],
    clientRequestId: b,
  });
  expect(process.exitCode).toBeUndefined();
});
it("validates local files and blocks manifest scope overrides before any Cloud write", async () => {
  const input = join(directory, "blueprint.json");
  writeFileSync(input, JSON.stringify({ title: "Test", localProjectId: "foreign" }));
  await expect(prepareBlueprintInput({ input })).rejects.toThrow("Select project/team");
  writeFileSync(input, JSON.stringify({ title: "Test" }));
  await blueprints().parseAsync(
    ["blueprints", "upload", "--input", input, "--file", join(directory, "missing.md"), "--json"],
    { from: "user" },
  );
  expect(result().ok).toBe(false);
  expect(mocks.post).not.toHaveBeenCalled();
  const file = join(directory, "bad.png");
  writeFileSync(file, Buffer.from([0xff, 0xfe]));
  await blueprints().parseAsync(
    ["blueprints", "upload", "--input", input, "--file", file, "--json"],
    { from: "user" },
  );
  expect(result().ok).toBe(false);
  expect(mocks.post).not.toHaveBeenCalled();
});

it("supports every task document format plus JSON, preserves bytes, and appends without creating a blueprint", async () => {
  const bytes = Buffer.from([0xff, 0x00, 0x42, 0x0a]);
  for (const extension of ["md", "txt", "json", "docx", "pdf", "html", "htm"]) {
    const file = join(directory, `document.${extension}`);
    writeFileSync(file, bytes);
    mocks.postForm.mockResolvedValue({
      attachment: {
        id: b,
        displayName: `document.${extension}`,
        parseStatus: "ready",
        parseError: null,
      },
    });
    await blueprints().parseAsync(["blueprints", "attach", a, "--file", file, "--json"], {
      from: "user",
    });
    const [path, form] = mocks.postForm.mock.calls.at(-1)!;
    expect(path).toBe(`/api/cli/blueprints/${a}/attachments`);
    expect(Buffer.from(await form.get("file").arrayBuffer())).toEqual(bytes);
    expect(result().ok).toBe(true);
  }
  expect(mocks.post).not.toHaveBeenCalled();
});

it("reports partial file failure with an existing blueprint ID and pending files", async () => {
  const input = join(directory, "blueprint.json"),
    first = join(directory, "one.html"),
    second = join(directory, "two.pdf");
  writeFileSync(input, '{"title":"Existing after creation"}');
  writeFileSync(first, "<h1>Reference</h1>");
  writeFileSync(second, "%PDF");
  mocks.post.mockResolvedValue({ blueprint: { id: a }, tasks: [], attachments: [], reused: false });
  mocks.postForm
    .mockResolvedValueOnce({ attachment: { id: b, displayName: "one.html" } })
    .mockRejectedValueOnce(new Error("Offline"));
  await blueprints().parseAsync(
    ["blueprints", "upload", "--input", input, "--file", first, "--file", second, "--json"],
    { from: "user" },
  );
  expect(result()).toMatchObject({
    ok: false,
    blueprintCreated: true,
    blueprintId: a,
    attachments: [{ id: b }],
    failedFile: second,
    pendingFiles: [second],
  });
  expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(mocks.postForm).toHaveBeenCalledTimes(2);
  expect(process.exitCode).toBe(1);
});

it("lists the current scope with pagination so an existing empty blueprint can be selected", async () => {
  mocks.get.mockResolvedValue({
    blueprints: [{ id: a, title: "Empty blueprint" }],
    total: 2,
    nextOffset: 1,
  });
  await blueprints().parseAsync(["blueprints", "list", "--personal", "--limit", "1", "--json"], {
    from: "user",
  });
  expect(mocks.get).toHaveBeenCalledWith(
    "/api/cli/blueprints?localProjectId=current-project&offset=0&limit=1&scope=personal",
  );
  expect(result().nextOffset).toBe(1);
});
it("preserves request ID and scope candidates when Cloud cannot resolve an upload scope", async () => {
  const { CloudApiError } = await import("@varveai/adit-cloud");
  const input = join(directory, "blueprint.json");
  writeFileSync(input, '{"title":"Test"}');
  mocks.post.mockRejectedValue(
    new CloudApiError(400, "choose team", { code: "TEAM_SELECTION_REQUIRED", teams: [{ id: b }] }),
  );
  await blueprints().parseAsync(
    ["blueprints", "upload", "--input", input, "--request-id", a, "--json"],
    { from: "user" },
  );
  expect(result()).toMatchObject({
    ok: false,
    code: "TEAM_SELECTION_REQUIRED",
    teams: [{ id: b }],
    clientRequestId: a,
  });
});
it("creates a module in the selected scope and forwards rename/delete versions", async () => {
  mocks.post.mockResolvedValue({ module: { id: a } });
  await modules().parseAsync(["modules", "create", "--name", " Billing ", "--team", b, "--json"], {
    from: "user",
  });
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith(
    `/api/cli/tasks/modules?localProjectId=current-project&teamId=${b}`,
    { name: "Billing" },
  );
  mocks.get.mockResolvedValue({ modules: [{ id: a, updatedAt: version }] });
  mocks.patch.mockResolvedValue({});
  mocks.delete.mockResolvedValue({ removed: true });
  await modules().parseAsync(
    ["modules", "update", a, "--name", "Payments", "--expected-updated-at", version, "--json"],
    { from: "user" },
  );
  expect(mocks.patch).toHaveBeenLastCalledWith(
    `/api/cli/tasks/modules/${a}?localProjectId=current-project`,
    { name: "Payments", expectedUpdatedAt: version },
  );
  await modules().parseAsync(["modules", "delete", a, "--json"], { from: "user" });
  expect(mocks.delete).toHaveBeenCalledWith(
    `/api/cli/tasks/modules/${a}?localProjectId=current-project`,
    { expectedUpdatedAt: version },
  );
});
it("add/remove preserve other memberships, set replaces and clear removes all without requiring a workspace", async () => {
  mocks.context.mockReturnValue(null);
  const available = [{ id: a }, { id: b }];
  mocks.get.mockResolvedValue({
    modules: available,
    moduleIds: [a],
    canEdit: true,
    updatedAt: version,
  });
  mocks.patch.mockResolvedValue({
    modules: available,
    moduleIds: [a, b],
    canEdit: true,
    updatedAt: version,
  });
  await modules().parseAsync(
    ["modules", "add", task, "--module", b, "--expected-updated-at", version, "--json"],
    { from: "user" },
  );
  expect(mocks.patch).toHaveBeenLastCalledWith(`/api/cli/tasks/${task}/modules`, {
    moduleIds: [a, b],
    expectedUpdatedAt: version,
  });
  mocks.get.mockResolvedValue({
    modules: available,
    moduleIds: [a, b],
    canEdit: true,
    updatedAt: version,
  });
  await modules().parseAsync(["modules", "remove", task, "--module", a, "--json"], {
    from: "user",
  });
  expect(mocks.patch).toHaveBeenLastCalledWith(`/api/cli/tasks/${task}/modules`, {
    moduleIds: [b],
    expectedUpdatedAt: version,
  });
  await modules().parseAsync(["modules", "set", task, "--module", a, "--json"], { from: "user" });
  expect(mocks.patch).toHaveBeenLastCalledWith(`/api/cli/tasks/${task}/modules`, {
    moduleIds: [a],
    expectedUpdatedAt: version,
  });
  await modules().parseAsync(["modules", "clear", task, "--json"], { from: "user" });
  expect(mocks.patch).toHaveBeenLastCalledWith(`/api/cli/tasks/${task}/modules`, {
    moduleIds: [],
    expectedUpdatedAt: version,
  });
  expect(mocks.context).not.toHaveBeenCalled();
});
it("does not overwrite stale task versions, inaccessible tasks or foreign module IDs", async () => {
  const before = { modules: [{ id: a }], moduleIds: [a], canEdit: true, updatedAt: version };
  mocks.get.mockResolvedValue(before);
  await modules().parseAsync(
    [
      "modules",
      "add",
      task,
      "--module",
      a,
      "--expected-updated-at",
      "2020-01-01T00:00:00.000Z",
      "--json",
    ],
    { from: "user" },
  );
  expect(result().ok).toBe(false);
  await modules().parseAsync(["modules", "set", task, "--module", b, "--json"], { from: "user" });
  expect(result().ok).toBe(false);
  mocks.get.mockResolvedValue({ ...before, canEdit: false });
  await modules().parseAsync(["modules", "clear", task, "--json"], { from: "user" });
  expect(result().ok).toBe(false);
  expect(mocks.patch).not.toHaveBeenCalled();
});
