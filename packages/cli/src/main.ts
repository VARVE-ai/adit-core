#!/usr/bin/env node

/**
 * ADIT CLI — AI Development Intent Tracker
 *
 * The main command-line interface for inspecting and managing
 * the ADIT timeline.
 */

import { Command, Option } from "commander";
import { localLoginStartupEnabled } from "@varveai/adit-core";
import { serveCommand, startDaemon, stopDaemon, daemonStatus } from "./local/daemon.js";
import { registerPrCommand } from "./commands/pr.js";
import { registerHistoryCommands } from "./commands/history.js";
import { initCommand } from "./commands/init.js";
import { listCommand } from "./commands/list.js";
import { showCommand } from "./commands/show.js";
import { searchCommand } from "./commands/search.js";
import {
  diffCommand,
  promptCommand,
  envCommand,
  envLatestCommand,
  envDiffCommand,
  envHistoryCommand,
} from "./commands/diff.js";
import { doctorCommand } from "./commands/doctor.js";
import { exportCommand, exportSessionCommand } from "./commands/export.js";
import { statusCommand } from "./commands/status.js";
import { configCommand } from "./commands/config.js";
import {
  pluginInstallCommand,
  pluginUninstallCommand,
  pluginListCommand,
  pluginValidateCommand,
} from "./commands/plugin.js";
import { projectUninstallCommand } from "./commands/project.js";
import {
  cloudLoginCommand,
  cloudLogoutCommand,
  cloudSyncCommand,
  cloudStatusCommand,
  cloudResetCredentialsCommand,
  cloudAuthTokenCommand,
} from "./commands/cloud.js";
import { registerCloudCliAgentCommands } from "./commands/cloud-cli-agent.js";
import { cloudClaudeCommand } from "./commands/cloud-claude.js";
import { cloudCodexCommand } from "./commands/cloud-codex.js";
import { registerCloudTaskCommands } from "./commands/cloud-tasks.js";
import { registerCloudHistoryCommands } from "./commands/cloud-history.js";
import { registerCloudMemoryCommands } from "./commands/cloud-memories.js";
import { registerCloudReportCommands } from "./commands/cloud-reports.js";
import { dbClearEventsCommand } from "./commands/db.js";
import { perfCommand, perfClearCommand } from "./commands/perf.js";
import { projectLinkCliHandler } from "./commands/project-link.js";
import { selfUpdateCommand } from "./commands/self-update.js";
import { isCliEntrypoint } from "./entrypoint.js";
import { launchTui } from "./tui/index.js";
import { withUpdateWarning } from "./update-check.js";
import { CLI_VERSION } from "./version.js";
import { dim, marks, outputStyle } from "./commands/cli-style.js";

