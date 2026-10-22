import type Database from "better-sqlite3";
import { LocalStateError, type LocalWorkspace } from "../local-state.js";
import { analyticsSessions } from "./analytics-scope.js";
import { conversationSegments } from "./session-identity.js";
import { NON_MERGE_COMMIT_SQL } from "./commit-policy.js";
import type { LocalPrices, CostUsage } from "./pricing.js";
import { redactSecrets, redactSecretValue } from "./secret-detector.js";
import { sourceDefinitions } from "./sources.js";
import { hasCodexPromptContext, promptText, promptSummary, promptImageCount } from "./prompt-summary.js";
import { replaceTextBlock } from "./transcript-edits.js";
import { cursorUserQuery } from "./cursor-prompt.js";
import { nativeContextSql, historyFinalReply } from "./message-semantics.js";
import {
  sessionToolDisplay,
  type SessionToolDisplay,
} from "./session-tool-display.js";

type Row = Record<string, any>;
export type TranscriptMode = "normal" | "focused";
export type SessionItem = {
  provider: string;
  id: string;
  title: string;
  startedAt: number | null;
  lastActivityAt: number | null;
  messages: number;
  prompts: number;
  commits: number;
  match?: { turnId: string | null; text: string; eventId: string };
};
export type SessionList = {
  items: SessionItem[];
  total: number;
  messages: number;
  first: number | null;
  providers: { id: string; name: string; count: number }[];
  nextOffset: number | null;
};
export type SessionCommit = {
  repository: string;
  sha: string;
  subject: string;
  at: number | null;
  turnId: string | null;
};
export type SessionEvent = {
  id: string;
  kind: "reply" | "thinking" | "system" | "tool" | "result" | "attachment";
  text: string;
  at: number | null;
  name?: string;
  truncated?: boolean;
  display?: SessionToolDisplay;
};
export type SessionUsage = {
  input: number | null;
  output: number | null;
  cache: number | null;
  cacheWrite: number | null;
  requests: number;
  models: string[];
  efforts: string[];
};
export type SessionTurn = {
  id: string;
  ordinal: number;
  prompt: string;
  imageCount?: number;
  promptBlockId: string | null;
  promptBlockIds?: string[];
  promptTruncated: boolean;
  at: number | null;
  usage: SessionUsage;
  events: SessionEvent[];
  openingEvents?: SessionEvent[];
  closingEvents?: SessionEvent[];
  nextOffset: number | null;
  commits: SessionCommit[];
  contextOnly: boolean;
  previousOffset: number | null;
  matchEventId: string | null;
};
export type SessionDetail = {
  session: SessionItem;
  models: string[];
  cost: number | null;
  unpriced: number;
  repositories: { path: string; commits: number }[];
  turns: SessionTurn[];
  totalTurns: number;
  nextOffset: number | null;
  children: SessionItem[];
  parent: { provider: string; id: string } | null;
  commits: SessionCommit[];
  context: SessionEvent[];
  contextNextOffset: number | null;
  previousOffset: number | null;
  matchTurnId: string | null;
};
export type SessionContent = { text: string; nextOffset: number | null };
export type SessionTurnEdit = {
  turnId: string;
  revision: number;
  blocks: { id: string; kind: "prompt" | "reply"; text: string }[];
};
const parse = (text: string | null) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
};
const offsetOf = (value = 0) =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0;
const textKinds = "'text','input_text','output_text'";
const item = (r: Row): SessionItem => ({
  provider: r.provider,
  id: r.id,
  title: redactSecrets(r.title || r.first_prompt || ""),
  startedAt: r.started_at,
  lastActivityAt: r.last_activity_at,
  messages: r.message_count,
  prompts: r.user_prompt_count,
  commits: r.commits || 0,
});

/** Paged views and explicit local edits. Browsing never reads native logs or runs analysis. */
export class LocalSessionBrowser {
  constructor(
    private db: Database.Database,
    private prices?: Pick<LocalPrices, "estimate">,
  ) {}

