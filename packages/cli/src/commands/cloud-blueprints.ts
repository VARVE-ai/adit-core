import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { Command } from "commander";
import {
  CloudClient,
  CloudApiError,
  loadCredentials,
  uploadCloudBlueprint,
  type CloudBlueprintInput,
} from "@varveai/adit-cloud";
import { loadProjectContext } from "./project-context.js";
import { NotLoggedInError, describeFailure } from "./cloud-read-output.js";
import { printTitle, printRows, printEnd, printError } from "./cli-style.js";

type Options = {
  input: string;
  file?: string[];
  project?: string;
  team?: string;
  personal?: boolean;
  json?: boolean;
  requestId?: string;
};
async function readText(path: string, max: number) {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max)
      throw new Error(`File must be a regular file of at most ${max} bytes: ${path}`);
    const bytes = Buffer.alloc(max + 1);
    let total = 0;
    while (total <= max) {
      const { bytesRead } = await handle.read(bytes, total, max + 1 - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > max) throw new Error(`File exceeds ${max} bytes: ${path}`);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total));
  } finally {
    await handle.close();
  }
}
export async function prepareBlueprintInput(
  options: Options,
): Promise<Omit<CloudBlueprintInput, "localProjectId">> {
  const raw: unknown = JSON.parse(await readText(options.input, 25 * 1024 * 1024));
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Blueprint input must be a JSON object.");
  const manifest = raw as Record<string, unknown>;
  const allowed = ["title", "baseIntent", "modules", "tasks", "attachments"];
  if (Object.keys(manifest).some((key) => !allowed.includes(key)))
    throw new Error(
      "Blueprint JSON accepts only title, baseIntent, modules, tasks and attachments. Select project/team with command options.",
    );
  if (
    typeof manifest.title !== "string" ||
    !manifest.title.trim() ||
    manifest.title.trim().length > 200
  )
    throw new Error("Blueprint title must contain 1-200 characters.");
  const attachments = manifest.attachments ?? [];
  if (!Array.isArray(attachments)) throw new Error("attachments must be an array.");
  const files: Array<{ displayName: string; contentText: string }> = [];
  for (const path of options.file ?? []) {
    const displayName = basename(path);
    if (!/\.(md|txt|json)$/i.test(displayName))
      throw new Error("Blueprint attachments support MD, TXT and JSON UTF-8 text files.");
    files.push({ displayName, contentText: await readText(path, 1000000) });
  }
  const combined = [...attachments, ...files];
  if (combined.length > 20) throw new Error("A blueprint supports at most 20 attachments.");
  let size = 0;
  for (const value of combined) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.displayName !== "string" ||
      !/^[^\\/]+\.(md|txt|json)$/i.test(value.displayName) ||
      [...value.displayName].some((char) => char.charCodeAt(0) < 32) ||
      value.displayName.length > 200 ||
      typeof value.contentText !== "string" ||
      value.contentText.length > 1000000
    )
      throw new Error("Invalid blueprint text attachment.");
    size += Buffer.byteLength(value.contentText, "utf8");
  }
  if (size > 5 * 1024 * 1024)
    throw new Error("Blueprint attachment content must not exceed 5 MiB.");
  return { ...manifest, title: manifest.title.trim(), attachments: combined } as Omit<
    CloudBlueprintInput,
    "localProjectId"
  >;
}
export async function cloudBlueprintUploadCommand(options: Options) {
  const clientRequestId = options.requestId ?? randomUUID();
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientRequestId))
      throw new Error("--request-id must be a UUID.");
    if (options.team && options.personal) throw new Error("Select either --team or --personal");
    const manifest = await prepareBlueprintInput(options);
    const credentials = loadCredentials();
    if (!credentials) throw new NotLoggedInError();
    const localProjectId =
      options.project ?? loadProjectContext("adit cloud blueprints upload")?.projectId;
    if (!localProjectId)
      throw new Error(
        "Add this working directory in Settings or provide an explicit workspace ID.",
      );
    const client = new CloudClient(credentials.serverUrl, credentials, { maxRetries: 0 });
    const result = await uploadCloudBlueprint(client, {
      ...manifest,
      localProjectId,
      teamId: options.team,
      scope: options.personal ? "personal" : undefined,
      clientRequestId,
    });
    if (options.json) console.log(JSON.stringify({ ...result, clientRequestId }, null, 2));
    else {
      printTitle("Blueprint", result.blueprint.id, result.blueprint.title);
      printRows([
        { label: "Tasks", value: String(result.tasks.length) },
        { label: "Attachments", value: String(result.attachments.length) },
        { label: "Request ID", value: clientRequestId },
      ]);
      printEnd(
        result.reused
          ? "Existing upload verified. No duplicate blueprint created."
          : "Blueprint uploaded to Cloud.",
      );
    }
  } catch (error) {
    const failure = describeFailure(error);
    const context =
      error instanceof CloudApiError && error.body && typeof error.body === "object"
        ? error.body
        : {};
    if (options.json)
      console.log(
        JSON.stringify({
          ...context,
          ok: false,
          error: failure.message,
          status: failure.status,
          code: failure.code,
          clientRequestId,
        }),
      );
    else
      printError(
        "Blueprint upload failed",
        `${failure.message}\nRequest ID: ${clientRequestId}. For an uncertain upload, retry unchanged input and scope with --request-id ${clientRequestId}.`,
      );
    process.exitCode = 1;
  }
}
export function registerCloudBlueprintCommands(cloud: Command) {
  cloud
    .command("blueprints")
    .description("Upload locally prepared requirement blueprints to Cloud")
    .command("upload")
    .requiredOption(
      "--input <path>",
      "Blueprint JSON: title, baseIntent, modules, tasks, attachments",
    )
    .option(
      "--file <path>",
      "Attach a UTF-8 MD/TXT/JSON document; repeat for multiple files",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--project <id>", "Local workspace ID")
    .option("--team <id>", "Linked collaboration project")
    .option("--personal", "Use your workspace")
    .option(
      "--request-id <uuid>",
      "Reuse an upload request ID to safely verify an uncertain result",
    )
    .option("--json", "Output JSON")
    .action((options) => cloudBlueprintUploadCommand(options));
}
