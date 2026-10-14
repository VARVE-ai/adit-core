import { Command, Option } from "commander";
import { CloudClient, CloudApiError, loadCredentials, createCloudTask, listCloudTasks, showCloudTask, cloudTaskContext, updateCloudTask, type CloudTaskCreate, type CloudTaskDetail, type CloudTaskList, type CloudTaskPatch } from "@varveai/adit-cloud";
import { loadInitializedProjectConfig } from "./project-initialization.js";
import { NotLoggedInError, commandWith, describeFailure, reportFailure } from "./cloud-read-output.js";
import {
  dim,
  joinParts,
  localDateTime,
  marks,
  printEnd,
  printError,
  printRows,
  printTable,
  printTitle,
  stateWord,
  strong,
  summaryColumns,
  truncate,
  type Row,
} from "./cli-style.js";

export { describeFailure };

type Options = { json?: boolean; team?: string; project?: string; personal?: boolean; state?: string; limit?: string; offset?: string; due?: string; clearDue?: boolean; title?: string; keyPoints?: string; priority?: string; assignee?: string; expectedUpdatedAt?: string };

export function taskDueDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error("Due date must be a valid YYYY-MM-DD date");
  return date.toISOString();
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

export async function cloudTasksCommand(action: "create" | "list" | "show" | "context" | "update" | "scopes", options: Options = {}, taskId?: string): Promise<void> {
  try {
    if (taskId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) throw new Error("Use the full taskId returned by the task list");
    const credentials = loadCredentials();
    if (!credentials) throw new NotLoggedInError();
    const client = new CloudClient(credentials.serverUrl, credentials, { maxRetries: action === "update" || action === "create" ? 0 : 2 });
    let localProjectId = options.project;
    if ((action === "list" || action === "scopes" || action === "create") && !localProjectId) {
      const config = loadInitializedProjectConfig(`adit cloud tasks ${action}`);
      if (!config) throw new Error("Initialize and link the current project before working with its tasks or teams.");
      localProjectId = config.projectId;
    }
    let result: unknown;
    if (action === "create") {
      if (options.team && options.personal) throw new Error("Select either --team or --personal");
      const title = options.title?.trim(), keyPointsText = options.keyPoints?.trim();
      if (!title || title.length > 200) throw new Error("Task title must contain 1-200 characters");
      if (!keyPointsText || keyPointsText.length > 20000) throw new Error("Task key points must contain 1-20000 characters");
      if (options.priority && !["high", "medium", "low"].includes(options.priority)) throw new Error("Invalid task priority");
      const created = await createCloudTask(client, {
        localProjectId: localProjectId!, teamId: options.team, scope: options.personal ? "personal" : undefined,
        title, keyPointsText, priority: options.priority as CloudTaskCreate["priority"], dueAt: options.due ? taskDueDate(options.due) : undefined,
      });
      if (!options.json) {
        printTitle("Task created", created.project.name ?? created.project.localProjectId, created.scope.teamName ? `team ${created.scope.teamName}` : "personal");
        printRows([
          { label: "ID", value: created.task.taskId }, { label: "Title", value: created.task.title },
          { label: "State", value: stateWord(created.task.progressState) }, { label: "Priority", value: created.task.priority },
          { label: "Due", value: created.task.dueAt?.slice(0, 10) ?? "-" },
        ]);
        printEnd(`${marks.ok} Independent task assigned to you`);
        return;
      }
      result = created;
    } else if (action === "list") {
      if (options.team && options.personal) throw new Error("Select either --team or --personal");
      const limit = pageNumber(options.limit, 50, 100);
      if (limit === 0) throw new Error("Limit must be between 1 and 100");
      const list = await listCloudTasks(client, { localProjectId: localProjectId!, teamId: options.team, scope: options.personal ? "personal" : undefined, state: options.state ?? "unfinished", offset: pageNumber(options.offset, 0, Number.MAX_SAFE_INTEGER), limit });
      if (!options.json) {
        printTaskList(list, options);
        return;
      }
      result = list;
    } else if (action === "scopes") {
      result = await client.get(`/api/cli/tasks/scopes?${new URLSearchParams({ localProjectId: localProjectId! })}`);
    } else if (!taskId) {
      throw new Error("Task ID is required");
    } else if (action === "show") {
      const detail = await showCloudTask(client, taskId);
      // Pipes and agents keep the JSON they always got; a person at a terminal gets the text view.
      if (!options.json && process.stdout.isTTY) {
        printTaskDetail(detail);
        return;
      }
      result = detail;
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
      if (!options.json && process.stdout.isTTY) {
        const teams = Array.isArray((error.body as { teams?: unknown }).teams)
          ? ((error.body as { teams: Array<{ id?: string; name?: string }> }).teams)
          : [];
        printError(
          `tasks ${action}`,
          failure.message.replace(/\.$/u, ""),
          `pick a team with ${strong("--team <id>")}${teams.length ? `: ${teams.map((team) => `${team.name ?? "?"} ${team.id ?? ""}`.trim()).join(", ")}` : ""}`,
        );
      } else {
        console.log(JSON.stringify({ ...error.body, ok: false, status: failure.status }, null, 2));
      }
      process.exitCode = 1;
      return;
    }
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: failure.message, status: failure.status, code: failure.code }));
      process.exitCode = 1;
      return;
    }
    reportFailure(error, options, `tasks ${action}`, `the task may be gone or not assigned to you; list yours with ${strong("adit cloud tasks list")}`);
  }
}

