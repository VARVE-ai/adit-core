import { stripVTControlCharacters } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  delete: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  postForm: vi.fn(),
  patch: vi.fn(),
  clientOptions: vi.fn(),
  credentials: vi.fn(),
  config: vi.fn(),
}));
vi.mock("@varveai/adit-cloud", async (original) => ({
  ...(await original<typeof import("@varveai/adit-cloud")>()),
  loadCredentials: mocks.credentials,
  CloudClient: class {
    delete = mocks.delete;
    get = mocks.get;
    post = mocks.post;
    postForm = mocks.postForm;
    patch = mocks.patch;
    constructor(_url: string, _credentials: unknown, options: unknown) {
      mocks.clientOptions(options);
    }
  },
}));
vi.mock("./project-context.js", () => ({ loadProjectContext: mocks.config }));
import { CloudApiError, CloudAuthError } from "@varveai/adit-cloud";
import {
  cloudTasksCommand,
  describeFailure,
  registerCloudTaskCommands,
  taskDueDate,
  taskPatchFromOptions,
} from "./cloud-tasks.js";
import { marks } from "./cli-style.js";

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
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("cloud task commands", () => {
  it("creates with documents and images, deduplicates mixed flags and exposes both upload options", async () => {
    const directory = mkdtempSync(join(tmpdir(), "adit-task-files-"));
    try {
      const document = join(directory, "需求 说明.md");
      const image = join(directory, "preview.png");
      writeFileSync(document, "# 原始需求\r\nKeep this document");
      writeFileSync(image, Buffer.from("89504e470d0a1a0a", "hex"));
      mocks.post.mockResolvedValue({ task: { taskId } });
      mocks.postForm.mockImplementation(async (_path, form: FormData) => ({
        attachment: { id: (form.get("file") as File).name, taskId },
      }));
      const cloud = new Command();
      registerCloudTaskCommands(cloud);
      const commands = cloud.commands.find((command) => command.name() === "tasks")!.commands;
      for (const name of ["create", "attach"]) {
        const help = commands.find((command) => command.name() === name)!.helpInformation();
        expect(help).toContain("--file");
        expect(help).toContain("--image");
        expect(help).toContain("20 MB");
      }
      await cloud.parseAsync(
        [
          "tasks",
          "create",
          "--title",
          "Files",
          "--key-points",
          "Use the references",
          "--file",
          document,
          "--file",
          image,
          "--image",
          image,
          "--json",
        ],
        { from: "user" },
      );
      expect(mocks.post).toHaveBeenCalledTimes(1);
      expect(mocks.postForm).toHaveBeenCalledTimes(2);
      const uploaded = mocks.postForm.mock.calls.map(
        ([, form]) => (form as FormData).get("file") as File,
      );
      expect(uploaded.map((file) => file.name)).toEqual(["需求 说明.md", "preview.png"]);
      expect(await uploaded[0].text()).toBe("# 原始需求\r\nKeep this document");
      expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0]).attachments).toHaveLength(2);
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports pending files after partial creation and attaches them without creating a second task", async () => {
    const directory = mkdtempSync(join(tmpdir(), "adit-task-files-"));
    try {
      const first = join(directory, "first.md");
      const failed = join(directory, "retry.pdf");
      const last = join(directory, "last.txt");
      for (const path of [first, failed, last]) writeFileSync(path, "original bytes");
      mocks.post.mockResolvedValue({ task: { taskId } });
      mocks.postForm
        .mockResolvedValueOnce({ attachment: { id: "first" } })
        .mockRejectedValueOnce(new Error("Request timed out"));
      await cloudTasksCommand("create", {
        title: "Files",
        keyPoints: "References",
        file: [first, failed, last],
        json: true,
      });
      expect(mocks.postForm).toHaveBeenCalledTimes(2);
      const result = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0]);
      expect(result).toMatchObject({
        ok: false,
        taskCreated: true,
        taskId,
        attachments: [{ id: "first" }],
        failedFile: failed,
        pendingFiles: [failed, last],
        code: "TASK_ATTACHMENT_UPLOAD_FAILED",
      });
      expect(result.pendingImages).toBeUndefined();
      expect(result.recovery).toContain("--file <path>");
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
      mocks.postForm
        .mockResolvedValueOnce({ attachment: { id: "retry" } })
        .mockResolvedValueOnce({ attachment: { id: "last" } });
      const cloud = new Command();
      registerCloudTaskCommands(cloud);
      await cloud.parseAsync(
        ["tasks", "attach", taskId, "--file", failed, "--file", last, "--json"],
        { from: "user" },
      );
      expect(mocks.post).toHaveBeenCalledTimes(1);
      expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0])).toMatchObject({
        ok: true,
        taskId,
        attachments: [{ id: "retry" }, { id: "last" }],
      });
      expect(mocks.clientOptions).toHaveBeenLastCalledWith({ maxRetries: 0 });
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("validates documents before any write and requires a file for attach", async () => {
    const directory = mkdtempSync(join(tmpdir(), "adit-task-files-"));
    try {
      const valid = join(directory, "valid.md");
      const invalid = join(directory, "unsupported.exe");
      writeFileSync(valid, "# Valid");
      writeFileSync(invalid, "not supported");
      await cloudTasksCommand("create", {
        title: "Files",
        keyPoints: "References",
        file: [valid, invalid],
        json: true,
      });
      await cloudTasksCommand("attach", { file: [valid, invalid], json: true }, taskId);
      const cloud = new Command();
      registerCloudTaskCommands(cloud);
      await cloud.parseAsync(["tasks", "attach", taskId, "--json"], { from: "user" });
      expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0]).error).toContain(
        "--file <path>",
      );
      expect(mocks.post).not.toHaveBeenCalled();
      expect(mocks.postForm).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves permission and older-server errors without retrying or changing the target", async () => {
    const directory = mkdtempSync(join(tmpdir(), "adit-task-files-"));
    try {
      const document = join(directory, "requirements.md");
      writeFileSync(document, "# Requirements");
      for (const [status, error] of [
        [403, "Forbidden"],
        [400, "Supported images: PNG, JPG, JPEG, WebP, GIF"],
      ] as const) {
        mocks.postForm.mockRejectedValueOnce(new CloudApiError(error, status, { error }));
        await cloudTasksCommand("attach", { file: [document], json: true }, taskId);
        expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0])).toMatchObject({
          ok: false,
          taskId,
          status,
          error,
          failedFile: document,
          pendingFiles: [document],
        });
      }
      expect(mocks.postForm).toHaveBeenCalledTimes(2);
      expect(mocks.post).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("show and context expose recorded history, continuation flags and their help", async () => {
    const response = {
      task: { taskId, updatedAt },
      timeline: {
        entries: [
          {
            id: "revision",
            actorName: null,
            changes: {
              field: { name: "keyPoints", from: "Old\nrequirements", to: "New\nrequirements" },
            },
          },
        ],
        nextCursor: "next-page",
        order: "newest_first",
      },
    };
    mocks.get.mockResolvedValue(response);
    for (const action of ["show", "context"] as const) {
      await cloudTasksCommand(
        action,
        { json: true, timelineLimit: "25", timelineCursor: "first-page" },
        taskId,
      );
      expect(mocks.get).toHaveBeenLastCalledWith(
        `/api/cli/tasks/${taskId}${action === "context" ? "/context" : ""}?timelineLimit=25&timelineCursor=first-page`,
      );
      expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0])).toEqual(response);
    }
    const program = new Command();
    registerCloudTaskCommands(program);
    for (const action of ["show", "context"]) {
      const command = program.commands
        .find((item) => item.name() === "tasks")!
        .commands.find((item) => item.name() === action)!;
      expect(command.helpInformation()).toContain("--timeline-limit");
      expect(command.helpInformation()).toContain("--timeline-cursor");
    }
    mocks.get.mockClear();
    for (const timelineLimit of ["0", "101", "-1", "1.5"]) {
      await cloudTasksCommand("show", { json: true, timelineLimit }, taskId);
      expect(process.exitCode).toBe(1);
    }
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("terminal details distinguish unavailable, empty and partial history and print before/after text", async () => {
    const originalTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    try {
      const detail = {
        task: {
          taskId,
          title: "Task",
          updatedAt,
          progressState: "not_started",
          priority: "medium",
          dueAt: null,
        },
        assignableMembers: [],
        permissions: { canManage: true, canUpdateState: true, canUpdateDueAt: true },
      };
      const output = () =>
        stripVTControlCharacters(
          vi
            .mocked(console.log)
            .mock.calls.map((call) => call.join(" "))
            .join("\n"),
        );
      mocks.get.mockResolvedValue(detail);
      await cloudTasksCommand("show", {}, taskId);
      expect(output()).toContain("not an empty history");
      vi.mocked(console.log).mockClear();
      mocks.get.mockResolvedValue({
        ...detail,
        timeline: { entries: [], nextCursor: null, order: "newest_first" },
      });
      await cloudTasksCommand("show", {}, taskId);
      expect(output()).toContain("No recorded changes");
      vi.mocked(console.log).mockClear();
      mocks.get.mockResolvedValue({
        ...detail,
        timeline: {
          entries: [
            {
              id: "revision",
              kind: "edit",
              actorId: null,
              actorName: null,
              createdAt: updatedAt,
              changes: { field: { name: "keyPoints", from: "Previous text", to: "Changed text" } },
            },
          ],
          nextCursor: "next-page",
          order: "newest_first",
        },
      });
      await cloudTasksCommand("show", {}, taskId);
      expect(output()).toContain("Previous text");
      expect(output()).toContain("Changed text");
      expect(output()).toContain("--timeline-cursor next-page");
    } finally {
      if (originalTTY) Object.defineProperty(process.stdout, "isTTY", originalTTY);
      else Reflect.deleteProperty(process.stdout, "isTTY");
    }
  });

  it("assigns and clears type names, preserves historical filters and exposes type commands", async () => {
    expect(taskPatchFromOptions({ type: " Bug " })).toEqual({ taskType: "Bug" });
    expect(taskPatchFromOptions({ clearType: true })).toEqual({ taskType: null });
    expect(() => taskPatchFromOptions({ type: "Bug", clearType: true })).toThrow("either");
    mocks.get.mockResolvedValue({ tasks: [], total: 0, nextOffset: null });
    await cloudTasksCommand("list", { type: "Deleted type", personal: true, json: true });
    const params = new URL(mocks.get.mock.calls.at(-1)![0], "https://cloud.test").searchParams;
    expect(params.get("taskType")).toBe("Deleted type");
    expect(params.get("scope")).toBe("personal");
    mocks.get.mockClear();
    await cloudTasksCommand("list", { type: "Bug", unclassified: true, json: true });
    expect(process.exitCode).toBe(1);
    expect(mocks.get).not.toHaveBeenCalled();
    process.exitCode = undefined;
    mocks.get.mockResolvedValue({
      scope: { projectId: "project", teamId: null },
      canManageTaskTypes: true,
      options: [{ id: taskId, name: "Bug", color: "#123456", updatedAt }],
    });
    mocks.delete.mockResolvedValue({ removed: true });
    const cloud = new Command();
    registerCloudTaskCommands(cloud);
    await cloud.parseAsync(["tasks", "types", "delete", "bug", "--personal", "--json"], {
      from: "user",
    });
    expect(mocks.delete).toHaveBeenCalledWith(
      `/api/cli/tasks/types/${taskId}?localProjectId=local-project&scope=personal`,
      { expectedUpdatedAt: updatedAt },
    );
    expect(mocks.clientOptions).toHaveBeenLastCalledWith({ maxRetries: 0 });
  });

  it("reports a created task ID rather than repeating creation if Cloud does not save its type", async () => {
    mocks.get.mockResolvedValue({ options: [] });
    mocks.post.mockResolvedValue({ task: { taskId } });
    await cloudTasksCommand("create", {
      title: "Typed",
      keyPoints: "Keep snapshot",
      type: "Bug",
      json: true,
    });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0])).toMatchObject({
      ok: false,
      taskCreated: true,
      taskId,
      code: "TASK_TYPE_NOT_SAVED",
    });
    expect(process.exitCode).toBe(1);
  });

  it("creates once with multiple images, reports partial success and supports attach-only recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adit-images-"));
    const first = join(dir, "参考 image.png"),
      second = join(dir, "expected.gif");
    writeFileSync(first, Buffer.from("89504e470d0a1a0a", "hex"));
    writeFileSync(second, "GIF89a");
    try {
      mocks.post.mockResolvedValue({ task: { taskId } });
      const attachment = { id: "image-1", taskId, displayName: "参考 image.png" };
      mocks.postForm
        .mockResolvedValueOnce({ attachment })
        .mockRejectedValueOnce(new Error("Request timed out"));
      const cloud = new Command();
      registerCloudTaskCommands(cloud);
      await cloud.parseAsync(
        [
          "tasks",
          "create",
          "--title",
          "Images",
          "--key-points",
          "Compare",
          "--image",
          first,
          "--image",
          second,
          "--json",
        ],
        { from: "user" },
      );
      expect(mocks.post).toHaveBeenCalledTimes(1);
      expect(mocks.postForm).toHaveBeenCalledTimes(2);
      expect(mocks.postForm.mock.calls[0][0]).toBe(`/api/cli/tasks/${taskId}/attachments`);
      const file = (mocks.postForm.mock.calls[0][1] as FormData).get("file") as File;
      expect(file.name).toBe("参考 image.png");
      expect(file.type).toBe("image/png");
      expect(Buffer.from(await file.arrayBuffer()).toString("hex")).toBe("89504e470d0a1a0a");
      expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toMatchObject({
        ok: false,
        taskCreated: true,
        taskId,
        attachments: [attachment],
        pendingImages: [second],
      });
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
      mocks.postForm.mockResolvedValueOnce({
        attachment: { id: "image-2", taskId, displayName: "expected.gif" },
      });
      await cloud.parseAsync(["tasks", "attach", taskId, "--image", second, "--json"], {
        from: "user",
      });
      expect(mocks.post).toHaveBeenCalledTimes(1);
      expect(JSON.parse(vi.mocked(console.log).mock.calls[1][0])).toMatchObject({
        ok: true,
        taskId,
        attachments: [{ id: "image-2" }],
      });
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates every image before creating a task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adit-images-"));
    try {
      const valid = join(dir, "valid.png");
      writeFileSync(valid, Buffer.from("89504e470d0a1a0a", "hex"));
      for (const [name, bytes] of [
        ["fake.png", Buffer.from("not an image")],
        ["empty.jpg", Buffer.alloc(0)],
        ["large.png", Buffer.alloc(10 * 1024 * 1024 + 1)],
        ["unsupported.svg", Buffer.from("<svg/>")],
      ] as const) {
        const invalid = join(dir, name);
        writeFileSync(invalid, bytes);
        await cloudTasksCommand("create", {
          title: "Images",
          keyPoints: "Compare",
          image: [valid, invalid],
          json: true,
        });
      }
      await cloudTasksCommand("create", {
        title: "Images",
        keyPoints: "Compare",
        image: [join(dir, "missing.png")],
        json: true,
      });
      expect(mocks.post).not.toHaveBeenCalled();
      expect(mocks.postForm).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes all uploaded images in a successful creation result and deduplicates repeated paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adit-images-"));
    try {
      const path = join(dir, "image.png");
      writeFileSync(path, Buffer.from("89504e470d0a1a0a", "hex"));
      const created = { task: { taskId } },
        attachment = { id: "image", taskId };
      mocks.post.mockResolvedValue(created);
      mocks.postForm.mockResolvedValue({ attachment });
      await cloudTasksCommand("create", {
        title: "Images",
        keyPoints: "Compare",
        image: [path, path],
        json: true,
      });
      expect(mocks.postForm).toHaveBeenCalledTimes(1);
      expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toEqual({
        ...created,
        attachments: [attachment],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates an independent task in the current project without automatic write retries", async () => {
    const result = {
      task: { taskId, blueprintId: null, progressState: "not_started" },
      project: { name: "Test project" },
      scope: { teamName: "Team" },
    };
    mocks.post.mockResolvedValue(result);
    const cloud = new Command();
    registerCloudTaskCommands(cloud);
    await cloud.parseAsync(
      [
        "tasks",
        "create",
        "--title",
        "  Booking conflicts  ",
        "--key-points",
        "Reject duplicate bookings",
        "--due",
        "2026-10-12",
        "--priority",
        "high",
        "--json",
      ],
      { from: "user" },
    );
    expect(mocks.config).toHaveBeenCalledWith("adit cloud tasks create");
    expect(mocks.clientOptions).toHaveBeenCalledWith({ maxRetries: 0 });
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/api/cli/tasks", {
      localProjectId: "local-project",
      title: "Booking conflicts",
      keyPointsText: "Reject duplicate bookings",
      dueAt: "2026-10-12T00:00:00.000Z",
      priority: "high",
      teamId: undefined,
      scope: undefined,
    });
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toEqual(result);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("preserves explicit personal and team scopes during creation", async () => {
    mocks.post.mockResolvedValue({ task: { taskId } });
    await cloudTasksCommand("create", {
      title: "Task",
      keyPoints: "Requirements",
      project: "selected",
      personal: true,
      json: true,
    });
    expect(mocks.config).not.toHaveBeenCalled();
    expect(mocks.post.mock.calls[0][1]).toMatchObject({
      localProjectId: "selected",
      scope: "personal",
    });
    await cloudTasksCommand("create", {
      title: "Task",
      keyPoints: "Requirements",
      team: taskId,
      json: true,
    });
    expect(mocks.post.mock.calls[1][1]).toMatchObject({
      localProjectId: "local-project",
      teamId: taskId,
    });
  });

  it("does not create with missing initialization or invalid fields", async () => {
    for (const options of [
      { title: " " },
      { title: "x".repeat(201) },
      { keyPoints: " " },
      { keyPoints: "x".repeat(20001) },
      { due: "2026-02-29" },
      { priority: "urgent" },
      { team: taskId, personal: true },
    ])
      await cloudTasksCommand("create", {
        title: "Task",
        keyPoints: "Requirements",
        json: true,
        ...options,
      });
    mocks.config.mockReturnValue(null);
    await cloudTasksCommand("create", { title: "Task", keyPoints: "Requirements", json: true });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("surfaces team selection and creation failures without trying another scope", async () => {
    const body = {
      error: "Choose a linked team",
      code: "TEAM_SELECTION_REQUIRED",
      teams: [{ id: taskId, name: "Team" }],
    };
    mocks.post.mockRejectedValueOnce(new CloudApiError(body.error, 400, body));
    await cloudTasksCommand("create", { title: "Task", keyPoints: "Requirements", json: true });
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toMatchObject({
      ...body,
      ok: false,
    });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    mocks.post.mockRejectedValueOnce(new Error("Request timed out"));
    await cloudTasksCommand("create", { title: "Task", keyPoints: "Requirements", json: true });
    expect(JSON.parse(vi.mocked(console.log).mock.calls[1][0])).toMatchObject({
      ok: false,
      error: "Request timed out",
    });
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("uses the current local project and preserves real task IDs and pagination", async () => {
    const result = { tasks: [{ taskId, title: "Fix upload" }], total: 60, nextOffset: 50 };
    mocks.get.mockResolvedValue(result);
    const cloud = new Command();
    registerCloudTaskCommands(cloud);
    await cloud.parseAsync(["tasks", "list", "--json"], { from: "user" });
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/cli/tasks?localProjectId=local-project&state=unfinished&offset=0&limit=50",
    );
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
    const result = {
      project: { id: "project", localProjectId: "local-project", name: "Test project" },
      teams: [],
    };
    mocks.get.mockResolvedValue(result);
    const cloud = new Command();
    registerCloudTaskCommands(cloud);
    await cloud.parseAsync(["tasks", "scopes", "--json"], { from: "user" });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(
      "/api/cli/tasks/scopes?localProjectId=local-project",
    );
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
    const body = {
      error: "Choose a linked team",
      code: "TEAM_SELECTION_REQUIRED",
      project: { name: "Test project" },
      teams: [{ id: taskId, name: "Linked team" }],
    };
    mocks.get.mockRejectedValueOnce(new CloudApiError(body.error, 400, body));
    await cloudTasksCommand("list", { json: true });
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toMatchObject({
      ...body,
      ok: false,
    });
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("supports personal scope and explicit project IDs without reading an unrelated cwd", async () => {
    mocks.get.mockResolvedValue({ tasks: [], total: 0, nextOffset: null });
    await cloudTasksCommand("list", {
      project: "chosen-project",
      personal: true,
      json: true,
      offset: "50",
    });
    expect(mocks.config).not.toHaveBeenCalled();
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/cli/tasks?localProjectId=chosen-project&scope=personal&state=unfinished&offset=50&limit=50",
    );
  });

  it("returns resource URLs without fetching their content", async () => {
    mocks.get.mockResolvedValue({
      task: { taskId },
      prd: null,
      resources: [{ url: "https://private.example/resource" }],
    });
    await cloudTasksCommand("context", { json: true }, taskId);
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(`/api/cli/tasks/${taskId}/context`);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("reads a current version before updating when no version was supplied", async () => {
    mocks.get.mockResolvedValue({ task: { taskId, updatedAt } });
    mocks.patch.mockResolvedValue({ task: { taskId, progressState: "done" } });
    await cloudTasksCommand("update", { state: "done", json: true }, taskId);
    expect(mocks.patch).toHaveBeenCalledExactlyOnceWith(`/api/cli/tasks/${taskId}`, {
      patch: { progressState: "done" },
      expectedUpdatedAt: updatedAt,
    });
  });

  it("does not overwrite or retry a conflict using a fresh version", async () => {
    mocks.patch.mockRejectedValue(new CloudApiError("Changed", 409));
    await cloudTasksCommand(
      "update",
      { due: "2026-09-30", expectedUpdatedAt: updatedAt, json: true },
      taskId,
    );
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toMatchObject({
      ok: false,
      status: 409,
    });
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

  it("maps every editable field and preserves two-hour estimates as quarter person-days", () => {
    expect(
      taskPatchFromOptions({
        title: "Renamed",
        keyPoints: "Details",
        state: "accepted",
        priority: "high",
        assignee: taskId,
        start: "2026-10-27",
        due: "2026-10-28",
        estimateHours: "2",
        createdAt: "2026-10-27T10:00:00+08:00",
        taskScope: ["Page", "API"],
      }),
    ).toEqual({
      title: "Renamed",
      keyPointsText: "Details",
      progressState: "accepted",
      priority: "high",
      assigneeId: taskId,
      startAt: "2026-10-27T00:00:00.000Z",
      dueAt: "2026-10-28T00:00:00.000Z",
      estimatedPersonDays: 0.25,
      createdAt: "2026-10-27T02:00:00.000Z",
      scope: ["Page", "API"],
    });
    expect(taskPatchFromOptions({ estimateDays: "0" })).toEqual({ estimatedPersonDays: 0 });
    expect(taskPatchFromOptions({ estimateDays: "0.25" })).toEqual({ estimatedPersonDays: 0.25 });
    expect(
      taskPatchFromOptions({
        clearDue: true,
        clearStart: true,
        clearEstimate: true,
        clearCreatedAt: true,
        clearKeyPoints: true,
        clearAssignee: true,
        clearScope: true,
      }),
    ).toEqual({
      dueAt: null,
      startAt: null,
      estimatedPersonDays: null,
      createdAt: null,
      keyPointsText: null,
      assigneeId: null,
      scope: [],
    });
  });

  it("rejects contradictory or invalid task field options before sending an update", async () => {
    for (const options of [
      { start: "2026-02-30" },
      { start: "2026-10-28", due: "2026-10-27" },
      { start: "2026-10-27", clearStart: true },
      { estimateHours: "2", estimateDays: "1" },
      { estimateHours: "2", clearEstimate: true },
      { estimateDays: "0", clearEstimate: true },
      ...["", " ", "-1", "NaN", "Infinity", "2h", "1e309"].map((estimateHours) => ({
        estimateHours,
      })),
      { createdAt: "2026-10-27" },
      { createdAt: "2026-02-30T00:00:00Z" },
      { createdAt: "2026-10-27T24:00:00Z" },
      { createdAt: "2026-10-27T00:00:00Z", clearCreatedAt: true },
      { assignee: "member name" },
      { assignee: taskId, clearAssignee: true },
      { keyPoints: "", clearKeyPoints: true },
      { taskScope: [""] },
      { taskScope: ["x".repeat(201)] },
      { taskScope: ["Page"], clearScope: true },
    ]) {
      expect(() => taskPatchFromOptions(options), JSON.stringify(options)).toThrow();
      await cloudTasksCommand("update", { ...options, json: true }, taskId);
    }
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("registers create and update workload, scope, timestamps and clear flags", async () => {
    mocks.post.mockResolvedValue({ task: { taskId, estimatedPersonDays: 0.25 } });
    const create = new Command();
    registerCloudTaskCommands(create);
    await create.parseAsync(
      [
        "tasks",
        "create",
        "--title",
        "Task",
        "--key-points",
        "Details",
        "--start",
        "2026-10-27",
        "--estimate-hours",
        "2",
        "--task-scope",
        "Page",
        "--task-scope",
        "API",
        "--assignee",
        taskId,
        "--created-at",
        "2026-10-27T10:00:00+08:00",
        "--json",
      ],
      { from: "user" },
    );
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/api/cli/tasks", {
      localProjectId: "local-project",
      teamId: undefined,
      scope: undefined,
      title: "Task",
      keyPointsText: "Details",
      startAt: "2026-10-27T00:00:00.000Z",
      estimatedPersonDays: 0.25,
      taskScope: ["Page", "API"],
      assigneeId: taskId,
      createdAt: "2026-10-27T02:00:00.000Z",
    });
    mocks.patch.mockResolvedValue({ task: { taskId } });
    const update = new Command();
    registerCloudTaskCommands(update);
    await update.parseAsync(
      [
        "tasks",
        "update",
        taskId,
        "--clear-estimate",
        "--clear-start",
        "--clear-created-at",
        "--clear-key-points",
        "--clear-assignee",
        "--clear-scope",
        "--expected-updated-at",
        updatedAt,
        "--json",
      ],
      { from: "user" },
    );
    expect(mocks.patch).toHaveBeenCalledExactlyOnceWith(`/api/cli/tasks/${taskId}`, {
      expectedUpdatedAt: updatedAt,
      patch: {
        estimatedPersonDays: null,
        startAt: null,
        createdAt: null,
        keyPointsText: null,
        assigneeId: null,
        scope: [],
      },
    });
  });

  it("requires login and never substitutes task titles for IDs", async () => {
    mocks.credentials.mockReturnValue(null);
    await cloudTasksCommand("show", { json: true }, taskId);
    expect(process.exitCode).toBe(1);
    expect(mocks.get).not.toHaveBeenCalled();
    await cloudTasksCommand("update", { state: "done", json: true }, "Fix upload");
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("prints the server's reason and status instead of a generic API error", async () => {
    const reason = "The task is done and frozen; owner, dates and estimate can no longer change";
    mocks.patch.mockRejectedValue(
      new CloudApiError("API error: 409 Conflict", 409, { error: reason }),
    );
    await cloudTasksCommand(
      "update",
      { due: "2026-10-01", expectedUpdatedAt: updatedAt, json: true },
      taskId,
    );
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toEqual({
      ok: false,
      error: reason,
      status: 409,
    });
    await cloudTasksCommand("update", { due: "2026-10-01", expectedUpdatedAt: updatedAt }, taskId);
    expect(
      vi.mocked(console.error).mock.calls.map((call) => stripVTControlCharacters(String(call[0]))),
    ).toContain(`${stripVTControlCharacters(marks.fail)} tasks update: ${reason} (409)`);
    expect(
      describeFailure(new CloudApiError("API error: 500 Internal Server Error", 500, "<html>")),
    ).toEqual({ message: "API error: 500 Internal Server Error", status: 500, code: undefined });
  });

  it("distinguishes a permission denial from a login failure", async () => {
    mocks.patch.mockRejectedValueOnce(
      new CloudApiError("API error: 403 Forbidden", 403, {
        error: "Only the responsible member can manage tasks",
      }),
    );
    await cloudTasksCommand(
      "update",
      { title: "Renamed", expectedUpdatedAt: updatedAt, json: true },
      taskId,
    );
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toEqual({
      ok: false,
      error: "Only the responsible member can manage tasks",
      status: 403,
    });
    mocks.get.mockRejectedValueOnce(
      new CloudAuthError("Authentication failed: 401 Unauthorized", {
        status: 401,
        code: "invalid_or_expired_token",
      }),
    );
    await cloudTasksCommand("show", { json: true }, taskId);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[1][0])).toEqual({
      ok: false,
      error: "Authentication failed: 401 Unauthorized",
      status: 401,
      code: "invalid_or_expired_token",
    });
  });

  it("accepts the paused state for listing and updating", async () => {
    mocks.get.mockResolvedValue({ tasks: [], total: 0, nextOffset: null });
    await cloudTasksCommand("list", { project: "chosen-project", state: "paused", json: true });
    expect(mocks.get.mock.calls[0][0]).toContain("state=paused");
    mocks.patch.mockResolvedValue({ task: { taskId, progressState: "paused" } });
    await cloudTasksCommand(
      "update",
      { state: "paused", expectedUpdatedAt: updatedAt, json: true },
      taskId,
    );
    expect(mocks.patch).toHaveBeenCalledExactlyOnceWith(`/api/cli/tasks/${taskId}`, {
      patch: { progressState: "paused" },
      expectedUpdatedAt: updatedAt,
    });
    expect(taskPatchFromOptions({ state: "paused" })).toEqual({ progressState: "paused" });
  });
});