/** Commander's own parse errors ("error: unknown option ...") in the shared failure shape. */
export function formatParseError(text: string): string {
  const [first = "", ...rest] = text.trimEnd().split("\n");
  const rail = outputStyle().rail;
  const head = `${marks.fail}${rail ? "  " : " "}${first.replace(/^error:\s*/u, "")}`;
  const details = rest.filter((line) => line.trim()).map((line) => `${rail ? `${dim("└")}  ` : "  "}${dim(line.trim())}`);
  return `${[head, ...details].join("\n")}\n`;
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("adit")
    .description("AI Development Intent Tracker — a flight recorder for AI-assisted development")
    .version(CLI_VERSION);
  // Subcommands such as memory history own their --version option.
  program.enablePositionalOptions();
  // Set before any subcommand exists so every subcommand inherits it.
  program.configureOutput({ outputError: (text, write) => write(formatParseError(text)) });
  configureTopLevelHelp(program);
  registerPrCommand(program);
  registerHistoryCommands(program);

  program.command("server").alias("serve").description("Open the local web UI, starting the background service if needed")
    .option("--port <port>", "Local port for a new daemon")
    .option("--no-browser", "Print the address without opening a browser")
    .action(serveCommand);
  const daemon = program.command("daemon").description("Manage the independent local collection service");
  daemon.command("start")
    .addOption(new Option("--on-login").hideHelp())
    .action(async (options) => {
      if (options.onLogin && !localLoginStartupEnabled()) return;
      console.log((await startDaemon()).url);
    });
  daemon.command("status").action(async () => { const s = await daemonStatus(); console.log(s ? `Running: ${s.url} (PID ${s.pid})` : "Stopped"); });
  daemon.command("stop").action(async () => { await stopDaemon(); console.log("Stopped"); });
  daemon.command("restart").action(async () => { await stopDaemon(); console.log((await startDaemon()).url); });

  program
    .command("init")
    .description("Initialize ADIT in the current project")
    .option(
      "-p, --platform <platform>",
      "Target platform (claude-code, opencode, cursor, codex, gemini)",
    )
    .option(
      "-f, --force",
      "Force reinstall hooks (removes existing ADIT hooks first)",
    )
    .option(
      "--single-repo",
      "Include only this Git repository (shortcut for --repos .)",
    )
    .option(
      "--multi-repo",
      "Include every child Git repository; on re-init also apply repository list changes without asking",
    )
    .option(
      "--repos <paths>",
      "Comma-separated repository paths to include (use . for this directory), e.g. --repos .,api,web",
    )
    .option(
      "--detach",
      "Deprecated alias: init always creates an independent project without changing its parent",
    )
    .option(
      "--absorb",
      "Unsupported legacy option; parent and child projects now remain independent",
    )
    .action(withUpdateWarning("init", (opts) =>
      initCommand({
        cwd: process.cwd(),
        platform: opts.platform,
        force: opts.force,
        singleRepo: opts.singleRepo,
        multiRepo: opts.multiRepo,
        repos: typeof opts.repos === "string"
          ? opts.repos.split(",").map((path: string) => path.trim()).filter(Boolean)
          : undefined,
        detach: opts.detach,
        absorb: opts.absorb,
      }),
    ));

  program
    .command("timeline")
    .aliases(["list", "ls"])
    .description("Show timeline entries")
    .option("-l, --limit <n>", "Number of entries to show", "20")
    .option("-a, --actor <actor>", "Filter by actor (assistant|user|tool)")
    .option("-t, --type <type>", "Filter by event type")
    .option("-q, --query <text>", "Search by text")
    .option("-e, --expand", "Show expanded summaries")
    .option(
      "-s, --sort <field>",
      "Sort by field: ACTOR or TIME (default: TIME)",
    )
    .option("--json", "Output as JSON")
    .action((opts) =>
      listCommand({
        limit: parseInt(opts.limit, 10),
        actor: opts.actor,
        type: opts.type,
        query: opts.query,
        expand: opts.expand,
        sort: opts.sort ? opts.sort.toUpperCase() : undefined,
        json: opts.json,
      }),
    );

  program
    .command("show <id>")
    .usage("<id>")
    .description("Show full event details")
    .action((id) => showCommand(id));

  // Search
  program
    .command("search <query>")
    .description("Search events by text")
    .option("-l, --limit <n>", "Max results", "20")
    .option("-a, --actor <actor>", "Filter by actor")
    .option("-t, --type <type>", "Filter by event type")
    .option("--from <date>", "Start date (ISO 8601)")
    .option("--to <date>", "End date (ISO 8601)")
    .option("--branch <branch>", "Filter by git branch")
    .option("--format <fmt>", "Output format (json)")
    .option("--json", "Output as JSON")
    .action((query, opts) =>
      searchCommand(query, {
        limit: parseInt(opts.limit, 10),
        actor: opts.actor,
        type: opts.type,
        from: opts.from,
        to: opts.to,
        branch: opts.branch,
        format: opts.format,
        json: opts.json,
      }),
    );

  program
    .command("prompt <id>")
    .description("Show prompt text for an event")
    .option("-m, --max-chars <n>", "Max characters to show")
    .option("-o, --offset <n>", "Character offset to start from")
    .action((id, opts) =>
      promptCommand(id, {
        maxChars: opts.maxChars ? parseInt(opts.maxChars, 10) : undefined,
        offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
      }),
    );

  program
    .command("status")
    .description("Show ADIT status for the current project")
    .option("--json", "Output as JSON")
    .action(withUpdateWarning("status", (opts) =>
      statusCommand({ json: opts.json }),
    ));

  program
    .command("doctor")
    .description("Validate ADIT installation health")
    .option("--fix", "Attempt automatic fixes")
    .option("--json", "Output as JSON")
    .action(withUpdateWarning("doctor", (opts) =>
      doctorCommand({ fix: opts.fix, json: opts.json }),
    ));

  // Export commands
  const exportCmd = program.command("export").description("Export event data");

  exportCmd
    .command("event <id>")
    .description("Export a single event bundle")
    .option("-o, --output <path>", "Output file path")
    .action((id, opts) =>
      exportCommand(id, { output: opts.output }),
    );

  exportCmd
    .command("session [session-id]")
    .description("Export entire session")
    .option("-f, --format <fmt>", "Output format (json|jsonl|markdown)", "json")
    .option("-o, --output <path>", "Output file path")
    .option("--from <date>", "Start date filter")
    .option("--to <date>", "End date filter")
    .option("--include-diffs", "Include full diffs (jsonl format only)")
    .option("--include-env", "Include environment snapshots (jsonl format only)")
    .option("--gzip", "Compress output with gzip")
    .action((sessionId, opts) =>
      exportSessionCommand(sessionId, {
        format: opts.format,
        output: opts.output,
        from: opts.from,
        to: opts.to,
        includeDiffs: opts.includeDiffs,
        includeEnv: opts.includeEnv,
        gzip: opts.gzip,
      }),
    );

  // Config
  program
    .command("config")
    .description("Show ADIT configuration")
    .option("--json", "Output as JSON")
    .action((opts) => configCommand({ json: opts.json }));

  // Hook management
  registerHookCommands(
    program
      .command("hook")
      .description("Manage platform hook integrations"),
  );

  program
    .command("uninstall")
    .description("Uninstall ADIT from the current project")
    .option("-y, --yes", "Skip confirmation")
    .option("--json", "Output as JSON")
    .action((opts) =>
      projectUninstallCommand({ yes: opts.yes, json: opts.json }),
    );

  // Cloud sync
  const cloudCmd = program.command("cloud").description("Cloud sync commands");
  cloudCmd.hook("preAction", async (_command, action) => {
    // Local sync and coding commands need the collector; diagnostics and remote
    // queries must not change the local service's running/stopped state.
    if (["sync", "claude", "codex"].includes(action.name())) await startDaemon();
  });
  registerCloudTaskCommands(cloudCmd);
  registerCloudHistoryCommands(cloudCmd);
  registerCloudMemoryCommands(cloudCmd);
  registerCloudReportCommands(cloudCmd);

  cloudCmd
    .command("login")
    .description("Authenticate with adit-cloud")
    .option("-s, --server <url>", "Cloud server URL")
    .option("--token <token>", "Authenticate with a static JWT token")
    .action(withUpdateWarning("cloud.login", (opts) =>
      opts.token
        ? cloudAuthTokenCommand(opts.token, { server: opts.server })
        : cloudLoginCommand({ server: opts.server }),
    ));

  cloudCmd
    .command("logout")
    .description("Clear stored cloud credentials")
    .action(() => cloudLogoutCommand());

  cloudCmd
    .command("sync")
    .description("Push conversation records, then linked Git metadata")
    .option("--json", "Output as JSON")
    .action(withUpdateWarning("cloud.sync", (opts) =>
      cloudSyncCommand({ json: opts.json }),
    ));

  cloudCmd
    .command("status")
    .description("Show cloud sync status")
    .option("--json", "Output as JSON")
    .action(withUpdateWarning("cloud.status", (opts) =>
      cloudStatusCommand({ json: opts.json }),
    ));

  const cloudAuthCmd = cloudCmd
    .command("auth")
    .description("Manage cloud authentication");

  cloudAuthCmd
    .command("reset")
    .description("Force-clear all credentials and sync state")
    .option("-y, --yes", "Skip confirmation")
    .action((opts) => cloudResetCredentialsCommand({ yes: opts.yes }));

  registerCloudCliAgentCommands(cloudCmd, {
    claude: withUpdateWarning("cloud.claude", cloudClaudeCommand),
    codex: withUpdateWarning("cloud.codex", cloudCodexCommand),
  });

  cloudCmd
    .command("link")
    .description("Link this project to adit-cloud")
    .option("-f, --force", "Clear cache and re-link from scratch")
    .option("--skip-docs", "Skip document upload")
    .option("--skip-commits", "Skip commit history upload")
    .option("--dry-run", "Preview without uploading")
    .option("--json", "Output result as JSON")
    .action(withUpdateWarning("cloud.link", async (opts) => {
      await projectLinkCliHandler({
        force: opts.force,
        skipDocs: opts.skipDocs,
        skipCommits: opts.skipCommits,
        dryRun: opts.dryRun,
        json: opts.json,
      });
    }));

  // Debug and maintenance commands
  const debugCmd = program
    .command("debug")
    .description("Debug and maintenance commands");

  const debugDbCmd = debugCmd
    .command("db")
    .description("Debug database commands");

  debugDbCmd
    .command("clear-events")
    .description("Delete all local events, sessions, diffs, and env snapshots")
    .option("-y, --yes", "Skip confirmation")
    .option("--json", "Output as JSON")
    .action((opts) => dbClearEventsCommand({ yes: opts.yes, json: opts.json }));

  const debugPerfCmd = debugCmd
    .command("perf")
    .description("Debug performance commands");

  debugPerfCmd
    .command("stats")
    .description("Show performance stats report")
    .option("--from <date>", "Start date (YYYY-MM-DD)")
    .option("--to <date>", "End date (YYYY-MM-DD)")
    .option(
      "-c, --category <cat>",
      "Filter by category (hook|git|snapshot|network)",
    )
    .option("--json", "Output as JSON")
    .action((opts) =>
      perfCommand({
        from: opts.from,
        to: opts.to,
        category: opts.category,
        json: opts.json,
      }),
    );

  debugPerfCmd
    .command("clear")
    .description("Clear all performance logs")
    .option("--json", "Output as JSON")
    .action((opts) => perfClearCommand({ json: opts.json }));

  // Snapshot — diff display and environment snapshot features
  const snapshotCmd = program
    .command("snapshot")
    .description("Diff and environment snapshot commands");

  snapshotCmd
    .command("diff <id>")
    .description("Show diff for a checkpoint event")
    .option("-n, --max-lines <n>", "Max lines to show")
    .option("-o, --offset-lines <n>", "Skip first N lines")
    .option("-f, --file <path>", "Filter by file path")
    .action((id, opts) =>
      diffCommand(id, {
        maxLines: opts.maxLines ? parseInt(opts.maxLines, 10) : undefined,
        offsetLines: opts.offsetLines
          ? parseInt(opts.offsetLines, 10)
          : undefined,
        file: opts.file,
      }),
    );

  // Environment snapshot commands (under snapshot)
  const envCmd = snapshotCmd
    .command("env")
    .description("Environment snapshot commands");

  envCmd
    .command("show <id>")
    .description("Show environment snapshot for an event")
    .action((id) => envCommand(id));

  envCmd
    .command("latest")
    .description("Show the most recent environment snapshot")
    .option("--json", "Output as JSON")
    .action((opts) => envLatestCommand({ json: opts.json }));

  envCmd
    .command("diff <id1> <id2>")
    .description("Compare two environment snapshots")
    .option("--json", "Output as JSON")
    .action((id1, id2, opts) => envDiffCommand(id1, id2, { json: opts.json }));

  envCmd
    .command("history")
    .description("List environment snapshot history")
    .option("-l, --limit <n>", "Max results", "20")
    .option("--json", "Output as JSON")
    .action((opts) =>
      envHistoryCommand({ limit: parseInt(opts.limit, 10), json: opts.json }),
    );

  // Self-update ("upgrade" and "self-update" stay as aliases for scripts and docs)
  program
    .command("update")
    .aliases(["upgrade", "self-update"])
    .description("Update ADIT to the latest version")
    .option("-c, --check", "Check for updates without installing")
    .action((opts) => selfUpdateCommand({ check: opts.check }));

  // TUI — interactive terminal interface
  program
    .command("tui")
    .description("Launch the interactive terminal UI")
    .action(() => launchTui());

  registerNestedHelpCommand(program);

  return program;
}

