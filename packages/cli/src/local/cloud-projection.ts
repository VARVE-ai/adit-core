import { createHash } from "node:crypto";
import { posix } from "node:path";
import { analyticsSessions, nativeConversationId, projectUploadRepositories, submittedPromptText, redactSecrets, nativeContextKind, nativeContextSql, historyFinalReply, replyCompleted, NON_MERGE_COMMIT_SQL, type LocalStore, type LocalWorkspace } from "@varveai/adit-core";
import { branchFromCommitOutput } from "./commits.js";

type Row = Record<string, any>;
export const syncKey = (...parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const iso = (time: number | null) => time !== null && Number.isFinite(time) ? new Date(time).toISOString() : null;
const parse = (value: string | null) => { try { return value ? JSON.parse(value) : {}; } catch { return {}; } };
/** Source rows append the native session ID; it is not part of the transcript filename. */
function transcriptPath(path: string, nativeId?: string) {
  if (nativeId && path.endsWith(`#${nativeId}`)) path = path.slice(0, -nativeId.length - 1);
  let normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("//?/UNC/")) normalized = `//${normalized.slice(8)}`;
  else if (normalized.startsWith("//?/")) normalized = normalized.slice(4);
  const windows = /^[a-z]:\//i.test(normalized) || normalized.startsWith("//");
  normalized = posix.normalize(normalized);
  return windows ? normalized.toLowerCase() : normalized;
}
export interface CloudBaseline {
  schemaVersion: number; accountId: string; before: string | null;
  serverProjectId?: string;
  knownCommits?: { localRepositoryId: string; sha: string }[];
  repositories: { localRepositoryId: string; relativePath: string; before: string | null; sha: string | null; legacy?: boolean }[];
  sessions: { id: string; platform: string; metadata: string | null; startedAt: string; deleted: boolean; sequence: number;
    lastEventAt?: string | null;
    lastPrompt?: {id:string;at:string;digest:string}|null }[];
  nextCursor: string | null;
}
export interface CloudEvent {
  id: string; sessionId: string; parentEventId: string | null; sequence: number;
  type: "prompt_submit" | "assistant_response" | "git_commit"; text: string | null; startedAt: string;
  usage?: Row[]; usageRevision?: number; commit?: { sha: string; localRepositoryId: string; method: string | null; branch: string | null };
}
export interface CloudSession { id: string; nativeId: string; provider: string; startedAt: string; title: string | null }

export class CloudSessionIndex {
  private identities = new Map<string, number[]>();
  private transcripts = new Map<string, number[]>();
  private ids = new Map<string, CloudBaseline["sessions"]>();
  private paths = new Map<string, Map<string, Set<string>>>();
  constructor(private store: LocalStore, private baseline: CloudBaseline) {
    baseline.sessions.forEach((session, ordinal) => {
      const rows = this.ids.get(session.id) ?? [];
      rows.push(session);this.ids.set(session.id,rows);
      const meta = parse(session.metadata);
      const provider = meta.provider ?? (session.platform.startsWith("claude") ? "claude" : session.platform);
      if (meta.nativeId || meta.platformSessionId) {
        for (const id of new Set([meta.nativeId,meta.platformSessionId])) {
          if (id === undefined) continue;
          this.add(this.identities,JSON.stringify([provider,id]),ordinal);
        }
      } else if (typeof meta.transcriptPath === "string") {
        this.add(this.transcripts,JSON.stringify([provider,transcriptPath(meta.transcriptPath)]),ordinal);
      }
    });
  }
  private add(index: Map<string, number[]>, key: string, ordinal: number) {
    const rows = index.get(key) ?? [];
    rows.push(ordinal);index.set(key,rows);
  }
  byId(id: string) { return this.ids.get(id) ?? []; }
  matches(provider: string, nativeId: string) {
    let paths = this.paths.get(provider);
    if (!paths) {
      paths = new Map();
      const owners = new Map<string, Set<string>>();
      const sources = this.store.db.prepare("SELECT path,session_id FROM adit_history_sources WHERE provider=?").all(provider) as Row[];
      for (const source of sources) {
        const path = transcriptPath(source.path,source.session_id);
        const ids = owners.get(path) ?? new Set<string>();
        ids.add(source.session_id);owners.set(path,ids);
      }
      for (const [path,ids] of owners) if (ids.size === 1) {
        const id = ids.values().next().value!;
        const entries = paths.get(id) ?? new Set<string>();
        entries.add(path);paths.set(id,entries);
      }
      this.paths.set(provider,paths);
    }
    const ordinals = new Set(this.identities.get(JSON.stringify([provider,nativeId])) ?? []);
    for (const path of paths.get(nativeId) ?? [])
      for (const ordinal of this.transcripts.get(JSON.stringify([provider,path])) ?? []) ordinals.add(ordinal);
    return [...ordinals].sort((left,right)=>left-right).map(ordinal=>this.baseline.sessions[ordinal]);
  }
}

