import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { LocalStateError, type LocalWorkspace } from "../local-state.js";
import { analyticsSessions } from "./analytics-scope.js";
import { conversationSegments,conversationRevision } from "./session-identity.js";
import { LocalPrices, type CostUsage } from "./pricing.js";
import { submittedPromptText } from "./prompt-summary.js";
import { nativeContextSql } from "./message-semantics.js";
import { sourceDefinitions } from "./sources.js";
import { sessionToolDisplay } from "./session-tool-display.js";
import { PublicationPrivacy, SHARE_POLICY_VERSION, isPersonalMemoryWrite } from "./publication-privacy.js";
import { createPublicationSchema, insertPublication } from "./publication-schema.js";
import { publicationCursor, nextPublicationCursor, PUBLICATION_PAGE_SIZE } from "./publication-pagination.js";
import { defaultShareOptions, type ShareDraft, type ShareOptions, type ShareSnapshot, type SharedCommit, type SharedTurn, type ShareItem } from "./sharing-types.js";
export * from "./sharing-types.js";
type Row = Record<string, any>;
export const publicationDigest = (text: string) => createHash("sha256").update(text).digest("hex");
const parse = (v: string | null) => { try { return v ? JSON.parse(v) : null; } catch { return v; } };
const textKinds = new Set(["text", "input_text", "output_text"]);

function shareOptions(value: Partial<ShareOptions>): ShareOptions {
  const o = { ...defaultShareOptions, ...value };
  if (!["all", "selected"].includes(o.scope)) throw new LocalStateError("Invalid share scope");
  for (const k of ["dialogue", "commands", "commits", "outputs", "thinking", "cost"] as const)
    if (typeof o[k] !== "boolean") throw new LocalStateError("Invalid share option");
  for (const k of ["turnIds", "names"] as const)
    if (!Array.isArray(o[k]) || o[k].length > 10000 || o[k].some(v => typeof v !== "string" || v.length > 500))
      throw new LocalStateError("Invalid share selection");
  return { ...o, turnIds: [...new Set(o.turnIds)], names: [...new Set(o.names.map(v => v.trim()).filter(Boolean))] };
}

export function shareMarkdown(s: ShareSnapshot): string {
  const code = (text: string) => { const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), m => m[0].length + 1))); return `${fence}\n${text}\n${fence}`; };
  const commit = (c: SharedCommit) => `- ${c.sha.slice(0, 7)} ${c.subject.replace(/\n/g, " ")} · ${c.repository} · ${c.files} files${c.additions === null ? "" : ` · +${c.additions} −${c.deletions ?? 0}`}`;
  return ["# " + s.title, `${s.agent} · ${s.models.join(", ")} · ${s.promptCount} prompts · ${s.commitCount} commits`,
    "The author reviewed this session before sharing. Local paths and session identifiers have been redacted.",
    ...s.turns.flatMap(t => [t.prompt ? `## ${t.prompt}` : "---", ...t.events.map(e => e.kind === "reply" ? e.text : `<details><summary>${e.kind === "command" ? "Executed command" : e.kind === "output" ? "Command output" : "Thinking"}</summary>\n\n${code(e.text)}\n\n</details>`), ...t.commits.map(commit)]),
    ...s.commits.map(commit), ...(s.costMicrousd !== undefined ? [`Estimated cost: ${s.costMicrousd === null ? "unknown" : "$" + (s.costMicrousd / 1e6).toFixed(2)}${s.costIncomplete ? " (incomplete)" : ""}`] : []),
    "---\nShared with ADIT. Organize and share your own AI coding sessions with ADIT."].filter(Boolean).join("\n\n");
}

