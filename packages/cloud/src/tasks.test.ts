import { describe, expect, it, vi } from "vitest";
import type { CloudClient } from "./http/client.js";
import {
  createCloudTask,
  updateCloudTask,
  listCloudTasks,
  listCloudTaskTypes,
  createCloudTaskType,
  updateCloudTaskType,
  deleteCloudTaskType,
  CloudTaskTypeVerificationError,
  showCloudTask,
  cloudTaskContext,
  uploadCloudTaskAttachment,
  uploadCloudTaskImage,
} from "./tasks.js";

describe("task attachment SDK", () => {
  it("uploads generic files and keeps the image API compatible", async () => {
    const response = { attachment: { id: "attachment", displayName: "需求.md" } };
    const postForm = vi.fn().mockResolvedValue(response);
    const client = { postForm } as unknown as CloudClient;
    const file = new File(["# Requirements"], "需求.md", { type: "application/octet-stream" });
    expect(await uploadCloudTaskAttachment(client, "task/id", file)).toEqual(response);
    expect(postForm.mock.calls[0][0]).toBe("/api/cli/tasks/task%2Fid/attachments");
    const body = postForm.mock.calls[0][1] as FormData;
    expect([...body.keys()]).toEqual(["file"]);
    expect(await (body.get("file") as File).text()).toBe("# Requirements");
    expect(uploadCloudTaskImage).toBe(uploadCloudTaskAttachment);
    postForm.mockRejectedValueOnce(new Error("Supported images only"));
    await expect(uploadCloudTaskAttachment(client, "task", file)).rejects.toThrow(
      "Supported images only",
    );
    expect(postForm).toHaveBeenCalledTimes(2);
  });
});

describe("task timeline SDK", () => {
  it("keeps existing paths and forwards history pages without dropping task or PRD fields", async () => {
    const response = {
      task: { title: "Current task" },
      prd: { markdown: "Current PRD" },
      resources: [],
      timeline: {
        entries: [
          { id: "revision", changes: { field: { name: "title", from: "Old", to: "New" } } },
        ],
        nextCursor: "next",
        order: "newest_first",
      },
    };
    const get = vi.fn().mockResolvedValue(response);
    const client = { get } as unknown as CloudClient;
    expect(await showCloudTask(client, "task/id")).toEqual(response);
    expect(get).toHaveBeenLastCalledWith("/api/cli/tasks/task%2Fid");
    expect(
      await cloudTaskContext(client, "task", {
        timelineLimit: 1,
        timelineCursor: "cursor+value/=",
      }),
    ).toEqual(response);
    expect(get).toHaveBeenLastCalledWith(
      "/api/cli/tasks/task/context?timelineLimit=1&timelineCursor=cursor%2Bvalue%2F%3D",
    );
    await showCloudTask(client, "task", { timelineCursor: "next" });
    expect(get).toHaveBeenLastCalledWith("/api/cli/tasks/task?timelineCursor=next");
    for (const timelineLimit of [0, 101, 1.5, NaN])
      expect(() => showCloudTask(client, "task", { timelineLimit })).toThrow("Timeline limit");
    expect(() => cloudTaskContext(client, "task", { timelineCursor: "" })).toThrow("cursor");
    get.mockResolvedValue({ task: { title: "Older server" } });
    expect((await showCloudTask(client, "task")).timeline).toBeUndefined();
  });
});

describe("task type SDK", () => {
  const scope = { localProjectId: "local/id", scope: "personal" as const };
  it("sends names and scope, exposes color snapshots and supports historical name filters", async () => {
    const get = vi.fn().mockResolvedValue({});
    const post = vi
      .fn()
      .mockResolvedValue({ task: { taskId: "task", taskType: "Bug", taskTypeColor: "#FFAA00" } });
    const patch = vi
      .fn()
      .mockResolvedValue({ task: { taskId: "task", taskType: null, taskTypeColor: null } });
    const remove = vi.fn().mockResolvedValue({ removed: true });
    const client = { get, post, patch, delete: remove } as unknown as CloudClient;
    const result = await createCloudTask(client, {
      ...scope,
      title: "Fix",
      keyPointsText: "Fix it",
      taskType: "bug",
    });
    expect(result.task.taskTypeColor).toBe("#FFAA00");
    await updateCloudTask(client, "task", { taskType: null }, "version");
    expect(patch).toHaveBeenCalledWith("/api/cli/tasks/task", {
      patch: { taskType: null },
      expectedUpdatedAt: "version",
    });
    await listCloudTasks(client, { ...scope, taskType: "旧 名称 & 特殊" });
    const query = new URL(get.mock.calls.at(-1)![0], "https://cloud.test").searchParams;
    expect(query.get("taskType")).toBe("旧 名称 & 特殊");
    expect(query.get("scope")).toBe("personal");
    await listCloudTaskTypes(client, scope);
    await createCloudTaskType(client, scope, { name: "Bug", color: "#FFAA00" });
    await updateCloudTaskType(client, scope, "option", {
      name: "Issue",
      expectedUpdatedAt: "version",
    });
    await deleteCloudTaskType(client, scope, "option", "version");
    expect(remove).toHaveBeenCalledWith(
      "/api/cli/tasks/types/option?localProjectId=local%2Fid&scope=personal",
      { expectedUpdatedAt: "version" },
    );
  });

  it("does not report success if old Cloud silently drops the type or color", async () => {
    const post = vi.fn().mockResolvedValue({ task: { taskId: "existing-created-task" } });
    const patch = vi.fn().mockResolvedValue({ task: { taskId: "task", taskType: "Bug" } });
    const client = { post, patch } as unknown as CloudClient;
    await expect(
      createCloudTask(client, { ...scope, title: "Fix", keyPointsText: "Fix it", taskType: "Bug" }),
    ).rejects.toMatchObject({
      taskId: "existing-created-task",
      taskCreated: true,
      code: "TASK_TYPE_NOT_SAVED",
    });
    await expect(
      updateCloudTask(client, "task", { taskType: "Bug" }, "version"),
    ).rejects.toBeInstanceOf(CloudTaskTypeVerificationError);
    expect(post).toHaveBeenCalledTimes(1);
    await expect(
      createCloudTask(client, { ...scope, title: "Old client", keyPointsText: "No type" }),
    ).resolves.toBeDefined();
  });
});
