import { Archive, ArrowDownToLine, ArrowUpFromLine, GitCommitHorizontal, MessageSquare, Sparkles, Wrench } from "lucide-react";
import type { ShareSnapshot, SharedCommit } from "../../core/src/local-history/sharing-types";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getLanguage } from "./i18n";
const p = (zh: string, en: string) => getLanguage() === "zh" ? zh : en;

function Message({ text, metadata, children }: { text: string; metadata?: ReactNode; children?: ReactNode }) {
  return <div className={metadata ? "shared-message shared-message-with-usage" : "shared-message"}>
    {children ?? <div className="session-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
      a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
      img: ({ alt }) => <span>{alt || p("附件", "Attachment")}</span>,
    }}>{text}</Markdown></div>}
    {metadata}
  </div>;
}

const compact = (value: number | null) => value === null ? "—" : new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);

function Commit({ commit: c }: { commit: SharedCommit }) {
  return <div className="session-reply">
    <span className="session-commit-node"><GitCommitHorizontal size={11} /></span>
    <Message text={c.subject}>
      <div className="session-markdown">
        <p>{c.subject}</p>
        <p><code>{c.sha.slice(0, 7)}</code> · {c.repository} · {c.files} {p("个文件", "files")}{c.additions !== null && ` · +${c.additions} −${c.deletions ?? 0}`}</p>
      </div>
    </Message>
  </div>;
}

/** Read only: render the redacted snapshot without requesting the original session. */
export function SharedSessionTimeline({ snapshot }: { snapshot: ShareSnapshot }) {
  return <div className="session-conversation shared-session-conversation">
    {snapshot.turns.map((turn, index) => <section className="session-exchange" key={index}>
      {turn.prompt !== undefined && <>
        <span className="session-prompt-node"><MessageSquare size={11} /></span>
        <div className="session-question">
          <Message text={turn.prompt} metadata={<span className="session-usage">
            <code>{turn.models.join(", ") || "—"}</code>
            {!!turn.efforts.length && <small>· {turn.efforts.join(", ")}</small>}
            <span className="input"><ArrowDownToLine />{compact(turn.input)}</span>
            <span className="output"><ArrowUpFromLine />{compact(turn.output)}</span>
            <span className="cache"><Archive />{compact(turn.cache)}</span>
          </span>} />
        </div>
      </>}
      {turn.events.map((event, i) => <div className="session-reply" key={i}>
        <span className={event.kind === "reply" ? "session-reply-node" : "session-tool-node"} title={event.kind === "reply" ? p("Agent 回复", "Agent reply") : event.kind === "thinking" ? p("思考过程", "Thinking") : event.kind === "output" ? p("命令输出", "Command output") : p("工具调用", "Tool call")}>
          {event.kind === "reply" || event.kind === "thinking" ? <Sparkles size={11} /> : <Wrench size={11} />}
        </span>
        <Message text={event.text}>
          {event.kind !== "reply" ? <div className="session-event-detail">
            <span className="session-muted">{event.kind === "command" ? event.name || p("工具输入", "Tool input") : event.kind === "output" ? p("命令输出", "Command output") : p("思考过程", "Thinking")}</span>
            <pre>{event.text}</pre>
          </div> : undefined}
        </Message>
      </div>)}
      {turn.commits.map(c => <Commit key={c.repository + c.sha} commit={c} />)}
    </section>)}
    {!!snapshot.commits.length && <section className="session-exchange">{snapshot.commits.map(c => <Commit key={c.repository + c.sha} commit={c} />)}</section>}
  </div>;
}