export function historicalCloudSessions(store: LocalStore, baseline: CloudBaseline, provider: string, nativeId: string, index = new CloudSessionIndex(store,baseline)) {
  return index.matches(provider,nativeId);
}

export function cloudSessionCutoff(store: LocalStore, scope: string, baseline: CloudBaseline, source: Row, cloudId?: string, index = new CloudSessionIndex(store,baseline)) {
  const nativeId = nativeConversationId(source as {id:string;parent_id:string|null;relationship:string|null});
  const saved = store.db.prepare("SELECT cloud_id FROM adit_local_cloud_sessions WHERE scope=? AND provider=? AND native_id=?")
    .get(scope,source.provider,nativeId) as {cloud_id:string}|undefined;
  const id = cloudId ?? saved?.cloud_id;
  const matches = id ? index.byId(id) : index.matches(source.provider,nativeId);
  if (matches.length === 1 && matches[0].lastEventAt !== undefined)
    return matches[0].lastEventAt === null ? null : Date.parse(matches[0].lastEventAt);
  if (id && !matches.length && (!baseline.before || source.started_at > Date.parse(baseline.before))) return null;
  return baseline.before ? Date.parse(baseline.before) : null;
}

/** Shared by upload and the read-only pending summary. Never confirm history while counting it. */
export function cloudCommitSelection(store: LocalStore, scope: string, baseline: CloudBaseline,
  repo: ReturnType<typeof projectUploadRepositories>[number]) {
  const db = store.db;
  const boundary = baseline.repositories.find(r => r.localRepositoryId === repo.localRepositoryId);
  if (!boundary && baseline.repositories.some(r => r.legacy && r.before)) return null;
  const known = (baseline.knownCommits ?? []).filter(c => c.localRepositoryId === repo.localRepositoryId);
  const findTime = db.prepare("SELECT committed_at FROM adit_local_commits WHERE repository=? AND sha=?");
  const times = known.map(c => (findTime.get(repo.path,c.sha) as Row | undefined)?.committed_at)
    .filter((t): t is number => typeof t === "number");
  const anchor = boundary?.sha ? (findTime.get(repo.path,boundary.sha) as Row | undefined)?.committed_at : null;
  const commitCutoff = times.length ? times.reduce((max,time) => Math.max(max,time),-Infinity) : anchor;
  const cutoff = commitCutoff ?? (boundary?.before ? Date.parse(boundary.before) : null);
  return {
    where: `repository=? AND ${NON_MERGE_COMMIT_SQL}
      AND NOT EXISTS(SELECT 1 FROM adit_local_cloud_receipts r WHERE r.scope=? AND r.kind='commit' AND r.id=? || ':' || c.sha)
      AND c.sha NOT IN (SELECT value FROM json_each(?))
      AND (? IS NULL OR ${commitCutoff != null ? "committed_at" : "authored_at"}>?)`,
    params: [repo.path,scope,repo.localRepositoryId,JSON.stringify(known.map(c => c.sha)),cutoff,cutoff],
  };
}