function registerHookCommands(hookCmd: Command): void {
  hookCmd
    .command("install [platform]")
    .description("Install ADIT hooks for a platform")
    .option("--json", "Output as JSON")
    .action(withUpdateWarning("hook.install", (platform, opts) =>
      pluginInstallCommand(platform, { json: opts.json }),
    ));

  hookCmd
    .command("uninstall [platform]")
    .description("Remove ADIT hooks for a platform")
    .option("-a, --all", "Uninstall hooks for all installed platforms")
    .option("--clean", "Also remove the .adit/ data directory")
    .option("--json", "Output as JSON")
    .action((platform, opts) =>
      pluginUninstallCommand(platform, {
        json: opts.json,
        all: opts.all,
        clean: opts.clean,
      }),
    );

  hookCmd
    .command("list")
    .description("List available platform adapters")
    .option("--json", "Output as JSON")
    .action((opts) => pluginListCommand({ json: opts.json }));

  hookCmd
    .command("validate [platform]")
    .description("Validate platform hook installation")
    .option("--json", "Output as JSON")
    .action(withUpdateWarning("hook.validate", (platform, opts) =>
      pluginValidateCommand(platform, { json: opts.json }),
    ));
}

function configureTopLevelHelp(program: Command): void {
  program.helpInformation = () => formatTopLevelHelp();
}

