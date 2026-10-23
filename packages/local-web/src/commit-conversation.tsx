import { useEffect, useState, type AnchorHTMLAttributes } from "react";
import { ArrowUpRight, ChevronRight, GitCommitHorizontal, Image, MessageSquare, Sparkles } from "lucide-react";
import type { SessionTurnPreview } from "../../core/src/local-history/session-browser";
import { AgentLabel } from "./agent-label";
import { locale, systemMessage, t } from "./i18n";

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
  const clock = (at: number | null) => at === null ? "" : new Date(at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  return <div className="commit-conversation">
    <div className="commit-conversation-heading">
      <SessionLink className="commit-conversation-title" href={href(targetTurn)} onNavigate={onNavigate} title={session.title}>
        <ChevronRight size={14} /><span>{session.title}</span><ArrowUpRight size={13} />
      </SessionLink>
      <AgentLabel provider={session.provider} />
    </div>
    {error ? <p className="commit-note" role="alert">{systemMessage(error)} <button onClick={() => setRetry(n => n + 1)}>{t("重试")}</button></p>
      : !record.turnId || data?.targetTurnId === null ? <p className="commit-note">{t("未找到对应轮次，可打开会话查看原始记录。")}</p>
      : !data ? <p className="commit-note" role="status">{t("正在读取附近问答…")}</p>
      : <>
        <div className="commit-conversation-meta">
          <span>{t("第 {0} 轮提问", data.turns.find(turn => turn.id === data.targetTurnId)?.ordinal ?? record.ordinal ?? "—")}</span>
          <span>{t("前后各 1 轮问答")}</span>
        </div>
        <ol className="commit-conversation-timeline" aria-label={t("提交前后的问答")}>
          {data.turns.map(turn => <li key={turn.id} className={turn.id === data.targetTurnId ? "commit-context-turn current" : "commit-context-turn"}>
            <SessionLink className="commit-context-row prompt" href={href(turn.id)} onNavigate={onNavigate} aria-label={t("打开第 {0} 轮提问", turn.ordinal)}>
              <span className="commit-context-node"><MessageSquare size={11} /></span>
              <span className="commit-context-text" title={turn.prompt || t("图片提问")}>
                {turn.imageCount > 0 && <Image size={12} />}{turn.prompt || (turn.imageCount ? t("图片提问") : t("未记录提问正文"))}
              </span>
              <span className="commit-context-ordinal">#{turn.ordinal}</span>
              <time>{clock(turn.at)}</time>
            </SessionLink>
            {turn.id === data.targetTurnId && <SessionLink className="commit-context-row submission" href={href(turn.id)} onNavigate={onNavigate} aria-label={t("在会话中查看提交 {0}", sha.slice(0, 7))}>
              <span className="commit-context-node"><GitCommitHorizontal size={12} /></span>
              <code>{sha.slice(0, 7)}</code><span className="commit-context-text" title={subject}>{subject}</span><ArrowUpRight size={12} />
            </SessionLink>}
            <SessionLink className="commit-context-row reply" href={href(turn.id)} onNavigate={onNavigate} aria-label={t("打开第 {0} 轮回复", turn.ordinal)}>
              <span className="commit-context-node"><Sparkles size={11} /></span>
              <span className={`commit-context-text${turn.reply ? "" : " unavailable"}`} title={turn.reply || undefined}>{turn.reply || t("未记录最终回复")}</span>
            </SessionLink>
          </li>)}
        </ol>
      </>}
    {record.command && <details className="commit-command"><summary>{t("查看提交命令")}</summary><pre>{record.command}</pre></details>}
  </div>;
}
