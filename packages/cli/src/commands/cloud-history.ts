/**
 * Read-only history commands: `adit cloud projects|teams|sessions|commits`.
 *
 * They work from any directory. Only `sessions current` looks at the local
 * project database, because the session recorded here and its unsynced
 * events are only known locally.
 */

import { existsSync } from "node:fs";
import { Command, Option } from "commander";
import {
  CloudApiError,
  CloudNetworkError,
  DEFAULT_SERVER_URL,
  cloudSessionLink,
  countUnsyncedEvents,
  explainCloudCommit,
  listCloudProjects,
  listCloudSessions,
  listCloudTeams,
  loadCloudConfig,
  loadCredentials,
  readCloudSessionEvents,
  searchCloudSessions,
  showCloudSession,
  type CloudSessionAnalysis,
  type CloudSessionDetail,
  type CloudSessionSummary,
} from "@varveai/adit-cloud";
import {
  closeDatabase,
  getLastEventOfSession,
  getLatestSession,
  getSessionByPlatformSessionId,
  getSyncState,
  listRecentSessions,
  loadConfig,
  openDatabase,
  type AditSession,
} from "@varveai/adit-core";
import { oneLine, pageOptions, periodOptions, printJson, reportFailure, requireCloudClient, shortTime } from "./cloud-read-output.js";

type ScopeOptions = { project?: string; team?: string; member?: string };
type PeriodOptions = { from?: string; to?: string; tz?: string };
type PageOpts = { offset?: string; limit?: string };
type Json = { json?: boolean };

// ─── Current session ─────────────────────────────────────────────────────────

export interface CurrentSessionDeps {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  serverUrl: string;
  now?: Date;
  local: {
    loadConfig: typeof loadConfig;
    existsSync: typeof existsSync;
    openDatabase: typeof openDatabase;
    closeDatabase: typeof closeDatabase;
    getSessionByPlatformSessionId: typeof getSessionByPlatformSessionId;
    getLatestSession: typeof getLatestSession;
    listRecentSessions: typeof listRecentSessions;
    getLastEventOfSession: typeof getLastEventOfSession;
    getSyncState: typeof getSyncState;
    countUnsyncedEvents: typeof countUnsyncedEvents;
  };
  /** Reads the session from Cloud; null skips Cloud entirely. */
  cloud: ((sessionId: string) => Promise<CloudSessionDetail>) | null;
}

export interface CurrentSessionReport {
  state: "resolved" | "ambiguous" | "notRecorded" | "notInitialized";
  platformSessionId: string | null;
  platform: string | null;
  /** True when no platform session ID was available and the latest local session was taken instead. */
  inferred: boolean;
  project: { id: string; root: string } | null;
  session: { id: string; platform: string; startedAt: string; lastEventAt: string | null } | null;
  local: { unsyncedEvents: number; lastSyncedAt: string | null } | null;
  cloud: { status: "ready" | "notSynced" | "unreachable" | "skipped"; analysis: CloudSessionAnalysis | null; title: string | null; error: string | null } | null;
  candidates: Array<{ id: string; platform: string; startedAt: string; lastEventAt: string | null }>;
  hint: string;
}

const SYNC_HINT = "Run 'adit cloud sync' in this project directory, then query the session again.";

export function defaultCurrentSessionDeps(): CurrentSessionDeps {
  const credentials = loadCredentials();
  const serverUrl = loadCloudConfig().serverUrl ?? credentials?.serverUrl ?? DEFAULT_SERVER_URL;
  return {
    env: process.env,
    serverUrl,
    local: { loadConfig, existsSync, openDatabase, closeDatabase, getSessionByPlatformSessionId, getLatestSession, listRecentSessions, getLastEventOfSession, getSyncState, countUnsyncedEvents },
    cloud: credentials ? (sessionId) => showCloudSession(requireCloudClient(), sessionId) : null,
  };
}

/** The platform session ID the agent's own shell exposes, when it does. */
export function platformSessionIdFromEnv(env: NodeJS.ProcessEnv): { id: string | null; platform: string | null } {
  const explicit = env.ADIT_SESSION_ID?.trim();
  if (explicit) return { id: explicit, platform: null };
  const claude = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (claude) return { id: claude, platform: "claude-code" };
  return { id: null, platform: env.CLAUDECODE ? "claude-code" : null };
}

