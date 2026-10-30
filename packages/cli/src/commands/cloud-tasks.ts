import { Command, Option } from "commander";
import {
  CloudClient,
  CloudApiError,
  CloudTaskTypeVerificationError,
  listCloudTaskTypes,
  loadCredentials,
  createCloudTask,
  listCloudTasks,
  showCloudTask,
  cloudTaskContext,
  updateCloudTask,
  type CloudTaskDetail,
  type CloudTaskList,
  type CloudTaskPatch,
} from "@varveai/adit-cloud";
import { registerCloudTaskTypeCommands, validateTaskTypeName } from "./cloud-task-types.js";
import { loadProjectContext } from "./project-context.js";
import {
  NotLoggedInError,
  commandWith,
  describeFailure,
  reportFailure,
} from "./cloud-read-output.js";
import { prepareTaskAttachments, uploadTaskAttachments } from "./cloud-task-attachments.js";
import {
  dim,
  joinParts,
  localDateTime,
  marks,
  printEnd,
  printError,
  printRows,
  printSection,
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
  timelineLimit?: string;
  timelineCursor?: string;
  json?: boolean;
  team?: string;
  project?: string;
  personal?: boolean;
  state?: string;
  limit?: string;
  offset?: string;
  type?: string;
  clearType?: boolean;
  unclassified?: boolean;
  due?: string;
  clearDue?: boolean;
  start?: string;
  clearStart?: boolean;
  estimateDays?: string;
  estimateHours?: string;
  clearEstimate?: boolean;
  createdAt?: string;
  clearCreatedAt?: boolean;
  taskScope?: string[];
  clearScope?: boolean;
  title?: string;
  keyPoints?: string;
  clearKeyPoints?: boolean;
  priority?: string;
  assignee?: string;
  clearAssignee?: boolean;
  expectedUpdatedAt?: string;
  image?: string[];
  file?: string[];
};

export function taskDueDate(value: string, label = "Due"): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    throw new Error(`${label} date must be a valid YYYY-MM-DD date`);
  return date.toISOString();
}

export function taskPatchFromOptions(options: Options): CloudTaskPatch {
  for (const [value, clear, flag] of [
    [options.type, options.clearType, "type"],
    [options.due, options.clearDue, "due"],
    [options.start, options.clearStart, "start"],
    [options.createdAt, options.clearCreatedAt, "created-at"],
    [options.keyPoints, options.clearKeyPoints, "key-points"],
    [options.assignee, options.clearAssignee, "assignee"],
    [options.taskScope, options.clearScope, "scope"],
  ] as const)
    if (value !== undefined && clear)
      throw new Error(`Use either --${flag === "scope" ? "task-scope" : flag} or --clear-${flag}`);
  if (
    Number(options.estimateDays !== undefined) +
      Number(options.estimateHours !== undefined) +
      Number(Boolean(options.clearEstimate)) >
    1
  )
    throw new Error("Use only one of --estimate-days, --estimate-hours or --clear-estimate");
  if (
    options.state !== undefined &&
    !["not_started", "in_progress", "paused", "done", "accepted"].includes(options.state)
  )
    throw new Error("Invalid task state");
  if (options.priority !== undefined && !["high", "medium", "low"].includes(options.priority))
    throw new Error("Invalid task priority");
  const patch: CloudTaskPatch = {};
  if (options.type !== undefined) patch.taskType = validateTaskTypeName(options.type);
  if (options.clearType) patch.taskType = null;
  if (options.state) patch.progressState = options.state as CloudTaskPatch["progressState"];
  if (options.due !== undefined) patch.dueAt = taskDueDate(options.due);
  if (options.clearDue) patch.dueAt = null;
  if (options.start !== undefined) patch.startAt = taskDueDate(options.start, "Start");
  if (options.clearStart) patch.startAt = null;
  if (patch.startAt && patch.dueAt && patch.startAt > patch.dueAt)
    throw new Error("Expected start must not be later than expected completion");
  const estimate = options.estimateDays ?? options.estimateHours;
  if (estimate !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(estimate.trim()) || !Number.isFinite(Number(estimate)))
      throw new Error("Estimate must be a finite number, 0 or more");
    patch.estimatedPersonDays = Number(estimate) / (options.estimateHours === undefined ? 1 : 8);
  }
  if (options.clearEstimate) patch.estimatedPersonDays = null;
  if (options.createdAt !== undefined) {
    if (
      !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(
        options.createdAt,
      )
    )
      throw new Error(
        "Creation time must be an ISO 8601 timestamp with timezone, such as 2026-10-27T10:00:00+08:00",
      );
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
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.assignee))
      throw new Error("Use a member ID returned by the task details");
    patch.assigneeId = options.assignee;
  }
  if (options.clearAssignee) patch.assigneeId = null;
  if (options.taskScope !== undefined) {
    const scope = options.taskScope.map((value) => value.trim());
    if (scope.length > 30 || scope.some((value) => !value || value.length > 200))
      throw new Error("Task scope accepts up to 30 nonempty entries of at most 200 characters");
    patch.scope = scope;
  }
  if (options.clearScope) patch.scope = [];
  if (!Object.keys(patch).length) throw new Error("Specify at least one task change");
  return patch;
}

