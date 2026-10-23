import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { LocalStateError, type LocalWorkspace } from "../local-state.js";
import { createPublicationSchema, insertPublication } from "./publication-schema.js";
import { PublicationPrivacy } from "./publication-privacy.js";
import { sourceDefinitions } from "./sources.js";
import { submittedPromptText } from "./prompt-summary.js";
import { conversationSegments,conversationRevision } from "./session-identity.js";
import { publicationCursor, nextPublicationCursor } from "./publication-pagination.js";
import { defaultPrOptions, type PrOptions, type PrScope, type PrCommit, type PrDescription, type PrLines, type PrSession, type PrItem } from "./pr-types.js";
export * from "./pr-types.js";
type Row = Record<string, any>;
const identity = (provider: string, id: string) => JSON.stringify([provider, id]);
const zeroLines = (): PrLines => ({ eligible: 0, excluded: 0, certain: 0, likely: 0, possible: 0, moved: 0, unknown: 0 });
const md = (v: string) => v.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");

function validateOptions(value: Partial<PrOptions>): PrOptions {
  const o = { ...defaultPrOptions, ...value };
  if (!["en", "zh"].includes(o.language) || !["brief", "detailed", "project-template"].includes(o.detail)) throw new LocalStateError("Invalid description format");
  for (const k of ["sessions", "lines", "assistedBy", "prompts", "shareLinks", "aditLabel"] as const) if (typeof o[k] !== "boolean") throw new LocalStateError("Invalid description option");
  if (o.title !== undefined && (typeof o.title !== "string" || !o.title.trim() || o.title.length > 500)) throw new LocalStateError("Invalid description title");
  return o;
}

