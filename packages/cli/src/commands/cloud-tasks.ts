import { Command, Option } from "commander";
import { CloudClient, CloudApiError, loadCredentials, createCloudTask, listCloudTasks, showCloudTask, cloudTaskContext, updateCloudTask, type CloudTaskDetail, type CloudTaskList, type CloudTaskPatch } from "@varveai/adit-cloud";
import { loadProjectContext } from "./project-context.js";
import { NotLoggedInError, commandWith, describeFailure, reportFailure } from "./cloud-read-output.js";
import { prepareTaskImages, uploadTaskImages } from "./cloud-task-images.js";
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

type Options = {
  json?: boolean; team?: string; project?: string; personal?: boolean; state?: string; limit?: string; offset?: string;
  due?: string; clearDue?: boolean; start?: string; clearStart?: boolean;
  estimateDays?: string; estimateHours?: string; clearEstimate?: boolean;
  createdAt?: string; clearCreatedAt?: boolean; taskScope?: string[]; clearScope?: boolean;
  title?: string; keyPoints?: string; clearKeyPoints?: boolean; priority?: string;
  assignee?: string; clearAssignee?: boolean; expectedUpdatedAt?: string; image?: string[];
};

export function taskDueDate(value: string, label = "Due"): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`${label} date must be a valid YYYY-MM-DD date`);
  return date.toISOString();
}

export function taskPatchFromOptions(options: Options): CloudTaskPatch {
  for (const [value, clear, flag] of [
    [options.due, options.clearDue, "due"], [options.start, options.clearStart, "start"],
    [options.createdAt, options.clearCreatedAt, "created-at"], [options.keyPoints, options.clearKeyPoints, "key-points"],
    [options.assignee, options.clearAssignee, "assignee"], [options.taskScope, options.clearScope, "scope"],
  ] as const) if (value !== undefined && clear) throw new Error(`Use either --${flag === "scope" ? "task-scope" : flag} or --clear-${flag}`);
  if (Number(options.estimateDays !== undefined) + Number(options.estimateHours !== undefined) + Number(Boolean(options.clearEstimate)) > 1) throw new Error("Use only one of --estimate-days, --estimate-hours or --clear-estimate");
  if (options.state !== undefined && !["not_started", "in_progress", "paused", "done", "accepted"].includes(options.state)) throw new Error("Invalid task state");
  if (options.priority !== undefined && !["high", "medium", "low"].includes(options.priority)) throw new Error("Invalid task priority");
  const patch: CloudTaskPatch = {};
  if (options.state) patch.progressState = options.state as CloudTaskPatch["progressState"];
  if (options.due !== undefined) patch.dueAt = taskDueDate(options.due);
  if (options.clearDue) patch.dueAt = null;
  if (options.start !== undefined) patch.startAt = taskDueDate(options.start, "Start");
  if (options.clearStart) patch.startAt = null;
  if (patch.startAt && patch.dueAt && patch.startAt > patch.dueAt) throw new Error("Expected start must not be later than expected completion");
  const estimate = options.estimateDays ?? options.estimateHours;
  if (estimate !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(estimate.trim()) || !Number.isFinite(Number(estimate))) throw new Error("Estimate must be a finite number, 0 or more");
    patch.estimatedPersonDays = Number(estimate) / (options.estimateHours === undefined ? 1 : 8);
  }
  if (options.clearEstimate) patch.estimatedPersonDays = null;
  if (options.createdAt !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(options.createdAt)) throw new Error("Creation time must be an ISO 8601 timestamp with timezone, such as 2026-10-27T10:00:00+08:00");
    taskDueDate(options.createdAt.slice(0, 10), "Creation");
    const createdAt = new Date(options.createdAt);
    if (!Number.isFinite(createdAt.getTime())) throw new Error("Invalid creation time");
    patch.createdAt = createdAt.toISOString();
  }
  if (options.clearCreatedAt) patch.createdAt = null;
  if (options.title !== undefined) patch.title = options.title;
  if (options.keyPoints !== undefined) patch.keyPointsText = options.keyPoints;
  if (options.clearKeyPoints) patch.keyPointsText = null;
  if (options.priority) patch.priority = options.priority as CloudTaskPatch["priority"];
  if (options.assignee !== undefined) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.assignee)) throw new Error("Use a member ID returned by the task details");
    patch.assigneeId = options.assignee;
  }
  if (options.clearAssignee) patch.assigneeId = null;
  if (options.taskScope !== undefined) {
    const scope = options.taskScope.map(value => value.trim());
    if (scope.length > 30 || scope.some(value => !value || value.length > 200)) throw new Error("Task scope accepts up to 30 nonempty entries of at most 200 characters");
    patch.scope = scope;
  }
  if (options.clearScope) patch.scope = [];
  if (!Object.keys(patch).length) throw new Error("Specify at least one task change");
  return patch;
}

