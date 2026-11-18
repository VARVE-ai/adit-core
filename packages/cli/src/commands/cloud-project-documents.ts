import { basename } from "node:path";
import { open } from "node:fs/promises";
import { Command } from "commander";
import {
  CloudApiError,
  CloudClient,
  loadCredentials,
  uploadCloudProjectDocument,
} from "@varveai/adit-cloud";
import { loadProjectContext } from "./project-context.js";
import { NotLoggedInError, describeFailure, failureDetails } from "./cloud-read-output.js";
import { printError, printEnd, printRows, printTitle } from "./cli-style.js";

const MAX_DOCUMENT_CHARS = 2_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Options = {
  file: string;
  project?: string;
  team?: string;
  personal?: boolean;
  sourcePath?: string;
  displayName?: string;
  folderId?: string;
  replace?: string;
  json?: boolean;
};

async function readMarkdown(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`File must be a regular file: ${path}`);
    const bytes = Buffer.alloc(MAX_DOCUMENT_CHARS * 4 + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total));
    if (content.length > MAX_DOCUMENT_CHARS)
      throw new Error(`Markdown content must be at most ${MAX_DOCUMENT_CHARS.toLocaleString()} characters`);
    if (total === bytes.length)
      throw new Error(`File is too large to upload (maximum ${MAX_DOCUMENT_CHARS.toLocaleString()} characters)`);
    return content;
  } finally {
    await handle.close();
  }
}