  private scope(w: LocalWorkspace) {
    return analyticsSessions(this.db, w);
  }
  private run(w: LocalWorkspace): string | null {
    return (
      (
        this.db
          .prepare(
            "SELECT id FROM adit_attribution_runs WHERE workspace_id=? AND status='done' ORDER BY started_at DESC LIMIT 1",
          )
          .get(w.id) as Row | undefined
      )?.id ?? null
    );
  }
  private session(w: LocalWorkspace, provider: string, id: string): Row {
    if (!this.scope(w).some((s) => s.provider === provider && s.id === id))
      throw new LocalStateError("Session not found", 404);
    return this.db
      .prepare("SELECT * FROM adit_history_sessions WHERE provider=? AND id=?")
      .get(provider, id) as Row;
  }
  private segments(provider:string,id:string) { return JSON.stringify(conversationSegments(this.db,provider,id)); }
  private turnRows(provider:string,id:string) {
    return this.db.prepare(`SELECT t.* FROM adit_history_turns t JOIN json_each(?) q ON q.value=t.session_id
      WHERE t.provider=? ORDER BY CAST(q.key AS INTEGER),t.ordinal`).all(this.segments(provider,id),provider) as Row[];
  }
  private commits(
    w: LocalWorkspace,
    provider: string,
    id: string,
  ): SessionCommit[] {
    return (
      this.db
        .prepare(
          `SELECT c.repository,c.sha,c.subject,c.authored_at AS at,
      CASE WHEN EXISTS(SELECT 1 FROM adit_history_turns t WHERE t.id=a.submit_turn_id) THEN a.submit_turn_id ELSE NULL END AS turnId
      FROM adit_attribution_commits a JOIN adit_local_commits c ON c.repository=a.repository AND c.sha=a.sha
      WHERE a.run_id=? AND a.submit_provider=? AND a.submit_session_id IN (SELECT value FROM json_each(?))
      AND c.repository IN (SELECT value FROM json_each(?)) AND ${NON_MERGE_COMMIT_SQL}
      ORDER BY c.authored_at,c.sha`,
        )
        .all(
          this.run(w),
          provider,
          this.segments(provider,id),
          JSON.stringify(w.repositories),
        ) as SessionCommit[]
    ).map((c) => ({ ...c, subject: redactSecrets(c.subject) }));
  }
  list(
    w: LocalWorkspace,
    options: {
      provider?: string;
      query?: string;
      onlyCommits?: boolean;
      sort?: string;
      offset?: number;
      limit?: number;
      from?: number;
      to?: number;
    } = {},
  ): SessionList {
    return this.db.transaction(() => {
      const scope = JSON.stringify(
        this.scope(w).filter((s) => !s.parent_id || s.relationship === "fork" || s.relationship === "continuation"),
      );
      const query = (options.query || "").trim().slice(0, 300);
      const pattern = "%" + query.replace(/[\\%_]/g, "\\$&") + "%";
      // Keep FTS on the outer side of this join. Joining its unindexed message_id
      // once per transcript message turns an ordinary search into a quadratic scan.
      const matches = query
        ? this.db
            .prepare(
              `SELECT DISTINCT m.provider,m.session_id id
        FROM adit_history_text_fts f CROSS JOIN adit_history_messages m ON m.id=f.message_id
        WHERE ${query.length >= 3 ? "adit_history_text_fts MATCH @fts" : "f.text_content LIKE @pattern ESCAPE '\\'"}
        UNION SELECT provider,session_id id FROM adit_history_tool_calls
        WHERE command_text LIKE @pattern ESCAPE '\\' OR input_json LIKE @pattern ESCAPE '\\'`,
            )
            .all({ fts: '"' + query.replace(/"/g, '""') + '"', pattern })
        : [];
      const cte = `WITH scope AS (SELECT json_extract(value,'$.provider') provider,json_extract(value,'$.id') id,json_extract(value,'$.conversation_id') conversation_id FROM json_each(@scope)),
        matched AS (SELECT q.provider,q.conversation_id id FROM json_each(@matches) m JOIN scope q
          ON q.provider=json_extract(m.value,'$.provider') AND q.id=json_extract(m.value,'$.id')),
        linked AS (SELECT a.submit_provider provider,a.submit_session_id id,count(*) commits
          FROM adit_attribution_commits a JOIN adit_local_commits c ON c.repository=a.repository AND c.sha=a.sha
          WHERE a.run_id=@run AND c.repository IN (SELECT value FROM json_each(@repositories)) AND ${NON_MERGE_COMMIT_SQL}
          GROUP BY a.submit_provider,a.submit_session_id),
        visible AS (SELECT s.provider,q.conversation_id id,root.title,root.first_prompt,min(s.started_at) started_at,max(s.last_activity_at) last_activity_at,
          sum(s.message_count) message_count,sum(s.user_prompt_count) user_prompt_count,sum(coalesce(l.commits,0)) commits
          FROM scope q JOIN adit_history_sessions s ON s.provider=q.provider AND s.id=q.id
          JOIN adit_history_sessions root ON root.provider=q.provider AND root.id=q.conversation_id
          LEFT JOIN linked l ON l.provider=s.provider AND l.id=s.id GROUP BY s.provider,q.conversation_id),
        filtered AS (SELECT s.* FROM visible s WHERE (@provider='all' OR s.provider=@provider) AND (@only=0 OR s.commits>0)
          AND (@from IS NULL OR s.last_activity_at>=@from) AND (@to IS NULL OR s.started_at<=@to)
          AND (@query='' OR s.title LIKE @pattern ESCAPE '\\' OR s.first_prompt LIKE @pattern ESCAPE '\\'
            OR EXISTS(SELECT 1 FROM matched m WHERE m.provider=s.provider AND m.id=s.id)))`;
      const params = {
        scope,
        run: this.run(w),
        repositories: JSON.stringify(w.repositories),
        provider: options.provider || "all",
        only: options.onlyCommits ? 1 : 0,
        query,
        pattern,
        matches: JSON.stringify(matches),
        from: options.from ?? null,
        to: options.to ?? null,
      };
      const summary = this.db
        .prepare(
          cte +
            " SELECT count(*) total,coalesce(sum(message_count),0) messages,min(started_at) first FROM filtered",
        )
        .get(params) as Row;
      const names = new Map(sourceDefinitions().map((p) => [p.id, p.name]));
      const providers = (
        this.db
          .prepare(
            cte +
              " SELECT provider,count(*) count FROM visible GROUP BY provider ORDER BY provider",
          )
          .all(params) as Row[]
      ).map((p) => ({
        id: p.provider,
        name: names.get(p.provider) || p.provider,
        count: p.count,
      }));
      const sort =
        {
          activity: "last_activity_at DESC",
          started: "started_at DESC",
          oldest: "started_at ASC",
          messages: "message_count DESC",
        }[options.sort || "activity"] || "last_activity_at DESC";
      const offset = offsetOf(options.offset);
      const limit = Math.min(50, Math.max(1, offsetOf(options.limit ?? 50)));
      const items = (
        this.db
          .prepare(
            cte +
              ` SELECT * FROM filtered ORDER BY ${sort},provider,id LIMIT @limit OFFSET @offset`,
          )
          .all({ ...params, offset, limit }) as Row[]
      ).map(item);
      if (query)
        for (const s of items)
          s.match = this.findMatch(s.provider, s.id, query) || undefined;
      return {
        items,
        providers,
        total: summary.total,
        messages: summary.messages,
        first: summary.first,
        nextOffset:
          offset + items.length < summary.total ? offset + items.length : null,
      };
    })();
  }

  private findMatch(
    provider: string,
    id: string,
    query: string,
  ): { turnId: string | null; text: string; eventId: string } | null {
    if (!query.trim()) return null;
    const pattern =
      "%" +
      query
        .trim()
        .slice(0, 300)
        .replace(/[\\%_]/g, "\\$&") +
      "%";
    const found = this.db
      .prepare(
        `SELECT turn_id,text,eventId FROM (
      SELECT m.turn_id,m.ordinal,b.text_content text,coalesce((SELECT t.id FROM adit_history_tool_calls t WHERE t.message_id=m.id LIMIT 1),(SELECT r.tool_call_id FROM adit_history_tool_results r WHERE r.message_id=m.id AND r.tool_call_id IS NOT NULL LIMIT 1),b.id) eventId FROM adit_history_messages m JOIN adit_history_blocks b ON b.message_id=m.id
        WHERE m.provider=@provider AND m.session_id IN (SELECT value FROM json_each(@ids)) AND b.text_content LIKE @pattern ESCAPE '\\'
      UNION ALL SELECT t.turn_id,m.ordinal,coalesce(t.command_text,t.input_json) text,t.id eventId FROM adit_history_tool_calls t JOIN adit_history_messages m ON m.id=t.message_id
        WHERE t.provider=@provider AND t.session_id IN (SELECT value FROM json_each(@ids)) AND (t.command_text LIKE @pattern ESCAPE '\\' OR t.input_json LIKE @pattern ESCAPE '\\')) ORDER BY ordinal LIMIT 1`,
      )
      .get({ provider, ids:this.segments(provider,id), pattern }) as Row | undefined;
    if (!found) return null;
    const text = redactSecrets(found.text || ""),
      position = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
    return {
      turnId: found.turn_id,
      text: text.slice(
        Math.max(0, position - 45),
        Math.max(0, position - 45) + 180,
      ),
      eventId: found.eventId,
    };
  }
  detail(
    w: LocalWorkspace,
    provider: string,
    id: string,
    mode: TranscriptMode = "normal",
    offset?: number,
    query = "",
  ): SessionDetail {
    return this.db.transaction(() => {
      this.session(w,provider,id);
      const ids=conversationSegments(this.db,provider,id);
      const s = this.session(w, provider, ids[0]),
        commits = this.commits(w, provider, id);
      const totals=this.db.prepare(`SELECT min(started_at) started_at,max(last_activity_at) last_activity_at,sum(message_count) message_count,
        sum(user_prompt_count) user_prompt_count FROM adit_history_sessions WHERE provider=? AND id IN (SELECT value FROM json_each(?))`)
        .get(provider,JSON.stringify(ids)) as Row;
      const allTurns=this.turnRows(provider,id).map((t,index):Row=>({...t,ordinal:index+1}));
      const match = this.findMatch(provider, id, query);
      if (offset === undefined && match?.turnId) {
        const found = allTurns.find(t=>t.id===match.turnId);
        if (found) offset = Math.floor((found.ordinal - 1) / 8) * 8;
      }
      offset = offsetOf(offset);
      const usage = this.db
        .prepare(
          "SELECT * FROM adit_history_usage_entries WHERE provider=? AND session_id IN (SELECT value FROM json_each(?)) AND ledger_role='canonical'",
        )
        .all(provider, JSON.stringify(ids)) as (Row & CostUsage)[];
      const costs = this.prices ? usage.map((u) => this.prices!.estimate(u)) : [],
        priced = costs.filter((v): v is number => v !== null);
      const total = allTurns.length;
      const turns = allTurns.slice(offset,offset+8);
      const allowed = new Set(
        this.scope(w)
          .filter((a) => a.provider === provider)
          .map((a) => a.id),
      );
      const children = (
        this.db
          .prepare(
            "SELECT * FROM adit_history_sessions WHERE provider=? AND parent_id IN (SELECT value FROM json_each(?)) AND coalesce(relationship,'') NOT IN ('fork','continuation') ORDER BY started_at,id",
          )
          .all(provider, JSON.stringify(ids)) as Row[]
      )
        .filter((c) => allowed.has(c.id))
        .map((c) =>
          item({ ...c, commits: this.commits(w, provider, c.id).length }),
        );
      const context = this.events(provider, ids[0], null, mode, 0);
      return {
        session: item({ ...s, ...totals, commits: commits.length }),
        models: [
          ...new Set(usage.map((u) => u.model).filter((m): m is string => !!m)),
        ],
        cost: priced.length ? priced.reduce((a, b) => a + b, 0) : null,
        unpriced: costs.length - priced.length,
        repositories: [...new Set(commits.map((c) => c.repository))].map(
          (path) => ({
            path,
            commits: commits.filter((c) => c.repository === path).length,
          }),
        ),
        turns: turns.map((t) =>
          this.readTurn(
            t,
            mode,
            0,
            commits,
            match?.turnId === t.id ? match?.eventId : undefined,
          ),
        ),
        totalTurns: total,
        nextOffset:
          offset + turns.length < total ? offset + turns.length : null,
        children,
        parent:
          s.parent_id && allowed.has(s.parent_id)
            ? { provider, id: s.parent_id }
            : null,
        commits: commits.filter((c) => !c.turnId),
        context: context.events,
        contextNextOffset: context.nextOffset,
        previousOffset: offset > 0 ? Math.max(0, offset - 8) : null,
        matchTurnId: match?.turnId || null,
      };
    })();
  }
  turn(
    w: LocalWorkspace,
    provider: string,
    id: string,
    turnId: string,
    mode: TranscriptMode,
    offset = 0,
  ): SessionTurn {
    this.session(w, provider, id);
    const turn = this.turnRows(provider,id).map((t,index):Row=>({...t,ordinal:index+1})).find(t=>t.id===turnId);
    if (!turn) throw new LocalStateError("Turn not found", 404);
    return this.readTurn(
      turn,
      mode,
      offsetOf(offset),
      this.commits(w, provider, id),
    );
  }
  private editable(w: LocalWorkspace, provider: string, id: string, turnId: string) {
    this.session(w, provider, id);
    const turn = this.db.prepare("SELECT t.*,m.source_key FROM adit_history_turns t JOIN adit_history_messages m ON m.id=t.prompt_message_id WHERE t.id=? AND t.provider=? AND t.session_id IN (SELECT value FROM json_each(?))")
      .get(turnId, provider, this.segments(provider,id)) as Row | undefined;
    if (!turn) throw new LocalStateError("Turn not found", 404);
    const session=this.session(w,provider,turn.session_id);
    const blocks = this.db.prepare(`SELECT b.*,m.source_key,m.content_json,m.role FROM adit_history_blocks b JOIN adit_history_messages m ON m.id=b.message_id
      WHERE m.turn_id=? AND b.kind IN (${textKinds}) AND (m.id=? OR m.role='assistant')
      AND NOT EXISTS(SELECT 1 FROM adit_history_tool_calls c WHERE c.message_id=m.id AND m.provider IN ('codex','traex','augure-code'))
      ORDER BY m.ordinal,b.block_index`).all(turnId, turn.prompt_message_id) as Row[];
    return { session, turn, blocks };
  }
  editTurn(w: LocalWorkspace, provider: string, id: string, turnId: string): SessionTurnEdit {
    return this.db.transaction(() => {
      const { session, turn, blocks } = this.editable(w, provider, id, turnId);
      return { turnId, revision: session.transcript_revision, blocks: blocks.map(b => ({
        id: b.id, kind: b.message_id === turn.prompt_message_id ? "prompt" as const : "reply" as const,
        text: redactSecrets(b.message_id === turn.prompt_message_id ? promptText(provider, b.text_content || "") || "" : b.text_content || ""),
      })) };
    })();
  }
  updateTurn(w: LocalWorkspace, provider: string, id: string, turnId: string, revision: unknown, changes: unknown): void {
    this.db.transaction(() => {
      const { session, turn, blocks } = this.editable(w, provider, id, turnId);
      id=turn.session_id;
      if (revision !== session.transcript_revision) throw new LocalStateError("This conversation changed. Reopen the editor and try again.", 409);
      if (!Array.isArray(changes) || !changes.length || changes.length > blocks.length)
        throw new LocalStateError("Select prompt or reply text to edit");
      const seen = new Set<string>();
      for (const change of changes) {
        const block = blocks.find(b => b.id === change?.id);
        if (!block || seen.has(block.id) || typeof change.text !== "string" || Buffer.byteLength(change.text) > 1_048_576)
          throw new LocalStateError("Invalid conversation text");
        seen.add(block.id);
        const isPrompt = block.message_id === turn.prompt_message_id;
        if (isPrompt && !change.text.trim()) throw new LocalStateError("The prompt cannot be empty");
        const original = block.text_content || "";
        const prompt = isPrompt ? promptText(provider, original) || "" : original;
        // Saving another field must not replace an unchanged, masked secret with its placeholder.
        if (change.text === redactSecrets(prompt)) continue;
        const cursorQuery = isPrompt && provider === "cursor" ? cursorUserQuery(original) : undefined;
        const text = cursorQuery
          ? original.slice(0, cursorQuery.start) + change.text + original.slice(cursorQuery.end)
          : isPrompt && prompt && original.includes(prompt)
          ? original.replace(prompt, () => change.text) : change.text;
        this.db.prepare(`INSERT INTO adit_history_text_edits VALUES (?,?,?,?,?,?)
          ON CONFLICT(provider,session_id,message_key,block_index) DO UPDATE SET text_content=excluded.text_content,updated_at=excluded.updated_at`)
          .run(provider, id, block.source_key, block.block_index, text, Date.now());
        this.db.prepare("UPDATE adit_history_blocks SET text_content=?,data_json=? WHERE id=?")
          .run(text, JSON.stringify(replaceTextBlock(parse(block.data_json), text)), block.id);
        // Read the current message so multiple changed text blocks cannot overwrite one another.
        const message = this.db.prepare("SELECT content_json FROM adit_history_messages WHERE id=?").get(block.message_id) as Row;
        const content = parse(message.content_json);
        const parts = Array.isArray(content) ? [...content] : [content];
        parts[block.block_index] = replaceTextBlock(parts[block.block_index], text);
        this.db.prepare("UPDATE adit_history_messages SET content_json=? WHERE id=?")
          .run(JSON.stringify(Array.isArray(content) ? parts : parts[0]), block.message_id);
      }
      this.refreshSession(provider, id);
    })();
  }
  deleteTurn(w: LocalWorkspace, provider: string, id: string, turnId: string, revision: unknown): void {
    this.db.transaction(() => {
      const { session, turn } = this.editable(w, provider, id, turnId);
      id=turn.session_id;
      if (revision !== session.transcript_revision) throw new LocalStateError("This conversation changed. Reopen the editor and try again.", 409);
      this.db.prepare("INSERT INTO adit_history_deleted_turns VALUES (?,?,?,?)").run(provider, id, turn.source_key, Date.now());
      this.db.prepare(`DELETE FROM adit_history_text_edits WHERE provider=? AND session_id=? AND message_key IN
        (SELECT source_key FROM adit_history_messages WHERE turn_id=?)`).run(provider, id, turnId);
      this.db.prepare("DELETE FROM adit_history_messages WHERE turn_id=?").run(turnId);
      this.db.prepare("DELETE FROM adit_history_turns WHERE id=?").run(turnId);
      const turns = this.db.prepare("SELECT id FROM adit_history_turns WHERE provider=? AND session_id=? ORDER BY ordinal").all(provider, id) as Row[];
      const reorder = this.db.prepare("UPDATE adit_history_turns SET ordinal=? WHERE id=?");
      turns.forEach((t, index) => reorder.run(index + 1, t.id));
      this.refreshSession(provider, id);
    })();
  }
  private refreshSession(provider: string, id: string) {
    let first: string | null = null;
    for (const row of this.db.prepare(`SELECT m.content_json FROM adit_history_turns t JOIN adit_history_messages m ON m.id=t.prompt_message_id
      WHERE t.provider=? AND t.session_id=? ORDER BY t.ordinal`).iterate(provider, id) as Iterable<Row>) {
      first = promptSummary(provider, parse(row.content_json));
      if (first) break;
    }
    this.db.prepare(`UPDATE adit_history_sessions SET first_prompt=@first,
      message_count=(SELECT count(*) FROM adit_history_messages WHERE provider=@provider AND session_id=@id),
      user_prompt_count=(SELECT count(*) FROM adit_history_turns WHERE provider=@provider AND session_id=@id),
      transcript_revision=transcript_revision+1 WHERE provider=@provider AND id=@id`).run({ provider, id, first });
  }
  private readTurn(
    turn: Row,
    mode: TranscriptMode,
    offset: number,
    commits: SessionCommit[],
    matchEventId?: string,
  ): SessionTurn {
    const prompt = this.db
      .prepare(
        `SELECT id,kind,text_content FROM adit_history_blocks WHERE message_id=? ORDER BY block_index`,
      )
      .all(turn.prompt_message_id) as Row[];
    const imageCount=promptImageCount(prompt.map(b=>({type:b.kind})));
    const original = prompt.filter(b=>['text','input_text','output_text'].includes(b.kind)).map((b) => b.text_content || "").join("\n");
    const clean = promptText(turn.provider, original);
    const contextOnly =
      hasCodexPromptContext(turn.provider, original) && !clean && !imageCount;
    const displayed = redactSecrets(clean || (imageCount ? "" : original));
    const usageRows = this.db
      .prepare(
        "SELECT * FROM adit_history_usage_entries WHERE turn_id=? AND ledger_role='canonical'",
      )
      .all(turn.id) as Row[];
    const sum = (key: string) =>
      usageRows.length && usageRows.every((u) => u[key] !== null)
        ? usageRows.reduce((a, u) => a + u[key], 0)
        : null;
    const models = this.db
      .prepare(
        "SELECT DISTINCT model,effort FROM adit_history_messages WHERE turn_id=? AND (model IS NOT NULL OR effort IS NOT NULL)",
      )
      .all(turn.id) as Row[];
    return {
      id: turn.id,
      ordinal: turn.ordinal,
      prompt: displayed.slice(0, 16000),
      imageCount,
      promptBlockId: prompt.find(b=>['text','input_text','output_text'].includes(b.kind))?.id || null,
      promptBlockIds: prompt.filter(b=>['text','input_text','output_text'].includes(b.kind)).map(b=>b.id),
      promptTruncated: displayed.length > 16000,
      at: turn.started_at,
      contextOnly,
      matchEventId: matchEventId || null,
      usage: {
        input: sum("uncached_input_tokens"),
        output: sum("output_tokens"),
        cache: sum("cache_read_tokens"),
        cacheWrite: sum("cache_write_tokens"),
        requests: usageRows.length,
        models: [...new Set(models.map((m) => m.model).filter(Boolean))],
        efforts: [...new Set(models.map((m) => m.effort).filter(Boolean))],
      },
      ...this.events(
        turn.provider,
        turn.session_id,
        turn.id,
        mode,
        offset,
        turn.prompt_message_id,
        matchEventId,
      ),
      commits: commits.filter((c) => c.turnId === turn.id),
    };
  }
  private events(
    provider: string,
    id: string,
    turnId: string | null,
    mode: TranscriptMode,
    offset: number,
    promptId = "",
    seekId?: string,
  ) {
    // Bodies stay out of the event index; large inputs and results are read only on expansion.
    const segmentIds=JSON.stringify(turnId===null?conversationSegments(this.db,provider,id):[id]);
    const index = this.db
      .prepare(
        `SELECT b.id,b.kind,m.role,(CAST(q.key AS INTEGER)*1000000000+m.ordinal) ordinal,b.block_index,m.occurred_at,
      length(b.text_content) text_length,substr(b.text_content,1,180) preview,
      (SELECT id FROM adit_history_tool_calls t WHERE t.message_id=m.id ORDER BY call_index LIMIT 1) tool_id,
      m.id message_id,${nativeContextSql()} native_context FROM adit_history_messages m JOIN adit_history_blocks b ON b.message_id=m.id JOIN json_each(?) q ON q.value=m.session_id
      WHERE m.provider=? AND m.turn_id IS ? AND m.id!=? ORDER BY CAST(q.key AS INTEGER),m.ordinal,b.block_index`,
      )
      .all(segmentIds,provider, turnId, promptId) as Row[];
    // Determine the closing reply across the complete event index, including
    // when its body falls beyond the current page of intermediate activity.
    const keepBeforeTools = ["codex", "traex", "augure-code"].includes(
      provider,
    );
    let last: string | null = null;
    for (const row of index) {
      if(row.native_context)continue;
      if (
        row.tool_id ||
        /tool|function_call/.test(row.kind) ||
        row.role === "tool"
      ) {
        if (!keepBeforeTools) last = null;
      } else if (
        row.role === "assistant" &&
        ["text", "output_text"].includes(row.kind) &&
        row.text_length
      )
        last = row.message_id;
    }
    if(keepBeforeTools && turnId) {
      // Browsing may show the latest unannotated reply in older logs; upload
      // still requires completion evidence or an actual subsequent prompt.
      last=historyFinalReply(this.db,turnId,true)?.id || last;
    }
    const closingRows = last
      ? index.filter(
          (b) =>
            b.message_id === last && ["text", "output_text"].includes(b.kind),
        )
      : [];
    const rows = mode === "focused" ? closingRows : index;
    const seenTools = new Set<string>();
    const projected = rows.flatMap((r): Row[] => {
      if (
        r.tool_id &&
        (["codex", "traex", "augure-code"].includes(provider) ||
          ![
            "text",
            "input_text",
            "output_text",
            "thinking",
            "reasoning",
          ].includes(r.kind))
      ) {
        if (seenTools.has(r.tool_id)) return [];
        seenTools.add(r.tool_id);
        return [{ ...r, type: "tool", id: r.tool_id }];
      }
      if (
        /tool_result|toolResult|function_call_output|custom_tool_call_output/.test(
          r.kind,
        ) ||
        r.role === "tool"
      ) {
        const result = this.db
          .prepare(
            "SELECT tool_call_id FROM adit_history_tool_results WHERE message_id=? LIMIT 1",
          )
          .get(r.message_id) as Row | undefined;
        if (result?.tool_call_id) return [];
        return [{ ...r, type: "result" }];
      }
      return [
        {
          ...r,
          type: r.native_context ? "system" : ["thinking", "reasoning", "summary_text"].includes(r.kind)
            ? "thinking"
            : r.role === "assistant" && r.text_length
              ? "reply"
              : r.role === "system" || r.role === "developer"
                ? "system"
                : r.text_length
                  ? "system"
                  : "attachment",
        },
      ];
    });
    // Calls represented only in the native payload still have a normalized tool table row.
    if (mode === "normal") {
      const calls = this.db
        .prepare(
          `SELECT t.id,t.message_id,(CAST(q.key AS INTEGER)*1000000000+m.ordinal) ordinal,m.occurred_at FROM adit_history_tool_calls t JOIN adit_history_messages m ON m.id=t.message_id
        JOIN json_each(?) q ON q.value=t.session_id WHERE t.provider=? AND m.turn_id IS ? ORDER BY CAST(q.key AS INTEGER),m.ordinal,t.call_index`,
        )
        .all(segmentIds,provider, turnId) as Row[];
      for (const call of calls)
        if (!seenTools.has(call.id))
          projected.push({ ...call, type: "tool", block_index: 999 });
      projected.sort(
        (a, b) => a.ordinal - b.ordinal || a.block_index - b.block_index,
      );
    }
    if (seekId) {
      const index = projected.findIndex((e) => e.id === seekId);
      if (index >= 0) offset = Math.floor(index / 40) * 40;
    }
    const hydrate = (r: Row): SessionEvent => {
      if (r.type === "tool") {
        const tool = this.db
          .prepare(
            `SELECT tool_name,command_text,file_path,substr(input_json,1,64000) input,
                CASE WHEN json_valid(input_json) AND json_type(input_json)='text'
                  THEN substr(json_extract(input_json,'$'),1,180) END body
                FROM adit_history_tool_calls WHERE id=?`,
          )
          .get(r.id) as Row;
        const input = parse(tool.input);
        const display = sessionToolDisplay(
          tool.tool_name || "Tool",
          input,
          tool.command_text,
          tool.file_path,
        );
        return {
          id: r.id,
          kind: "tool",
          name: tool.tool_name || "Tool",
          display: {
            ...display,
            name: redactSecrets(display.name),
            text: redactSecrets(display.text)
              .replace(/\s+/g, " ")
              .slice(0, 180),
          },
          at: r.occurred_at,
          text: redactSecrets(
            tool.command_text ||
              input?.description ||
              input?.plan?.map?.((p: Row) => p.step).join(" → ") ||
              tool.file_path ||
              tool.body ||
              "",
          ).slice(0, 180),
        };
      }
      const block = this.db
        .prepare("SELECT text_content FROM adit_history_blocks WHERE id=?")
        .get(r.id) as Row | undefined;
      const text = redactSecrets(block?.text_content || "");
      return {
        id: r.id,
        kind: r.type,
        at: r.occurred_at,
        text: text.slice(0, 16000),
        truncated: text.length > 16000,
      };
    };
    const events = projected.slice(offset, offset + 40).map(hydrate);
    const closingIds = new Set(closingRows.map((r) => r.id));
    const openingMessage = projected.find(
      (r) => r.type === "reply",
    )?.message_id;
    return {
      events,
      openingEvents:
        mode === "normal" && openingMessage
          ? projected
              .filter(
                (r) =>
                  r.type === "reply" &&
                  r.message_id === openingMessage &&
                  !closingIds.has(r.id),
              )
              .map(hydrate)
          : [],
      closingEvents:
        mode === "normal"
          ? projected
              .filter((r) => r.type === "reply" && closingIds.has(r.id))
              .map(hydrate)
          : [],
      nextOffset:
        offset + events.length < projected.length
          ? offset + events.length
          : null,
      previousOffset: offset > 0 ? Math.max(0, offset - 40) : null,
    };
  }
  context(w: LocalWorkspace, provider: string, id: string, offset = 0) {
    this.session(w, provider, id);
    return this.events(provider, id, null, "normal", offsetOf(offset));
  }
  content(
    w: LocalWorkspace,
    provider: string,
    id: string,
    eventId: string,
    kind: string,
    offset = 0,
  ): SessionContent {
    this.session(w, provider, id);
    let text: string;
    if (["tool", "tool-input", "tool-output"].includes(kind)) {
      const tool = this.db
        .prepare(
          "SELECT input_json FROM adit_history_tool_calls WHERE id=? AND provider=? AND session_id IN (SELECT value FROM json_each(?))",
        )
        .get(eventId, provider, this.segments(provider,id)) as Row | undefined;
      if (!tool) throw new LocalStateError("Event not found", 404);
      const results = this.db
        .prepare(
          "SELECT content_text,content_json FROM adit_history_tool_results WHERE tool_call_id=? ORDER BY event_index",
        )
        .all(eventId) as Row[];
      const input = parse(tool.input_json);
      const output = results.map(
        (r) => r.content_text || parse(r.content_json),
      );
      const display = (value: unknown) =>
        typeof value === "string"
          ? redactSecrets(value)
          : JSON.stringify(redactSecretValue(value), null, 2) || "";
      text =
        kind === "tool-input"
          ? display(input)
          : kind === "tool-output"
            ? output.map(display).join("\n\n")
            : display({ input, output });
    } else {
      const block = this.db
        .prepare(
          "SELECT b.text_content,b.data_json FROM adit_history_blocks b JOIN adit_history_messages m ON m.id=b.message_id WHERE b.id=? AND m.provider=? AND m.session_id IN (SELECT value FROM json_each(?))",
        )
        .get(eventId, provider, this.segments(provider,id)) as Row | undefined;
      if (!block) throw new LocalStateError("Event not found", 404);
      text = redactSecrets(
        block.text_content ||
          JSON.stringify(redactSecretValue(parse(block.data_json)), null, 2) ||
          "",
      );
    }
    offset = offsetOf(offset);
    return {
      text: text.slice(offset, offset + 32000),
      nextOffset: offset + 32000 < text.length ? offset + 32000 : null,
    };
  }
}
