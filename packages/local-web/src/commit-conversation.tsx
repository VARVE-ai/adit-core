import { useEffect, useState, type AnchorHTMLAttributes } from "react";
import { Archive, ArrowDownToLine, ArrowUpFromLine, ArrowUpRight, ChevronRight, GitCommitHorizontal, Image, MessageSquare, Sparkles } from "lucide-react";
import type { SessionTurnPreview, SessionUsage } from "../../core/src/local-history/session-browser";
import { PlatformIcon } from "./platform-icon";
import { locale, systemMessage, t } from "./i18n";
import { sc } from "./sessions-copy";

const compact = (value: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
function TurnUsage({ usage }: { usage?: SessionUsage }) {
  if (!usage || (!usage.models.length && !usage.efforts.length && !usage.requests)) return null;
  const title = [...usage.models, ...usage.efforts,
    `${sc("输入（不含缓存）")}: ${usage.input ?? "—"}`, `${sc("输出")}: ${usage.output ?? "—"}`,
    `${sc("缓存命中")}: ${usage.cache ?? "—"}`, `${sc("写入缓存")}: ${usage.cacheWrite ?? "—"}`,
    sc("此次提问及后续响应的累计用量"),
  ].join(" · ");
  return <span className="commit-context-usage" title={title} aria-label={sc("模型、思考等级与 Token 用量")}>
    {!!usage.models.length && <code>{usage.models.join(", ")}</code>}
    {!!usage.efforts.length && <small>{usage.efforts.join(", ")}</small>}
    {usage.input !== null && <span className="input"><ArrowDownToLine size={10} />{compact(usage.input)}</span>}
    {usage.output !== null && <span className="output"><ArrowUpFromLine size={10} />{compact(usage.output)}</span>}
    {usage.cache !== null && <span className="cache"><Archive size={10} />{compact(usage.cache)}</span>}
  </span>;
}

export type CommitRecord = {
  provider: string; sessionId: string; turnId: string | null; title: string;
  ordinal: number | null; at: number | null; command: string; prompt: string;
  method: string; matchedSha: string | null;
};
export function sessionHref(workspaceId: string, provider: string, sessionId: string, turnId?: string | null) {
  return `/sessions/${encodeURIComponent(workspaceId)}?${new URLSearchParams({ provider, session: sessionId, ...(turnId ? { turn: turnId } : {}) })}`;
}
export function SessionLink({ onNavigate, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { onNavigate?: (url: string) => void }) {
  return <a {...props} onClick={event => {
    if (onNavigate && props.href && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      onNavigate(props.href);
    }
  }} />;
}
export function CommitConversation({ workspaceId, record, sha, subject, api, onNavigate }: {
  workspaceId: string; record: CommitRecord; sha: string; subject: string;
  api: <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
  onNavigate?: (url: string) => void;
}) {
  const [data, setData] = useState<SessionTurnPreview>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const abort = new AbortController();
    setData(undefined); setError("");
    if (!record.sessionId || !record.turnId) return;
    void api<SessionTurnPreview>("/sessions/preview?" + new URLSearchParams({ workspaceId, provider: record.provider, id: record.sessionId, turnId: record.turnId }),
      "GET", undefined, abort.signal).then(value => { if (!abort.signal.aborted) setData(value); })
      .catch(error => { if (!abort.signal.aborted) setError(String(error)); });
    return () => abort.abort();
  }, [workspaceId, record.provider, record.sessionId, record.turnId, retry]);
  const session = data?.session || { provider: record.provider, id: record.sessionId, title: record.title };
  const targetTurn = data ? data.targetTurnId : record.turnId;
  const href = (turnId?: string | null) => sessionHref(workspaceId, session.provider, session.id, turnId);
  const clock = (at: number | null | undefined) => at == null ? "" : new Date(at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const times = data?.turns.flatMap(turn => [turn.at, turn.replyAt]).filter((at): at is number => at != null) || [];
  if (record.at != null) times.push(record.at);
  const first = times.length ? Math.min(...times) : null, last = times.length ? Math.max(...times) : null;
  const dated = first !== null && last !== null && new Date(first).toDateString() !== new Date(last).toDateString();
  const timestamp = (at: number | null) => at === null ? "" : dated ? new Date(at).toLocaleString(locale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : clock(at);
  const range = first !== null ? first === last ? timestamp(first) : `${timestamp(first)} – ${timestamp(last)}` : "";
  const context = `${t("第 {0} 轮提问", data?.turns.find(turn => turn.id === targetTurn)?.ordinal ?? record.ordinal ?? "—")} · ${t("前后各 1 轮问答")}`;
  return <details className="commit-conversation" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="commit-conversation-heading">
      <span className="commit-conversation-agent"><PlatformIcon platform={session.provider} size={12} /></span>
      <ChevronRight className="commit-conversation-chevron" size={13} />
      <span className="commit-conversation-title" title={session.title}>{session.title}</span>
      {!!data?.turns.length && <span className="commit-conversation-count" title={context} aria-label={context}>{data.turns.length * 2 + 1}</span>}
      {range && <span className="commit-conversation-range">{range}</span>}
      <SessionLink className="commit-conversation-open" href={href(targetTurn)} onNavigate={onNavigate} title={t("在会话中查看提交 {0}", sha.slice(0, 7))} aria-label={t("在会话中查看提交 {0}", sha.slice(0, 7))}><ArrowUpRight size={13} /></SessionLink>
    </summary>
    <div className="commit-conversation-body">
    {error ? <p className="commit-note" role="alert">{systemMessage(error)} <button onClick={() => setRetry(n => n + 1)}>{t("重试")}</button></p>
      : !record.turnId || data?.targetTurnId === null ? <p className="commit-note">{t("未找到对应轮次，可打开会话查看原始记录。")}</p>
      : !data ? <p className="commit-note" role="status">{t("正在读取附近问答…")}</p>
      : <>
        <ol className="commit-conversation-timeline" aria-label={t("提交前后的问答")}>
          {data.turns.map(turn => <li key={turn.id} className={turn.id === data.targetTurnId ? "commit-context-turn current" : "commit-context-turn"}>
            <SessionLink className="commit-context-row prompt" href={href(turn.id)} onNavigate={onNavigate} aria-label={t("打开第 {0} 轮提问", turn.ordinal)}>
              <span className="commit-context-node"><MessageSquare size={11} /></span>
              <span className="commit-context-text" title={turn.prompt || t("图片提问")}>
                {turn.imageCount > 0 && <Image size={12} />}{turn.prompt || (turn.imageCount ? t("图片提问") : t("未记录提问正文"))}
              </span>
              <time>{clock(turn.at)}</time>
            </SessionLink>
            {turn.id === data.targetTurnId && <SessionLink className="commit-context-row submission" href={href(turn.id)} onNavigate={onNavigate} aria-label={t("在会话中查看提交 {0}", sha.slice(0, 7))}>
              <span className="commit-context-node"><GitCommitHorizontal size={12} /></span>
              <span className="commit-context-text" title={subject}>{subject}</span><time>{clock(record.at)}</time>
            </SessionLink>}
            <SessionLink className="commit-context-row reply" href={href(turn.id)} onNavigate={onNavigate} aria-label={t("打开第 {0} 轮回复", turn.ordinal)}>
              <span className="commit-context-node"><Sparkles size={11} /></span>
              <span className={`commit-context-text${turn.reply ? "" : " unavailable"}`} title={turn.reply || undefined}>{turn.reply || t("未记录最终回复")}</span>
              <TurnUsage usage={turn.usage} />
              <time>{clock(turn.replyAt)}</time>
            </SessionLink>
          </li>)}
        </ol>
      </>}
    {record.command && <details className="commit-command"><summary>{t("查看提交命令")}</summary><pre>{record.command}</pre></details>}
    </div>
  </details>;
}
