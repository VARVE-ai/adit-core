/**
 * Read-only history commands: `adit cloud projects|teams|sessions|commits`.
 *
 * They work from any directory. Only `sessions current` looks at the local
 * project database, because the session recorded here and its unsynced
 * events are only known locally.
 */

import { existsSync } from "node:fs";
import { currentLocalSession } from "./current-local-session.js";
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
  type CloudReadScope,
  type CloudSessionAnalysis,
  type CloudSessionDetail,
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
import { commandWith, pageOptions, periodOptions, printJson, reportFailure, requireCloudClient } from "./cloud-read-output.js";
import {
  arrow,
  dim,
  displayWidth,
  formatDuration,
  formatTable,
  highlight,
  inTone,
  joinParts,
  localDateTime,
  localMoment,
  marks,
  padEnd,
  plural,
  printEnd,
  printLine,
  printRows,
  printSection,
  printTable,
  printTitle,
  shortId,
  stateWord,
  strong,
  summaryColumns,
  truncate,
  type Row,
} from "./cli-style.js";

type ScopeOptions = { scope?: CloudReadScope; project?: string; team?: string; member?: string };
type PeriodOptions = { from?: string; to?: string; tz?: string };
type PageOpts = { offset?: string; limit?: string };
type Json = { json?: boolean };

// ─── Current session ─────────────────────────────────────────────────────────

export interface CurrentSessionDeps {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  serverUrl: string;
  now?: Date;
  registry?: typeof currentLocalSession;
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
  session: { id: string; nativeId?:string; cloudId?:string|null; platform: string; startedAt: string; lastEventAt: string | null } | null;
  local: { unsyncedEvents: number|null; pendingSessions?:number|null; lastSyncedAt: string | null } | null;
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
    registry: currentLocalSession,
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
  const codex = env.CODEX_THREAD_ID?.trim();
  if (codex) return { id: codex, platform: "codex" };
  return { id: null, platform: env.CLAUDECODE ? "claude-code" : null };
}

export async function resolveCurrentSession(deps: CurrentSessionDeps): Promise<CurrentSessionReport> {
  const { id: platformSessionId, platform } = platformSessionIdFromEnv(deps.env);
  const current=await deps.registry?.(deps,platformSessionId,platform);
  if(current)return current;
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
    if (local.unsyncedEvents > 0) hints.push(`${local.unsyncedEvents} events of this project are not in Cloud yet (the count covers the whole project, not only this session). ${SYNC_HINT}`);
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
  if (report.session.nativeId && !report.session.cloudId) throw new Error("This collected session has not been synced to Cloud. Run 'adit cloud sync' first.");
  return report.session.id;
}

// ─── Command handlers ────────────────────────────────────────────────────────

function scopeParams(options: ScopeOptions) {
  return { scope: options.scope ?? "me", project: options.project, team: options.team, member: options.member };
}

const SYNC_NOT_FOUND = `run ${strong("adit cloud sync")} in the project directory, then retry`;
const PLATFORM_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude-vscode": "Claude Code (VS Code)",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
};

function platformName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform;
}

function personName(person: { name: string | null; email: string | null; id: string } | null | undefined): string {
  return person?.name ?? person?.email ?? person?.id ?? "-";
}

function periodLabel(period: { from: string | null; to: string | null }): string {
  return `${period.from ?? "any"} ${arrow()} ${period.to ?? "any"}`;
}