function pageNumber(value: string | undefined, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new Error("Invalid pagination value");
  return Number(value);
}

export async function cloudTasksCommand(action: "create" | "attach" | "list" | "show" | "context" | "update" | "scopes", options: Options = {}, taskId?: string): Promise<void> {
  try {
    if (taskId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) throw new Error("Use the full taskId returned by the task list");
    const credentials = loadCredentials();
    if (!credentials) throw new NotLoggedInError();
    const client = new CloudClient(credentials.serverUrl, credentials, { maxRetries: ["update", "create", "attach"].includes(action) ? 0 : 2 });
    let localProjectId = options.project;
    if ((action === "list" || action === "scopes" || action === "create") && !localProjectId) {
      const config = loadProjectContext(`adit cloud tasks ${action}`);
      if (!config) throw new Error("Add this working directory in Settings or provide an explicit project ID.");
      localProjectId = config.projectId;
    }
    let result: unknown;
    if (action === "create") {
      if (options.team && options.personal) throw new Error("Select either --team or --personal");
      const title = options.title?.trim(), keyPointsText = options.keyPoints?.trim();
      if (!title || title.length > 200) throw new Error("Task title must contain 1-200 characters");
      if (!keyPointsText || keyPointsText.length > 20000) throw new Error("Task key points must contain 1-20000 characters");
      const { scope: taskScope, ...fields } = taskPatchFromOptions(options);
      const images = await prepareTaskImages(options.image);
      const created = await createCloudTask(client, {
        localProjectId: localProjectId!, teamId: options.team, scope: options.personal ? "personal" : undefined,
        ...fields, title, keyPointsText, ...(taskScope === undefined ? {} : { taskScope }),
      });
      const uploaded = images.length ? await uploadTaskImages(client, created.task.taskId, images) : null;
      if (uploaded && !uploaded.ok) {
        process.exitCode = 1;
        if (options.json) console.log(JSON.stringify({ ...created, ...uploaded, taskCreated: true }, null, 2));
        else printImageFailure(uploaded);
        return;
      }
      if (!options.json) {
        printTitle("Task created", created.project.name ?? created.project.localProjectId, created.scope.teamName ? `team ${created.scope.teamName}` : "personal");
        printRows([
          { label: "ID", value: created.task.taskId }, { label: "Title", value: created.task.title },
          { label: "State", value: stateWord(created.task.progressState) }, { label: "Priority", value: created.task.priority },
          { label: "Due", value: created.task.dueAt?.slice(0, 10) ?? "-" },
          { label: "Estimate", value: created.task.estimatedPersonDays == null ? "-" : `${created.task.estimatedPersonDays} person-days` },
          ...(uploaded ? [{ label: "Images", value: `${uploaded.attachments.length} uploaded: ${uploaded.attachments.map(file => file.displayName).join(", ")}` }] : []),
        ]);
        printEnd(`${marks.ok} Independent task created`);
        return;
      }
      result = uploaded ? { ...created, attachments: uploaded.attachments } : created;
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
    } else if (action === "attach") {
      if (!options.image?.length) throw new Error("Provide at least one --image <path>");
      const images = await prepareTaskImages(options.image);
      const uploaded = await uploadTaskImages(client, taskId, images);
      if (!uploaded.ok) process.exitCode = 1;
      if (!options.json) {
        if (!uploaded.ok) printImageFailure(uploaded);
        else { printTitle("Task images", taskId); printRows(uploaded.attachments.map(file => ({ label: "Uploaded", value: file.displayName }))); printEnd(`${marks.ok} ${uploaded.attachments.length} image(s) attached`); }
        return;
      }
      result = uploaded;
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

function printImageFailure(result: Extract<Awaited<ReturnType<typeof uploadTaskImages>>, { ok: false }>) {
  printTitle("Task images incomplete", result.taskId);
  printRows([{ label: "Task ID", value: result.taskId },
    { label: "Uploaded", value: String(result.attachments.length) },
    ...result.pendingImages.map(path => ({ label: "Pending", value: path }))]);
  printError("image upload", result.error, result.recovery);
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
    { label: "Start", value: task.startAt?.slice(0, 10) ?? "-" },
    { label: "Estimate", value: task.estimatedPersonDays == null ? "-" : `${task.estimatedPersonDays} person-days` },
    { label: "Created", value: task.createdAt ? localDateTime(task.createdAt) : "-" },
  ];
  if (task.blueprintTitle) rows.push({ label: "Intent", value: task.blueprintTitle });
  if (task.keyPointsText) rows.push({ label: "Key points", value: task.keyPointsText.trim() });
  if (task.scope?.length) rows.push({ label: "Scope", value: task.scope.join(", ") });
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

function taskFieldOptions(command: Command) {
  return command
    .addOption(new Option("--state <state>", "Task state; requires an assignee").choices(["not_started", "in_progress", "paused", "done", "accepted"]))
    .option("--due <date>", "Expected completion, YYYY-MM-DD").option("--clear-due", "Remove expected completion")
    .option("--start <date>", "Expected start, YYYY-MM-DD").option("--clear-start", "Remove expected start")
    .option("--estimate-days <days>", "Estimated person-days, 0 or more; decimals allowed")
    .option("--estimate-hours <hours>", "Estimated hours; 8 hours = 1 person-day (2 hours = 0.25 person-days)")
    .option("--clear-estimate", "Remove estimated workload; distinct from zero")
    .option("--assignee <id>", "Assign to a member; updates require manage access")
    .option("--clear-assignee", "Clear the assignee; updates require manage access")
    .option("--task-scope <text>", "Task scope entry (repeat to replace the whole list; not team/project selection)", (value: string, previous: string[] = []) => [...previous, value])
    .option("--clear-scope", "Clear all task scope entries")
    .option("--created-at <timestamp>", "Creation time with timezone (independent tasks only)")
    .option("--clear-created-at", "Clear creation time (independent tasks only)");
}

export function registerCloudTaskCommands(cloud: Command) {
  const tasks = cloud.command("tasks").description("Create independent tasks, query and update tasks assigned to you");
  taskFieldOptions(tasks.command("create").description("Create an independent task in Cloud; assigned to you unless specified")
    .requiredOption("--title <text>", "Task title, 1-200 characters")
    .requiredOption("--key-points <text>", "Task requirements, 1-20000 characters")
    .option("--team <id>", "Select a team linked to this project (see tasks scopes)")
    .option("--project <id>", "Local project ID; defaults to this initialized project")
    .option("--personal", "Create in the personal project instead of its linked team")
    .option("--image <path>", "Attach an image (repeat for multiple files; max 10 MB each)", (value: string, previous: string[]) => [...previous, value], [])
    .addOption(new Option("--priority <priority>", "Task priority; defaults to medium").choices(["high", "medium", "low"])))
    .option("--json", "Output JSON").action((options) => cloudTasksCommand("create", options));
  tasks.command("attach <taskId>").description("Upload images to an existing assigned task; identical uploads are deduplicated")
    .requiredOption("--image <path>", "Local PNG, JPG, JPEG, WebP or GIF (repeat for multiple files; max 10 MB each)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--json", "Output JSON").action((taskId, options) => cloudTasksCommand("attach", options, taskId));
  tasks.command("list").description("List your tasks in the current project or a team")
    .option("--team <id>", "Select a team linked to this project (see tasks scopes)").option("--project <id>", "Local project ID; defaults to this initialized project")
    .option("--personal", "Query personal project tasks instead of its linked team")
    .addOption(new Option("--state <state>", "Task state").choices(["unfinished", "all", "not_started", "in_progress", "paused", "done", "accepted"]).default("unfinished"))
    .option("--limit <number>", "Page size, 1-100", "50").option("--offset <number>", "Pagination offset", "0").option("--json", "Output JSON")
    .action((options) => cloudTasksCommand("list", options));
  tasks.command("scopes").description("List teams linked to the current project, not all account teams").option("--project <id>", "Local project ID; defaults to this initialized project").option("--json", "Output JSON").action((options) => cloudTasksCommand("scopes", options));
  for (const action of ["show", "context"] as const) tasks.command(`${action} <taskId>`).description(action === "show" ? "Read a task and its current version" : "Read task requirements, PRD and resource URLs (no downloads)").option("--json", "Output JSON").action((taskId, options) => cloudTasksCommand(action, options, taskId));
  taskFieldOptions(tasks.command("update <taskId>").description("Update an assigned or created task in Cloud immediately"))
    .option("--title <text>", "Task title (requires manage access)").option("--key-points <text>", "Task key points (requires manage access)")
    .option("--clear-key-points", "Clear task key points (requires manage access)")
    .addOption(new Option("--priority <priority>", "Task priority (requires manage access)").choices(["high", "medium", "low"]))
    .option("--expected-updated-at <timestamp>", "updatedAt from the last task read; reject stale updates")
    .option("--json", "Output JSON").action((taskId, options) => cloudTasksCommand("update", options, taskId));
}