function formatTopLevelHelp(): string {
  return `Usage: adit [options] [command]

AI Development Intent Tracker

Options:
  -V, --version              output the version number
  -h, --help                 display help for command

Commands:
  server|serve [options]     Open the local web UI (starts the service if needed)
  daemon                     Start, stop or inspect the background service
  init [options]             Initialize ADIT in the current project
  uninstall [options]        Uninstall ADIT from the current project

  status [options]           Show project status
  timeline|list [options]    Show local timeline entries
  show <id>                  Show full event details
  search [options] <query>   Search timeline events
  history                    Search collected local sessions and commits across Agents

  snapshot                   Show event diffs and environment snapshots
  cloud                      Sync and connect with adit-cloud
  hook                       Manage AI platform hook integrations
  export                     Export event or session data

  doctor [options]           Validate installation health
  tui                        Launch the interactive terminal UI
  update [options]           Update ADIT
  debug                      Debug and maintenance commands
  help [command...]          display help for command
`;
}

function registerNestedHelpCommand(program: Command): void {
  program.helpCommand(false);

  program
    .command("help [command...]")
    .description("display help for command")
    .action((commandPath: string[] = []) => {
      const command = findNestedCommand(program, commandPath);
      if (!command) {
        program.error(`error: unknown command '${commandPath.join(" ")}'`, {
          code: "adit.unknownHelpCommand",
          exitCode: 1,
        });
        return;
      }
      command.outputHelp();
    });
}