function pageNumber(value: string | undefined, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max)
    throw new Error("Invalid pagination value");
  return Number(value);
}

function timelineOptions(options: Options) {
  const timelineLimit =
    options.timelineLimit === undefined ? undefined : pageNumber(options.timelineLimit, 50, 100);
  if (timelineLimit === 0) throw new Error("Timeline limit must be between 1 and 100");
  return { timelineLimit, timelineCursor: options.timelineCursor };
}

export async function cloudTasksCommand(
  action: "create" | "attach" | "list" | "show" | "context" | "update" | "scopes",
  options: Options = {},
  taskId?: string,
): Promise<void> {
  try {
    if (taskId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId))
      throw new Error("Use the full taskId returned by the task list");
    const credentials = loadCredentials();
    if (!credentials) throw new NotLoggedInError();
    const client = new CloudClient(credentials.serverUrl, credentials, {
      maxRetries: ["update", "create", "attach"].includes(action) ? 0 : 2,
    });
    let localProjectId = options.project;
    if ((action === "list" || action === "scopes" || action === "create") && !localProjectId) {
      const config = loadProjectContext(`adit cloud tasks ${action}`);
      if (!config)
        throw new Error(
          "Add this working directory in Settings or provide an explicit project ID.",
        );
      localProjectId = config.projectId;
    }
    let result: unknown;
    if (action === "create") {
      if (options.team && options.personal) throw new Error("Select either --team or --personal");
      const title = options.title?.trim(),
        keyPointsText = options.keyPoints?.trim();
      if (!title || title.length > 200) throw new Error("Task title must contain 1-200 characters");
      if (!keyPointsText || keyPointsText.length > 20000)
        throw new Error("Task key points must contain 1-20000 characters");
      const { scope: taskScope, ...fields } = taskPatchFromOptions(options);
      const files = await prepareTaskAttachments(options.file, options.image);
      if (fields.taskType !== undefined)
        await listCloudTaskTypes(client, {
          localProjectId: localProjectId!,
          teamId: options.team,
          scope: options.personal ? "personal" : undefined,
        });
      const created = await createCloudTask(client, {
        localProjectId: localProjectId!,
        teamId: options.team,
        scope: options.personal ? "personal" : undefined,
        ...fields,
        title,
        keyPointsText,
        ...(taskScope === undefined ? {} : { taskScope }),
      });
      const uploaded = files.length
        ? await uploadTaskAttachments(client, created.task.taskId, files)
        : null;
      if (uploaded && !uploaded.ok) {
        process.exitCode = 1;
        if (options.json)
          console.log(JSON.stringify({ ...created, ...uploaded, taskCreated: true }, null, 2));
        else printAttachmentFailure(uploaded);
        return;
      }
      if (!options.json) {
        printTitle(
          "Task created",
          created.project.name ?? created.project.localProjectId,
          created.scope.teamName ? `team ${created.scope.teamName}` : "personal",
        );
        printRows([
          { label: "ID", value: created.task.taskId },
          { label: "Title", value: created.task.title },
          { label: "State", value: stateWord(created.task.progressState) },
          { label: "Priority", value: created.task.priority },
          { label: "Type", value: created.task.taskType ?? "Unclassified" },
          { label: "Due", value: created.task.dueAt?.slice(0, 10) ?? "-" },
          {
            label: "Estimate",
            value:
              created.task.estimatedPersonDays == null
                ? "-"
                : `${created.task.estimatedPersonDays} person-days`,
          },
          ...(uploaded
            ? [
                {
                  label: "Attachments",
                  value: `${uploaded.attachments.length} uploaded: ${uploaded.attachments.map((file) => file.displayName).join(", ")}`,
                },
              ]
            : []),
        ]);
        printEnd(`${marks.ok} Independent task created`);
        return;
      }
      result = uploaded ? { ...created, attachments: uploaded.attachments } : created;
    } else if (action === "list") {
      if (options.team && options.personal) throw new Error("Select either --team or --personal");
      if (options.type !== undefined && options.unclassified)
        throw new Error("Use either --type or --unclassified");
      const limit = pageNumber(options.limit, 50, 100);
      if (limit === 0) throw new Error("Limit must be between 1 and 100");
      const list = await listCloudTasks(client, {
        localProjectId: localProjectId!,
        teamId: options.team,
        scope: options.personal ? "personal" : undefined,
        state: options.state ?? "unfinished",
        taskType: options.type,
        unclassified: options.unclassified,
        offset: pageNumber(options.offset, 0, Number.MAX_SAFE_INTEGER),
        limit,
      });
      if (!options.json) {
        printTaskList(list, options);
        return;
      }
      result = list;
    } else if (action === "scopes") {
      result = await client.get(
        `/api/cli/tasks/scopes?${new URLSearchParams({ localProjectId: localProjectId! })}`,
      );
    } else if (!taskId) {
      throw new Error("Task ID is required");
    } else if (action === "attach") {
      if (!options.file?.length && !options.image?.length)
        throw new Error("Provide at least one --file <path> or --image <path>");
      const files = await prepareTaskAttachments(options.file, options.image);
      const uploaded = await uploadTaskAttachments(client, taskId, files);
      if (!uploaded.ok) process.exitCode = 1;
      if (!options.json) {
        if (!uploaded.ok) printAttachmentFailure(uploaded);
        else {
          printTitle("Task attachments", taskId);
          printRows(
            uploaded.attachments.map((file) => ({ label: "Uploaded", value: file.displayName })),
          );
          printEnd(`${marks.ok} ${uploaded.attachments.length} file(s) attached`);
        }
        return;
      }
      result = uploaded;
    } else if (action === "show") {
      const detail = await showCloudTask(client, taskId, timelineOptions(options));
      // Pipes and agents keep the JSON they always got; a person at a terminal gets the text view.
      if (!options.json && process.stdout.isTTY) {
        printTaskDetail(detail);
        return;
      }
      result = detail;
    } else if (action === "context") {
      result = await cloudTaskContext(client, taskId, timelineOptions(options));
    } else {
      const patch = taskPatchFromOptions(options);
      const expectedUpdatedAt =
        options.expectedUpdatedAt ?? (await showCloudTask(client, taskId)).task.updatedAt;
      result = await updateCloudTask(client, taskId, patch, expectedUpdatedAt);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof CloudTaskTypeVerificationError) {
      process.exitCode = 1;
      if (options.json)
        console.log(
          JSON.stringify({
            ok: false,
            error: error.message,
            code: error.code,
            taskId: error.taskId,
            taskCreated: error.taskCreated,
          }),
        );
      else printError(`tasks ${action}`, error.message);
      return;
    }
    const failure = describeFailure(error);
    if (
      failure.code === "TEAM_SELECTION_REQUIRED" &&
      error instanceof CloudApiError &&
      error.body &&
      typeof error.body === "object"
    ) {
      if (!options.json && process.stdout.isTTY) {
        const teams = Array.isArray((error.body as { teams?: unknown }).teams)
          ? (error.body as { teams: Array<{ id?: string; name?: string }> }).teams
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
      console.log(
        JSON.stringify({
          ok: false,
          error: failure.message,
          status: failure.status,
          code: failure.code,
        }),
      );
      process.exitCode = 1;
      return;
    }
    reportFailure(
      error,
      options,
      `tasks ${action}`,
      `the task may be gone or not assigned to you; list yours with ${strong("adit cloud tasks list")}`,
    );
  }
}