export async function cloudProjectsCommand(options: Json & { scope?: CloudReadScope; query?: string; kind?: string }): Promise<void> {
  try {
    if (options.scope === "me" && options.kind === "team") throw new Error("--scope me cannot be combined with --kind team; use --scope visible");
    const result = await listCloudProjects(requireCloudClient(), { q: options.query, kind: options.kind, scope: options.scope });
    if (options.json) return printJson(result);
    const filters = [result.scope.description, options.query ? `matching "${options.query}"` : null, options.kind ?? null];
    if (!result.projects.length) {
      printTitle("Projects", ...filters);
      printEnd(`${marks.skip} No projects in this scope`);
      return;
    }
    printTitle("Projects", ...filters, String(result.projects.length));
    printTable(
      [{ header: "id" }, { header: "kind" }, { header: "name" }, { header: "teams" }, { header: "last activity" }],
      result.projects.map((project) => [
        project.id,
        project.kind,
        project.name ? strong(truncate(project.name, 30)) : dim("(unnamed)"),
        truncate(project.teams.map((team) => team.name).join(", "), 30) || "-",
        localDateTime(project.lastActivityAt),
      ]),
    );
    printEnd();
  } catch (error) { reportFailure(error, options, "projects list"); }
}

export async function cloudTeamsCommand(options: Json): Promise<void> {
  try {
    const result = await listCloudTeams(requireCloudClient());
    if (options.json) return printJson(result);
    if (!result.teams.length) {
      printTitle("Teams");
      printEnd(`${marks.skip} You are not in any team`);
      return;
    }
    printTitle("Teams", String(result.teams.length));
    printTable(
      [{ header: "id" }, { header: "role" }, { header: "name" }, { header: "members" }, { header: "projects" }],
      result.teams.map((team) => [team.id, team.role, strong(truncate(team.name, 30)), String(team.memberCount), String(team.projects.length)]),
    );
    printEnd(dim(`members: ${strong("adit cloud team members --team <id>")}`));
  } catch (error) { reportFailure(error, options, "teams list"); }
}

export async function cloudSessionsCurrentCommand(options: Json, deps: CurrentSessionDeps = defaultCurrentSessionDeps()): Promise<void> {
  try {
    const report = await resolveCurrentSession(deps);
    if (options.json) return printJson(report);
    const candidatesTable = () => printTable(
      [{ header: "id" }, { header: "platform" }, { header: "started" }, { header: "last event" }],
      report.candidates.map((candidate) => [candidate.id, candidate.platform, localDateTime(candidate.startedAt), localDateTime(candidate.lastEventAt)]),
    );

    if (report.state === "notInitialized") {
      printTitle("Current session", "not initialized here");
      printEnd(`${marks.warn} ${report.hint}`);
      return;
    }
    if (report.state === "ambiguous") {
      printTitle("Current session", "ambiguous");
      candidatesTable();
      printEnd(`${marks.warn} Several sessions were active in the last day ${dim("·")} pick one by ID`);
      return;
    }
    if (report.state === "notRecorded" || !report.session) {
      printTitle("Current session", "not recorded");
      if (report.candidates.length > 0) candidatesTable();
      printEnd(deps.registry ? `${marks.warn} ${report.hint}` : report.platformSessionId
        ? `${marks.warn} This session is not recorded in this project ${dim("·")} run ${strong("adit doctor")} to check the hooks`
        : `${marks.skip} No session recorded in this project yet`);
      return;
    }

    const session = report.session;
    const now = new Date().toISOString();
    const rows: Row[] = [
      {
        label: "Started",
        value: joinParts([localDateTime(session.startedAt), session.lastEventAt ? `last event ${localMoment(session.lastEventAt, session.startedAt)}` : null]),
      },
    ];
    if (report.local) {
      rows.push({
        label: "Local",
        value: joinParts([
          report.local.unsyncedEvents === null ? (report.local.pendingSessions === null ? "sync baseline not established" : `${report.local.pendingSessions} sessions pending in this project`) : report.local.unsyncedEvents > 0 ? inTone("unsynced", `${report.local.unsyncedEvents} unsynced in this project`) : "0 unsynced",
          report.local.lastSyncedAt ? `last sync ${localMoment(report.local.lastSyncedAt, now)}` : "never synced",
        ]),
      });
    }
    const cloud = report.cloud;
    if (cloud) {
      const analysis = cloud.analysis ? `analysis ${stateWord(cloud.analysis.state)} · ${plural(cloud.analysis.sections, "section")}` : null;
      rows.push({
        label: "Cloud",
        value: cloud.status === "ready"
          ? joinParts([stateWord("ready"), analysis])
          : cloud.status === "notSynced"
            ? inTone("pending", "not synced yet")
            : cloud.status === "unreachable"
              ? `${stateWord("unreachable")} ${dim(`· ${cloud.error ?? ""}`)}`
              : dim("not checked (not logged in)"),
      });
    }
    if (report.inferred) rows.push({ label: "Note", value: inTone("warning", "no session ID came from the environment; this is the latest session in the project") });

    printTitle("Current session", session.id, platformName(session.platform));
    printRows(rows);
    if (report.local && report.local.unsyncedEvents !== null && report.local.unsyncedEvents > 0) {
      printEnd(`${marks.warn} ${plural(report.local.unsyncedEvents, "event")} not in Cloud yet ${dim("·")} run ${strong("adit cloud sync")} here, then query again`);
    } else if (cloud?.status === "notSynced") {
      printEnd(`${marks.warn} Cloud has not received this session yet ${dim("·")} run ${strong("adit cloud sync")}`);
    } else if (cloud?.status === "unreachable") {
      printEnd(`${marks.warn} Cloud unreachable ${dim("·")} check ${strong("adit cloud status")}`);
    } else if (cloud?.status === "skipped") {
      printEnd(`${marks.skip} Not logged in ${dim("·")} run ${strong("adit cloud login")} to compare with Cloud`);
    } else {
      printEnd(`${marks.ok} Cloud has this session ${dim("·")} read it: ${strong("adit cloud sessions show current")}`);
    }
  } catch (error) { reportFailure(error, options, "sessions current"); }
}