export async function cloudProjectDocumentUploadCommand(options: Options): Promise<void> {
  try {
    if (!options.file.trim()) throw new Error("--file is required");
    if (!options.file.toLowerCase().endsWith(".md"))
      throw new Error("Only Markdown (.md) project documents are supported");
    if (options.team && options.personal) throw new Error("Select either --team or --personal");
    if (options.replace && !UUID.test(options.replace))
      throw new Error("--replace must be a document UUID");
    if (options.folderId && !UUID.test(options.folderId))
      throw new Error("--folder-id must be a directory UUID");
    if (options.displayName !== undefined && (!options.displayName.trim() || options.displayName.length > 255))
      throw new Error("--display-name must contain 1-255 characters");
    if (options.sourcePath !== undefined && !options.sourcePath.trim())
      throw new Error("--source-path must not be empty");
    if (options.team && options.sourcePath)
      throw new Error("--source-path is only available for personal project documents");

    const credentials = loadCredentials();
    if (!credentials) throw new NotLoggedInError();
    const destination = documentDestination(options);

    const content = await readMarkdown(options.file);
    const fileName = basename(options.file);
    const client = new CloudClient(credentials.serverUrl, credentials, {
      maxRetries: 0,
    });
    const result = await uploadCloudProjectDocument(client, {
      projectId: destination.localProjectId,
      scope: destination.scope,
      teamId: destination.teamId,
      fileName,
      content,
      ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
      ...(options.displayName ? { displayName: options.displayName.trim() } : {}),
      ...(options.folderId ? { folderId: options.folderId } : {}),
      ...(options.replace ? { replaceDocId: options.replace } : {}),
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const document = result.projectDocument as { id?: string; displayName?: string; fileName?: string; teamId?: string | null; projectId?: string | null };
    printTitle("Project document", document.id ?? "", document.displayName ?? document.fileName ?? fileName);
    printRows([
      { label: "Status", value: result.status },
      ...(result.versionNumber ? [{ label: "Version", value: String(result.versionNumber) }] : []),
      { label: "Scope", value: document.teamId ? `team ${document.teamId}` : `project ${document.projectId ?? destination.localProjectId}` },
    ]);
    printEnd("Project document uploaded");
  } catch (error) {
    const failure = describeFailure(error);
    const context = error instanceof CloudApiError ? failureDetails(error) : {};
    if (options.json)
      console.log(JSON.stringify({ ...context, ok: false, error: failure.message, status: failure.status, code: failure.code }, null, 2));
    else printError("Project document upload failed", failure.message);
    process.exitCode = 1;
  }
}

export function registerCloudProjectDocumentCommands(cloud: Command): void {
  const documents = cloud
    .command("project-documents")
    .description("Upload documents to a Cloud project document library");
  documents
    .command("upload")
    .requiredOption("--file <path>", "Markdown file to upload")
    .option("--project <id>", "Local workspace ID used to resolve the upload scope")
    .option("--team <id>", "Collaboration team ID")
    .option("--personal", "Upload to the personal project resolved from this workspace")
    .option("--source-path <path>", "Stable source path used to update the same document")
    .option("--display-name <name>", "Document name shown in the library")
    .option("--folder-id <id>", "Existing project document directory ID")
    .option("--replace <documentId>", "Replace an existing document by creating a new version")
    .option("--json", "Output JSON")
    .action((options: Options) => cloudProjectDocumentUploadCommand(options));

  const scoped = (command: Command) => command
    .option("--project <id>", "Local workspace ID")
    .option("--team <id>", "Collaboration team ID")
    .option("--personal", "Use the personal project")
    .option("--json", "Output JSON");
  scoped(documents.command("list").description("List your documents and their directory IDs"))
    .action(options => documentDirectoryCommand("documents", options));
  const folders = documents.command("folders").description("Manage project document directories");
  scoped(folders.command("list").description("List directories"))
    .action(options => documentDirectoryCommand("folders", options));
  scoped(folders.command("create").description("Create a directory").requiredOption("--name <name>", "Directory name"))
    .action(options => documentDirectoryCommand("create", options));
  scoped(documents.command("move <documentId>").description("Move a document to a directory or back to the root")
    .option("--folder-id <id>", "Destination directory UUID")
    .option("--root", "Move back to the root directory"))
    .action((documentId, options) => documentDirectoryCommand("move", { ...options, documentId }));
}

type DirectoryOptions = Pick<Options, "project" | "team" | "personal" | "json" | "folderId"> & {
  name?: string; root?: boolean; documentId?: string;
};

export async function documentDirectoryCommand(operation: "documents" | "folders" | "create" | "move", options: DirectoryOptions): Promise<void> {
  try {
    if (options.team && options.personal) throw new Error("Select either --team or --personal");
    if (operation === "create" && (!options.name?.trim() || options.name.trim().length > 100)) throw new Error("--name must contain 1-100 characters");
    if (operation === "move") {
      if (!options.documentId || !UUID.test(options.documentId)) throw new Error("documentId must be a document UUID");
      if (Boolean(options.root) === Boolean(options.folderId)) throw new Error("Select exactly one of --folder-id <id> or --root");
      if (options.folderId && !UUID.test(options.folderId)) throw new Error("--folder-id must be a directory UUID");
    }
    const credentials = loadCredentials();
    if (!credentials) throw new NotLoggedInError();
    const scope = documentDestination(options);
    const client = new CloudClient(credentials.serverUrl, credentials, { maxRetries: 0 });
    const base = "/api/cli/project-documents";
    const result = operation === "create"
      ? await client.post(`${base}/folders`, { ...scope, name: options.name!.trim() })
      : operation === "move"
        ? await client.post(`${base}/move`, { ...scope, documentId: options.documentId, folderId: options.root ? null : options.folderId })
        : await client.get(`${base}${operation === "folders" ? "/folders" : ""}?${new URLSearchParams(Object.entries(scope).filter((entry): entry is [string, string] => typeof entry[1] === "string"))}`);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      const data = result as { folders?: { id: string; name: string }[]; folder?: { id: string; name: string }; projectDocuments?: { id: string; displayName: string; folderId: string | null }[]; projectDocument?: { id: string; folderId: string | null } };
      if (data.folders) for (const folder of data.folders) printTitle("Directory", folder.id, folder.name);
      if (data.folder) printTitle("Directory created", data.folder.id, data.folder.name);
      if (data.projectDocuments) for (const doc of data.projectDocuments) { printTitle("Document", doc.id, doc.displayName); printRows([{ label: "Directory", value: doc.folderId ?? "root" }]); }
      if (data.projectDocument) printRows([{ label: "Document", value: data.projectDocument.id }, { label: "Directory", value: data.projectDocument.folderId ?? "root" }]);
      printEnd(operation === "move" ? "Document moved" : "Done");
    }
  } catch (error) {
    const failure = describeFailure(error);
    if (options.json) console.log(JSON.stringify({ ...(error instanceof CloudApiError ? failureDetails(error) : {}), ok: false, error: failure.message, status: failure.status, code: failure.code }, null, 2));
    else printError("Project document directory operation failed", failure.message);
    process.exitCode = 1;
  }
}


export function documentDestination(options: { team?: string; personal?: boolean; project?: string }): { localProjectId?: string; teamId?: string; scope: "team" | "personal" } {
  if (options.team) {
    if (options.personal || options.project) throw new Error("Select either --team or a personal workspace, not both");
    if (!UUID.test(options.team)) throw new Error("--team must be a team UUID");
    return { teamId: options.team, scope: "team" };
  }
  if (!options.personal && !options.project) throw new Error("Choose the destination first: --team <id> or --personal [--project <localProjectId>]");
  const localProjectId = options.project ?? loadProjectContext("adit cloud project-documents")?.projectId;
  if (!localProjectId?.trim()) throw new Error("Select a personal workspace with --project <localProjectId> or run --personal from an initialized workspace");
  return { localProjectId, scope: "personal" };
}
