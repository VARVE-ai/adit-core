import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  LocalSessionBrowser, analyticsSessions, conversationSegments, localDataDir,
  resolveLocalProject, pathKey, redactOverview,
  type LocalWorkspace, type SessionEvent, type SessionTurn, type TranscriptMode,
} from "@varveai/adit-core";
import { queryCommits } from "./commits.js";
import { queryCommitSources } from "./commit-sources.js";

export class HistoryQueryError extends Error {
  constructor(public code: string, message: string, public candidates?: unknown[]) { super(message); }
}
type ScopeOptions = { workspace?: string; cwd?: string };

/** Opens only the collected global store. No schema setup, daemon, Git, native logs or Cloud. */
export class LocalHistoryReader {
  readonly db: Database.Database;
  readonly browser: LocalSessionBrowser;
  constructor(readonly directory = localDataDir()) {
    const filename = join(directory, "local.sqlite");
    if (!existsSync(filename)) throw new HistoryQueryError("HISTORY_NOT_COLLECTED", "No collected local history. Add a working directory in ADIT Settings and run Start organizing first.");
    this.db = new Database(filename, { readonly: true, fileMustExist: true, timeout: 3000 });
    try {
      const columns = this.db.prepare("PRAGMA table_info(adit_history_sessions)").all() as { name: string }[];
      if (!columns.some(c => c.name === "transcript_revision"))
        throw new HistoryQueryError("HISTORY_NOT_COLLECTED", "The local history store is not ready for browsing. Open ADIT Settings and organize the working directory.");
      this.browser = new LocalSessionBrowser(this.db);
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  private registered(): LocalWorkspace[] {
    return (this.db.prepare("SELECT data FROM adit_local_workspaces ORDER BY id").all() as { data: string }[]).map(r => JSON.parse(r.data));
  }
  workspaces() {
    return this.registered().map(w => ({ id: w.id, name: w.name, path: w.path, providers: w.providers, started: w.started }));
  }
  workspace(options: ScopeOptions = {}) {
    const workspaces = this.registered();
    let selected: LocalWorkspace | undefined;
    if (options.workspace) {
      const value = options.workspace;
      const candidates = workspaces.filter(w => w.id === value);
      if (!candidates.length) candidates.push(...workspaces.filter(w => w.name === value || pathKey(w.path) === pathKey(value)));
      if (candidates.length !== 1) throw new HistoryQueryError(candidates.length ? "WORKSPACE_AMBIGUOUS" : "WORKSPACE_NOT_FOUND",
        "Select a registered working directory with --workspace <id>.", this.workspaces());
      selected = candidates[0];
    }
    try {
      const resolved = resolveLocalProject({ directory: this.directory, path: selected?.path ?? options.cwd,
        ...(selected ? { workspaceId: selected.id } : {}) });
      const w = workspaces.find(w => w.id === resolved.projectId);
      if (resolved.source === "registry" && w) return w;
    } catch (error) {
      throw new HistoryQueryError("WORKSPACE_REQUIRED", `${error instanceof Error ? error.message : "Cannot resolve the working directory"}. Use adit history workspaces and --workspace <id>.`, this.workspaces());
    }
    throw new HistoryQueryError("WORKSPACE_REQUIRED", "Select a collected working directory with --workspace <id>.", this.workspaces());
  }
  metadata(w: LocalWorkspace) {
    const times = analyticsSessions(this.db, w).map(s => s.last_activity_at).filter((n): n is number => n !== null);
    return { source: "local" as const, workspace: { id: w.id, name: w.name, path: w.path },
      coverage: { lastEventAt: times.length ? times.reduce((a, b) => Math.max(a, b)) : null, readAt: Date.now(), collectedOnly: true },
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
  session(w: LocalWorkspace, id: string, provider?: string) {
    const candidates = analyticsSessions(this.db, w).filter(s => s.id === id && (!provider || s.provider === provider));
    if (candidates.length !== 1) throw new HistoryQueryError(candidates.length ? "SESSION_AMBIGUOUS" : "SESSION_NOT_FOUND",
      candidates.length ? "Pass --provider to select this session." : "This session is not in the selected working directory.",
      candidates.map(s => ({ provider: s.provider, id: s.id })));
    return { provider: candidates[0].provider, id };
  }
  show(w: LocalWorkspace, id: string, options: { provider?: string; mode?: TranscriptMode; offset?: number; query?: string; maxChars: number }) {
    const s = this.session(w, id, options.provider);
    const { cost: _cost, unpriced: _unpriced, ...detail } = this.browser.detail(w, s.provider, s.id, options.mode ?? "focused", options.offset, options.query);
    return { ...detail, turns: detail.turns.map(t => clipTurn(t, options.maxChars)), context: detail.context.map(e => clipEvent(e, options.maxChars)) };
  }
  commits(w: LocalWorkspace, options: { session?: string; provider?: string; repository?: string; limit: number; offset: number }) {
    const session = options.session ? this.session(w, options.session, options.provider) : undefined;
    return queryCommits(this, w, { limit: options.limit, offset: options.offset, repository: this.repository(w, options.repository),
      ...(session ? { session: { provider: session.provider, ids: conversationSegments(this.db, session.provider, session.id) } } : {}) });
  }
  async commit(w: LocalWorkspace, sha: string, repository?: string) {
    if (!/^[a-f0-9]{7,64}$/i.test(sha)) throw new HistoryQueryError("INVALID_COMMIT", "Use a Git SHA with 7 to 64 hexadecimal characters.");
    const result = queryCommits(this, w, { sha: sha.toLowerCase(), repository: this.repository(w, repository), limit: 20 });
    if (result.total !== 1) throw new HistoryQueryError(result.total ? "COMMIT_AMBIGUOUS" : "COMMIT_NOT_FOUND",
      result.total ? "Use a longer SHA or --repo <path>." : "No collected commit matches this SHA in the selected working directory.",
      result.commits.map(c => ({ sha: c.sha, repository: c.repository, subject: c.subject })));
    const commit = result.commits[0];
    return { commit, authorship: await queryCommitSources(this, w, commit.repository, commit.sha) };
  }
  private repository(w: LocalWorkspace, path?: string) {
    if (!path) return undefined;
    const found = w.repositories.find(r => pathKey(r) === pathKey(path));
    if (!found) throw new HistoryQueryError("REPOSITORY_NOT_FOUND", "The repository is not registered in this working directory.");
    return found;
  }
}
export function clipEvent(event: SessionEvent, maxChars: number): SessionEvent {
  return { ...event, text: event.text.slice(0, maxChars), ...(event.truncated || event.text.length > maxChars ? { truncated: true } : {}) };
}
export function clipTurn(turn: SessionTurn, maxChars: number): SessionTurn {
  return { ...turn, prompt: turn.prompt.slice(0, maxChars), promptTruncated: turn.promptTruncated || turn.prompt.length > maxChars,
    events: turn.events.map(e => clipEvent(e, maxChars)), openingEvents: turn.openingEvents?.map(e => clipEvent(e, maxChars)), closingEvents: turn.closingEvents?.map(e => clipEvent(e, maxChars)) };
}
export function historyError(error: unknown) {
  return { ok: false, source: "local", code: error instanceof HistoryQueryError ? error.code : "LOCAL_HISTORY_ERROR",
    error: redactOverview(error instanceof Error ? error.message : String(error)),
    ...(error instanceof HistoryQueryError && error.candidates ? { candidates: error.candidates } : {}) };
}
