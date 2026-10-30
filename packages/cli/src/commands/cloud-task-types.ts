import { Command } from "commander";
import {
  CloudClient,
  CloudApiError,
  loadCredentials,
  listCloudTaskTypes,
  createCloudTaskType,
  updateCloudTaskType,
  deleteCloudTaskType,
  taskTypeNameKey,
} from "@varveai/adit-cloud";
import { loadProjectContext } from "./project-context.js";
import { NotLoggedInError, describeFailure, reportFailure } from "./cloud-read-output.js";
import { printTitle, printTable, printEnd } from "./cli-style.js";

type Options = {
  project?: string;
  team?: string;
  personal?: boolean;
  json?: boolean;
  name?: string;
  color?: string;
  expectedUpdatedAt?: string;
};

export function validateTaskTypeName(value: string): string {
  const name = value.trim();
  if (
    !name ||
    name.length > 100 ||
    Array.from(name).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    ["unclassified", "未分类"].includes(taskTypeNameKey(name))
  )
    throw new Error("Type name must contain 1-100 characters; use --clear-type for Unclassified");
  return name;
}

export async function cloudTaskTypesCommand(
  action: "list" | "create" | "update" | "delete",
  options: Options,
  currentName?: string,
) {
  try {
    if (options.team && options.personal) throw new Error("Select either --team or --personal");
    const name = options.name === undefined ? undefined : validateTaskTypeName(options.name);
    if (options.color !== undefined && !/^#[0-9a-f]{6}$/i.test(options.color))
      throw new Error("Color must be a six-digit hex value, such as #3B82F6");
    if (action === "create" && !name) throw new Error("Provide --name");
    if (action === "update" && name === undefined && options.color === undefined)
      throw new Error("Provide --name or --color");
    const credentials = loadCredentials();
    if (!credentials) throw new NotLoggedInError();
    const localProjectId =
      options.project ?? loadProjectContext("adit cloud tasks types")?.projectId;
    if (!localProjectId)
      throw new Error("Add this working directory in Settings or provide an explicit workspace ID.");
    const client = new CloudClient(credentials.serverUrl, credentials, {
      maxRetries: action === "list" ? 2 : 0,
    });
    const scope = {
      localProjectId,
      teamId: options.team,
      scope: options.personal ? ("personal" as const) : undefined,
    };
    const catalog = await listCloudTaskTypes(client, scope);
    let result: unknown = catalog;
    if (action === "create")
      result = await createCloudTaskType(client, scope, { name: name!, color: options.color });
    else if (action !== "list") {
      const option = catalog.options.find(
        (option) => taskTypeNameKey(option.name) === taskTypeNameKey(currentName ?? ""),
      );
      if (!option)
        throw new Error("Type not found in this scope. List current types before updating.");
      const expectedUpdatedAt = options.expectedUpdatedAt ?? option.updatedAt;
      result =
        action === "delete"
          ? await deleteCloudTaskType(client, scope, option.id, expectedUpdatedAt)
          : await updateCloudTaskType(client, scope, option.id, {
              name,
              color: options.color,
              expectedUpdatedAt,
            });
    }
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if (action === "list") {
      printTitle("Task types", catalog.scope.teamId ? "collaboration project" : "workspace");
      printTable(
        [{ header: "name" }, { header: "color" }],
        catalog.options.map((option) => [option.name, option.color]),
      );
      printEnd(
        "Names and colors are saved on tasks. Managing options never changes existing tasks.",
      );
    } else {
      printTitle("Task types");
      printEnd(
        action === "delete"
          ? "Option removed. Existing task names and colors are unchanged."
          : "Option saved. Existing task names and colors are unchanged.",
      );
    }
  } catch (error) {
    if (options.json) {
      const failure = describeFailure(error);
      const message =
        failure.status === 404
          ? `${failure.message} Check the selected workspace/collaboration project; an older Cloud may need upgrading for task types.`
          : failure.message;
      const context =
        error instanceof CloudApiError && error.body && typeof error.body === "object"
          ? error.body
          : {};
      console.log(
        JSON.stringify({
          ...context,
          ok: false,
          error: message,
          status: failure.status,
          code: failure.code,
        }),
      );
      process.exitCode = 1;
    } else
      reportFailure(
        error,
        options,
        `tasks types ${action}`,
        "Check the current workspace/collaboration project; a missing endpoint may require a Cloud upgrade. Do not blindly retry writes.",
      );
  }
}

export function registerCloudTaskTypeCommands(tasks: Command) {
  const types = tasks
    .command("types")
    .description("Manage type names and colors; existing tasks keep their snapshots");
  const scopeOptions = (command: Command) =>
    command
      .option("--team <id>", "Select a collaboration project linked to this workspace's repositories")
      .option("--project <id>", "Explicit local workspace ID")
      .option("--personal", "Use your workspace")
      .option("--json", "Output JSON");
  scopeOptions(types.command("list")).action((options) => cloudTaskTypesCommand("list", options));
  scopeOptions(
    types
      .command("create")
      .requiredOption("--name <text>", "Type name")
      .option("--color <hex>", "Six-digit hex color"),
  ).action((options) => cloudTaskTypesCommand("create", options));
  scopeOptions(
    types
      .command("update <name>")
      .option("--name <text>", "New name")
      .option("--color <hex>", "New color")
      .option("--expected-updated-at <timestamp>", "Reject a stale option update"),
  ).action((name, options) => cloudTaskTypesCommand("update", options, name));
  scopeOptions(
    types
      .command("delete <name>")
      .description("Remove a choice; do not change existing tasks")
      .option("--expected-updated-at <timestamp>", "Reject a stale removal"),
  ).action((name, options) => cloudTaskTypesCommand("delete", options, name));
}