export class LocalSharing {
  constructor(private db: Database.Database, private prices: LocalPrices) { createPublicationSchema(db); }
  list(w: LocalWorkspace, offset = 0, cursor?: string | null) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new LocalStateError("Invalid offset");
    const after = publicationCursor(cursor);
    const total = (this.db.prepare("SELECT count(*) n FROM adit_shares WHERE workspace_id=? AND status='published'").get(w.id) as Row).n;
    const rows = this.db.prepare("SELECT id,title,provider,status,published_at,created_at,remote_url,viewer_url,prompt_count,commit_count FROM adit_shares WHERE workspace_id=? AND status='published' AND (? IS NULL OR published_at<? OR (published_at=? AND id>?)) ORDER BY published_at DESC,id LIMIT ? OFFSET ?").all(w.id, after?.at ?? null, after?.at ?? null, after?.at ?? null, after?.id ?? null, PUBLICATION_PAGE_SIZE + 1, after ? 0 : offset) as ShareItem[];
    const items = rows.slice(0, PUBLICATION_PAGE_SIZE), last = items.at(-1);
    return { total, items, nextOffset: rows.length > PUBLICATION_PAGE_SIZE ? offset + items.length : null, nextCursor: rows.length > PUBLICATION_PAGE_SIZE && last ? nextPublicationCursor(last.published_at!, last.id) : null };
  }
  private record(w: LocalWorkspace, id: string) {
    const r = this.db.prepare("SELECT s.*,v.source_revision,v.snapshot_digest,v.snapshot_json,v.markdown,v.options_json,v.review_json FROM adit_shares s JOIN adit_share_versions v ON v.id=s.current_version_id WHERE s.workspace_id=? AND s.id=?").get(w.id, id) as Row | undefined;
    if (!r) throw new LocalStateError("Share not found", 404);
    return r;
  }
  read(w: LocalWorkspace, id: string): ShareDraft & { remoteUrl: string | null; viewerUrl: string | null } {
    const r = this.record(w, id);
    return { id, provider: r.provider, sessionId: r.session_id, version: r.current_version_id, sourceRevision: r.source_revision, digest: r.snapshot_digest, status: r.status,
      options: JSON.parse(r.options_json), snapshot: JSON.parse(r.snapshot_json), markdown: r.markdown,
      ...JSON.parse(r.review_json), error: r.last_error || undefined, remoteUrl: r.remote_url, viewerUrl: r.viewer_url };
  }
  create(w: LocalWorkspace, provider: string, sessionId: string, input: { title?: string; options?: Partial<ShareOptions> } = {}, existingId?: string): ShareDraft {
    // Keep a consistent read snapshot without reserving the writer while redacting.
    // A WAL read transaction cannot upgrade to a writer after collection commits.
    const { o, session, chosen, commits, snapshot, snapshotJson, markdown, review, redactions, previousVersion } = this.db.transaction(() => {
      if (!analyticsSessions(this.db, w).some(s => s.provider === provider && s.id === sessionId)) throw new LocalStateError("Session not found", 404);
      const existing = existingId ? this.record(w, existingId) : null;
      if (existing && (existing.provider !== provider || existing.session_id !== sessionId || !["ready", "failed"].includes(existing.status))) throw new LocalStateError("This share cannot be edited", 409);
      const o = shareOptions(input.options || {});
      const session = this.db.prepare("SELECT * FROM adit_history_sessions WHERE provider=? AND id=?").get(provider, sessionId) as Row;
      const segments=conversationSegments(this.db,provider,sessionId),segmentJSON=JSON.stringify(segments);
      session.transcript_revision=conversationRevision(this.db,provider,sessionId);
      const nativeTurns = (this.db.prepare("SELECT t.* FROM adit_history_turns t JOIN json_each(?) q ON q.value=t.session_id WHERE t.provider=? ORDER BY CAST(q.key AS INTEGER),t.ordinal")
        .all(segmentJSON,provider) as Row[]).map((t,i):Row=>({...t,ordinal:i+1}));
      const calls = this.db.prepare("SELECT * FROM adit_history_tool_calls WHERE provider=? AND session_id IN (SELECT value FROM json_each(?)) ORDER BY occurred_at,call_index").all(provider, segmentJSON) as Row[];
      const ids = [...segments, ...calls.flatMap(c => [c.id, c.source_call_id]).filter(Boolean)];
      const privacy = new PublicationPrivacy(ids, o.names), choicesPrivacy = new PublicationPrivacy(ids, o.names);
      const blocks = this.db.prepare(`SELECT b.*,m.role,m.turn_id,m.ordinal,m.id owner_id FROM adit_history_blocks b JOIN adit_history_messages m ON m.id=b.message_id JOIN json_each(?) q ON q.value=m.session_id WHERE m.provider=? AND NOT ${nativeContextSql()} ORDER BY CAST(q.key AS INTEGER),m.ordinal,b.block_index`).all(segmentJSON,provider) as Row[];
      const getPrompt = (turn: Row) => submittedPromptText(provider, blocks.filter(b => b.owner_id === turn.prompt_message_id).map(b=>({type:b.kind,text:b.text_content||""}))) || "";
      const turns = nativeTurns.filter(t => getPrompt(t).trim());
      const chosen = turns.filter(t => o.scope === "all" || o.turnIds.includes(t.id));
      if (!chosen.length || (o.scope === "selected" && chosen.length !== o.turnIds.length)) throw new LocalStateError("Select at least one valid prompt");
      const chosenIds = new Set(chosen.map(t => t.id));
      const memoryCalls = calls.filter(c => chosenIds.has(c.turn_id) && isPersonalMemoryWrite(c.tool_name || "", (c.command_text || "") + "\n" + (c.input_json || "")));
      const memoryIds = new Set(memoryCalls.map(c => c.id));
      const memoryMessages = new Set(memoryCalls.map(c => c.message_id));
      const nativeToolMessages = new Set(["codex", "traex", "augure-code"].includes(provider) ? calls.map(c => c.message_id) : []);
      const memoryTexts: string[] = [];
      const collectMemoryText = (v: unknown) => {
        if (typeof v === "string" && v.length >= 12) memoryTexts.push(v);
        else if (Array.isArray(v)) v.forEach(collectMemoryText);
        else if (v && typeof v === "object") Object.values(v).forEach(collectMemoryText);
      };
      memoryCalls.forEach(c => collectMemoryText(parse(c.input_json)));
      const safe = (value: string, field: string) => {
        for (const memory of memoryTexts) value = value.split(memory).join("[personal memory omitted]");
        return privacy.text(value, field);
      };
      const run = this.db.prepare("SELECT id FROM adit_attribution_runs WHERE workspace_id=? AND status='done' ORDER BY started_at DESC LIMIT 1").get(w.id) as Row | undefined;
      const commits = (this.db.prepare(`SELECT c.*,a.submit_turn_id turn_id,(SELECT count(*) FROM adit_local_commit_files f WHERE f.repository=c.repository AND f.sha=c.sha) files,
        (SELECT sum(additions) FROM adit_local_commit_files f WHERE f.repository=c.repository AND f.sha=c.sha) additions,
        (SELECT sum(deletions) FROM adit_local_commit_files f WHERE f.repository=c.repository AND f.sha=c.sha) deletions
        FROM adit_attribution_commits a JOIN adit_local_commits c ON c.repository=a.repository AND c.sha=a.sha
        WHERE a.run_id=? AND a.submit_provider=? AND a.submit_session_id IN (SELECT value FROM json_each(?)) AND c.repository IN (SELECT value FROM json_each(?)) ORDER BY c.authored_at,c.sha`)
        .all(run?.id || "", provider, segmentJSON, JSON.stringify(w.repositories)) as Row[])
        .filter(c => o.commits && (chosenIds.has(c.turn_id) || (o.scope === "all" && !c.turn_id)));
      const exportCommit = (c: Row): SharedCommit => ({ sha: c.sha, subject: safe(c.subject, `commit.${c.sha}.subject`), repository: safe(basename(c.repository), `commit.${c.sha}.repository`), files: c.files, additions: c.additions, deletions: c.deletions });
      const usage = this.db.prepare("SELECT * FROM adit_history_usage_entries WHERE provider=? AND session_id IN (SELECT value FROM json_each(?)) AND ledger_role='canonical'").all(provider, segmentJSON) as (Row & CostUsage)[];
      let commandCount = 0;
      const exportedTurns: SharedTurn[] = chosen.map((turn, index) => {
        const u = usage.filter(v => v.turn_id === turn.id);
        const sum = (field: string) => u.length && u.every(v => v[field] != null) ? u.reduce((n, v) => n + v[field], 0) : null;
        const meta = this.db.prepare("SELECT DISTINCT model,effort FROM adit_history_messages WHERE turn_id=?").all(turn.id) as Row[];
        const events: { ordinal: number; index: number; kind: "reply" | "thinking" | "command" | "output"; text: string; name?: string; summary?: string; icon?: string }[] = [];
        for (const b of blocks.filter(b => b.turn_id === turn.id && b.owner_id !== turn.prompt_message_id && !memoryMessages.has(b.owner_id) && !nativeToolMessages.has(b.owner_id))) {
          if (b.role !== "assistant") continue;
          const thinking = ["thinking", "reasoning", "analysis"].includes(b.kind);
          if ((thinking && o.thinking) || (textKinds.has(b.kind) && o.dialogue))
            events.push({ ordinal: b.ordinal, index: b.block_index, kind: thinking ? "thinking" : "reply", text: safe(b.text_content || "", `turn.${index}.block.${b.id}`) });
        }
        for (const c of calls.filter(c => c.turn_id === turn.id && !memoryIds.has(c.id))) {
          const owner = blocks.find(b => b.owner_id === c.message_id);
          const ordinal = owner?.ordinal ?? (this.db.prepare("SELECT ordinal FROM adit_history_messages WHERE id=?").get(c.message_id) as Row)?.ordinal ?? 0;
          if (o.commands) {
            commandCount++;
            const input = parse(c.input_json);
            const display = sessionToolDisplay(c.tool_name || "Tool", input, c.command_text, c.file_path);
            events.push({ ordinal, index: 1000 + c.call_index * 2, kind: "command", name: safe(display.name, `tool.${c.id}.name`), summary: safe(display.text, `tool.${c.id}.summary`), icon: display.icon, text: safe(c.command_text || (typeof input === "string" ? input : JSON.stringify(input, null, 2)) || "", `tool.${c.id}.input`) });
          }
          if (o.outputs) {
            const results = this.db.prepare("SELECT content_text,content_json FROM adit_history_tool_results WHERE tool_call_id=? ORDER BY event_index").all(c.id) as Row[];
            const text = results.map(r => r.content_text || JSON.stringify(parse(r.content_json), null, 2) || "").join("\n\n");
            if (text) events.push({ ordinal, index: 1001 + c.call_index * 2, kind: "output", text: safe(text, `tool.${c.id}.output`) });
          }
        }
        events.sort((a, b) => a.ordinal - b.ordinal || a.index - b.index);
        return { ...(o.dialogue ? { prompt: safe(getPrompt(turn), `turn.${index}.prompt`) } : {}),
          models: [...new Set(meta.map(m => m.model).filter(Boolean))].map(m => safe(m, `turn.${index}.model`)),
          efforts: [...new Set(meta.map(m => m.effort).filter(Boolean))].map(m => safe(m, `turn.${index}.effort`)),
          input: sum("uncached_input_tokens"), output: sum("output_tokens"), cache: sum("cache_read_tokens"),
          events: events.map(({ ordinal: _o, index: _i, ...event }) => event), commits: commits.filter(c => c.turn_id === turn.id).map(exportCommit) };
      });
      const rawTitle = input.title === undefined ? getPrompt(chosen[0]).trim().split("\n")[0].slice(0, 240) : input.title;
      if (typeof rawTitle !== "string" || !rawTitle.trim() || rawTitle.length > 500) throw new LocalStateError("A share title of 1–500 characters is required");
      const snapshot: ShareSnapshot = { schemaVersion: 1, title: safe(rawTitle.trim(), "title"), agent: sourceDefinitions().find(p => p.id === provider)?.name || provider,
        provider, models: [...new Set(exportedTurns.flatMap(t => t.models))], date: chosen[0].started_at, promptCount: chosen.length,
        commitCount: commits.length, commandCount, turns: exportedTurns, commits: commits.filter(c => !c.turn_id).map(exportCommit) };
      if (o.cost) {
        const costs = usage.filter(u => chosenIds.has(u.turn_id) || o.scope === "all").map(u => this.prices.estimate(u));
        snapshot.costMicrousd = costs.length && costs.every(c => c !== null) ? costs.reduce<number>((n, c) => n + (c || 0), 0) : null;
        snapshot.costIncomplete = !costs.length || costs.some(c => c === null);
      }
      if (!snapshot.turns.some(t => t.prompt || t.events.length || t.commits.length) && !snapshot.commits.length) throw new LocalStateError("There is no content to share");
      const snapshotJson = JSON.stringify(snapshot);
      if (Buffer.byteLength(snapshotJson) > 8 * 1024 * 1024) throw new LocalStateError("This session is too large to share at once. Select fewer prompts.", 413);
      const review = { titleCustom: input.title !== undefined, turns: turns.map(t => ({ id: t.id, ordinal: t.ordinal, prompt: choicesPrivacy.text(getPrompt(t).slice(0, 300), "choice") })),
        redactions: privacy.redactions.reduce<Record<string, number>>((counts, r) => ({ ...counts, [r.rule]: (counts[r.rule] || 0) + 1 }), {}),
        excludedCategories: [!o.dialogue, !o.commands, !o.commits, !o.outputs, !o.thinking, !o.cost, true].filter(Boolean).length,
        memoryActions: memoryCalls.length };
      return { o, session, chosen, commits, snapshot, snapshotJson, markdown: shareMarkdown(snapshot), review,
        redactions: privacy.redactions, previousVersion: existing?.current_version_id };
    })();
    return this.db.transaction(() => {
      if (existingId) {
        const current = this.record(w, existingId);
        if (!["ready", "failed"].includes(current.status)) throw new LocalStateError("This share cannot be edited", 409);
        if (current.current_version_id !== previousVersion) throw new LocalStateError("Content changed. Review the current preview before publishing.", 409);
      }
      const id = existingId || randomUUID(), version = randomUUID(), now = Date.now();
      if (!existingId) insertPublication(this.db, "adit_shares", { id, workspace_id: w.id, provider, session_id: sessionId, title: snapshot.title, status: "ready", created_at: now, current_version_id: version, prompt_count: snapshot.promptCount, commit_count: snapshot.commitCount });
      insertPublication(this.db, "adit_share_versions", { id: version, share_id: id, source_revision: session.transcript_revision, policy_version: SHARE_POLICY_VERSION,
        scope_kind: o.scope, title: snapshot.title, include_dialogue: +o.dialogue, include_commands: +o.commands, include_commits: +o.commits,
        include_outputs: +o.outputs, include_thinking: +o.thinking, include_cost: +o.cost, snapshot_digest: publicationDigest(snapshotJson),
        snapshot_json: snapshotJson, markdown, options_json: JSON.stringify(o), review_json: JSON.stringify(review), created_at: now });
      chosen.forEach(t => insertPublication(this.db, "adit_share_turns", { version_id: version, turn_id: t.id, ordinal: t.ordinal }));
      commits.forEach((c, ordinal) => insertPublication(this.db, "adit_share_commits", { version_id: version, repository: c.repository, commit_sha: c.sha, ordinal, source_turn_id: c.turn_id }));
      redactions.forEach(r => insertPublication(this.db, "adit_share_redactions", { version_id: version, field_path: r.field, rule_id: r.rule, start_offset: r.start, end_offset: r.end, replacement_kind: r.replacement }));
      this.db.prepare("UPDATE adit_shares SET current_version_id=?,status='ready',title=?,prompt_count=?,commit_count=?,last_error=NULL WHERE id=?").run(version, snapshot.title, snapshot.promptCount, snapshot.commitCount, id);
      return this.read(w, id);
    }).immediate();
  }
  update(w: LocalWorkspace, id: string, input: { title?: string; options?: Partial<ShareOptions> }) {
    const r = this.record(w, id);
    const review = JSON.parse(r.review_json), previous = JSON.parse(r.snapshot_json) as ShareSnapshot;
    const wasCustom = review.titleCustom ?? (r.title !== previous.turns[0]?.prompt?.trim().split("\n")[0].slice(0, 240));
    // Default titles follow the first selected prompt; an excluded prompt must not leak through the title.
    const title = input.title !== undefined && input.title !== r.title ? input.title : wasCustom ? r.title : undefined;
    return this.create(w, r.provider, r.session_id, { title, options: { ...JSON.parse(r.options_json), ...input.options } }, id);
  }
  beginPublish(w: LocalWorkspace, id: string, version: string, digest: string, key: string) {
    return this.db.transaction(() => {
      const r = this.record(w, id);
      if (r.current_version_id !== version || r.snapshot_digest !== digest) throw new LocalStateError("Content changed. Review the current preview before publishing.", 409);
      if (r.status === "published") return { ...this.read(w, id), alreadyPublished: true, reconcile: false };
      const revision = conversationRevision(this.db,r.provider,r.session_id);
      if (revision === null || revision !== r.source_revision) throw new LocalStateError("Content changed. Review the current preview before publishing.", 409);
      if (!["ready", "failed", "publish_unknown"].includes(r.status)) throw new LocalStateError("Publication is already in progress", 409);
      if (!/^[\w-]{8,100}$/.test(key)) throw new LocalStateError("Invalid publication request");
      const attempt = this.db.prepare("SELECT version_id FROM adit_share_publish_attempts WHERE idempotency_key=?").get(key) as Row | undefined;
      if (attempt && attempt.version_id !== version) throw new LocalStateError("Publication request belongs to a different preview", 409);
      this.db.prepare("INSERT INTO adit_share_publish_attempts(idempotency_key,version_id,status,started_at) VALUES (?,?,'publishing',?) ON CONFLICT(idempotency_key) DO UPDATE SET status='publishing'").run(key, version, Date.now());
      this.db.prepare("UPDATE adit_shares SET status='publishing',last_error=NULL WHERE id=?").run(id);
      return { ...this.read(w, id), alreadyPublished: false, reconcile: r.status === "publish_unknown" };
    }).immediate();
  }
  published(w: LocalWorkspace, id: string, key: string, remote: { id: string; url: string; revision: string; viewer: string | null }) {
    this.record(w, id);
    this.db.transaction(() => {
      this.db.prepare("UPDATE adit_shares SET status='published',remote_id=?,remote_url=?,remote_revision=?,viewer_url=?,published_at=?,last_error=NULL WHERE id=?").run(remote.id, remote.url, remote.revision, remote.viewer, Date.now(), id);
      this.db.prepare("UPDATE adit_share_publish_attempts SET status='published',remote_id=?,finished_at=? WHERE idempotency_key=?").run(remote.id, Date.now(), key);
    })();
    return this.read(w, id);
  }
  failed(w: LocalWorkspace, id: string, key: string, message: string, unknown = false) {
    this.record(w, id);
    this.db.prepare("UPDATE adit_shares SET status=?,last_error=? WHERE id=?").run(unknown ? "publish_unknown" : "failed", message, id);
    this.db.prepare("UPDATE adit_share_publish_attempts SET status=?,error_code=?,finished_at=? WHERE idempotency_key=?").run(unknown ? "unknown" : "failed", message, Date.now(), key);
  }
}