function findNestedCommand(
  program: Command,
  commandPath: string[],
): Command | null {
  let current = program;
  for (const name of commandPath) {
    const next = current.commands.find(
      (command) => command.name() === name || command.aliases().includes(name),
    );
    if (!next) return null;
    current = next;
  }
  return current;
}

export function normalizeLegacyIntentCompleteArgs(argv: string[]): string[] {
  const commandStart = 2;
  if (argv[commandStart] !== "cloud" || argv[commandStart + 1] !== "intent") {
    return argv;
  }

  const completeIndex = argv.indexOf("complete", commandStart + 2);
  if (completeIndex === -1) return argv;

  const completeArg = argv[completeIndex + 1];
  if (completeArg && !completeArg.startsWith("-")) return argv;

  let intentId: string | null = null;
  const nextArgs = argv.slice();
  for (let index = commandStart + 2; index < completeIndex; index += 1) {
    const arg = nextArgs[index];
    if (arg === "--id") {
      const value = nextArgs[index + 1];
      if (!value || value.startsWith("-")) return argv;
      intentId = value;
      nextArgs.splice(index, 2);
      break;
    }
    if (arg.startsWith("--id=")) {
      intentId = arg.slice("--id=".length);
      nextArgs.splice(index, 1);
      break;
    }
  }

  if (!intentId) return argv;

  const nextCompleteIndex = nextArgs.indexOf("complete", commandStart + 2);
  nextArgs.splice(nextCompleteIndex + 1, 0, intentId);
  return nextArgs;
}

export function parseProgram(argv = process.argv): void {
  createProgram().parse(normalizeLegacyIntentCompleteArgs(argv));
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  parseProgram();
}
