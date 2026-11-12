import { Command } from "commander";
import {
  CloudClient,
  CloudApiError,
  loadCredentials,
  listCloudTaskModules,
  createCloudTaskModule,
  updateCloudTaskModule,
  deleteCloudTaskModule,
  readCloudTaskModules,
  setCloudTaskModules,
} from "@varveai/adit-cloud";
import { loadProjectContext } from "./project-context.js";
import { NotLoggedInError, describeFailure, reportFailure } from "./cloud-read-output.js";
import { printTitle, printTable, printEnd } from "./cli-style.js";

type Action = "list" | "create" | "update" | "delete" | "show" | "set" | "add" | "remove" | "clear";
type Options = {
  project?: string;
  team?: string;
  personal?: boolean;
  json?: boolean;
  name?: string;
  module?: string[];
  expectedUpdatedAt?: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const catalogActions = new Set(["list", "create", "update", "delete"]);
export async function cloudTaskModulesCommand(action: Action, options: Options, id?: string) {
  try {
    if (id && !UUID.test(id)) throw new Error("Use the full module/task ID returned by a read.");
    if (options.team && options.personal) throw new Error("Select either --team or --personal");
    const name = options.name?.trim();
    if (
      ["create", "update"].includes(action) &&
      (!name ||
        name.length > 100 ||
        [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    )
      throw new Error("Module name must contain 1-100 characters.");
    const ids = [...new Set(options.module ?? [])];
    if (ids.length > 100 || ids.some((value) => !UUID.test(value)))
      throw new Error("Provide up to 100 module IDs returned by modules list.");
    if (["set", "add", "remove"].includes(action) && !ids.length)
      throw new Error("Provide --module <id>; use clear to remove all module memberships.");
    if (options.expectedUpdatedAt && !Number.isFinite(Date.parse(options.expectedUpdatedAt)))
      throw new Error("Invalid --expected-updated-at timestamp");
    const credentials = loadCredentials();
    if (!credentials) throw new NotLoggedInError();
    const client = new CloudClient(credentials.serverUrl, credentials, {
      maxRetries: ["list", "show"].includes(action) ? 2 : 0,
    });
    let result: unknown;
    if (catalogActions.has(action)) {
      const localProjectId =
        options.project ?? loadProjectContext("adit cloud tasks modules")?.projectId;
      if (!localProjectId)
        throw new Error(
          "Add this working directory in Settings or provide an explicit workspace ID.",
        );
      const scope = {
        localProjectId,
        teamId: options.team,
        scope: options.personal ? ("personal" as const) : undefined,
      };
      if (action === "list") result = await listCloudTaskModules(client, scope);
      else if (action === "create") result = await createCloudTaskModule(client, scope, name!);
      else {
        const module = (await listCloudTaskModules(client, scope)).modules.find(
          (item) => item.id === id,
        );
        if (!module)
          throw new Error("Module not found in the selected scope. List modules before updating.");
        const version = options.expectedUpdatedAt ?? module.updatedAt;
        result =
          action === "delete"
            ? await deleteCloudTaskModule(client, scope, id!, version)
            : await updateCloudTaskModule(client, scope, id!, name!, version);
      }
    } else {
      const before = await readCloudTaskModules(client, id!);
      if (action === "show") result = before;
      else {
        if (!before.canEdit) throw new Error("You cannot edit this task's modules.");
        if (options.expectedUpdatedAt && options.expectedUpdatedAt !== before.updatedAt)
          throw new Error("Task changed. Read its modules before trying again.");
        const moduleIds =
          action === "clear"
            ? []
            : action === "set"
              ? ids
              : action === "add"
                ? [...new Set([...before.moduleIds, ...ids])]
                : before.moduleIds.filter((value) => !ids.includes(value));
        if (moduleIds.length > 100) throw new Error("A task can belong to at most 100 modules.");
        if (action === "remove" && ids.some((value) => !before.moduleIds.includes(value)))
          throw new Error("Some selected modules no longer belong to this task. Read it again.");
        if (moduleIds.some((value) => !before.modules.some((module) => module.id === value)))
          throw new Error("Some modules are unavailable in this task's scope.");
        result = await setCloudTaskModules(client, id!, moduleIds, before.updatedAt);
      }
    }
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if (action === "list" || action === "show") {
      const data = result as Awaited<ReturnType<typeof readCloudTaskModules>>;
      printTitle("Task modules");
      printTable(
        [{ header: "ID" }, { header: "Name" }, { header: "Tasks" }],
        data.modules
          .filter((module) => action === "list" || data.moduleIds.includes(module.id))
          .map((module) => [module.id, module.name, String(module.taskCount)]),
      );
    } else
      printEnd(
        action === "delete" ? "Module deleted. All tasks were retained." : "Saved to Cloud.",
      );
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
        `tasks modules ${action}`,
        "Read the same scope after an uncertain write; do not blindly repeat it.",
      );
  }
}
export function registerCloudTaskModuleCommands(tasks: Command) {
  const modules = tasks
    .command("modules")
    .description("Manage custom modules; a task can belong to multiple modules");
  const scope = (command: Command) =>
    command
      .option("--project <id>", "Local workspace ID")
      .option("--team <id>", "Linked collaboration project")
      .option("--personal", "Use your workspace")
      .option("--json", "Output JSON");
  scope(modules.command("list")).action((options) => cloudTaskModulesCommand("list", options));
  scope(modules.command("create").requiredOption("--name <text>", "Module name")).action(
    (options) => cloudTaskModulesCommand("create", options),
  );
  scope(modules.command("update <moduleId>").requiredOption("--name <text>", "New module name"))
    .option("--expected-updated-at <timestamp>", "Version from modules list")
    .action((id, options) => cloudTaskModulesCommand("update", options, id));
  scope(modules.command("delete <moduleId>"))
    .option("--expected-updated-at <timestamp>", "Version from modules list")
    .action((id, options) => cloudTaskModulesCommand("delete", options, id));
  for (const action of ["show", "set", "add", "remove", "clear"] as const) {
    const command = modules
      .command(`${action} <taskId>`)
      .description(`${action} a task's module memberships`)
      .option("--json", "Output JSON");
    if (action !== "show")
      command.option("--expected-updated-at <timestamp>", "Task version from modules show");
    if (["set", "add", "remove"].includes(action))
      command.requiredOption(
        "--module <id>",
        "Module ID; repeat for multiple modules",
        (value: string, previous: string[]) => [...previous, value],
        [],
      );
    command.action((id, options) => cloudTaskModulesCommand(action, options, id));
  }
}