export async function resolveCurrentSession(deps: CurrentSessionDeps): Promise<CurrentSessionReport> {
  const { id: platformSessionId, platform } = platformSessionIdFromEnv(deps.env);
  const now = deps.now ?? new Date();
  const base = { platformSessionId, platform, inferred: false, project: null, session: null, local: null, cloud: null, candidates: [] as CurrentSessionReport["candidates"] };
  const config = deps.local.loadConfig(deps.cwd);
  if (config.initialization !== "initialized" || !deps.local.existsSync(config.dbPath)) {
    return { ...base, state: "notInitialized", hint: "This directory is not initialized for ADIT, so sessions started here are not recorded locally or in Cloud. Run this command inside the project where the session was recorded, or run 'adit init' there first." };
  }
  const project = { id: config.projectId, root: config.projectRoot };
  const db = deps.local.openDatabase(config.dbPath);
  try {
    const describe = (session: AditSession) => ({ id: session.id, platform: session.platform, startedAt: session.startedAt, lastEventAt: deps.local.getLastEventOfSession(db, session.id)?.startedAt ?? null });
    let session = platformSessionId ? deps.local.getSessionByPlatformSessionId(db, platformSessionId) : null;
    let inferred = false;
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const recent = deps.local.listRecentSessions(db, { projectId: config.projectId, since, limit: 5 });
    if (!session && platformSessionId) {
      return { ...base, state: "notRecorded", project, candidates: recent.map(describe), hint: "The current session is not recorded in this project: hooks may not be installed here, or the session belongs to another project directory. Run 'adit doctor' to check the hooks." };
    }
    if (!session) {
      if (recent.length > 1) return { ...base, state: "ambiguous", project, candidates: recent.map(describe), hint: "No session ID is available from the environment and several sessions were active in the last day; pick one by ID." };
      session = recent[0] ?? deps.local.getLatestSession(db, config.projectId, config.clientId);
      inferred = true;
      if (!session) return { ...base, state: "notRecorded", project, hint: "No session has been recorded in this project yet." };
    }
    const syncState = deps.local.getSyncState(db, deps.serverUrl);
    const local = { unsyncedEvents: deps.local.countUnsyncedEvents(db, syncState?.lastSyncedEventId ?? null, config.projectId), lastSyncedAt: syncState?.lastSyncedAt ?? null };
    let cloud: CurrentSessionReport["cloud"] = { status: "skipped", analysis: null, title: null, error: null };
    if (deps.cloud) {
      try {
        const detail = await deps.cloud(session.id);
        cloud = { status: "ready", analysis: detail.session.analysis, title: detail.session.title, error: null };
      } catch (error) {
        const cause = error instanceof CloudNetworkError && error.cause ? `: ${error.cause.message}` : "";
        cloud = error instanceof CloudApiError && error.status === 404
          ? { status: "notSynced", analysis: null, title: null, error: null }
          : { status: "unreachable", analysis: null, title: null, error: `${error instanceof Error ? error.message : String(error)}${cause}` };
      }
    }
    const hints: string[] = [];
    if (inferred) hints.push("No session ID came from the environment; this is the latest session recorded in the project.");
    if (local.unsyncedEvents > 0) hints.push(`${local.unsyncedEvents} local events are not in Cloud yet. ${SYNC_HINT}`);
    else if (cloud.status === "notSynced") hints.push(`Cloud has not received this session yet. ${SYNC_HINT}`);
    if (cloud.analysis && cloud.analysis.state !== "ready") hints.push(`Cloud analysis is ${cloud.analysis.state}; read raw events when the outline is missing.`);
    return { ...base, state: "resolved", inferred, project, session: describe(session), local, cloud, candidates: [], hint: hints.join(" ") };
  } finally {
    deps.local.closeDatabase(db);
  }
}

async function sessionArgument(value: string): Promise<string> {
  if (value !== "current") return value;
  const report = await resolveCurrentSession({ ...defaultCurrentSessionDeps(), cloud: null });
  if (!report.session) throw new Error(`Could not determine the current session (${report.state}). ${report.hint}`);
  return report.session.id;
}

// ─── Command handlers ────────────────────────────────────────────────────────

function scopeParams(options: ScopeOptions) {
  return { project: options.project, team: options.team, member: options.member };
}