function printAttachmentFailure(
  result: Extract<Awaited<ReturnType<typeof uploadTaskAttachments>>, { ok: false }>,
) {
  printTitle("Task attachments incomplete", result.taskId);
  printRows([
    { label: "Task ID", value: result.taskId },
    { label: "Uploaded", value: String(result.attachments.length) },
    ...result.pendingFiles.map((path) => ({ label: "Pending", value: path })),
  ]);
  printError("attachment upload", result.error, result.recovery);
}

function printTaskList(list: CloudTaskList, options: Options): void {
  const state = options.state ?? "unfinished";
  const scope = [
    list.project.name ?? list.project.localProjectId,
    list.scope.teamName ? `team ${list.scope.teamName}` : "personal",
    state,
  ];
  if (!list.tasks.length) {
    printTitle("Tasks", ...scope);
    printEnd(
      `${marks.skip} No ${state === "all" ? "" : `${state.replace("_", " ")} `}tasks assigned to you`,
    );
    return;
  }
  printTitle("Tasks", ...scope, `${list.tasks.length} of ${list.total}`);
  printTable(
    [
      { header: "id" },
      { header: "state" },
      { header: "due" },
      { header: "type" },
      { header: "title" },
    ],
    list.tasks.map((task) => [
      task.taskId,
      stateWord(task.progressState),
      task.dueAt ? task.dueAt.slice(0, 10) : "-",
      truncate(task.taskType ?? "Unclassified", 16),
      truncate(task.title, summaryColumns(36 + 11 + 10 + 16 + 8)),
    ]),
  );
  const more =
    list.nextOffset !== null
      ? `more: ${strong(commandWith(`adit cloud tasks list${options.personal ? " --personal" : ""}${options.unclassified ? " --unclassified" : ""}`, { type: options.type, team: options.team, project: options.project, state: options.state === "unfinished" ? undefined : options.state, limit: options.limit === "50" ? undefined : options.limit, offset: list.nextOffset }))}`
      : null;
  printEnd(
    dim(
      [
        more,
        `details: ${strong("adit cloud tasks show <id>")}`,
        `done: ${strong("adit cloud tasks update <id> --state done")}`,
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  );
}

function printTaskDetail(detail: CloudTaskDetail): void {
  const { task, permissions } = detail;
  const rows: Row[] = [
    { label: "State", value: stateWord(task.progressState) },
    { label: "Priority", value: task.priority },
    { label: "Type", value: task.taskType ?? "Unclassified" },
    { label: "Type color", value: task.taskTypeColor ?? "-" },
    { label: "Due", value: task.dueAt ? task.dueAt.slice(0, 10) : "-" },
    { label: "Start", value: task.startAt?.slice(0, 10) ?? "-" },
    {
      label: "Estimate",
      value: task.estimatedPersonDays == null ? "-" : `${task.estimatedPersonDays} person-days`,
    },
    { label: "Created", value: task.createdAt ? localDateTime(task.createdAt) : "-" },
  ];
  if (task.blueprintTitle) rows.push({ label: "Intent", value: task.blueprintTitle });
  if (task.keyPointsText) rows.push({ label: "Key points", value: task.keyPointsText.trim() });
  if (task.scope?.length) rows.push({ label: "Scope", value: task.scope.join(", ") });
  rows.push({ label: "Updated", value: localDateTime(task.updatedAt) });
  if (detail.assignableMembers.length) {
    rows.push({
      label: "Assignable",
      value: detail.assignableMembers
        .map((member) => member.name ?? member.email ?? member.id)
        .join(", "),
    });
  }
  rows.push({
    label: "You can",
    value:
      joinParts([
        permissions.canManage ? "manage" : null,
        permissions.canUpdateState ? "update state" : null,
        permissions.canUpdateDueAt ? "update due date" : null,
      ]) || "read only",
  });
  printTitle("Task", task.taskId, truncate(task.title, 60));
  printRows(rows);
  const timeline = detail.timeline;
  printSection("Timeline", "newest first");
  if (!timeline)
    printRows([
      {
        label: "Unavailable",
        value: "This Cloud version does not return task history; this is not an empty history.",
      },
    ]);
  else {
    if (!timeline.entries.length) printRows([{ label: "History", value: "No recorded changes" }]);
    for (const entry of timeline.entries) {
      printRows([
        { label: "Revision", value: entry.id },
        { label: "Time", value: localDateTime(entry.createdAt) },
        { label: "Actor", value: entry.actorName ?? entry.actorId ?? "Unknown" },
        { label: "Action", value: entry.kind },
        {
          label: "Changes",
          value: entry.changes
            ? JSON.stringify(entry.changes, null, 2)
            : "Change details unavailable in this record",
        },
      ]);
    }
    if (timeline.nextCursor)
      printRows([
        {
          label: "More history",
          value: commandWith(`adit cloud tasks show ${task.taskId} --json`, {
            "timeline-cursor": timeline.nextCursor,
          }),
        },
      ]);
  }
  printEnd(dim(`full record: ${strong(`adit cloud tasks show ${task.taskId} --json`)}`));
}

function taskFieldOptions(command: Command) {
  return command
    .option("--type <name>", "Task type name from the current scope; saves its color snapshot")
    .option("--clear-type", "Clear both type name and color")
    .addOption(
      new Option("--state <state>", "Task state; requires an assignee").choices([
        "not_started",
        "in_progress",
        "paused",
        "done",
        "accepted",
      ]),
    )
    .option("--due <date>", "Expected completion, YYYY-MM-DD")
    .option("--clear-due", "Remove expected completion")
    .option("--start <date>", "Expected start, YYYY-MM-DD")
    .option("--clear-start", "Remove expected start")
    .option("--estimate-days <days>", "Estimated person-days, 0 or more; decimals allowed")
    .option(
      "--estimate-hours <hours>",
      "Estimated hours; 8 hours = 1 person-day (2 hours = 0.25 person-days)",
    )
    .option("--clear-estimate", "Remove estimated workload; distinct from zero")
    .option("--assignee <id>", "Assign to a member; updates require manage access")
    .option("--clear-assignee", "Clear the assignee; updates require manage access")
    .option(
      "--task-scope <text>",
      "Task scope entry (repeat to replace the whole list; not team/project selection)",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--clear-scope", "Clear all task scope entries")
    .option("--created-at <timestamp>", "Creation time with timezone (independent tasks only)")
    .option("--clear-created-at", "Clear creation time (independent tasks only)");
}

export function registerCloudTaskCommands(cloud: Command) {
  const tasks = cloud
    .command("tasks")
    .description("Create independent tasks, query and update tasks assigned to you");
  registerCloudTaskTypeCommands(tasks);
  taskFieldOptions(
    tasks
      .command("create")
      .description("Create an independent task in Cloud; assigned to you unless specified")
      .requiredOption("--title <text>", "Task title, 1-200 characters")
      .requiredOption("--key-points <text>", "Task requirements, 1-20000 characters")
      .option("--team <id>", "Select a team linked to this project (see tasks scopes)")
      .option("--project <id>", "Local project ID; defaults to this initialized project")
      .option("--personal", "Create in the personal project instead of its linked team")
      .option(
        "--file <path>",
        "Attach an image (max 10 MB) or MD, TXT, DOCX, PDF, HTML, HTM document (max 20 MB); repeat for multiple files",
        (value: string, previous: string[]) => [...previous, value],
        [],
      )
      .option(
        "--image <path>",
        "Attach an image (repeat for multiple files; max 10 MB each)",
        (value: string, previous: string[]) => [...previous, value],
        [],
      )
      .addOption(
        new Option("--priority <priority>", "Task priority; defaults to medium").choices([
          "high",
          "medium",
          "low",
        ]),
      ),
  )
    .option("--json", "Output JSON")
    .action((options) => cloudTasksCommand("create", options));
  tasks
    .command("attach <taskId>")
    .description(
      "Upload attachments to an existing task you can upload to; identical uploads are deduplicated",
    )
    .option(
      "--file <path>",
      "Local image (max 10 MB) or MD, TXT, DOCX, PDF, HTML, HTM document (max 20 MB); repeat for multiple files",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      "--image <path>",
      "Local PNG, JPG, JPEG, WebP or GIF (repeat for multiple files; max 10 MB each)",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--json", "Output JSON")
    .action((taskId, options) => cloudTasksCommand("attach", options, taskId));
  tasks
    .command("list")
    .description("List your tasks in the current project or a team")
    .option("--team <id>", "Select a team linked to this project (see tasks scopes)")
    .option("--project <id>", "Local project ID; defaults to this initialized project")
    .option("--personal", "Query personal project tasks instead of its linked team")
    .option("--type <name>", "Filter by a saved type name, including removed choices")
    .option("--unclassified", "Show only tasks without a type")
    .addOption(
      new Option("--state <state>", "Task state")
        .choices(["unfinished", "all", "not_started", "in_progress", "paused", "done", "accepted"])
        .default("unfinished"),
    )
    .option("--limit <number>", "Page size, 1-100", "50")
    .option("--offset <number>", "Pagination offset", "0")
    .option("--json", "Output JSON")
    .action((options) => cloudTasksCommand("list", options));
  tasks
    .command("scopes")
    .description("List teams linked to the current project, not all account teams")
    .option("--project <id>", "Local project ID; defaults to this initialized project")
    .option("--json", "Output JSON")
    .action((options) => cloudTasksCommand("scopes", options));
  for (const action of ["show", "context"] as const)
    tasks
      .command(`${action} <taskId>`)
      .description(
        action === "show"
          ? "Read a task, its current version and recorded change history"
          : "Read task requirements, change history, PRD and resource URLs (no downloads)",
      )
      .option("--timeline-limit <number>", "History page size, 1-100 (default 50), newest first")
      .option(
        "--timeline-cursor <cursor>",
        "Continue history with timeline.nextCursor from the previous response",
      )
      .option("--json", "Output JSON")
      .action((taskId, options) => cloudTasksCommand(action, options, taskId));
  taskFieldOptions(
    tasks
      .command("update <taskId>")
      .description("Update an assigned or created task in Cloud immediately"),
  )
    .option("--title <text>", "Task title (requires manage access)")
    .option("--key-points <text>", "Task key points (requires manage access)")
    .option("--clear-key-points", "Clear task key points (requires manage access)")
    .addOption(
      new Option("--priority <priority>", "Task priority (requires manage access)").choices([
        "high",
        "medium",
        "low",
      ]),
    )
    .option(
      "--expected-updated-at <timestamp>",
      "updatedAt from the last task read; reject stale updates",
    )
    .option("--json", "Output JSON")
    .action((taskId, options) => cloudTasksCommand("update", options, taskId));
}
