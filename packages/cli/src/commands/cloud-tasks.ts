import { Command, Option } from "commander";
import { CloudClient, CloudApiError, CloudAuthError, loadCredentials, listCloudTasks, showCloudTask, cloudTaskContext, updateCloudTask, type CloudTaskPatch } from "@varveai/adit-cloud";
import { loadInitializedProjectConfig } from "./project-initialization.js";

type Options = { json?: boolean; team?: string; project?: string; personal?: boolean; state?: string; limit?: string; offset?: string; due?: string; clearDue?: boolean; title?: string; keyPoints?: string; priority?: string; assignee?: string; expectedUpdatedAt?: string };

export function taskDueDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error("Due date must be a valid YYYY-MM-DD date");
  return date.toISOString();
}

/** The server's own reason, status and code for a failed request, falling back to the transport message. */
export function describeFailure(error: unknown): { message: string; status?: number; code?: string } {
  if (error instanceof CloudApiError) {
    const body = error.body && typeof error.body === "object" ? error.body as Record<string, unknown> : {};
    const reason = typeof body.error === "string" && body.error.trim() ? body.error.trim() : undefined;
    return { message: reason ?? error.message, status: error.status, code: typeof body.code === "string" ? body.code : undefined };
  }
  if (error instanceof CloudAuthError) return { message: error.message, status: error.status, code: error.code };
  return { message: error instanceof Error ? error.message : String(error) };
}

export function taskPatchFromOptions(options: Options): CloudTaskPatch {
  if (options.due && options.clearDue) throw new Error("Use either --due or --clear-due");
  if (options.state && !["not_started", "in_progress", "paused", "done"].includes(options.state)) throw new Error("Invalid task state");
  if (options.priority && !["high", "medium", "low"].includes(options.priority)) throw new Error("Invalid task priority");
  const patch: CloudTaskPatch = {};
  if (options.state) patch.progressState = options.state as CloudTaskPatch["progressState"];
  if (options.due) patch.dueAt = taskDueDate(options.due);
  if (options.clearDue) patch.dueAt = null;
  if (options.title !== undefined) patch.title = options.title;
  if (options.keyPoints !== undefined) patch.keyPointsText = options.keyPoints;
  if (options.priority) patch.priority = options.priority as CloudTaskPatch["priority"];
  if (options.assignee) patch.assigneeId = options.assignee;
  if (!Object.keys(patch).length) throw new Error("Specify at least one task change");
  return patch;
}

function pageNumber(value: string | undefined, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new Error("Invalid pagination value");
  return Number(value);
}

