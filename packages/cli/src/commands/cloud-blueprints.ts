import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { Command } from "commander";
import {
  CloudClient,
  CloudApiError,
  loadCredentials,
  uploadCloudBlueprint,
  uploadCloudBlueprintAttachment,
  listCloudBlueprints,
  type CloudBlueprintAttachment,
  type CloudBlueprintInput,
} from "@varveai/adit-cloud";
import { loadProjectContext } from "./project-context.js";
import { NotLoggedInError, describeFailure } from "./cloud-read-output.js";
import { printTitle, printRows, printEnd, printError } from "./cli-style.js";
import { prepareTaskAttachments, type PreparedTaskAttachment } from "./cloud-task-attachments.js";

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
  const combined = attachments;
  if (combined.length > 20)
    throw new Error(
      "A blueprint supports at most 20 inline text attachments. Use --file for up to 50 files.",
    );
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
    const files = await prepareTaskAttachments(options.file, [], { allowJson: true });
    if ((manifest.attachments?.length ?? 0) + files.length > 50)
      throw new Error("A blueprint supports at most 50 attachments.");
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
    const uploaded = await uploadBlueprintFiles(client, result.blueprint.id, files);
    result.attachments = [
      ...new Map(
        [...result.attachments, ...uploaded.attachments].map((attachment) => [
          attachment.id,
          attachment,
        ]),
      ).values(),
    ];
    if (!uploaded.ok) {
      if (options.json)
        console.log(
          JSON.stringify(
            {
              ...result,
              ...uploaded,
              attachments: result.attachments,
              blueprintCreated: true,
              clientRequestId,
            },
            null,
            2,
          ),
        );
      else
        printError("Blueprint attachment upload failed", `${uploaded.error}\n${uploaded.recovery}`);
      process.exitCode = 1;
      return;
    }
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
  const blueprints = cloud
    .command("blueprints")
    .description("Create or upload requirement blueprints to Cloud");
  blueprints
    .command("upload")
    .requiredOption(
      "--input <path>",
      "Blueprint JSON: title required; baseIntent, modules, tasks, attachments optional",
    )
    .option(
      "--file <path>",
      "Attach MD/TXT/JSON/DOCX/PDF/HTML/HTM/XLSX/CSV or PNG/JPG/JPEG/WebP/GIF; repeat for files",
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
  blueprints
    .command("attach <blueprintId>")
    .requiredOption(
      "--file <path>",
      "Attach documents or images; repeat for multiple files",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--json", "Output JSON")
    .action(async (blueprintId: string, options: { file: string[]; json?: boolean }) => {
      try {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(blueprintId))
          throw new Error("Blueprint ID must be a UUID.");
        const files = await prepareTaskAttachments(options.file, [], { allowJson: true });
        const credentials = loadCredentials();
        if (!credentials) throw new NotLoggedInError();
        const result = await uploadBlueprintFiles(
          new CloudClient(credentials.serverUrl, credentials, { maxRetries: 0 }),
          blueprintId,
          files,
        );
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else if (result.ok)
          printEnd(
            `Uploaded ${result.attachments.length} attachments to blueprint ${blueprintId}.`,
          );
        else
          printError("Blueprint attachment upload failed", `${result.error}\n${result.recovery}`);
        if (!result.ok) process.exitCode = 1;
      } catch (error) {
        const failure = describeFailure(error);
        if (options.json)
          console.log(
            JSON.stringify({
              ok: false,
              blueprintId,
              error: failure.message,
              status: failure.status,
              code: failure.code,
            }),
          );
        else printError("Blueprint attachment upload failed", failure.message);
        process.exitCode = 1;
      }
    });
  blueprints
    .command("list")
    .option("--project <id>", "Local workspace ID")
    .option("--team <id>", "Linked collaboration project")
    .option("--personal", "Use your workspace")
    .option("--offset <number>", "Pagination offset", "0")
    .option("--limit <number>", "Page size (1-100)", "50")
    .option("--json", "Output JSON")
    .action(async (options) => {
      try {
        if (options.team && options.personal) throw new Error("Select either --team or --personal");
        const localProjectId =
          options.project ?? loadProjectContext("adit cloud blueprints list")?.projectId;
        if (!localProjectId) throw new Error("Select a workspace with --project.");
        const credentials = loadCredentials();
        if (!credentials) throw new NotLoggedInError();
        const query = new URLSearchParams({
          localProjectId,
          offset: options.offset,
          limit: options.limit,
        });
        if (options.team) query.set("teamId", options.team);
        if (options.personal) query.set("scope", "personal");
        const result = await listCloudBlueprints(
          new CloudClient(credentials.serverUrl, credentials, { maxRetries: 0 }),
          query,
        );
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else {
          for (const item of result.blueprints) printTitle("Blueprint", item.id, item.title);
          printEnd(`Total: ${result.total}. Next offset: ${result.nextOffset ?? "none"}`);
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
            }),
          );
        else printError("Blueprint list failed", failure.message);
        process.exitCode = 1;
      }
    });
}

async function uploadBlueprintFiles(
  client: CloudClient,
  blueprintId: string,
  files: PreparedTaskAttachment[],
) {
  const attachments: CloudBlueprintAttachment[] = [];
  for (let index = 0; index < files.length; index++) {
    try {
      const { attachment } = await uploadCloudBlueprintAttachment(
        client,
        blueprintId,
        files[index].file,
      );
      attachments.push(attachment);
    } catch (error) {
      const failure = describeFailure(error);
      return {
        ok: false as const,
        blueprintId,
        attachments,
        failedFile: files[index].path,
        pendingFiles: files.slice(index).map((file) => file.path),
        error: failure.message,
        status: failure.status,
        code: failure.code ?? "BLUEPRINT_ATTACHMENT_UPLOAD_FAILED",
        recovery: `The blueprint exists. Retry only pending files with adit cloud blueprints attach ${blueprintId} --file <path>. Identical uploads are deduplicated. Do not recreate the blueprint.`,
      };
    }
  }
  return { ok: true as const, blueprintId, attachments };
}