export class LocalPrDescriptions {
  constructor(private db: Database.Database) { createPublicationSchema(db); }
  list(w: LocalWorkspace, offset = 0, cursor?: string | null) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new LocalStateError("Invalid offset");
    const after = publicationCursor(cursor);
    const total = (this.db.prepare("SELECT count(*) n FROM adit_pr_descriptions WHERE workspace_id=? AND status='ready'").get(w.id) as Row).n;
    const rows = this.db.prepare("SELECT id,title,repository,source_ref,target_ref,created_at,detail_level,language,commit_count,session_count,unmatched_count FROM adit_pr_descriptions WHERE workspace_id=? AND status='ready' AND (? IS NULL OR created_at<? OR (created_at=? AND id>?)) ORDER BY created_at DESC,id LIMIT 41 OFFSET ?").all(w.id, after?.at ?? null, after?.at ?? null, after?.at ?? null, after?.id ?? null, after ? 0 : offset) as PrItem[];
    const items = rows.slice(0, 40), last = items.at(-1);
    return { total, items, nextOffset: rows.length > 40 ? offset + items.length : null, nextCursor: rows.length > 40 && last ? nextPublicationCursor(last.created_at, last.id) : null };
  }
  read(w: LocalWorkspace, id: string): PrDescription {
    const r = this.db.prepare("SELECT snapshot_json FROM adit_pr_descriptions WHERE id=? AND workspace_id=? AND status='ready'").get(id, w.id) as Row | undefined;
    if (!r) throw new LocalStateError("PR description not found", 404);
    const result: PrDescription = JSON.parse(r.snapshot_json);
    // Presentation-only upgrade of saved descriptions; attribution stays at generation time.
    return { ...result, markdown: clarifyPrMarkdown(result) };
  }
  generate(w: LocalWorkspace, scope: PrScope, input: Partial<PrOptions>, template?: { path: string; text: string; digest: string }, descriptionId = randomUUID()): PrDescription {
    // Read one consistent analysis snapshot; let collection write while rendering.
    const { result, options, commits, sessionList, usage, links, prompts } = this.db.transaction(() => {
      if (!w.repositories.includes(scope.repository)) throw new LocalStateError("Repository is outside this workspace", 404);
      const options = validateOptions(input);
      const say = (en: string, zh: string) => options.language === "zh" ? zh : en;
      if (options.detail === "project-template" && !template) throw new LocalStateError("Select a project Markdown template");
      if (!scope.commits.some(c => c.included)) throw new LocalStateError("The selected range has no eligible commits");
      const privacy = new PublicationPrivacy();
      const run = this.db.prepare("SELECT id,algorithm_version FROM adit_attribution_runs WHERE workspace_id=? AND status='done' ORDER BY started_at DESC LIMIT 1").get(w.id) as Row | undefined;
      const sessions = new Map<string, PrSession & { revision: number | null; parent: string | null; relationship: string | null }>();
      const associatedTurns = new Map<string, Set<string>>();
      const segmentJSON=(provider:string,id:string)=>JSON.stringify(conversationSegments(this.db,provider,id));
      const addSession = (provider: string, id: string, turnId?: string | null) => {
        const segments=conversationSegments(this.db,provider,id);id=segments[0]||id;
        const key = identity(provider, id);
        if (turnId) { if (!associatedTurns.has(key)) associatedTurns.set(key, new Set()); associatedTurns.get(key)!.add(turnId); }
        if (!sessions.has(key)) {
          const s = this.db.prepare("SELECT * FROM adit_history_sessions WHERE provider=? AND id=?").get(provider, id) as Row | undefined;
          const time = this.db.prepare("SELECT count(*) n,sum(work_duration_ms) duration,sum(work_duration_ms IS NULL) missing FROM adit_history_turns WHERE provider=? AND session_id IN (SELECT value FROM json_each(?))").get(provider, JSON.stringify(segments)) as Row;
          const models = this.db.prepare("SELECT DISTINCT model FROM adit_history_usage_entries WHERE provider=? AND session_id IN (SELECT value FROM json_each(?)) AND ledger_role='canonical' AND model IS NOT NULL").all(provider, JSON.stringify(segments)) as Row[];
          sessions.set(key, { provider, sessionId: id, number: sessions.size + 1, agent: sourceDefinitions().find(p => p.id === provider)?.name || provider,
            date: s?.started_at ?? null, prompts: s ? time.n : null, duration: time.n && !time.missing ? time.duration : null,
            models: models.map(m => privacy.text(m.model, "model")), rangeModels: [], revision: conversationRevision(this.db,provider,id), parent: s?.parent_id ?? null, relationship: s?.relationship ?? null });
        }
        const s = sessions.get(key)!;
        return { provider, sessionId: id, number: s.number };
      };
      const commits: PrCommit[] = scope.commits.map(c => {
        const row = c.included ? this.db.prepare("SELECT * FROM adit_attribution_commits WHERE run_id=? AND repository=? AND sha=?").get(run?.id || "", scope.repository, c.sha) as Row | undefined : undefined;
        const lines: PrLines | null = row ? { eligible: row.eligible_lines, excluded: row.excluded_lines, certain: row.certain_lines, likely: row.likely_lines, possible: row.possible_lines, moved: row.moved_lines, unknown: row.unknown_lines } : null;
        if (lines && lines.eligible !== lines.certain + lines.likely + lines.possible + lines.moved + lines.unknown) throw new LocalStateError("Saved attribution totals are inconsistent. Recheck the selected commits.", 409);
        const submitter = row?.submit_session_id ? { ...addSession(row.submit_provider, row.submit_session_id, row.submit_turn_id), turnId: row.submit_turn_id, method: row.match_method } : null;
        const writerRows = row ? this.db.prepare("SELECT provider,session_id,sum(certain_lines) certain,sum(likely_lines) likely,sum(possible_lines) possible FROM adit_attribution_writers WHERE run_id=? AND repository=? AND sha=? AND provider IS NOT NULL GROUP BY provider,session_id ORDER BY sum(certain_lines+likely_lines+possible_lines) DESC,provider,session_id").all(run!.id, scope.repository, c.sha) as Row[] : [];
        const writers = writerRows.map(r => ({ ...addSession(r.provider, r.session_id), certain: r.certain, likely: r.likely, possible: r.possible }))
          .reduce<{provider:string;sessionId:string;number:number;certain:number;likely:number;possible:number}[]>((all,r)=>{
            const previous=all.find(v=>v.provider===r.provider&&v.sessionId===r.sessionId);
            if(previous){previous.certain+=r.certain;previous.likely+=r.likely;previous.possible+=r.possible;}else all.push(r);return all;
          },[]);
        if (row) for (const e of this.db.prepare("SELECT provider,session_id,NULLIF(turn_id,'') turn_id FROM adit_attribution_turns WHERE run_id=? AND repository=? AND sha=? ORDER BY provider,session_id,turn_id").all(run!.id, scope.repository, c.sha) as Row[]) addSession(e.provider, e.session_id, e.turn_id);
        const alternatives = row ? (this.db.prepare("SELECT provider,session_id,sum(certain_lines) certain,sum(likely_lines) likely,sum(possible_lines) possible FROM adit_attribution_alternatives WHERE run_id=? AND repository=? AND sha=? GROUP BY provider,session_id ORDER BY provider,session_id").all(run!.id, scope.repository, c.sha) as Row[]).map(r => ({ provider: r.provider, sessionId: r.session_id, certain: r.certain, likely: r.likely, possible: r.possible })) : [];
        return { ...c, subject: privacy.text(c.subject, "subject"), analysis: !c.included ? "excluded" : row ? "done" : "pending", submitter, writers, alternatives, lines };
      });
      const included = commits.filter(c => c.included), pending = included.filter(c => c.analysis === "pending").length;
      if (options.lines && pending) throw new LocalStateError(`${pending} selected commits have not been analyzed. Collect and analyze them before including line statistics.`, 409);
      const sessionList = [...sessions.values()];
      for (const s of sessionList) s.contextIncluded = !(s.parent && s.relationship !== "fork" && sessions.has(identity(s.provider, s.parent)));
      const contextSessions = sessionList.filter(s => s.contextIncluded);
      for (const session of sessionList) {
        const turns = [...(associatedTurns.get(identity(session.provider, session.sessionId)) || [])];
        session.rangeModels = (this.db.prepare("SELECT DISTINCT model FROM adit_history_messages WHERE provider=? AND session_id IN (SELECT value FROM json_each(?)) AND turn_id IN (SELECT value FROM json_each(?)) AND model IS NOT NULL").all(session.provider, segmentJSON(session.provider,session.sessionId), JSON.stringify(turns)) as Row[]).map(row => privacy.text(row.model, "range-model"));
      }
      const lineTotals = pending ? null : included.reduce((total, c) => {
        if (c.lines) for (const key of Object.keys(total) as (keyof PrLines)[]) total[key] += c.lines[key]; return total;
      }, zeroLines());
      const sum = (field: "prompts" | "duration") => contextSessions.length && contextSessions.every(s => s[field] !== null) ? contextSessions.reduce((n, s) => n + (s[field] || 0), 0) : null;
      const warnings: string[] = [];
      if (pending) warnings.push(say(`${pending} commits have no completed analysis; they are not classified as unmatched.`, `${pending} 个提交尚未完成分析，不归入未匹配项。`));
      if (sessionList.some(s => s.revision === null)) warnings.push(say("Some associated source sessions are no longer available.", "部分关联会话的原始记录已不可用。"));
      if (contextSessions.length < sessionList.length) warnings.push(say("Subtask conversations remain in the provenance map; their prompt, time and usage totals are not added again when their parent is included.", "子任务会话保留在来源关联中；父会话已纳入时，提问、时间和用量不再重复累计子任务。"));
      const usage = new Map<string, Row>();
      let duplicateUsage = 0;
      for (const s of contextSessions) for (const u of this.db.prepare("SELECT u.*,o.request_id,o.response_id FROM adit_history_usage_entries u JOIN adit_history_usage_observations o ON o.id=u.id WHERE u.provider=? AND u.session_id IN (SELECT value FROM json_each(?)) AND u.ledger_role='canonical' ORDER BY u.id").all(s.provider, segmentJSON(s.provider,s.sessionId)) as Row[]) {
        const key = u.request_id || u.response_id ? JSON.stringify([s.provider, u.request_id, u.response_id]) : u.id;
        const prior = usage.get(key);
        if (prior) duplicateUsage++;
        if (!prior || u.completeness === "complete" && prior.completeness !== "complete") usage.set(key, u);
      }
      if (duplicateUsage) warnings.push(say(`${duplicateUsage} repeated usage records were deduplicated by native request/response identity.`, `${duplicateUsage} 条重复用量记录已按原生请求／响应编号去重。`));
      const result: PrDescription = { id: descriptionId, title: privacy.text(options.title || `${basename(scope.repository)} · ${scope.kind === "branches" ? `${scope.head} → ${scope.base}` : `${included.length} commits`}`, "title"), createdAt: Date.now(), scope,
        options, markdown: "", commits, sessions: sessionList.map(({ revision: _r, parent: _p, relationship: _relationship, ...s }) => s),
        summary: { commits: included.length, sessions: sessionList.length, unmatched: included.filter(c => c.analysis === "done" && !c.submitter).length,
          pending, excludedMerges: commits.filter(c => c.reason === "merge").length, excludedAuthors: commits.filter(c => c.reason === "other-author").length,
          lines: lineTotals, prompts: sum("prompts"), duration: sum("duration") }, warnings, attributionVersion: run?.algorithm_version ?? null };
      const links: { number: number; url: string; partial: boolean; version: string; provider: string; sessionId: string }[] = [];
      if (options.shareLinks) for (const s of sessionList) {
        const required = [...(associatedTurns.get(identity(s.provider, s.sessionId)) || [])];
        const candidates = this.db.prepare("SELECT s.viewer_url,s.remote_url,v.id,v.scope_kind FROM adit_shares s JOIN adit_share_versions v ON v.id=s.current_version_id WHERE s.workspace_id=? AND s.provider=? AND s.session_id=? AND s.status='published' ORDER BY (v.scope_kind='all') DESC,s.published_at DESC").all(w.id, s.provider, s.sessionId) as Row[];
        const share = candidates.find(candidate => { const turns = new Set((this.db.prepare("SELECT turn_id FROM adit_share_turns WHERE version_id=?").all(candidate.id) as Row[]).map(t => t.turn_id)); return required.length ? required.every(id => turns.has(id)) : candidate.scope_kind === "all"; });
        if (share && /^https:\/\//.test(share.viewer_url || share.remote_url)) links.push({ number: s.number, url: share.viewer_url || share.remote_url, partial: share.scope_kind !== "all", version: share.id, provider: s.provider, sessionId: s.sessionId });
        else warnings.push(say(`Conversation #${s.number} has no published share covering these prompts.`, `会话 #${s.number} 没有覆盖相关提问的已发布分享。`));
      }
      const prompts: { number: number; text: string; provider: string; sessionId: string; turnId: string }[] = [];
      if (options.prompts) for (const s of sessionList) {
        const ids = associatedTurns.get(identity(s.provider, s.sessionId));
        if (!ids?.size) { warnings.push(say(`Conversation #${s.number} has no prompt directly associated with this range.`, `会话 #${s.number} 没有与本次范围直接关联的提问。`)); continue; }
        for (const t of this.db.prepare("SELECT t.id,t.prompt_message_id FROM adit_history_turns t WHERE t.provider=? AND t.session_id IN (SELECT value FROM json_each(?)) AND t.id IN (SELECT value FROM json_each(?)) ORDER BY t.started_at,t.ordinal").all(s.provider, segmentJSON(s.provider,s.sessionId), JSON.stringify([...ids])) as Row[]) {
          const blocks = this.db.prepare("SELECT kind,text_content FROM adit_history_blocks WHERE message_id=? ORDER BY block_index").all(t.prompt_message_id) as Row[];
          prompts.push({ number: s.number, text: privacy.text(submittedPromptText(s.provider, blocks.map(b=>({type:b.kind,text:b.text_content||""}))) || "", "prompt"), provider: s.provider, sessionId: s.sessionId, turnId: t.id });
        }
      }
      result.markdown = renderPrMarkdown(result, prompts, links);
      if (template) {
        const text = privacy.text(template.text, "template");
        result.markdown = text.includes("{{ADIT_DISCLOSURE}}") ? text.replaceAll("{{ADIT_DISCLOSURE}}", result.markdown) : text.trimEnd() + "\n\n" + result.markdown;
      }
      return { result, options, commits, sessionList, usage, links, prompts };
    })();
    return this.db.transaction(() => {
      insertPublication(this.db, "adit_pr_descriptions", { id: result.id, workspace_id: w.id, repository: scope.repository, title: result.title,
        scope_kind: scope.kind, source_ref: scope.head, target_ref: scope.base, source_head_sha: scope.headSha, target_head_sha: scope.baseSha,
        merge_base_sha: scope.mergeBase, scope_digest: scope.digest, status: "ready", created_at: result.createdAt, generation_version: 1,
        attribution_version: result.attributionVersion, detail_level: options.detail, language: options.language, template_ref: template?.path,
        template_digest: template?.digest, include_session_ids: +options.sessions, include_line_stats: +options.lines, include_assisted_by: +options.assistedBy,
        include_prompts: +options.prompts, include_share_links: +options.shareLinks, include_adit_label: +options.aditLabel, author_filter: scope.author,
        merge_policy: "exclude", commit_count: result.summary.commits, session_count: result.summary.sessions, unmatched_count: result.summary.unmatched,
        excluded_merge_count: result.summary.excludedMerges, excluded_author_count: result.summary.excludedAuthors, markdown: result.markdown, snapshot_json: JSON.stringify(result) });
      for (const c of commits) {
        insertPublication(this.db, "adit_pr_description_commits", { description_id: result.id, repository: scope.repository, commit_sha: c.sha,
          ordinal: commits.indexOf(c), subject_snapshot: c.subject, inclusion_status: c.included ? "included" : "excluded", exclusion_reason: c.reason,
          analysis_status: c.analysis, submit_provider: c.submitter?.provider, submit_session_id: c.submitter?.sessionId, submit_turn_id: c.submitter?.turnId,
          match_method: c.submitter?.method, ...Object.fromEntries(Object.entries(c.lines || zeroLines()).map(([k, v]) => [`${k}_lines`, c.lines ? v : null])) });
        for (const s of [...c.writers.map(s => ({ ...s, role: "writer" })), ...c.alternatives.map(s => ({ ...s, role: "alternative" })), ...(c.submitter ? [{ ...c.submitter, role: "submitter", certain: null, likely: null, possible: null }] : [])])
          insertPublication(this.db, "adit_pr_description_commit_sessions", { description_id: result.id, commit_sha: c.sha, provider: s.provider, session_id: s.sessionId,
            role: s.role, certain_lines: s.certain, likely_lines: s.likely, possible_lines: s.possible });
      }
      for (const s of sessionList) {
        insertPublication(this.db, "adit_pr_description_sessions", { description_id: result.id, provider: s.provider, session_id: s.sessionId, display_number: s.number,
          transcript_revision: s.revision, prompt_count: s.prompts, work_duration_ms: s.duration });
        for (const [scope, models] of [["session_context", s.models], ["associated_turns", s.rangeModels]] as const) for (const model of models)
          insertPublication(this.db, "adit_pr_description_models", { description_id: result.id, provider: s.provider, session_id: s.sessionId, model, evidence_scope: scope });
      }
      for (const u of usage.values())
          insertPublication(this.db, "adit_pr_description_usage", { description_id: result.id, source_usage_entry_id: u.id, provider: u.provider, session_id: u.session_id,
            model: u.model, inclusion_scope: "session_context", input_tokens: u.uncached_input_tokens, output_tokens: u.output_tokens, cache_read_tokens: u.cache_read_tokens,
            cache_write_tokens: u.cache_write_tokens, reasoning_tokens: u.reasoning_tokens, total_tokens: u.total_tokens, cost_microusd: u.provider_cost_microusd, completeness: u.completeness });
      for (const link of links) insertPublication(this.db, "adit_pr_description_share_links", { description_id: result.id, provider: link.provider, session_id: link.sessionId, share_version_id: link.version, url_snapshot: link.url, coverage_kind: link.partial ? "excerpt" : "whole_session" });
      prompts.forEach((prompt, ordinal) => insertPublication(this.db, "adit_pr_description_prompts", { description_id: result.id, provider: prompt.provider, session_id: prompt.sessionId, turn_id: prompt.turnId, ordinal, sanitized_text: prompt.text, redaction_policy_version: 1 }));
      return result;
    }).immediate();
  }
}