function sessionLine(session: CloudSessionSummary): string {
  return `${session.id}  ${shortTime(session.startedAt)}  ${session.platform}  ${session.analysis.state}  ${oneLine(session.title ?? "(untitled)", 70)}`;
}

export async function cloudProjectsCommand(options: Json & { query?: string; kind?: string }): Promise<void> {
  try {
    const result = await listCloudProjects(requireCloudClient(), { q: options.query, kind: options.kind });
    if (options.json) return printJson(result);
    if (!result.projects.length) return console.log("No projects are visible to you.");
    for (const project of result.projects) console.log(`${project.id}  ${project.kind.padEnd(8)}  ${oneLine(project.name ?? project.localProjectId ?? "(unnamed)", 40)}  ${project.teams.map((team) => team.name).join(", ") || "-"}  last activity ${shortTime(project.lastActivityAt)}`);
  } catch (error) { reportFailure(error, options, "Project listing"); }
}

export async function cloudTeamsCommand(options: Json): Promise<void> {
  try {
    const result = await listCloudTeams(requireCloudClient());
    if (options.json) return printJson(result);
    if (!result.teams.length) return console.log("You are not a member of any team.");
    for (const team of result.teams) console.log(`${team.id}  ${team.role.padEnd(6)}  ${oneLine(team.name, 40)}  ${team.memberCount} members  ${team.projects.length} projects`);
  } catch (error) { reportFailure(error, options, "Team listing"); }
}

export async function cloudSessionsCurrentCommand(options: Json, deps: CurrentSessionDeps = defaultCurrentSessionDeps()): Promise<void> {
  try {
    const report = await resolveCurrentSession(deps);
    if (options.json) return printJson(report);
    console.log(`State: ${report.state}${report.inferred ? " (latest local session)" : ""}`);
    if (report.session) {
      console.log(`Session: ${report.session.id}  ${report.session.platform}  started ${shortTime(report.session.startedAt)}  last event ${shortTime(report.session.lastEventAt)}`);
      if (report.local) console.log(`Local: ${report.local.unsyncedEvents} unsynced events, last sync ${shortTime(report.local.lastSyncedAt)}`);
      if (report.cloud) console.log(`Cloud: ${report.cloud.status}${report.cloud.analysis ? `, analysis ${report.cloud.analysis.state} (${report.cloud.analysis.sections} sections)` : ""}${report.cloud.error ? ` (${report.cloud.error})` : ""}`);
    }
    for (const candidate of report.candidates) console.log(`Candidate: ${candidate.id}  ${candidate.platform}  started ${shortTime(candidate.startedAt)}  last event ${shortTime(candidate.lastEventAt)}`);
    if (report.hint) console.log(report.hint);
  } catch (error) { reportFailure(error, options, "Current session"); }
}

export async function cloudSessionsListCommand(options: Json & ScopeOptions & PeriodOptions & PageOpts): Promise<void> {
  try {
    const result = await listCloudSessions(requireCloudClient(), { ...scopeParams(options), ...periodOptions(options), ...pageOptions(options, 100) });
    if (options.json) return printJson(result);
    console.log(`${result.sessions.length} of ${result.total} sessions (${result.scope.description}; ${result.period.from ?? "any"} to ${result.period.to ?? "any"}, ${result.period.timeZone})`);
    for (const session of result.sessions) console.log(sessionLine(session));
    if (result.nextOffset !== null) console.log(`More sessions: repeat with --offset ${result.nextOffset}`);
  } catch (error) { reportFailure(error, options, "Session listing"); }
}

export async function cloudSessionsSearchCommand(query: string, options: Json & ScopeOptions & PeriodOptions & PageOpts): Promise<void> {
  try {
    const result = await searchCloudSessions(requireCloudClient(), { q: query, ...scopeParams(options), ...periodOptions(options), ...pageOptions(options, 50) });
    if (options.json) return printJson(result);
    console.log(`${result.sessions.length} of ${result.total} matching sessions (${result.searchMode} search over ${result.scannedSessions} sessions${result.scopeTruncated ? ", newest only" : ""})`);
    for (const session of result.sessions) {
      console.log(`${sessionLine(session)}  score ${session.score}`);
      for (const match of session.matches) console.log(`    outline #${match.sequence} ${match.field}: ${oneLine(match.snippet, 100)}`);
    }
    if (result.nextOffset !== null) console.log(`More sessions: repeat with --offset ${result.nextOffset}`);
  } catch (error) { reportFailure(error, options, "Session search"); }
}