export async function cloudSessionsListCommand(options: Json & ScopeOptions & PeriodOptions & PageOpts): Promise<void> {
  try {
    const result = await listCloudSessions(requireCloudClient(), { ...scopeParams(options), ...periodOptions(options), ...pageOptions(options, 100) });
    if (options.json) return printJson(result);
    const scope = [result.scope.description, periodLabel(result.period), result.period.timeZone];
    if (!result.sessions.length) {
      printTitle("Sessions", ...scope);
      printEnd(`${marks.skip} No sessions in this period`);
      return;
    }
    printTitle("Sessions", ...scope, `${result.sessions.length} of ${result.total}`);
    printTable(
      [{ header: "id" }, { header: "started" }, { header: "platform" }, { header: "analysis" }, { header: "title" }],
      result.sessions.map((session) => [
        session.id,
        localDateTime(session.startedAt),
        session.platform,
        stateWord(session.analysis.state),
        truncate(session.title ?? "(untitled)", summaryColumns(26 + 16 + 11 + 8 + 8)),
      ]),
    );
    const more = result.nextOffset !== null
      ? `more: ${strong(commandWith("adit cloud sessions list", { ...scopeParams(options), from: options.from, to: options.to, tz: options.tz, limit: options.limit, offset: result.nextOffset }))}`
      : null;
    printEnd(dim([`${result.sessions.length} of ${result.total}`, more, `details: ${strong("adit cloud sessions show <id>")}`].filter(Boolean).join(" · ")));
  } catch (error) { reportFailure(error, options, "sessions list"); }
}

