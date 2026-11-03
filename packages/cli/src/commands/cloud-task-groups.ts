import { Command } from "commander";
import {
  CloudClient,
  CloudApiError,
  loadCredentials,
  listCloudTaskGroups,
  showCloudTaskGroup,
  createCloudTaskGroup,
  updateCloudTaskGroup,
  deleteCloudTaskGroup,
  selectCloudGroupTasks,
  moveCloudGroupTasks,
  type CloudGroupTaskVersion,
} from "@varveai/adit-cloud";
import { loadProjectContext } from "./project-context.js";
import { NotLoggedInError, describeFailure, reportFailure } from "./cloud-read-output.js";
import { printTitle, printTable, printEnd } from "./cli-style.js";

type Action = "list" | "show" | "create" | "update" | "reorder" | "delete" | "move" | "remove";
type Options = {
  project?: string;
  team?: string;
  personal?: boolean;
  json?: boolean;
  name?: string;
  expectedUpdatedAt?: string;
  before?: string;
  after?: string;
  first?: boolean;
  last?: boolean;
  task?: string[];
  taskVersion?: string[];
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireId(id: string) {
  if (!UUID.test(id)) throw new Error("Provide a group/task ID from a previous read.");
  return id;
}
export function validateGroupOptions(action: Action, options: Options, id?: string) {
  if (options.team && options.personal) throw new Error("Select either --team or --personal");
  if (id) requireId(id);
  const name = options.name?.trim();
  if (
    options.name !== undefined &&
    (!name ||
      name.length > 100 ||
      [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
  )
    throw new Error("Group name must contain 1-100 characters.");
  if ((action === "create" || action === "update") && !name) throw new Error("Provide --name");
  if (
    action === "reorder" &&
    [options.before, options.after, options.first, options.last].filter(Boolean).length !== 1
  )
    throw new Error("Provide exactly one of --before, --after, --first or --last");
  if (options.before) requireId(options.before);
  if (options.after) requireId(options.after);
  if (options.expectedUpdatedAt && !Number.isFinite(Date.parse(options.expectedUpdatedAt)))
    throw new Error("Invalid --expected-updated-at timestamp");
  const ids = [...new Set(options.task ?? [])];
  if ((action === "move" || action === "remove") && (!ids.length || ids.length > 2000))
    throw new Error("Provide 1-2000 unique --task IDs");
  ids.forEach(requireId);
  const versions = new Map<string, string>();
  for (const entry of options.taskVersion ?? []) {
    const separator = entry.indexOf("=");
    const taskId = entry.slice(0, separator);
    const version = entry.slice(separator + 1);
    if (
      separator < 0 ||
      !ids.includes(taskId) ||
      !Number.isFinite(Date.parse(version)) ||
      versions.has(taskId)
    )
      throw new Error("Use --task-version <taskId>=<updatedAt> once per selected task");
    versions.set(taskId, new Date(version).toISOString());
  }
  return { name, ids, versions };
}
export async function cloudTaskGroupsCommand(action: Action, options: Options, id?: string) {
  try {
    const { name, ids, versions } = validateGroupOptions(action, options, id);
    const credentials = loadCredentials();
    if (!credentials) throw new NotLoggedInError();
    const localProjectId =
      options.project ?? loadProjectContext("adit cloud tasks groups")?.projectId;
    if (!localProjectId)
      throw new Error(
        "Add this working directory in Settings or provide an explicit workspace ID.",
      );
    const scope = {
      localProjectId,
      teamId: options.team,
      scope: options.personal ? ("personal" as const) : undefined,
    };
    const client = new CloudClient(credentials.serverUrl, credentials, {
      maxRetries: ["list", "show"].includes(action) ? 2 : 0,
    });
    let result: unknown;
    if (action === "list") result = await listCloudTaskGroups(client, scope);
    else if (action === "show") {
      let detail = await showCloudTaskGroup(client, scope, id!);
      const version = detail.group.updatedAt;
      const total = detail.total;
      const tasks = [...detail.tasks];
      while (detail.nextOffset !== null) {
        const offset = detail.nextOffset;
        detail = await showCloudTaskGroup(client, scope, id!, offset);
        if (
          detail.group.updatedAt !== version ||
          detail.total !== total ||
          (detail.nextOffset !== null && detail.nextOffset <= offset)
        )
          throw new Error("Group membership changed during pagination. Read it again.");
        tasks.push(...detail.tasks);
      }
      if (tasks.length !== total || new Set(tasks.map((task) => task.taskId)).size !== total)
        throw new Error("Group membership changed during pagination. Read it again.");
      result = { ...detail, tasks, nextOffset: null };
    } else if (action === "create") result = await createCloudTaskGroup(client, scope, name!);
    else if (action === "move" || action === "remove") {
      const selection = await selectCloudGroupTasks(client, scope, ids);
      if (selection.tasks.length !== ids.length)
        throw new Error("Some selected tasks are unavailable or cannot be managed.");
      if (action === "remove" && selection.tasks.some((task) => task.groupId !== id))
        throw new Error("Some tasks no longer belong to the source group. Read and select again.");
      const tasks: CloudGroupTaskVersion[] = selection.tasks.map((task) => ({
        taskId: task.taskId,
        groupId: task.groupId,
        expectedUpdatedAt: versions.get(task.taskId) ?? task.expectedUpdatedAt,
      }));
      result = await moveCloudGroupTasks(client, scope, action === "remove" ? null : id!, tasks);
    } else {
      const group = (await listCloudTaskGroups(client, scope)).groups.find(
        (group) => group.id === id,
      );
      if (!group)
        throw new Error("Group not found in the selected scope. List groups before updating.");
      const expectedUpdatedAt = options.expectedUpdatedAt ?? group.updatedAt;
      result =
        action === "delete"
          ? await deleteCloudTaskGroup(client, scope, id!, expectedUpdatedAt)
          : await updateCloudTaskGroup(client, scope, id!, {
              expectedUpdatedAt,
              name,
              before: options.before,
              after: options.after,
              position: options.first ? "first" : options.last ? "last" : undefined,
            });
    }
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      printTitle("Task groups");
      if (action === "list") {
        const list = result as Awaited<ReturnType<typeof listCloudTaskGroups>>;
        printTable(
          [{ header: "ID" }, { header: "Name" }, { header: "Tasks" }],
          list.groups.map((group) => [group.id, group.name, String(group.taskCount)]),
        );
      } else if (action === "show") {
        const detail = result as Awaited<ReturnType<typeof showCloudTaskGroup>>;
        printTable(
          [{ header: "ID" }, { header: "Task" }, { header: "Blueprint" }],
          detail.tasks.map((task) => [
            task.taskId,
            task.title,
            task.blueprintTitle ?? "Independent",
          ]),
        );
      } else
        printEnd(
          action === "delete" ? "Group deleted. All tasks were retained." : "Saved to Cloud.",
        );
    }
  } catch (error) {
    if (options.json) {
      const failure = describeFailure(error);
      const context =
        error instanceof CloudApiError && error.body && typeof error.body === "object"
          ? error.body
          : {};
      console.log(
        JSON.stringify({
          ...context,
          ok: false,
          error: failure.message,
          status: failure.status,
          code: failure.code,
        }),
      );
      process.exitCode = 1;
    } else
      reportFailure(
        error,
        options,
        `tasks groups ${action}`,
        "Read the same scope after an uncertain write; do not blindly repeat it.",
      );
  }
}
export function registerCloudTaskGroupCommands(tasks: Command) {
  const groups = tasks
    .command("groups")
    .description("Organize independent and blueprint tasks into shared Cloud groups");
  const scopeOptions = (command: Command) =>
    command
      .option("--team <id>", "Select a linked collaboration project")
      .option("--project <id>", "Explicit local workspace ID")
      .option("--personal", "Use your workspace")
      .option("--json", "Output structured JSON");
  scopeOptions(groups.command("list")).action((options) => cloudTaskGroupsCommand("list", options));
  scopeOptions(
    groups
      .command("show <groupId>")
      .description("Read all visible group tasks, following pagination"),
  ).action((id, options) => cloudTaskGroupsCommand("show", options, id));
  scopeOptions(groups.command("create").requiredOption("--name <text>", "Group name")).action(
    (options) => cloudTaskGroupsCommand("create", options),
  );
  const version = (command: Command) =>
    scopeOptions(command).option(
      "--expected-updated-at <timestamp>",
      "Reject a stale group change; defaults to a fresh read",
    );
  version(
    groups.command("update <groupId>").requiredOption("--name <text>", "New group name"),
  ).action((id, options) => cloudTaskGroupsCommand("update", options, id));
  version(
    groups.command("delete <groupId>").description("Delete the group and keep all tasks"),
  ).action((id, options) => cloudTaskGroupsCommand("delete", options, id));
  version(
    groups
      .command("reorder <groupId>")
      .option("--before <groupId>", "Place before this group")
      .option("--after <groupId>", "Place after this group")
      .option("--first", "Place first")
      .option("--last", "Place last"),
  ).action((id, options) => cloudTaskGroupsCommand("reorder", options, id));
  const collect = (value: string, previous: string[]) => [...previous, value];
  for (const action of ["move", "remove"] as const)
    scopeOptions(
      groups
        .command(`${action} <groupId>`)
        .description(
          action === "move"
            ? "Move selected tasks into this group atomically"
            : "Remove tasks only if still in this source group",
        )
        .requiredOption("--task <taskId>", "Task to move; repeat for multiple tasks", collect, [])
        .option(
          "--task-version <taskId=updatedAt>",
          "Expected task version; repeat per task, otherwise use a fresh read",
          collect,
          [],
        ),
    ).action((id, options) => cloudTaskGroupsCommand(action, options, id));
}
