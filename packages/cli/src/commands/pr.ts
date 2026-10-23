import { Command } from "commander";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { canonicalDirectory, type PrDescription, type PrOptions } from "@varveai/adit-core";
import { startDaemon, openBrowser } from "../local/daemon.js";
const exec = promisify(execFile);

async function copy(text: string) {
  const command = process.platform === "win32" ? "powershell.exe" : process.platform === "darwin" ? "pbcopy" : "xclip";
  const args = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"] : process.platform === "darwin" ? [] : ["-selection", "clipboard"];
  await new Promise<void>((resolveCopy, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject); child.on("close", code => code === 0 ? resolveCopy() : reject(new Error("Clipboard unavailable; use --output or --json"))); child.stdin.end(text);
  });
}
export function registerPrCommand(program: Command) {
  program.command("pr").description("Generate an AI usage disclosure from local commits and sessions")
    .option("--repo <path>", "Repository path (defaults to the current Git repository)")
    .option("--base <ref>", "Target branch").option("--head <ref>", "Source branch")
    .option("--commit <sha>", "Explicit commit SHA; repeat for each commit", (value: string, previous: string[]) => [...previous, value], [])
    .option("--detail <format>", "brief, detailed, or project-template", "detailed")
    .option("--language <language>", "en or zh", "en").option("--template <path>", "Local Markdown project template")
    .option("--title <text>", "Description title").option("--no-sessions", "Omit per-commit conversation numbers")
    .option("--no-lines", "Omit line statistics").option("--no-assisted-by", "Omit Assisted-by lines")
    .option("--prompts", "Include sanitized prompts associated with this range")
    .option("--share-links", "Include already published session links")
    .option("--no-adit-label", "Omit the ADIT label").option("--json", "Return structured JSON without interaction")
    .option("--output <path>", "Write Markdown to this file").action(async (args) => {
      try { await prCommand(args); }
      catch (error) { const message = error instanceof Error ? error.message : "Description generation failed"; if (args.json) console.log(JSON.stringify({ ok: false, error: message })); else console.error(message); process.exitCode = 1; }
    });
}
export async function prCommand(args: Record<string, any>) {
  const explicit = Array.isArray(args.commit) && args.commit.length > 0;
  if (explicit ? args.base || args.head : !args.base || !args.head) throw new Error("Provide --base and --head, or one or more --commit values");
  const repository = canonicalDirectory(args.repo || (await exec("git", ["rev-parse", "--show-toplevel"], { windowsHide: true })).stdout.trim());
  const daemon = await startDaemon();
  const request = async <T = any>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${daemon.url}/api/local${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as any;
    if (!response.ok) throw new Error(value.error || `Local service returned ${response.status}`);
    return value;
  };
  const project = await request(`/projects/resolve?path=${encodeURIComponent(repository)}&repository=1`);
  if (project.source !== "registry") throw new Error("Add this repository to a local workspace and collect it first");
  const workspaceId = project.projectId;
  const options: PrOptions = { detail: args.detail, language: args.language, sessions: args.sessions !== false, lines: args.lines !== false,
    assistedBy: args.assistedBy !== false, prompts: !!args.prompts, shareLinks: !!args.shareLinks, aditLabel: args.aditLabel !== false,
    ...(args.template ? { template: resolve(args.template) } : {}), ...(args.title ? { title: args.title } : {}) };
  const resolved = await request("/pr-scopes/resolve", { workspaceId, repository, ...(explicit ? { commits: args.commit } : { base: args.base, head: args.head }) });
  const generate = async () => {
    const job = await request("/pr-descriptions", { workspaceId, scopeId: resolved.scopeId, options, idempotencyKey: randomUUID() });
    for (;;) {
      const status = await request(`/pr-description-jobs/${job.jobId}?workspaceId=${workspaceId}`);
      if (status.status === "failed") throw new Error(status.error);
      if (status.status === "done") return status.result as PrDescription;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  };
  let result = await generate();
  const localUrl = `${daemon.url}/pr/${workspaceId}?id=${result.id}`;
  if (args.output) await writeFile(resolve(args.output), result.markdown, "utf8");
  if (args.json) { console.log(JSON.stringify({ ok: true, schemaVersion: 1, ...result, localUrl }, null, 2)); return; }
  if (!process.stdin.isTTY || !process.stdout.isTTY || args.output) { console.log(args.output ? `Markdown saved: ${resolve(args.output)}` : result.markdown); return; }
  console.log(`${result.title}\n${result.summary.commits} commits · ${result.summary.sessions} unique conversations · ${result.summary.unmatched} unmatched commits`);
  if (result.summary.lines) {
    const l = result.summary.lines;
    console.log(`${l.eligible.toLocaleString()} eligible added lines, summed across commits\n${l.eligible ? ((l.certain + l.likely + l.possible) / l.eligible * 100).toFixed(1) : "—"}% matched session content · ${l.unknown} not traced · ${l.moved} copied or moved`);
  }
  console.log(`Excluded: ${result.summary.excludedMerges} merge commits, ${result.summary.excludedAuthors} other-author commits\nWhole-session totals: ${result.summary.prompts ?? "unknown"} prompts · ${result.summary.duration === null ? "unknown time" : Math.round(result.summary.duration / 60000) + " min"}; may include work outside this range\nMarkdown ready: ${options.detail} · ${options.language}`);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const action = (await terminal.question("[enter] copy description   [o] adjust in the local page   [n] no ADIT badge   [q] quit\n")).trim().toLowerCase();
    if (action === "o") {
      const params = new URLSearchParams({ repository, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])) });
      if (explicit) for (const sha of args.commit) params.append("commit", sha); else { params.set("head", args.head); params.set("base", args.base); }
      openBrowser(`${daemon.url}/pr-create/${workspaceId}?${params}`);
    } else if (action === "n") { options.aditLabel = false; result = await generate(); await copy(result.markdown); console.log("Copied without the ADIT label."); }
    else if (!action) { await copy(result.markdown); console.log("Copied."); }
  } finally { terminal.close(); }
}