export async function cloudSessionsSearchCommand(query: string, options: Json & ScopeOptions & PeriodOptions & PageOpts): Promise<void> {
  try {
    const result = await searchCloudSessions(requireCloudClient(), { q: query, ...scopeParams(options), ...periodOptions(options), ...pageOptions(options, 50) });
    if (options.json) return printJson(result);
    const scope = [result.scope.description, `"${query}"`, `${result.searchMode} search`, result.scopeTruncated ? "newest sessions only" : null];
    if (!result.sessions.length) {
      printTitle("Sessions", ...scope);
      printEnd(`${marks.skip} No sessions match ${dim("· only outline titles, keywords and descriptions are searched")}`);
      return;
    }
    printTitle("Sessions", ...scope, plural(result.total, "match", "matches"));
    const lines = formatTable(
      [{ header: "id" }, { header: "started" }, { header: "score" }, { header: "title" }],
      result.sessions.map((session) => [session.id, localDateTime(session.startedAt), String(session.score), truncate(session.title ?? "(untitled)", 60)]),
    );
    const indent = " ".repeat(displayWidth(result.sessions[0]?.id ?? "") + 2);
    const words = query.trim().split(/\s+/u).filter(Boolean).map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
    const mark = (text: string) => words.length > 0 ? text.replace(new RegExp(`(${words.join("|")})`, "giu"), (hit) => highlight(hit)) : text;
    printLine(lines[0] ?? "");
    result.sessions.forEach((session, index) => {
      printLine(lines[index + 1] ?? "");
      for (const match of session.matches) {
        printLine(`${indent}${dim(padEnd(`outline #${match.sequence} ${match.field}`, 22))}${mark(truncate(match.snippet, 70))}`);
      }
    });
    const more = result.nextOffset !== null
      ? `more: ${strong(commandWith(`adit cloud sessions search "${query}"`, { ...scopeParams(options), from: options.from, to: options.to, tz: options.tz, limit: options.limit, offset: result.nextOffset }))}`
      : null;
    printEnd(dim([`${result.sessions.length} of ${result.total}`, more, "only outline titles, keywords and descriptions are searched"].filter(Boolean).join(" · ")));
  } catch (error) { reportFailure(error, options, "sessions search"); }
}

export async function cloudSessionsShowCommand(sessionId: string, options: Json): Promise<void> {
  try {
    const result = await showCloudSession(requireCloudClient(), await sessionArgument(sessionId));
    if (options.json) return printJson(result);
    const { session } = result;
    const durationMs = Date.parse(session.lastActivityAt) - Date.parse(session.startedAt);
    const coverage = result.coverage;
    const pending = coverage && coverage.uncoveredCount > 0
      ? `${plural(coverage.uncoveredCount, "event")} not in the outline yet${coverage.pendingBatches || coverage.failedBatches ? ` (${joinParts([
          coverage.pendingBatches ? inTone("pending", `${plural(coverage.pendingBatches, "batch", "batches")} pending`) : null,
          coverage.failedBatches ? inTone("failed", `${plural(coverage.failedBatches, "batch", "batches")} failed`) : null,
        ])})` : ""}`
      : null;
    const rows: Row[] = [
      { label: "Project", value: joinParts([strong(session.project.name ?? session.project.id), platformName(session.platform), personName(session.user)]) },
      {
        label: "Time",
        value: joinParts([
          `${localDateTime(session.startedAt)} ${dim(arrow())} ${localMoment(session.lastActivityAt, session.startedAt)}`,
          Number.isFinite(durationMs) && durationMs > 0 ? formatDuration(durationMs) : null,
        ]),
      },
      { label: "Activity", value: joinParts([plural(session.promptCount, "prompt"), plural(session.commitCount, "commit"), plural(session.fileCount, "file")]) },
      { label: "Analysis", value: joinParts([stateWord(session.analysis.state), plural(session.analysis.sections, "section"), pending]) },
    ];
    if (result.teams.length > 0) rows.push({ label: "Teams", value: result.teams.map((team) => team.name).join(", ") });

    printTitle("Session", session.id, truncate(session.title ?? "(untitled)", 60));
    printRows(rows);
    if (result.outline.length > 0) {
      printSection("Outline");
      printTable(
        [{ header: "#" }, { header: "start" }, { header: "events", align: "right" }, { header: "title" }],
        result.outline.map((section) => [`#${section.sequence}`, localMoment(section.startedAt, session.startedAt), String(section.eventCount), truncate(section.title, 70)]),
      );
    }
    if (result.commits.length > 0) {
      printSection("Commits");
      printTable(
        [{ header: "sha" }, { header: "match" }, { header: "confidence" }, { header: "message" }],
        result.commits.map((commit) => [shortId(commit.sha), commit.matchType, commit.confidence.toFixed(2), truncate(commit.message, 70)]),
      );
    }
    if (result.tasks.length > 0) {
      printSection("Tasks");
      printTable(
        [{ header: "" }, { header: "" }, { header: "" }],
        result.tasks.map((task) => [task.id, stateWord(task.progressState), truncate(task.title, 60)]),
      );
    }
    printEnd(dim(`events: ${strong(`adit cloud sessions events ${session.id}${result.outline.length > 0 ? " --section 1" : ""}`)}`));
  } catch (error) { reportFailure(error, options, "sessions show", SYNC_NOT_FOUND); }
}

export async function cloudSessionsEventsCommand(sessionId: string, options: Json & PageOpts & { section?: string; types?: string; maxChars?: string }): Promise<void> {
  try {
    const integer = (value: string | undefined, name: string, max: number) => {
      if (value === undefined) return undefined;
      if (!/^\d+$/.test(value) || Number(value) > max) throw new Error(`${name} must be an integer between 0 and ${max}`);
      return Number(value);
    };
    const resolvedId = await sessionArgument(sessionId);
    const result = await readCloudSessionEvents(requireCloudClient(), resolvedId, {
      section: integer(options.section, "--section", 100_000), types: options.types, maxChars: integer(options.maxChars, "--max-chars", 50_000), ...pageOptions(options, 200),
    });
    if (options.json) return printJson(result);
    const scope = [result.sessionId, result.section ? `section #${result.section.sequence} ${truncate(result.section.title, 40)}` : null, options.types ? `types ${options.types}` : null];
    if (!result.events.length) {
      printTitle("Events", ...scope);
      printEnd(`${marks.skip} No events ${result.section ? "in this section" : "in this range"}`);
      return;
    }
    printTitle("Events", ...scope, `${result.events.length} of ${result.total}`);
    const first = result.events[0]?.startedAt ?? null;
    const width = summaryColumns(16);
    for (const event of result.events) {
      printLine(`${strong(`#${event.sequence}`)}  ${localMoment(event.startedAt, first, { seconds: true })}  ${event.type}${event.truncated.length ? dim(" · truncated") : ""}`);
      const rows: Row[] = [];
      if (event.prompt) rows.push({ label: "prompt", value: truncate(event.prompt, width) });
      if (event.response) rows.push({ label: "response", value: truncate(event.response, width) });
      if (event.reasoning) rows.push({ label: "reasoning", value: truncate(event.reasoning, width) });
      if (event.tool) rows.push({ label: "tool", value: truncate(joinParts([event.tool.name ?? "?", event.tool.input]), width) });
      if (event.files.length) rows.push({ label: "files", value: truncate(event.files.join(", "), width) });
      if (event.git?.commitSha) rows.push({ label: "commit", value: joinParts([shortId(event.git.commitSha), event.git.branch]) });
      for (const row of rows) printLine(`    ${dim(padEnd(row.label, 9))} ${row.value}`);
    }
    const more = result.nextOffset !== null
      ? `more: ${strong(commandWith(`adit cloud sessions events ${result.sessionId}`, { section: options.section, types: options.types, "max-chars": options.maxChars, limit: options.limit, offset: result.nextOffset }))}`
      : null;
    printEnd(dim([`${result.events.length} of ${result.total}`, more].filter(Boolean).join(" · ")));
  } catch (error) { reportFailure(error, options, "sessions events", SYNC_NOT_FOUND); }
}

export async function cloudSessionsLinkCommand(action: "create" | "status" | "renew" | "revoke", sessionId: string, options: Json): Promise<void> {
  try {
    const resolvedId = await sessionArgument(sessionId);
    const result = await cloudSessionLink(requireCloudClient(action === "status" ? 2 : 0), resolvedId, action);
    if (options.json) return printJson(result);
    printTitle("Read link", result.sessionId);
    const link = result.link;
    if (!link || (result.active === false && !link.revokedAt)) {
      printEnd(`${marks.skip} No active read link ${dim("·")} create one: ${strong(`adit cloud sessions link create ${sessionId}`)}`);
      return;
    }
    const minutesLeft = Math.max(0, Math.round((Date.parse(link.expiresAt) - Date.parse(result.serverNow)) / 60_000));
    printRows([
      {
        label: "Status",
        value: link.revokedAt ? stateWord("revoked") : joinParts([stateWord("active"), `${minutesLeft} min left`]),
      },
      { label: "Created", value: localDateTime(link.createdAt) },
      { label: link.revokedAt ? "Revoked" : "Expires", value: localDateTime(link.revokedAt ?? link.expiresAt) },
      { label: "URL", value: result.url ? strong(result.url) : dim("(only shown when created)") },
    ]);
    if (link.revokedAt) {
      printEnd(`${marks.change} Read link revoked`);
    } else if (action === "create" && result.created !== false) {
      printEnd(`${marks.ok} Read link created ${dim("· valid for one hour; share the URL only with the assistant that needs it")}`);
    } else if (action === "create") {
      printEnd(`${marks.skip} An active link already exists ${dim("· the URL is only shown when created; revoke it to get a new one")}`);
    } else if (action === "renew") {
      printEnd(`${marks.ok} Extended by one hour`);
    } else {
      printEnd(dim(`renew: ${strong(`adit cloud sessions link renew ${sessionId}`)}`));
    }
  } catch (error) { reportFailure(error, options, `sessions link ${action}`, SYNC_NOT_FOUND); }
}

export async function cloudCommitsExplainCommand(sha: string, options: Json & { scope?: CloudReadScope; project?: string }): Promise<void> {
  try {
    const result = await explainCloudCommit(requireCloudClient(), sha, { project: options.project, scope: options.scope });
    if (options.json) return printJson(result);
    const { commit } = result;
    printTitle("Commit", shortId(commit.sha), result.scope.description, commit.branch, localDateTime(commit.committedAt), commit.author.name);
    printLine(commit.message.trim());
    if (result.attributions.length === 0) {
      printLine();
      printLine(`${marks.skip} ${dim("no recorded session in this scope is linked to this commit")}`);
    }
    const width = summaryColumns(14);
    for (const attribution of result.attributions) {
      printSection(
        `Session ${attribution.session.id}`,
        truncate(attribution.session.title ?? "untitled", 40),
        attribution.matchType,
        attribution.confidence.toFixed(2),
      );
      const rows: Row[] = [];
      if (attribution.prompt) rows.push({ label: "prompt", value: truncate(attribution.prompt.text, width) });
      if (attribution.response) rows.push({ label: "response", value: truncate(attribution.response.text, width) });
      if (attribution.outlineSections.length) {
        rows.push({ label: "outline", value: truncate(attribution.outlineSections.map((section) => `#${section.sequence} ${section.title}`).join(" · "), width) });
      }
      printRows(rows);
    }
    printEnd(dim(result.note));
  } catch (error) { reportFailure(error, options, "commits explain", `the commit may not be synced yet; run ${strong("adit cloud sync")} in its project`); }
}

// ─── Registration ────────────────────────────────────────────────────────────

function withScope(command: Command): Command {
  return command
    .addOption(new Option("--scope <scope>", "me: your sessions; visible: all sessions you may read").choices(["me", "visible"]).default("me"))
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
  projects.command("list").description("List your projects; use --scope visible to include readable team projects")
    .addOption(new Option("--scope <scope>", "me: your projects (default); visible: all readable projects; legacy --kind team implies visible when omitted").choices(["me", "visible"]))
    .option("--query <text>", "Filter by project or repository name")
    .addOption(new Option("--kind <kind>", "Legacy filter: personal (owned by you) or team (owned by others)").choices(["personal", "team"]))
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
  commits.command("explain <sha>").description("Show your prompts and responses recorded around a commit")
    .addOption(new Option("--scope <scope>", "me: your linked sessions; visible: all readable linked sessions").choices(["me", "visible"]).default("me"))
    .option("--project <id>", "Project ID when a short SHA is ambiguous")
    .option("--json", "Output JSON").action((sha, options) => cloudCommitsExplainCommand(sha, options));
}
