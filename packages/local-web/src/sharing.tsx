import { AgentLabel } from "./agent-label";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, ExternalLink, Link, Loader2, LockKeyhole, Share2 } from "lucide-react";
import { type ShareDraft, type ShareItem, type ShareOptions } from "../../core/src/local-history/sharing-types";
import { p, number, publicationDate, PublicationAgent, PublicationCopy, PublicationError, SharedSessionView, type PublicationApi } from "./publication-ui";

type Detail = ShareDraft & { remoteUrl?: string; viewerUrl?: string };
export function SharingPage({ workspace, api, review, onNavigate }: { workspace: { id: string }; api: PublicationApi; review: boolean; onNavigate: (path: string) => void }) {
  const [list, setList] = useState<{ total: number; items: ShareItem[]; nextOffset: number | null; nextCursor?: string | null }>();
  const [detail, setDetail] = useState<Detail>(), [error, setError] = useState(""), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [title, setTitle] = useState(""), [options, setOptions] = useState<ShareOptions>(), [nameInput, setNameInput] = useState("");
  const update = useRef(0), start = useRef(false), idempotency = useRef(crypto.randomUUID()), publishing = useRef(false);
  const [retryPreview, setRetryPreview] = useState(0);
  const query = new URLSearchParams(location.search);
  const endpoint = (path: string) => path + (path.includes("?") ? "&" : "?") + new URLSearchParams({ workspaceId: workspace.id });
  const accept = (d: Detail) => { setDetail(d); setTitle(d.snapshot.title); setOptions(d.options); };
  const choose = async (id: string) => { const request = ++update.current; setLoading(true); setError(""); try { const d = await api<Detail>(endpoint(`/shares/${id}`)); if (request === update.current) setDetail(d); } catch (e) { if (request === update.current) setError(String(e)); } finally { if (request === update.current) setLoading(false); } };
  const loadList = async (offset = 0) => {
    const d = await api<NonNullable<typeof list>>(endpoint(`/shares?offset=${offset}${offset && list?.nextCursor ? `&cursor=${list.nextCursor}` : ""}`));
    setList(old => ({ ...d, items: offset ? [...(old?.items || []), ...d.items] : d.items }));
    if (!offset) { const id = query.get("id") || d.items[0]?.id; if (id) await choose(id); else setLoading(false); }
  };
  const loadInitial = async () => {
      setLoading(true); setError("");
      try {
        if (review) {
          const id = query.get("draft");
          const d = id ? await api<Detail>(endpoint(`/share-drafts/${id}`)) : await api<Detail>(endpoint("/share-drafts"), "POST", { provider: query.get("provider"), sessionId: query.get("session") });
          accept(d); history.replaceState(null, "", `/share-review/${workspace.id}?draft=${d.id}`); setLoading(false);
        } else await loadList();
      } catch (e) { setError(String(e)); setLoading(false); }
  };
  useEffect(() => {
    if (start.current) return; start.current = true;
    void loadInitial();
  }, []);
  const changed = !!detail && !!options && (title !== detail.snapshot.title || JSON.stringify(options) !== JSON.stringify(detail.options));
  useEffect(() => {
    if (!review || !detail || !options || (!changed && !retryPreview) || busy) return;
    const request = ++update.current;
    const timer = setTimeout(() => {
      setLoading(true); setError("");
      void api<Detail>(endpoint(`/share-drafts/${detail.id}`), "PATCH", { title, options }).then(d => { if (request === update.current) { setDetail(d); setTitle(d.snapshot.title); setRetryPreview(0); idempotency.current = crypto.randomUUID(); } }).catch(e => { if (request === update.current) setError(String(e)); }).finally(() => { if (request === update.current) setLoading(false); });
    }, 350);
    return () => clearTimeout(timer);
  }, [title, options, review, changed, busy, retryPreview]);
  const toggle = (key: keyof ShareOptions, value: unknown) => setOptions(o => o ? { ...o, [key]: value } : o);
  const publish = async () => {
    if (!detail || publishing.current) return;
    if (!detail.gistConfigured) { onNavigate(`/settings/workspaces/${workspace.id}`); return; }
    publishing.current = true; setBusy(true); setError("");
    try { const d = await api<Detail>(endpoint(`/share-drafts/${detail.id}/publish`), "POST", { version: detail.version, digest: detail.digest, idempotencyKey: idempotency.current }); onNavigate(`/share/${workspace.id}?id=${d.id}`); }
    catch (e) { setError(String(e)); try { setDetail(await api<Detail>(endpoint(`/share-drafts/${detail.id}`))); } catch { /* Preserve preview during connectivity failure. */ } }
    finally { publishing.current = false; setBusy(false); }
  };
  const caption = detail?.remoteUrl ? `### ${p("AI 协作记录", "AI collaboration record")}\n\n${p(
    `分享一段使用 ${detail.snapshot.agent} 的开发会话，共 ${detail.snapshot.promptCount} 轮提问，关联 ${detail.snapshot.commitCount} 个提交。`,
    `Sharing a development session with ${detail.snapshot.agent}: ${detail.snapshot.promptCount} prompt${detail.snapshot.promptCount === 1 ? "" : "s"} and ${detail.snapshot.commitCount} linked commit${detail.snapshot.commitCount === 1 ? "" : "s"}.`,
  )}\n\n[${(detail.snapshot.title.trim() || p("未命名会话", "Untitled session")).replace(/\r?\n/g, " ").replace(/([\\\[\]])/g, "\\$1")}](${detail.viewerUrl || detail.remoteUrl})` : undefined;
  return <section className={`publication-page ${review ? "share-review-page" : "share-library-page"}`}>
    <div className="publication-toolbar">{review ? <><button onClick={() => onNavigate(`/sessions/${workspace.id}${detail ? `?${new URLSearchParams({ provider: detail.provider, session: detail.sessionId })}` : ""}`)}><ArrowLeft size={14} />{p("返回会话", "Back to sessions")}</button><span className="publication-toolbar-title"><Share2 size={14} />{p("分享这个会话", "Share this session")}</span><span className="publication-truncate publication-muted">{detail?.snapshot.title}</span><span className="publication-toolbar-right publication-muted"><LockKeyhole size={13} />{p("这一页只有你能看到，生成链接之前不会上传任何内容", "Only you can see this page. Nothing is uploaded before you publish.")}</span></> : <><span>{p("已分享的会话", "Shared sessions")} <span className="publication-muted">{list?.total ?? "—"}</span></span><div className="publication-toolbar-right"><PublicationCopy text={caption} label={p("复制分享文案", "Copy share text")} /><button className="primary" onClick={() => onNavigate(`/sessions/${workspace.id}`)}><Share2 size={14} />{p("去分享", "Share a session")}</button></div></>}</div>
    <PublicationError error={error} />
    {review && error && !detail && <div className="publication-retry"><button disabled={loading} onClick={() => void loadInitial()}>{p("重新检查预览", "Refresh preview")}</button></div>}
    {review && error && detail && ["ready", "failed"].includes(detail.status) && <div className="publication-retry"><button disabled={loading} onClick={() => setRetryPreview(n => n + 1)}>{p("重新检查预览", "Refresh preview")}</button></div>}
    <div className="publication-work">
      {!review && <aside className="publication-list share-list">{list?.items.map((s, index) => <div key={s.id}>
        {(index === 0 || new Date(s.published_at!).toDateString() !== new Date(list.items[index - 1].published_at!).toDateString()) && <div className="publication-day">{publicationDate(s.published_at)} {p("分享", "shared")}</div>}
        <div className="publication-list-entry"><span className="publication-list-node"><PublicationAgent provider={s.provider} /></span><div role="button" tabIndex={0} className={`publication-choice ${detail?.id === s.id ? "on" : ""}`} onClick={() => void choose(s.id)} onKeyDown={e => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); void choose(s.id); } }}><strong>{detail?.id === s.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{s.title}</strong><small><AgentLabel provider={s.provider} /> · {p("分享于", "Shared")} {publicationDate(s.published_at, true)} · <span className="publication-success">{p("已分享", "Shared")}</span></small><small className="publication-link"><Link size={12} /><a href={s.remote_url || undefined} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>{s.remote_url}</a></small><small>{s.prompt_count} {p("轮提问", "prompts")} · {s.commit_count} {p("个提交", "commits")}</small></div></div>
      </div>)}{list?.nextOffset != null && <button onClick={() => void loadList(list.nextOffset!).catch(e => setError(String(e)))}>{p("加载更多", "Load more")}</button>}{list?.total === 0 && <div className="publication-empty">{p("还没有分享过会话", "No shared sessions yet")}</div>}</aside>}
      <div className="publication-preview" aria-busy={loading}>{review && detail && <div className="share-review-heading"><b>{p("公开后别人看到的内容", "What others will see")}</b><span className="publication-success">{p("已遮盖", "Redacted")} {number(Object.values(detail.redactions).reduce((n, v) => n + v, 0))} {p("处", "locations")}</span><span className="publication-muted">{detail.excludedCategories} {p("类内容不分享", "content types excluded")}</span>{loading && <Loader2 className="spin" size={14} />}</div>}
        {detail ? <><SharedSessionView snapshot={detail.snapshot} review={review} />{review && detail.memoryActions > 0 && <p className="publication-muted share-memory-note"><LockKeyhole size={13} />{p(`写入个人记忆的 ${detail.memoryActions} 次操作已去掉，不会出现在分享页里`, `${detail.memoryActions} personal memory writes were removed and will not appear in the shared page.`)}</p>}{!review && detail.remoteUrl && <a className="share-open-gist" href={detail.remoteUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />{p("打开分享链接", "Open share link")}</a>}</> : <div className="publication-empty">{review ? loading ? <><Loader2 className="spin" />{p("正在检查分享内容…", "Checking share content…")}</> : p("内容检查失败，请重试", "Content check failed. Please try again.") : loading ? <Loader2 className="spin" /> : p("选择一个分享查看内容", "Select a shared session")}</div>}
      </div>
      {review && detail && options && <div className="share-settings"><div className="share-settings-scroll">
        <section><h4>{p("标题", "Title")}</h4><input aria-label={p("标题", "Title")} value={title} maxLength={500} onChange={e => setTitle(e.target.value)} /><p className="publication-help">{p("默认用第一句提问，可以改成别人一眼能看懂的说法", "Starts with the first prompt. Give it a title others can understand at a glance.")}</p></section>
        <section><h4>{p("分享范围", "Share scope")}</h4><label><input type="radio" checked={options.scope === "all"} onChange={() => toggle("scope", "all")} />{p("整个会话", "Entire session")}<small>{detail.turns.length} {p("轮提问", "prompts")}</small></label><label><input type="radio" checked={options.scope === "selected"} onChange={() => setOptions({ ...options, scope: "selected", turnIds: options.turnIds.length ? options.turnIds : detail.turns.slice(0, 1).map(t => t.id) })} />{p("只分享选中的轮次", "Selected prompts only")}</label>{options.scope === "selected" && <div className="share-turn-options">{detail.turns.map(t => <label key={t.id}><input type="checkbox" checked={options.turnIds.includes(t.id)} onChange={e => toggle("turnIds", e.target.checked ? [...options.turnIds, t.id] : options.turnIds.filter(id => id !== t.id))} /><span>{t.ordinal}. {t.prompt}</span></label>)}</div>}</section>
        <section><h4>{p("包含的内容", "Include")}</h4>{([
          ["dialogue", p("提问和回复", "Prompts and replies"), `${detail.snapshot.promptCount} ${p("轮", "prompts")}`],
          ["commands", p("执行过的命令", "Executed commands"), `${detail.snapshot.commandCount} ${p("条，本机信息已遮盖", "commands, local details redacted")}`],
          ["commits", p("关联的提交", "Linked commits"), `${detail.snapshot.commitCount}`],
          ["outputs", p("命令输出", "Command output"), p("可能含本机数据，默认不分享", "May contain local data; excluded by default")],
          ["thinking", p("思考过程", "Thinking"), ""], ["cost", p("花费", "Cost"), p("默认不公开", "Excluded by default")],
        ] as const).map(([key, label, hint]) => <label key={key}><input type="checkbox" checked={options[key]} onChange={e => toggle(key, e.target.checked)} />{label}<small>{hint}</small></label>)}</section>
        <section><h4>{p("自动遮盖", "Automatic redaction")}</h4>{([
          ["path", p("带用户名的本机路径", "Local paths containing usernames")], ["identifier", p("本机会话文件名和调用编号", "Local session filenames and call IDs")], ["installation", p("本机安装目录", "Local installation directories")],
        ] as const).map(([key, label]) => <div className="share-redaction" key={key}><span>{label}</span><small>{detail.redactions[key] || 0} {p("处", "locations")}</small><em>{p("已遮盖", "Redacted")}</em></div>)}
          <div className="share-redaction"><span>{p("密钥、邮箱、IP 地址", "Secrets, email addresses, IP addresses")}</span><small>{(detail.redactions.secret || 0) + (detail.redactions.email || 0) + (detail.redactions.ip || 0) || p("扫描过，没有发现", "Scanned; none found")}</small></div>
          <div className="share-redaction"><span>{p("提到的他人名字", "Other people’s names")}</span><small>{options.names.length ? p("已遮盖", "Redacted") : p("保留", "Kept")}</small></div><div className="share-name-input"><input aria-label={p("要遮盖的名字", "Name to redact")} placeholder={p("输入要遮盖的名字", "Enter a name to redact")} value={nameInput} onChange={e => setNameInput(e.target.value)} /><button disabled={nameInput.trim().length < 2} onClick={() => { toggle("names", [...options.names, nameInput.trim()]); setNameInput(""); }}>{p("改为遮盖", "Redact")}</button></div>{options.names.map(name => <button className="share-name" key={name} onClick={() => toggle("names", options.names.filter(n => n !== name))}>{name} ×</button>)}
          <div className="share-redaction"><span>{p("写入个人记忆的操作", "Personal memory writes")}</span><small>{detail.memoryActions} {p("次", "operations")}</small><span className="publication-muted">{p("不分享", "Excluded")}</span></div>
        </section>
      </div><div className="share-publish-footer"><button className="primary" disabled={busy || loading || changed || !!error && detail.status === "publishing"} onClick={() => void publish()}>{busy && <Loader2 size={14} className="spin" />}{p("发布到 GitHub Gist", "Publish to GitHub Gist")}</button><span className="publication-help">{p("发布后可将链接分享给同事，或贴到 PR、commit 等地方", "Share the link with colleagues or add it to a PR or commit.")}</span><small className="publication-muted">{p("不公开列出；持有链接的人可以阅读。", "Unlisted; anyone with the link can read it.")}{!detail.gistConfigured && ` ${p("请先配置此目录的 GitHub 令牌。", "Configure this workspace’s GitHub token first.")}`}</small></div></div>}
    </div>
  </section>;
}