export async function cloudSessionsShowCommand(sessionId: string, options: Json): Promise<void> {
  try {
    const result = await showCloudSession(requireCloudClient(), await sessionArgument(sessionId));
    if (options.json) return printJson(result);
    const { session } = result;
    console.log(`${session.id}  ${session.platform}  ${oneLine(session.title ?? "(untitled)", 80)}`);
    console.log(`Project ${session.project.name ?? session.project.id}; ${shortTime(session.startedAt)} to ${shortTime(session.lastActivityAt)}; ${session.promptCount} prompts, ${session.commitCount} commits, ${session.fileCount} files; analysis ${session.analysis.state}`);
    for (const section of result.outline) console.log(`  #${section.sequence}  ${oneLine(section.title, 70)}  (${section.eventCount} events, ${shortTime(section.startedAt)})`);
    if (result.coverage && result.coverage.uncoveredCount > 0) console.log(`  ${result.coverage.uncoveredCount} events are not in the outline yet (${result.coverage.pendingBatches} pending, ${result.coverage.failedBatches} failed batches)`);
    for (const commit of result.commits) console.log(`  commit ${commit.sha.slice(0, 10)}  ${oneLine(commit.message, 60)}  (${commit.matchType}, ${commit.confidence})`);
    for (const task of result.tasks) console.log(`  task ${task.id}  ${task.progressState}  ${oneLine(task.title, 60)}`);
  } catch (error) { reportFailure(error, options, "Session detail"); }
}