export function renderPrMarkdown(r: PrDescription, prompts: { number: number; text: string }[] = [], links: { number: number; url: string; partial: boolean }[] = []) {
  const zh = r.options.language === "zh", say = (en: string, cn: string) => zh ? cn : en;
  const n = (v: number) => v.toLocaleString(zh ? "zh-CN" : "en-US");
  const s = r.summary, l = s.lines;
  const percentage = (v: number) => l?.eligible ? (v / l.eligible * 100).toFixed(1) + "%" : "—";
  const out = ["## " + say("AI usage disclosure", "AI 使用声明")];
  const agents = [...new Set(r.sessions.map(s => s.agent))].join(", ");
  out.push(say(`The selected range contains ${n(s.commits)} commits linked to ${n(s.sessions)} unique conversations${agents ? ` (${agents})` : ""}. ${n(s.unmatched)} commits have no matched submitting conversation.`, `所选范围包含 ${n(s.commits)} 个提交，关联 ${n(s.sessions)} 个去重会话${agents ? `（${agents}）` : ""}。${n(s.unmatched)} 个提交未找到提交它的会话。`));
  if (r.options.lines && l) {
    out.push(say(`Across these commits, ${n(l.eligible)} added lines were eligible for comparison (blank lines, brackets and generated files excluded). **${percentage(l.certain + l.likely + l.possible)} matched recorded session content** (certain ${percentage(l.certain)}, likely ${percentage(l.likely)}, possible ${percentage(l.possible)}). ${percentage(l.unknown)} could not be traced to any session; that does not mean they were written by hand. These are per-commit totals, not the net PR diff.`, `逐提交累计有 ${n(l.eligible)} 行新增代码可比对（不含空行、括号等过短行和生成文件）。**${percentage(l.certain + l.likely + l.possible)} 匹配到会话记录的内容**（确定 ${percentage(l.certain)}、较确定 ${percentage(l.likely)}、可能 ${percentage(l.possible)}）。${percentage(l.unknown)} 未找到来源；来源不明不等于人写的。这是逐提交累计，不是 PR 的最终净改动。`));
    if (l.moved) out.push(say(`${n(l.moved)} lines were copied or moved from existing code and are counted separately.`, `${n(l.moved)} 行为复制或挪动已有代码，单独计数。`));
  }
  if (s.sessions) {
    const duration = s.duration === null ? say("unknown agent time", "工作时间未知") : `${Math.floor(s.duration / 3600000)} h ${Math.floor(s.duration / 60000) % 60} min`;
    out.push(say(`The associated conversations contain ${s.prompts === null ? "an unknown number of" : n(s.prompts)} prompts and ${duration} in total. These whole-session totals may include work outside the selected commit range.`, `关联完整会话合计 ${s.prompts === null ? "未知" : n(s.prompts)} 次提问、${duration}。这些完整会话统计可能包含本次提交范围以外的工作。`));
  }
  if (r.options.sessions || (r.options.lines && r.options.detail !== "brief")) {
    const headers = [say("Commit", "提交"), say("Submitting conversation", "提交会话"), ...(r.options.lines ? [say("Matched code lines", "已匹配代码行"), say("Untraced code lines", "来源不明代码行")] : [])];
    const table = ["| " + headers.join(" | ") + " |", "| " + headers.map((_, index) => r.options.lines && index >= headers.length - 2 ? "---:" : "---").join(" | ") + " |"];
    for (const c of r.commits.filter(c => c.included)) {
      const other = c.writers.filter(w => w.number !== c.submitter?.number);
      const conversation = c.submitter ? `#${c.submitter.number}` : say(c.analysis === "pending" ? "Analysis pending" : "No submitting conversation found", c.analysis === "pending" ? "尚未分析" : "没找到提交会话");
      table.push("| " + [c.sha.slice(0, 7) + " " + md(c.subject), r.options.sessions ? conversation + (other.length ? `; ${say("content", "代码来源")}: ${other.map(w => "#" + w.number).join(", ")}` : "") : submissionLabel(c, zh), ...(r.options.lines ? [c.lines ? `${n(c.lines.certain + c.lines.likely + c.lines.possible)} of ${n(c.lines.eligible)}` : "—", c.lines ? n(c.lines.unknown) : "—"] : [])].join(" | ") + " |");
    }
    table.push("| " + [say("Total", "合计"), r.options.sessions ? `${n(s.sessions)} ${say("conversations", "个会话")}` : say(`${n(s.commits - s.unmatched - s.pending)} matched`, `${n(s.commits - s.unmatched - s.pending)} 个已找到`), ...(r.options.lines ? [l ? `${n(l.certain + l.likely + l.possible)} of ${n(l.eligible)} (${percentage(l.certain + l.likely + l.possible)})` : "—", l ? `${n(l.unknown)} (${percentage(l.unknown)})` : "—"] : [])].join(" | ") + " |");
    out.push(table.join("\n"));
  }
  if (r.options.sessions) out.push(r.sessions.map(s => `#${s.number} ${md(s.agent)} · ${s.date === null ? "—" : new Date(s.date).toISOString().slice(0, 10)} · ${s.prompts ?? "—"} ${say("prompts", "次提问")} · ${s.models.map(md).join(", ") || say("model unknown", "模型未知")}`).join("  \n"));
  const excluded = r.commits.filter(c => !c.included);
  if (excluded.length) out.push(say("Excluded commits: ", "排除的提交：") + excluded.map(c => `${c.sha.slice(0, 7)} (${c.reason === "merge" ? say("merge", "合并提交") : say("other author", "其他作者")})`).join(", ") + ".");
  if (!r.options.prompts) out.push(say("Prompts are not included.", "不包含提问原文。"));
  else for (const p of prompts) out.push(`### ${say("Prompt", "提问")} · #${p.number}\n\n${p.text}`);
  for (const link of links) out.push(`[#${link.number}${link.partial ? say(" · excerpt", " · 节选") : ""}](${link.url})`);
  for (const warning of r.warnings) out.push(say("Note: ", "说明：") + warning);
  if (r.options.assistedBy) {
    // Full-session model lists are contextual, not proof of a model's involvement in this range.
    const marks = [...new Set(r.sessions.flatMap(s => s.rangeModels.length ? s.rangeModels.map(model => `${md(s.agent)}:${md(model)}`) : [md(s.agent)]))];
    out.push(marks.map(mark => `Assisted-by: ${mark}`).join("  \n"));
  }
  if (r.options.aditLabel) out.push(zh ? "_AI 使用声明 · 由 ADIT 生成_" : "_AI usage disclosure · by ADIT_");
  return out.filter(Boolean).join("\n\n");
}


