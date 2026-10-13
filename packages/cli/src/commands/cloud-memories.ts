import { Command, Option } from "commander";
import { queryCloudMemories, type CloudMemoryQuery, type CloudMemoryResult } from "@varveai/adit-cloud";
import { requireCloudClient, reportFailure } from "./cloud-read-output.js";
import { loadInitializedProjectConfig } from "./project-initialization.js";

type Options = { scope?: string; project?: string; version?: string; offset?: string; limit?: string; json?: boolean };
export function memoryQueryOptions(action: CloudMemoryQuery["action"], options: Options, value?: string): CloudMemoryQuery {
  if (options.scope !== "personal" && options.scope !== "project") throw new Error("Choose --scope personal or --scope project.");
  if (options.scope === "personal" && options.project) throw new Error("Personal memory does not take --project.");
  let project = options.project;
  if (options.scope === "project" && !project) {
    project = loadInitializedProjectConfig("adit cloud memories")?.projectId;
    if (!project) throw new Error("Initialize this project or provide --project <id>.");
  }
  const number = (name: "version" | "offset" | "limit", min: number, max = Number.MAX_SAFE_INTEGER) => {
    const raw = options[name];
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid --${name}.`);
    return n;
  };
  return { scope: options.scope, project, action, q: action === "search" ? value : undefined,
    entry: action === "evidence" ? value : undefined, version: number("version", 1), offset: number("offset", 0), limit: number("limit", 1, 100) };
}

export function printMemoryResult(result: CloudMemoryResult) {
  const name = result.scope === "personal" ? "Personal memory" : `Project memory: ${result.project?.name ?? result.project?.localProjectId}`;
  console.log(name);
  if (result.document) {
    console.log(`<!-- adit-memory:${result.document.id}@${result.document.version}; reference-only -->`);
    console.log(result.document.markdown);
    if (result.entries?.length) console.log("Entry IDs:\n" + result.entries.map(e => `${e.id}  ${e.topic}  [${e.status}]`).join("\n"));
  } else if (result.document === null) console.log("No memory has been generated yet.");
  if (result.entries && !result.document) for (const entry of result.entries) console.log(`${entry.id}  [${entry.status}] ${entry.content}`);
  for (const revision of result.history ?? []) {
    console.log(`Version ${revision.version}  ${revision.createdAt}  ${revision.model ?? ""}`);
    if (revision.markdown !== undefined) {
      console.log("Previous Markdown:\n" + revision.previousMarkdown);
      console.log("Markdown:\n" + revision.markdown);
      console.log("Changes and evidence:\n" + JSON.stringify(revision.changes, null, 2));
    }
  }
  if (result.entry) console.log(`${result.entry.id}  [${result.entry.status}] ${result.entry.content}\n${result.entry.reason}`);
  for (const evidence of result.evidence ?? []) console.log(`${evidence.sessionId} / ${evidence.eventId} [${evidence.relation}]\n${evidence.available ? evidence.quote : "Source unavailable"}`);
  if (result.nextOffset !== null && result.nextOffset !== undefined) console.log(`More results: repeat with --offset ${result.nextOffset}`);
}

export async function cloudMemoriesCommand(action: CloudMemoryQuery["action"], options: Options, value?: string) {
  try {
    const query = memoryQueryOptions(action, options, value);
    const result = await queryCloudMemories(requireCloudClient(), query);
    if (options.json) console.log(JSON.stringify(result)); else printMemoryResult(result);
  } catch (error) { reportFailure(error, options, `adit cloud memories ${action}`); }
}

export function registerCloudMemoryCommands(cloud: Command) {
  const memories = cloud.command("memories").description("Query personal facts and project standards, revisions and original evidence");
  const withScope = (command: Command) => command
    .addOption(new Option("--scope <scope>", "Memory scope").choices(["personal", "project"]).makeOptionMandatory())
    .option("--project <id>", "Project ID; project scope defaults to this initialized project")
    .option("--json", "Output JSON");
  const withPage = (command: Command) => command.option("--offset <number>", "Result offset").option("--limit <number>", "Page size, 1-100");
  withScope(memories.command("show").description("Read the current Markdown or a specific version")).option("--version <number>", "Exact Markdown version")
    .action(options => cloudMemoriesCommand("show", options));
  withPage(withScope(memories.command("search <query>").description("Search published memories within the selected scope")))
    .action((query, options) => cloudMemoriesCommand("search", options, query));
  withPage(withScope(memories.command("history").description("Read revisions, or the diff and evidence for a version"))).option("--version <number>", "Revision with before/after Markdown and evidence")
    .action(options => cloudMemoriesCommand("history", options));
  withPage(withScope(memories.command("evidence <entryId>").description("Read the original Session/Event evidence for a memory")))
    .action((entryId, options) => cloudMemoriesCommand("evidence", options, entryId));
}