export async function cloudSessionsEventsCommand(sessionId: string, options: Json & PageOpts & { section?: string; types?: string; maxChars?: string }): Promise<void> {
  try {
    const integer = (value: string | undefined, name: string, max: number) => {
      if (value === undefined) return undefined;
      if (!/^\d+$/.test(value) || Number(value) > max) throw new Error(`${name} must be an integer between 0 and ${max}`);
      return Number(value);
    };
    const result = await readCloudSessionEvents(requireCloudClient(), await sessionArgument(sessionId), {
      section: integer(options.section, "--section", 100_000), types: options.types, maxChars: integer(options.maxChars, "--max-chars", 50_000), ...pageOptions(options, 200),
    });
    if (options.json) return printJson(result);
    console.log(`${result.events.length} of ${result.total} events${result.section ? ` in section #${result.section.sequence} ${result.section.title}` : ""}`);
    for (const event of result.events) {
      console.log(`#${event.sequence}  ${shortTime(event.startedAt)}  ${event.type}${event.truncated.length ? "  (truncated)" : ""}`);
      if (event.prompt) console.log(`  prompt: ${oneLine(event.prompt, 160)}`);
      if (event.response) console.log(`  response: ${oneLine(event.response, 160)}`);
      if (event.tool) console.log(`  tool: ${event.tool.name ?? "?"} ${oneLine(event.tool.input, 100)}`);
      if (event.files.length) console.log(`  files: ${event.files.join(", ")}`);
    }
    if (result.nextOffset !== null) console.log(`More events: repeat with --offset ${result.nextOffset}`);
  } catch (error) { reportFailure(error, options, "Session events"); }
}

export async function cloudSessionsLinkCommand(action: "create" | "status" | "renew" | "revoke", sessionId: string, options: Json): Promise<void> {
  try {
    const result = await cloudSessionLink(requireCloudClient(action === "status" ? 2 : 0), await sessionArgument(sessionId), action);
    if (options.json) return printJson(result);
    if (result.link?.revokedAt) return console.log(`Read link revoked at ${shortTime(result.link.revokedAt)}.`);
    if (!result.link || result.active === false) return console.log("No active read link for this session.");
    console.log(`${result.created === false ? "Existing read link" : "Read link"}: ${result.url ?? "(URL only returned on creation)"}`);
    console.log(`Expires ${result.link.expiresAt} (server time ${result.serverNow}).`);
  } catch (error) { reportFailure(error, options, "Read link"); }
}

export async function cloudCommitsExplainCommand(sha: string, options: Json & { project?: string }): Promise<void> {
  try {
    const result = await explainCloudCommit(requireCloudClient(), sha, { project: options.project });
    if (options.json) return printJson(result);
    console.log(`${result.commit.sha}  ${shortTime(result.commit.committedAt)}  ${result.commit.author.name}  ${oneLine(result.commit.message, 80)}`);
    console.log(result.note);
    for (const attribution of result.attributions) {
      console.log(`Session ${attribution.session.id} (${oneLine(attribution.session.title ?? "untitled", 50)}) ${attribution.matchType} ${attribution.confidence}`);
      if (attribution.prompt) console.log(`  prompt: ${oneLine(attribution.prompt.text, 200)}`);
      if (attribution.response) console.log(`  response: ${oneLine(attribution.response.text, 200)}`);
      if (attribution.outlineSections.length) console.log(`  outline: ${attribution.outlineSections.map((section) => `#${section.sequence} ${section.title}`).join("; ")}`);
    }
  } catch (error) { reportFailure(error, options, "Commit explanation"); }
}

// ─── Registration ────────────────────────────────────────────────────────────

function withScope(command: Command): Command {
  return command
    .option("--project <id>", "Project ID from 'projects list'")
    .option("--team <id>", "Team ID from 'teams list'")
    .option("--member <id>", "Member ID from 'team members' (owners and leads only)");
}
function withPeriod(command: Command): Command {
  return command
    .option("--from <date>", "First calendar day, YYYY-MM-DD")
    .option("--to <date>", "Last calendar day, YYYY-MM-DD")
    .option("--tz <zone>", "IANA time zone; defaults to this machine's zone");
}
function withPage(command: Command, maxLimit: number): Command {
  return command.option("--offset <number>", "Pagination offset", "0").option("--limit <number>", `Page size, 1-${maxLimit}`);
}

export function registerCloudHistoryCommands(cloud: Command): void {
  const projects = cloud.command("projects").description("Projects you can read");
  projects.command("list").description("List your projects and the team projects your role allows")
    .option("--query <text>", "Filter by project or repository name")
    .addOption(new Option("--kind <kind>", "Only personal or team projects").choices(["personal", "team"]))
    .option("--json", "Output JSON").action((options) => cloudProjectsCommand(options));

  const teams = cloud.command("teams").description("Teams you belong to");
  teams.command("list").description("List your teams with your role in each").option("--json", "Output JSON").action((options) => cloudTeamsCommand(options));

  const sessions = cloud.command("sessions").description("Recorded coding sessions");
  sessions.command("current").description("Identify the session running here and whether Cloud has it").option("--json", "Output JSON").action((options) => cloudSessionsCurrentCommand(options));
  withPage(withPeriod(withScope(sessions.command("list").description("List sessions, newest first"))), 100).option("--json", "Output JSON").action((options) => cloudSessionsListCommand(options));
  withPage(withPeriod(withScope(sessions.command("search <query>").description("Find sessions by words in their outline titles, keywords or descriptions"))), 50).option("--json", "Output JSON").action((query, options) => cloudSessionsSearchCommand(query, options));
  sessions.command("show <sessionId>").description("Read a session's summary and outline ('current' for this session)").option("--json", "Output JSON").action((sessionId, options) => cloudSessionsShowCommand(sessionId, options));
  withPage(sessions.command("events <sessionId>").description("Read a session's events, by outline section or page"), 200)
    .option("--section <number>", "Outline section number from 'sessions show'")
    .option("--types <list>", "Comma-separated: prompt, response, commit, tool or raw event types")
    .option("--max-chars <number>", "Characters kept per text field", "2000")
    .option("--json", "Output JSON").action((sessionId, options) => cloudSessionsEventsCommand(sessionId, options));
  const link = sessions.command("link").description("One-hour read links for another assistant");
  for (const action of ["create", "status", "renew", "revoke"] as const) {
    link.command(`${action} <sessionId>`).description({ create: "Create a read link (returns the existing active one)", status: "Show the read link state", renew: "Extend the read link by one hour", revoke: "Revoke the read link" }[action])
      .option("--json", "Output JSON").action((sessionId, options) => cloudSessionsLinkCommand(action, sessionId, options));
  }

  const commits = cloud.command("commits").description("Synced git commits");
  commits.command("explain <sha>").description("Show the prompts and responses recorded around a commit")
    .option("--project <id>", "Project ID when a short SHA is ambiguous")
    .option("--json", "Output JSON").action((sha, options) => cloudCommitsExplainCommand(sha, options));
}