function submissionLabel(commit: PrCommit, zh: boolean) {
  return commit.analysis === "pending" ? (zh ? "尚未分析" : "Analysis pending")
    : commit.submitter ? (zh ? "已找到" : "Found") : (zh ? "未找到提交会话" : "No submitting conversation found");
}

function clarifyPrMarkdown(result: PrDescription): string {
  const zh = result.options.language === "zh";
  let inLegacyTable = false;
  return result.markdown.split("\n").map(line => {
    const legacy = line.startsWith("| Commit |") && line.includes("| Matched session content |") || line.startsWith("| 提交 |") && line.includes("| 匹配到会话内容 |");
    if (legacy) {
      inLegacyTable = !line.includes("| Conversation |") && !line.includes("| 会话 |");
      line = line.replace("| Matched session content |", "| Matched code lines |").replace("| Not traced |", "| Untraced code lines |")
        .replace("| 匹配到会话内容 |", "| 已匹配代码行 |").replace("| 来源不明 |", "| 来源不明代码行 |")
        .replace("| Conversation |", "| Submitting conversation |").replace("| 会话 |", "| 提交会话 |");
      if (inLegacyTable) line = line.replace(zh ? "| 提交 |" : "| Commit |", zh ? "| 提交 | 提交会话 |" : "| Commit | Submitting conversation |");
      return line;
    }
    if (!line.startsWith("|")) { inLegacyTable = false; return line; }
    if (!inLegacyTable) return line;
    const separator = (/^\|(?:\\.|[^|\\])*\|/.exec(line)?.[0].length ?? 0) - 1;
    if (separator < 0) return line;
    const commit = result.commits.find(c => c.included && line.startsWith("| " + c.sha.slice(0,7) + " "));
    const value = commit ? submissionLabel(commit, zh) : /^\|\s*:?-+/.test(line) ? "---"
      : zh ? `${result.summary.commits - result.summary.unmatched - result.summary.pending} 个已找到` : `${result.summary.commits - result.summary.unmatched - result.summary.pending} matched`;
    return line.slice(0,separator + 1) + " " + value + " |" + line.slice(separator + 1);
  }).join("\n");
}
