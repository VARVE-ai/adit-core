import { useCallback, useEffect, useRef, useState } from "react";
import { ListLoadMore, usePagedList, type ListPage } from "./paged-list";
import { ArrowLeft, GitBranch, GitPullRequest, Loader2 } from "lucide-react";
import { defaultPrOptions, type PrDescription, type PrItem, type PrOptions, type PrScope } from "../../core/src/local-history/pr-types";
import { p, publicationDate, repoName, PublicationCopy, PublicationError, PublicationMarkdown, type PublicationApi } from "./publication-ui";

export function PrDescriptionsPage({ workspace, api, create, onNavigate }: { workspace: { id: string; repositories: string[] }; api: PublicationApi; create: boolean; onNavigate: (path: string) => void }) {
  const query = new URLSearchParams(location.search);
  const [repository, setRepository] = useState(query.get("repository") || workspace.repositories[0] || "");
  const [head, setHead] = useState(query.get("head") || ""), [base, setBase] = useState(query.get("base") || "");
  const [refs, setRefs] = useState<string[]>([]), [options, setOptions] = useState<PrOptions>(() => {
    // Removed form fields stay excluded even when opening an older CLI/deep link.
    const initial: PrOptions = { ...defaultPrOptions, language: "en", sessions: false, prompts: false, shareLinks: false };
    if (["brief", "detailed", "project-template"].includes(query.get("detail") || "")) initial.detail = query.get("detail") as PrOptions["detail"];
    for (const key of ["lines", "assistedBy", "aditLabel"] as const) if (query.has(key)) initial[key] = query.get(key) === "true";
    for (const key of ["template", "title"] as const) if (query.get(key)) initial[key] = query.get(key)!;
    return initial;
  });
  const [detail, setDetail] = useState<PrDescription>();
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [loading, setLoading] = useState(!create), [scope, setScope] = useState<PrScope>();
  const serial = useRef(0), mounted = useRef(true), generating = useRef(false);
  const endpoint = (path: string) => path + (path.includes("?") ? "&" : "?") + new URLSearchParams({ workspaceId: workspace.id });
  const choose = async (id: string) => { const current = ++serial.current; setLoading(true); setError(""); try { const d = await api<PrDescription>(endpoint(`/pr-descriptions/${id}`)); if (current === serial.current) setDetail(d); } catch (e) { if (current === serial.current) setError(String(e)); } finally { if (current === serial.current) setLoading(false); } };
  const request = useCallback((offset: number, cursor: string | undefined, signal: AbortSignal) =>
    api<ListPage<PrItem>>(`/pr-descriptions?${new URLSearchParams({ workspaceId: workspace.id, offset: String(offset), limit: "50", ...(cursor ? { cursor } : {}) })}`, "GET", undefined, signal), [api, workspace.id]);
  const pagination = usePagedList<PrItem, ListPage<PrItem>>({ request, itemKey: item => item.id, enabled: !create,
    onFirstPage: d => { const id = query.get("id") || d.items[0]?.id; if (id) void choose(id); else setLoading(false); },
  });
  const list = pagination.data;
  useEffect(() => { if (pagination.error && !list) setLoading(false); }, [pagination.error, list]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; serial.current++; }; }, []);
  useEffect(() => {
    if (!create || !repository) return;
    const controller = new AbortController(); setLoading(true); setError(""); setScope(undefined);
    void api<{ refs: string[]; current: string | null }>(endpoint("/pr-refs"), "POST", { repository }, controller.signal).then(d => { setRefs(d.refs); setHead(h => d.refs.includes(h) ? h : d.current || ""); setBase(b => d.refs.includes(b) ? b : ""); }).catch(e => { if (!controller.signal.aborted) setError(String(e)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [repository, create]);
  const set = (key: keyof PrOptions, value: unknown) => setOptions(o => ({ ...o, [key]: value }));
  const generate = async () => {
    if (generating.current) return;
    generating.current = true;
    setBusy(true); setError("");
    try {
      const explicit = query.getAll("commit");
      const resolved = await api<{ scopeId: string; scope: PrScope }>(endpoint("/pr-scopes/resolve"), "POST", { repository, ...(explicit.length ? { commits: explicit } : { head, base }) });
      setScope(resolved.scope);
      const job = await api<{ jobId: string }>(endpoint("/pr-descriptions"), "POST", { scopeId: resolved.scopeId, options, idempotencyKey: crypto.randomUUID() });
      while (mounted.current) {
        const state = await api<{ status: string; result?: PrDescription; error?: string }>(endpoint(`/pr-description-jobs/${job.jobId}`));
        if (state.status === "failed") throw new Error(state.error);
        if (state.status === "done" && state.result) { onNavigate(`/pr/${workspace.id}?id=${state.result.id}`); return; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (e) { if (mounted.current) setError(String(e)); } finally { generating.current = false; if (mounted.current) setBusy(false); }
  };
  const detailLabel = (value: string) => value === "brief" ? p("简版", "Brief") : value === "project-template" ? p("项目要求的格式", "Project format") : p("详版", "Detailed");
  return <section className={`publication-page ${create ? "pr-create-page" : "pr-library-page"}`}>
    <div className="publication-toolbar">{create ? <><button onClick={() => onNavigate(`/pr/${workspace.id}`)}><ArrowLeft size={14} />{p("返回 PR 说明", "Back to PR descriptions")}</button><span className="publication-toolbar-title">{p("创建 PR 说明", "Create PR description")}</span></> : <><span>{p("PR 说明", "PR Descriptions")} <span className="publication-muted">{list?.total ?? "—"}</span></span><div className="publication-toolbar-right"><PublicationCopy text={detail?.markdown} label={p("复制 PR 说明", "Copy PR description")} /><button className="primary" onClick={() => onNavigate(`/pr-create/${workspace.id}`)}><GitPullRequest size={14} />{p("创建 PR 说明", "Create PR description")}</button></div></>}</div>
    <PublicationError error={error} />
    {create ? <div className="pr-create-scroll"><form className="pr-create-form" onSubmit={e => { e.preventDefault(); void generate(); }}>
      <h1>{p("创建 PR 说明", "Create PR description")}</h1>
      <fieldset disabled={busy}>
        <section><h4>{p("提交范围", "Commit range")}</h4><label className="pr-field">{p("仓库", "Repository")}<select value={repository} onChange={e => setRepository(e.target.value)}>{!workspace.repositories.length && <option value="">{p("当前工作目录还没有可用仓库", "No repositories in this workspace")}</option>}{workspace.repositories.map(r => <option value={r} key={r}>{repoName(r)}</option>)}</select></label>
          {query.getAll("commit").length ? <p className="publication-help">{query.getAll("commit").length} {p("个明确指定的提交", "explicit commits")}<code>{query.getAll("commit").map(s => s.slice(0, 7)).join(", ")}</code></p> : <>
            <label className="pr-field">{p("来源分支 · 准备合入的改动", "Source branch · changes to merge")}<select value={head} disabled={loading} onChange={e => { setHead(e.target.value); setScope(undefined); }}><option value="">{p("选择来源分支", "Select source branch")}</option>{refs.map(r => <option key={r}>{r}</option>)}</select></label>
            <label className="pr-field">{p("目标分支 · 合入到哪里", "Target branch · merge into")}<select value={base} disabled={loading} onChange={e => { setBase(e.target.value); setScope(undefined); }}><option value="">{p("选择目标分支", "Select target branch")}</option>{refs.map(r => <option key={r}>{r}</option>)}</select></label></>}
          <p className="publication-help">{p("统计来源分支中准备合入目标分支的提交。同一会话只统计一次。", "Include commits in the source branch that are not in the target branch. Count each conversation once.")}{scope && ` ${p("已排除的合并提交", "Excluded merge commits")}: ${scope.commits.filter(c => c.reason === "merge").length}; ${p("其他作者", "Other authors")}: ${scope.commits.filter(c => c.reason === "other-author").length}`}</p>
        </section>
        <section className="pr-inline"><h4>{p("详细程度", "Detail")}</h4><div className="publication-segment">{(["brief", "detailed", "project-template"] as const).map(value => <button type="button" key={value} className={options.detail === value ? "on" : ""} aria-pressed={options.detail === value} onClick={() => set("detail", value)}>{detailLabel(value)}</button>)}</div></section>
        {options.detail === "project-template" && <label className="pr-field">{p("项目 Markdown 模板", "Project Markdown template")}<input value={options.template || ""} onChange={e => set("template", e.target.value)} placeholder={p("留空读取仓库已有的 PR 模板", "Leave blank to use the repository PR template")} /><small className="publication-muted">{p("使用 {{ADIT_DISCLOSURE}} 指定插入位置；没有此标记时附在末尾。", "Use {{ADIT_DISCLOSURE}} to choose the insertion point; otherwise the disclosure is appended.")}</small></label>}
        <section><h4>{p("包含", "Include")}</h4>{([
          ["lines", p("行数统计", "Line statistics"), p("默认展示", "Included by default")],
          ["assistedBy", p("Assisted-by 标注", "Assisted-by lines"), p("放在描述末尾", "At the end of the description")],
        ] as const).map(([key, label, hint]) => <label className="pr-check" key={key}><input type="checkbox" checked={options[key]} onChange={e => set(key, e.target.checked)} />{label}<small>{hint}</small></label>)}</section>
        <section><h4>{p("小标签", "Label")}</h4><label className="pr-check">{p('末尾带上"由 ADIT 生成"', 'Add “Generated by ADIT” at the end')}<small>{p("可以关掉", "Optional")}</small><input className="publication-switch" role="switch" type="checkbox" checked={options.aditLabel} onChange={e => set("aditLabel", e.target.checked)} /></label></section>
        <section><h4>{p("说明", "About these results")}</h4><p>{p("来源不明不等于人写的：只是在 Agent 的记录里找不到这几行的原文。", "Untraced does not mean written by hand: the original text of these lines was not found in the agent’s records.")}</p></section>
        <div className="pr-form-footer"><button className="primary" type="submit" disabled={loading || !repository || (!query.getAll("commit").length && (!head || !base))}>{busy && <Loader2 className="spin" size={14} />}{busy ? p("正在生成说明…", "Generating…") : p("生成说明", "Generate description")}</button><button type="button" onClick={() => onNavigate(`/pr/${workspace.id}`)}>{p("取消", "Cancel")}</button><small className="publication-muted">{p("根据本地提交和会话生成，不需要已有 PR。", "Generated from local commits and sessions. No existing PR is required.")}</small></div>
      </fieldset>
    </form></div> : <div className="publication-work">
      <aside ref={pagination.scrollRef} className="publication-list pr-list" aria-busy={pagination.loading}>{list?.items.map((item, index) => <div key={item.id}>{(index === 0 || new Date(item.created_at).toDateString() !== new Date(list.items[index - 1].created_at).toDateString()) && <div className="publication-day">{publicationDate(item.created_at)} {p("生成", "generated")}</div>}<div className="publication-list-entry"><span className="publication-list-node"><GitPullRequest size={14} /></span><button className={`publication-choice ${detail?.id === item.id ? "on" : ""}`} onClick={() => void choose(item.id)}><span className="publication-choice-heading"><strong title={item.title}>{item.title}</strong><small className="publication-choice-meta"><span className="publication-repo" title={repoName(item.repository)}>{repoName(item.repository)}</span><code title={item.source_ref ? `${item.source_ref} → ${item.target_ref}` : p("明确提交列表", "Explicit commit list")}>{item.source_ref ? `${item.source_ref} → ${item.target_ref}` : p("明确提交列表", "Explicit commit list")}</code></small></span><small>{publicationDate(item.created_at, true)} {p("生成", "generated")} · {item.commit_count} {p("个提交", "commits")} · {item.session_count} {p("个关联会话", "linked conversations")} · <span className="publication-success">{p("已生成", "Generated")}</span></small></button></div></div>)}{list?.total === 0 && <div className="publication-empty">{p("还没有生成 PR 说明", "No PR descriptions yet")}</div>}<ListLoadMore pagination={pagination} /></aside>
      <div className="publication-preview pr-detail" aria-busy={loading}>{detail ? <><h1>{detail.title}</h1><div className="publication-meta"><span className="publication-repo">{repoName(detail.scope.repository)}</span><span>{publicationDate(detail.createdAt, true)} {p("生成", "generated")}</span><span>{detailLabel(detail.options.detail)} · {detail.options.language === "en" ? "English" : "中文"}</span></div><div className="publication-meta pr-branch"><span><GitBranch size={14} /><code>{detail.scope.kind === "branches" ? `${detail.scope.head} → ${detail.scope.base}` : p("明确提交列表", "Explicit commit list")}</code></span></div>
        <div className="pr-scope-summary">{[[detail.summary.commits, p("纳入的提交", "Included commits")], [detail.summary.sessions, p("关联会话 · 已去重", "Unique conversations")], [detail.summary.unmatched, p("未找到提交会话", "No submitting conversation")], [detail.summary.excludedMerges, p("已排除的合并提交", "Excluded merge commits")]].map(([value, label]) => <span key={label}><b>{value}</b>{label}</span>)}</div>
        {(detail.summary.excludedAuthors > 0 || detail.summary.pending > 0) && <p className="publication-help">{detail.summary.excludedAuthors > 0 && `${p("已排除的其他作者提交", "Excluded commits by other authors")}: ${detail.summary.excludedAuthors}. `}{detail.summary.pending > 0 && `${p("尚未分析", "Analysis pending")}: ${detail.summary.pending}`}</p>}
        <div className="pr-preview-heading"><h4>{p("说明预览", "Description preview")}</h4><span className={detail.summary.unmatched || detail.summary.pending ? "publication-muted" : "publication-success"}>{detail.summary.pending ? p("所选提交的分析尚未完成", "Some selected commits have not been analyzed") : detail.summary.unmatched ? p(`${detail.summary.unmatched} 个提交未找到提交会话`, `${detail.summary.unmatched} commits have no submitting conversation`) : p(`${detail.summary.commits} 个提交都找到了关联会话`, `All ${detail.summary.commits} commits have a linked conversation`)}</span></div>
        <p className="publication-help">{p("按所选提交汇总；未找到会话的提交也会保留。代码来源按内容匹配，关联到会话不代表整个提交都由 AI 编写。", "Summarized for the selected commits, including those without a conversation. Code provenance is matched by content; a linked conversation does not mean the entire commit was written by AI.")}</p>
        {detail.summary.unmatched > 0 && <p className="publication-help">{p("未找到提交会话的提交：", "Commits without a submitting conversation: ")}{detail.commits.filter(c => c.included && c.analysis === "done" && !c.submitter).map(c => c.sha.slice(0,7)).join(", ")}</p>}
        <div className="pr-document"><PublicationMarkdown text={detail.markdown} disclosure /></div><p className="publication-help">{p("复制后粘贴到 PR，或让 Agent 创建 PR 时附上。说明保留生成时的统计；新增提交或修复会话关联后，请重新生成。", "Paste into a PR, or ask your agent to include it when creating one. Statistics reflect generation time; regenerate after adding commits or repairing conversation links.")}</p>
      </> : <div className="publication-empty">{loading ? <Loader2 className="spin" /> : p("选择一条 PR 说明查看内容", "Select a PR description")}</div>}</div>
    </div>}
  </section>;
}