export async function cloudTasksCommand(action: "list" | "show" | "context" | "update" | "scopes", options: Options = {}, taskId?: string): Promise<void> {
  try {
    if (taskId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) throw new Error("Use the full taskId returned by the task list");
    const credentials = loadCredentials();
    if (!credentials) throw new Error("Not logged in. Run 'adit cloud login' first.");
    const client = new CloudClient(credentials.serverUrl, credentials, { maxRetries: action === "update" ? 0 : 2 });
    let localProjectId = options.project;
    if ((action === "list" || action === "scopes") && !localProjectId) {
      const config = loadInitializedProjectConfig(`adit cloud tasks ${action}`);
      if (!config) throw new Error("Initialize and link the current project before querying its tasks or teams.");
      localProjectId = config.projectId;
    }
    let result: unknown;
    if (action === "list") {
      if (options.team && options.personal) throw new Error("Select either --team or --personal");
      const limit = pageNumber(options.limit, 50, 100);
      if (limit === 0) throw new Error("Limit must be between 1 and 100");
      const list = await listCloudTasks(client, { localProjectId: localProjectId!, teamId: options.team, scope: options.personal ? "personal" : undefined, state: options.state ?? "unfinished", offset: pageNumber(options.offset, 0, Number.MAX_SAFE_INTEGER), limit });
      if (!options.json) {
        console.log(`Project: ${list.project.name ?? list.project.localProjectId}; scope: ${list.scope.teamName ?? "personal"}`);
        console.log(`${list.tasks.length} of ${list.total} assigned tasks`);
        for (const task of list.tasks) console.log(`${task.taskId}  ${task.progressState}  ${task.title}${task.dueAt ? `  due ${task.dueAt.slice(0, 10)}` : ""}`);
        if (list.nextOffset !== null) console.log(`More tasks: repeat with --offset ${list.nextOffset}`);
        return;
      }
      result = list;
    } else if (action === "scopes") {
      result = await client.get(`/api/cli/tasks/scopes?${new URLSearchParams({ localProjectId: localProjectId! })}`);
    } else if (!taskId) {
      throw new Error("Task ID is required");
    } else if (action === "show") {
      result = await showCloudTask(client, taskId);
    } else if (action === "context") {
      result = await cloudTaskContext(client, taskId);
    } else {
      const patch = taskPatchFromOptions(options);
      const expectedUpdatedAt = options.expectedUpdatedAt ?? (await showCloudTask(client, taskId)).task.updatedAt;
      result = await updateCloudTask(client, taskId, patch, expectedUpdatedAt);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const failure = describeFailure(error);
    if (failure.code === "TEAM_SELECTION_REQUIRED" && error instanceof CloudApiError && error.body && typeof error.body === "object") {
      console.log(JSON.stringify({ ...error.body, ok: false, status: failure.status }, null, 2));
      process.exitCode = 1;
      return;
    }
    if (options.json) console.log(JSON.stringify({ ok: false, error: failure.message, status: failure.status, code: failure.code }));
    else console.error(`Task command failed${failure.status ? ` (${failure.status})` : ""}: ${failure.message}`);
    process.exitCode = 1;
  }
}

export function registerCloudTaskCommands(cloud: Command) {
  const tasks = cloud.command("tasks").description("Query and update tasks assigned to you");
  tasks.command("list").description("List your tasks in the current project or a team")
    .option("--team <id>", "Select a team linked to this project (see tasks scopes)").option("--project <id>", "Local project ID; defaults to this initialized project")
    .option("--personal", "Query personal project tasks instead of its linked team")
    .addOption(new Option("--state <state>", "Task state").choices(["unfinished", "all", "not_started", "in_progress", "paused", "done"]).default("unfinished"))
    .option("--limit <number>", "Page size, 1-100", "50").option("--offset <number>", "Pagination offset", "0").option("--json", "Output JSON")
    .action((options) => cloudTasksCommand("list", options));
  tasks.command("scopes").description("List teams linked to the current project, not all account teams").option("--project <id>", "Local project ID; defaults to this initialized project").option("--json", "Output JSON").action((options) => cloudTasksCommand("scopes", options));
  for (const action of ["show", "context"] as const) tasks.command(`${action} <taskId>`).description(action === "show" ? "Read a task and its current version" : "Read task requirements, PRD and resource URLs (no downloads)").option("--json", "Output JSON").action((taskId, options) => cloudTasksCommand(action, options, taskId));
  tasks.command("update <taskId>").description("Update an assigned task in Cloud immediately")
    .addOption(new Option("--state <state>", "New state").choices(["not_started", "in_progress", "paused", "done"]))
    .option("--due <date>", "Due date, YYYY-MM-DD").option("--clear-due", "Remove due date")
    .option("--title <text>", "Task title (requires manage access)").option("--key-points <text>", "Task key points (requires manage access)")
    .addOption(new Option("--priority <priority>", "Task priority (requires manage access)").choices(["high", "medium", "low"]))
    .option("--assignee <id>", "Transfer to a member (requires manage access)")
    .option("--expected-updated-at <timestamp>", "updatedAt from the last task read; reject stale updates")
    .option("--json", "Output JSON").action((taskId, options) => cloudTasksCommand("update", options, taskId));
}