function printTaskList(list: CloudTaskList, options: Options): void {
  const state = options.state ?? "unfinished";
  const scope = [list.project.name ?? list.project.localProjectId, list.scope.teamName ? `team ${list.scope.teamName}` : "personal", state];
  if (!list.tasks.length) {
    printTitle("Tasks", ...scope);
    printEnd(`${marks.skip} No ${state === "all" ? "" : `${state.replace("_", " ")} `}tasks assigned to you`);
    return;
  }
  printTitle("Tasks", ...scope, `${list.tasks.length} of ${list.total}`);
  printTable(
    [{ header: "id" }, { header: "state" }, { header: "due" }, { header: "title" }],
    list.tasks.map((task) => [
      task.taskId,
      stateWord(task.progressState),
      task.dueAt ? task.dueAt.slice(0, 10) : "-",
      truncate(task.title, summaryColumns(36 + 11 + 10 + 6)),
    ]),
  );
  const more = list.nextOffset !== null
    ? `more: ${strong(commandWith("adit cloud tasks list", { team: options.team, project: options.project, state: options.state === "unfinished" ? undefined : options.state, limit: options.limit === "50" ? undefined : options.limit, offset: list.nextOffset }))}`
    : null;
  printEnd(dim([more, `details: ${strong("adit cloud tasks show <id>")}`, `done: ${strong("adit cloud tasks update <id> --state done")}`].filter(Boolean).join(" · ")));
}

function printTaskDetail(detail: CloudTaskDetail): void {
  const { task, permissions } = detail;
  const rows: Row[] = [
    { label: "State", value: stateWord(task.progressState) },
    { label: "Priority", value: task.priority },
    { label: "Due", value: task.dueAt ? task.dueAt.slice(0, 10) : "-" },
  ];
  if (task.blueprintTitle) rows.push({ label: "Intent", value: task.blueprintTitle });
  if (task.keyPointsText) rows.push({ label: "Key points", value: task.keyPointsText.trim() });
  rows.push({ label: "Updated", value: localDateTime(task.updatedAt) });
  if (detail.assignableMembers.length) {
    rows.push({ label: "Assignable", value: detail.assignableMembers.map((member) => member.name ?? member.email ?? member.id).join(", ") });
  }
  rows.push({
    label: "You can",
    value: joinParts([
      permissions.canManage ? "manage" : null,
      permissions.canUpdateState ? "update state" : null,
      permissions.canUpdateDueAt ? "update due date" : null,
    ]) || "read only",
  });
  printTitle("Task", task.taskId, truncate(task.title, 60));
  printRows(rows);
  printEnd(dim(`full record: ${strong(`adit cloud tasks show ${task.taskId} --json`)}`));
}

export function registerCloudTaskCommands(cloud: Command) {
  const tasks = cloud.command("tasks").description("Create independent tasks, query and update tasks assigned to you");
  tasks.command("create").description("Create an independent task assigned to you in Cloud")
    .requiredOption("--title <text>", "Task title, 1-200 characters")
    .requiredOption("--key-points <text>", "Task requirements, 1-20000 characters")
    .option("--team <id>", "Select a team linked to this project (see tasks scopes)")
    .option("--project <id>", "Local project ID; defaults to this initialized project")
    .option("--personal", "Create in the personal project instead of its linked team")
    .option("--due <date>", "Due date, YYYY-MM-DD")
    .addOption(new Option("--priority <priority>", "Task priority; defaults to medium").choices(["high", "medium", "low"]))
    .option("--json", "Output JSON").action((options) => cloudTasksCommand("create", options));
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