export function cloudTurnUsage(store: LocalStore, turnId: string): Row[] {
  return store.db.prepare(`SELECT u.*,o.request_id,o.response_id FROM adit_history_usage_entries u
    JOIN adit_history_usage_observations o ON o.id=u.id WHERE u.turn_id=? AND u.ledger_role='canonical' AND u.scope<>'session'
    ORDER BY u.occurred_at,u.id`).all(turnId) as Row[];
}

export function createCloudSyncSchema(store: LocalStore) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS adit_local_cloud_scopes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, baseline TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS adit_local_cloud_sessions (scope TEXT NOT NULL, provider TEXT NOT NULL, native_id TEXT NOT NULL,
      cloud_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, sequence_base INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(scope,provider,native_id));
    CREATE TABLE IF NOT EXISTS adit_local_cloud_receipts (scope TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
      confirmed_at INTEGER NOT NULL, PRIMARY KEY(scope,kind,id));
  `);
  // Old revisions could be marked current after skipping image-only turns.
  // Revisit only sessions with an unacknowledged image prompt; receipts and the
  // inherited Cloud history boundary still decide which events may be sent.
  const upgrade="cloud-image-prompt-projection-v1";
  if(!store.get(upgrade,false))store.db.transaction(()=>{
    const candidates=store.db.prepare(`SELECT DISTINCT c.scope,c.provider,c.native_id,m.id FROM adit_local_cloud_sessions c
      JOIN adit_history_turns t ON t.provider=c.provider AND t.session_id=c.native_id
      JOIN adit_history_messages m ON m.id=t.prompt_message_id JOIN adit_history_blocks b ON b.message_id=m.id
      WHERE c.revision>0 AND b.kind IN ('input_image','image','image_url')
      AND NOT EXISTS(SELECT 1 FROM adit_history_deleted_turns d WHERE d.provider=m.provider AND d.session_id=m.session_id AND d.prompt_key=m.source_key)`).all() as Row[];
    const receipt=store.db.prepare("SELECT 1 FROM adit_local_cloud_receipts WHERE scope=? AND kind='event' AND id=?");
    const reset=store.db.prepare("UPDATE adit_local_cloud_sessions SET revision=0 WHERE scope=? AND provider=? AND native_id=?");
    for(const row of candidates)if(!receipt.get(row.scope,`lh_${syncKey(row.scope,row.id)}`))reset.run(row.scope,row.provider,row.native_id);
    store.set(upgrade,true);
  })();
  const repliesUpgrade="cloud-native-context-projection-v1";
  if(!store.get(repliesUpgrade,false))store.db.transaction(()=>{
    store.db.prepare(`UPDATE adit_local_cloud_sessions AS c SET revision=0 WHERE EXISTS(
      SELECT 1 FROM adit_history_messages m WHERE m.provider=c.provider AND m.session_id=c.native_id AND ${nativeContextSql()})`).run();
    store.set(repliesUpgrade,true);
  })();
}

/** A final text must be supported by native completion evidence or the following user turn. */
export function finalReply(messages: Row[], hasNextTurn: boolean): Row | undefined {
  const candidates = messages.filter(m => m.role === "assistant" && m.text?.trim() && !m.has_tool && !nativeContextKind(m.provider||"codex",parse(m.raw_json),parse(m.extra_json)));
  const candidate = candidates.filter(m=>parse(m.extra_json).finalReply===true).at(-1) || candidates.at(-1);
  if (!candidate) return;
  const raw = parse(candidate.raw_json), payload = raw.payload ?? raw.message ?? raw;
  const phase = payload.phase ?? payload.channel ?? raw.phase;
  const stop = payload.stop_reason ?? payload.finish_reason ?? raw.finish_reason;
  if (replyCompleted(phase,stop,parse(candidate.extra_json).finalReply === true,hasNextTurn,
    messages.some(m => m.ordinal > candidate.ordinal && (m.has_tool || m.role === "tool")))) return candidate;
}

/** The same reply eligibility for upload and counters, reading only candidate metadata.
 * SQL projects completion fields; transcript bodies and tool results never leave SQLite here. */
export function cloudFinalReply(store: LocalStore, turnId: string, hasNextTurn: boolean): {id:string;occurred_at:number|null;ordinal:number} | undefined {
  return historyFinalReply(store.db,turnId,hasNextTurn);
}

export class CloudProjection {
  private sessionIndex: CloudSessionIndex;
  readonly warnings = new Set<string>();
  readonly mappings = new Map<string, CloudSession>();
  constructor(readonly store: LocalStore, readonly workspace: LocalWorkspace, readonly scope: string, readonly baseline: CloudBaseline) {
    this.sessionIndex = new CloudSessionIndex(store,baseline);
  }
  private nativeKey(provider: string, id: string) { return `${provider}\0${id}`; }
  receipt(kind: string, id: string) {
    return !!this.store.db.prepare("SELECT 1 FROM adit_local_cloud_receipts WHERE scope=? AND kind=? AND id=?").get(this.scope, kind, id);
  }
  confirm(kind: string, ids: string[]) {
    const insert = this.store.db.prepare("INSERT OR IGNORE INTO adit_local_cloud_receipts VALUES (?,?,?,?)");
    this.store.db.transaction(() => ids.forEach(id => insert.run(this.scope, kind, id, Date.now())))();
  }
  private text(message: Row) {
    return redactSecrets((this.store.db.prepare(`SELECT coalesce(e.text_content,b.text_content,'') text FROM adit_history_blocks b
      LEFT JOIN adit_history_text_edits e ON e.provider=? AND e.session_id=? AND e.message_key=? AND e.block_index=b.block_index
      WHERE b.message_id=? AND b.kind IN ('text','input_text','output_text') ORDER BY b.block_index`)
      .all(message.provider, message.session_id, message.source_key, message.id) as {text:string}[]).map(b => b.text).join("\n"));
  }
  private prompt(message:Row):string|null {
    if(nativeContextKind(message.provider,parse(message.raw_json)))return null;
    const images=(this.store.db.prepare("SELECT count(*) n FROM adit_history_blocks WHERE message_id=? AND kind IN ('input_image','image','image_url')")
      .get(message.id) as {n:number}).n;
    return submittedPromptText(message.provider,typeof message.text==='string'?message.text:this.text(message),images);
  }
  private mapSession(s: Row): CloudSession | undefined {
    const db = this.store.db, key = this.nativeKey(s.provider, s.id);
    if(this.mappings.has(key))return this.mappings.get(key);
    const nativeId=nativeConversationId(s as {id:string;parent_id:string|null;relationship:string|null});
    if(nativeId!==s.id) {
      const root=db.prepare("SELECT * FROM adit_history_sessions WHERE provider=? AND id=?").get(s.provider,nativeId) as Row|undefined;
      const canonical=this.mapSession(root || {...s,id:nativeId,source_id:s.id,parent_id:null,relationship:null});
      if(!canonical)return;
      const saved=db.prepare("SELECT * FROM adit_local_cloud_sessions WHERE scope=? AND provider=? AND native_id=?").get(this.scope,s.provider,s.id) as Row|undefined;
      if(saved && saved.cloud_id!==canonical.id) {
        this.warnings.add("This conversation was previously uploaded under separate segment identities. Reconcile the existing Cloud records before uploading its continuation.");
        return;
      }
      if(!saved) {
        const previous=db.prepare(`SELECT max(m.sequence_base+coalesce(s.message_count,0)*2+2) next FROM adit_local_cloud_sessions m
          LEFT JOIN adit_history_sessions s ON s.provider=m.provider AND s.id=m.native_id WHERE m.scope=? AND m.cloud_id=?`)
          .get(this.scope,canonical.id) as {next:number|null};
        db.prepare("INSERT INTO adit_local_cloud_sessions(scope,provider,native_id,cloud_id,sequence_base) VALUES (?,?,?,?,?)")
          .run(this.scope,s.provider,s.id,canonical.id,previous.next||0);
      }
      this.mappings.set(key,canonical);return canonical;
    }
    const row = db.prepare("SELECT * FROM adit_local_cloud_sessions WHERE scope=? AND provider=? AND native_id=?").get(this.scope, s.provider, s.id) as Row | undefined;
    let id = row?.cloud_id, base = row?.sequence_base ?? 0;
    if (!id) {
      const matches = this.sessionIndex.matches(s.provider,s.id);
      if (matches.length > 1 || matches[0]?.deleted) { this.warnings.add("A historical session identity is ambiguous or deleted in Cloud; its new content is pending."); return; }
      if (matches.length === 1) { id = matches[0].id; base = matches[0].sequence + 1; }
      else {
        const before = this.baseline.before ? Date.parse(this.baseline.before) : null;
        if (before !== null && (s.started_at === null || s.started_at <= before)) {
          if (s.last_activity_at > before) this.warnings.add("A session crosses the Cloud history boundary but its original identity could not be verified; its new content is pending.");
          return;
        }
        id = `lh_${syncKey(this.scope, s.provider, s.id)}`;
      }
      db.prepare("INSERT INTO adit_local_cloud_sessions(scope,provider,native_id,cloud_id,sequence_base) VALUES (?,?,?,?,?)").run(this.scope, s.provider, s.id, id, base);
    }
    const time = iso(s.started_at);
    if (!time) { this.warnings.add("Sessions without a recorded start time remain local until a reliable timestamp is available."); return; }
    const meta = db.prepare("SELECT title,first_prompt FROM adit_history_sessions WHERE provider=? AND id=?").get(s.provider, s.source_id||s.id) as Row;
    const hasDeleted = db.prepare("SELECT 1 FROM adit_history_deleted_turns WHERE provider=? AND session_id=? LIMIT 1").get(s.provider,s.id);
    const firstVisible = hasDeleted ? db.prepare(`SELECT m.* FROM adit_history_turns t JOIN adit_history_messages m ON m.id=t.prompt_message_id
      WHERE t.provider=? AND t.session_id=? AND NOT EXISTS(SELECT 1 FROM adit_history_deleted_turns d
        WHERE d.provider=t.provider AND d.session_id=t.session_id AND d.prompt_key=m.source_key) ORDER BY t.ordinal LIMIT 1`).get(s.provider,s.id) as Row|undefined : undefined;
    const title = hasDeleted ? (firstVisible ? this.prompt(firstVisible) : "") : meta.title || meta.first_prompt || "";
    const session = { id, nativeId: s.id, provider: s.provider, startedAt: time, title: redactSecrets(title).slice(0,4096) || null };
    this.mappings.set(key, session);
    return session;
  }
  sessions() {
    return analyticsSessions(this.store.db, this.workspace).sort((a,b)=>(a.started_at??0)-(b.started_at??0)||a.id.localeCompare(b.id))
      .map(s => ({ source: s, session: this.mapSession(s) })).filter(s => !!s.session);
  }
  eventId(nativeId: string) { return `lh_${syncKey(this.scope, nativeId)}`; }
  promptId(turnId: string | null): string | null {
    if (!turnId) return null;
    const turn = this.store.db.prepare("SELECT prompt_message_id FROM adit_history_turns WHERE id=?").get(turnId) as Row | undefined;
    const id = turn ? this.eventId(turn.prompt_message_id) : null;
    return id && this.receipt("event", id) ? id : null;
  }
  *sessionBatches(s: Row, session: CloudSession): Generator<CloudEvent[]> {
    const db = this.store.db;
    const state = db.prepare("SELECT revision,sequence_base FROM adit_local_cloud_sessions WHERE scope=? AND provider=? AND native_id=?").get(this.scope,s.provider,s.id) as Row;
    if (state.revision === s.transcript_revision) return;
    const turns = db.prepare("SELECT * FROM adit_history_turns WHERE provider=? AND session_id=? ORDER BY ordinal").all(s.provider,s.id) as Row[];
    if (db.prepare("SELECT 1 FROM adit_history_usage_entries WHERE provider=? AND session_id=? AND scope='session' AND ledger_role='canonical' LIMIT 1").get(s.provider,s.id))
      this.warnings.add("Some sources only provide a session-wide usage total. It remains local and is not counted as an individual turn's usage.");
    let pending = false;
    const cutoff = cloudSessionCutoff(this.store,this.scope,this.baseline,s,session.id,this.sessionIndex);
    for (let index=0; index<turns.length; index++) {
      const t = turns[index];
      const usageRows = cloudTurnUsage(this.store,t.id);
      const usageKey = syncKey(t.id,usageRows);
      if (cutoff !== null && t.ended_at !== null && t.ended_at <= cutoff) continue;
      const finalHead = cloudFinalReply(this.store,t.id,index < turns.length-1);
      if (finalHead && this.receipt("event",this.eventId(finalHead.id)) && this.receipt("turn",t.id) && this.receipt("usage",usageKey))continue;
      const messages: Row[] = (db.prepare(`SELECT m.*,EXISTS(SELECT 1 FROM adit_history_tool_calls c WHERE c.message_id=m.id) has_tool
        FROM adit_history_messages m WHERE m.turn_id=? ORDER BY m.ordinal`).all(t.id) as Row[]).map(m => ({...m,text:this.text(m)}));
      const prompt = messages.find(m => m.id === t.prompt_message_id);
      if (!prompt || db.prepare("SELECT 1 FROM adit_history_deleted_turns WHERE provider=? AND session_id=? AND prompt_key=?").get(s.provider,s.id,prompt.source_key)) continue;
      const content = this.prompt(prompt);
      if (!content) continue;
      const final = finalHead ? messages.find(m => m.id === finalHead.id) : undefined;
      if (!iso(prompt.occurred_at)) {
        this.warnings.add("Some messages have no reliable timestamp and remain pending."); pending=true; continue;
      }
      const events: CloudEvent[] = [];
      const pid = this.eventId(prompt.id);
      const newPrompt = cutoff === null || (prompt.occurred_at !== null && prompt.occurred_at > cutoff);
      const oldPrompt = this.baseline.sessions.find(s => s.id === session.id)?.lastPrompt;
      const inheritedPrompt = !newPrompt && oldPrompt && oldPrompt.at === iso(prompt.occurred_at) &&
        [content.trim(),prompt.text.trim()].some(text => syncKey("prompt",text) === oldPrompt.digest) ? oldPrompt.id : null;
      if (newPrompt && !this.receipt("event",pid)) {
        if (!iso(prompt.occurred_at)) { this.warnings.add("Some messages have no reliable timestamp and remain pending."); pending=true; continue; }
        events.push({id:pid,sessionId:session.id,parentEventId:null,sequence:state.sequence_base+prompt.ordinal*2,type:"prompt_submit",text:content,startedAt:iso(prompt.occurred_at)!});
      }
      const fid = final ? this.eventId(final.id) : null;
      if (final && !iso(final.occurred_at)) {
        this.warnings.add("Some final replies have no reliable timestamp and remain pending."); pending=true;
      } else if (final && fid && (!this.receipt("event",fid) || !this.receipt("usage",usageKey)) && (cutoff === null || final.occurred_at > cutoff)) {
        const usage = usageRows
          .filter(u => cutoff === null || (u.occurred_at !== null && u.occurred_at > cutoff)).map(u => ({
            id:syncKey(this.scope,u.id),provider:u.provider,model:u.model,occurredAt:iso(u.occurred_at),requestId:u.request_id,responseId:u.response_id,
            inputTokens:u.input_total_tokens,uncachedInputTokens:u.uncached_input_tokens,outputTokens:u.output_tokens,
            cacheReadTokens:u.cache_read_tokens,cacheWriteTokens:u.cache_write_tokens,reasoningTokens:u.reasoning_tokens,
            totalTokens:u.total_tokens,complete:u.completeness==="complete",
          }));
        events.push({id:fid,sessionId:session.id,parentEventId:events.some(e=>e.id===pid)||this.receipt("event",pid)?pid:inheritedPrompt,
          sequence:state.sequence_base+final.ordinal*2,type:"assistant_response",text:final.text,startedAt:iso(final.occurred_at)!,usage,usageRevision:s.transcript_revision});
      }
      if (events.length) yield events;
      // Enumerating the generator alone must never confirm an upload.
      if (events.some(e => !this.receipt("event", e.id))) { pending = true; continue; }
      // Prompts are independent events, as in the original CLI. A prompt-only
      // upload must not close this turn: a later reply still needs to be sent.
      if (final && iso(final.occurred_at)) {
        this.confirm("turn", [t.id]);
        this.confirm("usage", [usageKey]);
      }
    }
    if (!pending) db.prepare("UPDATE adit_local_cloud_sessions SET revision=? WHERE scope=? AND provider=? AND native_id=?").run(s.transcript_revision,this.scope,s.provider,s.id);
  }
  *commitBatches(): Generator<{commit:Row; events:CloudEvent[]; sessions:CloudSession[]}> {
    const db=this.store.db;
    const run=db.prepare("SELECT id FROM adit_attribution_runs WHERE workspace_id=? AND status='done' ORDER BY started_at DESC LIMIT 1").get(this.workspace.id) as Row|undefined;
    for (const repo of projectUploadRepositories(db,this.workspace)) {
      const selection=cloudCommitSelection(this.store,this.scope,this.baseline,repo);
      if(!selection) {
        this.warnings.add("Cloud has legacy Git history without a verified repository identity; new commits remain pending to avoid reuploading old history.");
        continue;
      }
      const rows=db.prepare(`SELECT c.* FROM adit_local_commits c WHERE ${selection.where} ORDER BY authored_at,sha`).all(...selection.params) as Row[];
      for (const c of rows) {
        const a=run?db.prepare("SELECT * FROM adit_attribution_commits WHERE run_id=? AND repository=? AND sha=?").get(run.id,repo.path,c.sha) as Row|undefined:undefined;
        if (!a) { this.warnings.add("New commits awaiting local attribution analysis remain pending."); continue; }
        if (!iso(c.authored_at)) { this.warnings.add("Commits without a reliable timestamp remain pending."); continue; }
        const groups=db.prepare(`SELECT provider,session_id,sum(certain_lines) certain,sum(likely_lines) likely,sum(possible_lines) possible
          FROM adit_attribution_writers WHERE run_id=? AND repository=? AND sha=? AND provider IS NOT NULL GROUP BY provider,session_id`).all(run!.id,repo.path,c.sha) as Row[];
        const missingSource = [...groups, ...(a.submit_session_id ? [{provider:a.submit_provider,session_id:a.submit_session_id}] : [])]
          .some(g => !this.mappings.has(this.nativeKey(g.provider,g.session_id)) &&
            db.prepare("SELECT 1 FROM adit_history_turns WHERE provider=? AND session_id=? LIMIT 1").get(g.provider,g.session_id));
        if (missingSource) { this.warnings.add("Some commits reference a historical session whose Cloud identity could not be verified; those commits remain pending."); continue; }
        const associations=new Map<string,Row>();
        for (const g of groups) {
          const session=this.mappings.get(this.nativeKey(g.provider,g.session_id));
          if(session) {
            const old=associations.get(session.id);
            associations.set(session.id,{sessionId:session.id,promptEventId:null,committed:false,
              certain:(old?.certain||0)+g.certain,likely:(old?.likely||0)+g.likely,possible:(old?.possible||0)+g.possible,method:null});
          }
        }
        const submit=a.submit_session_id?this.mappings.get(this.nativeKey(a.submit_provider,a.submit_session_id)):undefined;
        const outputs=a.submit_tool_call_id?(db.prepare("SELECT content_text FROM adit_history_tool_results WHERE tool_call_id=?").all(a.submit_tool_call_id) as Row[]).map(r=>r.content_text||""):[];
        const branch=a.match_method==="hash"?branchFromCommitOutput(outputs,c.sha):null;
        const events:CloudEvent[]=[];
        if(submit && a.submit_turn_id) {
          const turn=db.prepare("SELECT t.*,m.source_key FROM adit_history_turns t JOIN adit_history_messages m ON m.id=t.prompt_message_id WHERE t.id=?").get(a.submit_turn_id) as Row|undefined;
          const deleted=turn&&db.prepare("SELECT 1 FROM adit_history_deleted_turns WHERE provider=? AND session_id=? AND prompt_key=?").get(a.submit_provider,a.submit_session_id,turn.source_key);
          if(turn&&!deleted) {
            const previous=associations.get(submit.id);
            associations.set(submit.id,{sessionId:submit.id,committed:true,certain:0,likely:0,possible:0,...previous,promptEventId:this.promptId(a.submit_turn_id),method:a.match_method});
            associations.get(submit.id)!.committed=true;
            const call=db.prepare("SELECT * FROM adit_history_tool_calls WHERE id=?").get(a.submit_tool_call_id) as Row|undefined;
            const succeeded=!!db.prepare("SELECT 1 FROM adit_history_tool_results WHERE tool_call_id=? AND (exit_code=0 OR status IN ('success','completed')) LIMIT 1").get(a.submit_tool_call_id)
              || (a.matched_sha && outputs.some(output=>output.includes(a.matched_sha)));
            if(call && succeeded && iso(call.occurred_at) && (!this.baseline.before || call.occurred_at>Date.parse(this.baseline.before))) {
              const id=this.eventId(`commit:${repo.localRepositoryId}:${c.sha}`);
              if(!this.receipt("event",id)) events.push({id,sessionId:submit.id,parentEventId:this.promptId(a.submit_turn_id),
                sequence:turn.ordinal*2,type:"git_commit",text:redactSecrets(c.subject),startedAt:iso(call.occurred_at)!,
                commit:{sha:c.sha,localRepositoryId:repo.localRepositoryId,method:a.match_method,branch}});
            }
          }
        }
        const attributions=[...associations.values()];
        const required=[...new Set([...attributions.map(a=>a.sessionId),...events.map(e=>e.sessionId)])];
        // Only reference sessions whose projected history has been acknowledged (or inherited).
        const sessions=[...new Map([...this.mappings.values()].filter(s=>required.includes(s.id)).map(s=>[s.id,s])).values()];
        yield {sessions,events,commit:{localRepositoryId:repo.localRepositoryId,sha:c.sha,parentSha:(db.prepare("SELECT parent_sha FROM adit_local_commit_parents WHERE repository=? AND sha=? AND ordinal=0").get(repo.path,c.sha) as Row|undefined)?.parent_sha??null,
          date:iso(c.authored_at),authorName:c.author_name,authorEmail:c.author_email,message:redactSecrets(c.body||c.subject),branch,
          files:db.prepare("SELECT path,additions,deletions FROM adit_local_commit_files WHERE repository=? AND sha=? ORDER BY ordinal").all(repo.path,c.sha),attributions,
          totals:{eligible:a.eligible_lines,excluded:a.excluded_lines,certain:a.certain_lines,likely:a.likely_lines,possible:a.possible_lines,moved:a.moved_lines,unknown:a.unknown_lines}}};
      }
    }
  }
}
