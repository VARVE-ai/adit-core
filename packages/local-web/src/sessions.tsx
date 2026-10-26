import { AgentLabel } from "./agent-label";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  ArrowDownToLine,
  ArrowUpFromLine,
  CalendarDays,
  ChevronRight,
  Archive,
  FilePlus,
  FileText,
  FolderSearch,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  MessageSquare,
  Sparkles,
  Pencil,
  Search,
  Share2,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type {
  SessionList,
  SessionDetail,
  SessionTurn,
  SessionEvent,
  SessionContent,
  SessionCommit,
  SessionTurnEdit,
  TranscriptMode,
} from "../../core/src/local-history/session-browser";
import { locale, systemMessage } from "./i18n";
import { sc } from "./sessions-copy";
import { SessionTurnActions, SessionTurnEditor } from "./session-turn-editor";
import "./sessions.css";
import { PlatformIcon } from "./platform-icon";

type Api = <T = any>(
  path: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;
type Selection = { provider: string; id: string; day?: string | null };
const dayParams = (selection?: Selection): Record<string, string> => selection?.day === undefined ? {} : {
  day: selection.day ?? "unknown", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};
const n = (value: number) => value.toLocaleString(locale());
const date = (at: number | null, time = false) =>
  at === null
    ? sc("日期未知")
    : new Date(at)
        .toLocaleString(
          locale(),
          time
            ? {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              }
            : { month: "short", day: "numeric" },
        )
        .replace(/(\d)([年月日])/g, "$1 $2 ")
        .replace(/ {2,}/g, " ")
        .trim();
const clock = (at: number | null, compact = false) =>
  at === null
    ? "—"
    : new Date(at).toLocaleTimeString(locale(), {
        hour: "2-digit",
        minute: "2-digit",
        ...(compact ? { hourCycle: "h23" as const } : {}),
      });
const money = (amount: number | null) =>
  amount === null
    ? "—"
    : "$" +
      new Intl.NumberFormat(locale(), {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }).format(amount / 1e6);
const compact = (value: number | null) =>
  value === null
    ? "—"
    : new Intl.NumberFormat("en", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value);
const key = (s: Selection) => `${s.provider}:${s.id}`;
const rowKey = (s: Selection) => JSON.stringify([s.provider, s.id, s.day ?? null]);
const toolIcons = {
  read: FileText,
  search: Search,
  edit: Pencil,
  write: FilePlus,
  list: FolderSearch,
  web: Globe,
  git: GitBranch,
  terminal: Terminal,
  plan: FileText,
  task: GitBranch,
  tool: Wrench,
};
function AgentIcon({ provider }: { provider: string }) {
  return <PlatformIcon platform={provider} size={12} className="session-agent-icon" />;
}
function Body({ text }: { text: string }) {
  return (
    <div className="session-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          img: ({ alt }) => <span>{alt || sc("附件")}</span>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
function Content({
  eventId,
  kind,
  request,
  markdown = false,
}: {
  eventId: string;
  kind: string;
  request: <T>(path: string, params?: Record<string, string>) => Promise<T>;
  markdown?: boolean;
}) {
  const [data, setData] = useState<SessionContent>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const load = async (offset = 0) => {
    setLoading(true);
    setError("");
    try {
      const d = await request<SessionContent>("content", {
        eventId,
        kind,
        offset: String(offset),
      });
      setData((old) => ({
        ...d,
        text: offset ? (old?.text || "") + d.text : d.text,
      }));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [eventId]);
  return (
    <div className="session-event-detail">
      {error && (
        <p role="alert">
          {systemMessage(error)}{" "}
          <button onClick={() => void load(data?.nextOffset || 0)}>
            {sc("重试")}
          </button>
        </p>
      )}
      {data && (markdown ? <Body text={data.text} /> : <pre>{data.text}</pre>)}
      {loading && <span>{sc("正在加载…")}</span>}
      {data?.nextOffset != null && (
        <button disabled={loading} onClick={() => void load(data.nextOffset!)}>
          {sc("加载更多内容")}
        </button>
      )}
    </div>
  );
}
export function Message({ text, matched = false, defaultExpanded = false, metadata, children, actions }: {
  text: string; matched?: boolean; defaultExpanded?: boolean; metadata?: ReactNode; children?: ReactNode; actions?: ReactNode;
}) {
  const [open, setOpen] = useState(matched || defaultExpanded);
  const shell = useRef<HTMLDivElement>(null), controls = useRef<HTMLDivElement>(null);
  const collapseTimer = useRef<ReturnType<typeof setTimeout>>();
  const pointerStart = useRef<{ x: number; y: number }>();
  const cancelCollapse = () => { clearTimeout(collapseTimer.current); collapseTimer.current = undefined; };
  const collapseLine = (target: EventTarget, y: number) => {
    if (!open || !(target instanceof Element) || target.closest("a,button,summary,input,textarea,select,pre,code,table,[role=button],.session-message-controls")) return;
    const first = shell.current?.querySelector<HTMLElement>(".session-message-body .session-markdown > :first-child");
    if (!first || !/^(P|H[1-6])$/.test(first.tagName)) return;
    const rect = first.getBoundingClientRect(), style = getComputedStyle(first);
    const height = Math.min(rect.height, parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5);
    if (y >= rect.top && y < rect.top + height) return { top: rect.top - shell.current!.getBoundingClientRect().top, height };
  };
  useEffect(() => {
    if (shell.current) delete shell.current.dataset.collapseHover;
    return cancelCollapse;
  }, [open]);
  useLayoutEffect(() => {
    const node = controls.current;
    if (!node || !shell.current) return;
    const measure = () => shell.current?.style.setProperty("--session-controls-width", `${Math.ceil(node.getBoundingClientRect().width) + 36}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [metadata, actions]);
  useEffect(() => { if (matched) setOpen(true); }, [matched]);
  return <div ref={shell} className="session-message-shell"
    onPointerDown={e => { cancelCollapse(); pointerStart.current = { x: e.clientX, y: e.clientY }; }}
    onPointerMove={e => {
      const line = collapseLine(e.target, e.clientY);
      if (!line) { delete e.currentTarget.dataset.collapseHover; return; }
      e.currentTarget.dataset.collapseHover = "true";
      e.currentTarget.style.setProperty("--session-collapse-top", `${line.top}px`);
      e.currentTarget.style.setProperty("--session-collapse-height", `${line.height}px`);
    }}
    onPointerLeave={e => { delete e.currentTarget.dataset.collapseHover; }}
    onClick={e => {
      cancelCollapse();
      if (e.detail > 1 || !collapseLine(e.target, e.clientY) || window.getSelection()?.toString()) return;
      const start = pointerStart.current;
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;
      // Let a second click select a word instead of collapsing mid-selection.
      collapseTimer.current = setTimeout(() => {
        if (!window.getSelection()?.toString()) setOpen(false);
      }, 250);
    }}>
    {(metadata || actions) && <div ref={controls} className="session-message-controls">{metadata}{actions}</div>}
    <details className="session-message" data-inline-event open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary aria-label={open ? sc("收起") : sc("展开查看完整内容")}>
      {!open && <span className="session-message-preview">{text.replace(/\s+/g, " ") || "—"}</span>}
      <ChevronRight size={12} aria-hidden="true" />
    </summary>
    {open && <div className="session-message-body session-inline-body">
      {children ?? <Body text={text} />}
    </div>}
  </details></div>;
}
/** Intersection is scoped to the detail pane; one request per visible cursor. */
function AutoLoad({ cursor, loading, error, load }: {
  cursor: number | null; loading: boolean; error?: string; load: () => Promise<void>;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  useEffect(() => {
    if (cursor === null || loading || error || !sentinel.current) return;
    let active = true;
    const observer = new IntersectionObserver(entries => {
      if (!active || pending.current || !entries.some(e => e.isIntersecting)) return;
      pending.current = true;
      void load().finally(() => { pending.current = false; });
    }, { root: sentinel.current.closest(".session-events-scroll"), rootMargin: "0px 0px 120px 0px" });
    observer.observe(sentinel.current);
    return () => { active = false; observer.disconnect(); };
  }, [cursor, loading, error, load]);
  return cursor === null ? null : <div ref={sentinel} className="session-detail-sentinel">
    {loading && <span className="session-muted">{sc("正在加载…")}</span>}
  </div>;
}

export function mergeSessionTurns(first: SessionTurn[], later: SessionTurn[]): SessionTurn[] {
  const merged = new Map(first.map(turn => [turn.id, turn]));
  const events = (a: SessionEvent[] = [], b: SessionEvent[] = []) => [...new Map([...a, ...b].map(e => [e.id,e])).values()];
  for (const turn of later) {
    const old = merged.get(turn.id);
    merged.set(turn.id, old ? { ...turn,
      promptVisible: old.promptVisible !== false || turn.promptVisible !== false,
      events: events(old.events,turn.events), openingEvents: events(old.openingEvents,turn.openingEvents),
      closingEvents: events(old.closingEvents,turn.closingEvents), matchEventId: old.matchEventId ?? turn.matchEventId,
    } : turn);
  }
  return [...merged.values()];
}

function ReplyNode() {
  return <span className="session-reply-node" title={sc("Agent 回复")}><Sparkles size={11} aria-hidden="true" /></span>;
}

function Event({
  event,
  request,
  matched = false,
  onEdit,
  onDelete,
}: {
  event: SessionEvent;
  request: <T>(path: string, params?: Record<string, string>) => Promise<T>;
  matched?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const [open, setOpen] = useState(matched);
  if (event.kind === "reply")
    return (
      <div
        className={`session-reply${matched ? " search-event-match" : ""}`}
        data-event-id={event.id}
        title={date(event.at, true)}
      >
        <ReplyNode />
        <Message text={event.text} matched={matched} actions={onEdit && onDelete ? <SessionTurnActions reply onEdit={onEdit} onDelete={onDelete} /> : undefined}>
          {event.truncated ? <Content eventId={event.id} kind="reply" request={request} markdown /> : undefined}
        </Message>
      </div>
    );
  const title =
    event.kind === "tool"
      ? event.display?.kind === "plan"
        ? sc("计划")
        : event.display?.kind === "task"
          ? sc("子任务")
          : event.display?.name || event.name
      : event.kind === "thinking"
        ? sc("思考过程")
        : event.kind === "system"
          ? sc("上下文")
          : event.kind === "result"
            ? sc("工具输出")
            : sc("附件");
  const summary = event.display?.text ?? event.text;
  const command = event.display?.kind === "command";
  const icon =
    event.display?.icon ||
    (event.display?.kind === "plan"
      ? "plan"
      : event.display?.kind === "task"
        ? "task"
        : command
          ? "terminal"
          : "tool");
  const Icon = toolIcons[icon];
  return (
    <details
      className={`session-operation${matched ? " search-event-match" : ""}`}
      data-inline-event
      data-event-id={event.id}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary title={date(event.at, true)} aria-label={open ? sc("收起") : sc("展开查看完整内容")}>
        {!open && <>
        <Icon size={12} aria-hidden="true" />
        {command ? (
          <code>{summary || title}</code>
        ) : (
          <span>
            {title}
            {summary && ` · ${summary.replace(/\s+/g, " ").slice(0, 180)}`}
          </span>
        )}
        </>}
        <ChevronRight size={12} />
      </summary>
      {open && <div className="session-inline-body">
        {event.kind === "tool" ? (
          <div className="session-tool-content">
            <h5>{sc("工具输入")}</h5>
            <Content eventId={event.id} kind="tool-input" request={request} />
            <h5>{sc("工具输出")}</h5>
            <Content eventId={event.id} kind="tool-output" request={request} />
          </div>
        ) : (
          <Content eventId={event.id} kind={event.kind} request={request} />
        )}
      </div>}
    </details>
  );
}
function ToolGroup({ events, request, matchEventId }: {
  events: SessionEvent[];
  request: <T>(path: string, params?: Record<string, string>) => Promise<T>;
  matchEventId: string | null;
}) {
  const matched = events.some(event => event.id === matchEventId);
  const [open, setOpen] = useState(matched);
  useEffect(() => { if (matched) setOpen(true); }, [matched]);
  return <details className="session-operations" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary className="session-operation-count">
      <span className="session-tool-node"><Wrench size={11} aria-hidden="true" /></span>
      <span>{events.length === 1 ? sc("1 次工具调用") : sc("{0} 次工具调用", n(events.length))}</span>
      <ChevronRight size={12} aria-hidden="true" />
    </summary>
    <div className="session-operations-body">
      {events.map(event => <Event key={event.id} event={event} request={request} matched={event.id === matchEventId} />)}
    </div>
  </details>;
}
function CommitGroup({
  commits,
  onCommit,
}: {
  commits: SessionCommit[];
  onCommit: (c: SessionCommit) => void;
}) {
  return commits.length ? (
    <div className="session-commits">
      {commits.map((c) => (
        <Commit key={c.repository + c.sha} commit={c} onCommit={onCommit} />
      ))}
    </div>
  ) : null;
}
function Commit({
  commit,
  onCommit,
}: {
  commit: SessionCommit;
  onCommit: (c: SessionCommit) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="session-commit" data-inline-event open={open} onToggle={e => setOpen(e.currentTarget.open)}>
      <summary title={sc("提交信息")} aria-label={open ? sc("收起") : sc("展开查看完整内容")}>
        {!open && <>
        <span className="session-commit-node"><GitCommitHorizontal size={11} aria-hidden="true" /></span>
        <code>{commit.sha.slice(0, 7)}</code>
        <span>{commit.subject}</span>
        <small>
          {commit.repository.split(/[\\/]/).pop()} · {clock(commit.at)}
        </small>
        </>}
        <ChevronRight size={12} aria-hidden="true" />
      </summary>
      {open && <div className="session-event-detail session-inline-body">
        <span className="session-commit-node"><GitCommitHorizontal size={11} aria-hidden="true" /></span>
        <p>{commit.subject}</p>
        <p>
          {sc("仓库")}：{commit.repository}
        </p>
        <p>
          {sc("提交编号")}：<code>{commit.sha}</code>
        </p>
        <p className="session-muted">{date(commit.at, true)}</p>
        <button onClick={() => onCommit(commit)}>{sc("查看提交")}</button>
      </div>}
    </details>
  );
}
export function SessionTurnView({
  turn,
  mode,
  request,
  onCommit,
  matched,
  onEdit,
  onDelete,
  onEditReply,
  onDeleteReply,
}: {
  turn: SessionTurn;
  mode: TranscriptMode;
  request: <T>(path: string, params?: Record<string, string>) => Promise<T>;
  onCommit: (c: SessionCommit) => void;
  matched?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  onEditReply?: (event: SessionEvent) => void;
  onDeleteReply?: (event: SessionEvent) => void;
}) {
  const [events, setEvents] = useState(turn.events),
    [next, setNext] = useState(turn.nextOffset),
    [previous, setPrevious] = useState(turn.previousOffset),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const usage = turn.usage;
  const activityRequest = useRef(0);
  useEffect(() => {
    activityRequest.current++;
    setEvents(turn.events); setNext(turn.nextOffset); setPrevious(turn.previousOffset); setError(""); setLoading(false);
    return () => { activityRequest.current++; };
  }, [turn]);
  const load = async (earlier = false) => {
    const current = ++activityRequest.current;
    setLoading(true);
    setError("");
    try {
      const d = await request<SessionTurn>("turn", {
        turnId: turn.id,
        offset: String(earlier ? previous : next),
        mode,
      });
      if (current !== activityRequest.current) return;
      setEvents((old) =>
        earlier ? [...d.events, ...old] : [...old, ...d.events],
      );
      if (earlier) setPrevious(d.previousOffset);
      else setNext(d.nextOffset);
    } catch (e) {
      if (current === activityRequest.current) setError(String(e));
    } finally {
      if (current === activityRequest.current) setLoading(false);
    }
  };
  const usageTitle = [
    ...usage.models,
    ...usage.efforts,
    sc("输入（不含缓存）") +
      ": " +
      (usage.input === null ? "—" : n(usage.input)),
    sc("输出") + ": " + (usage.output === null ? "—" : n(usage.output)),
    sc("缓存命中") + ": " + (usage.cache === null ? "—" : n(usage.cache)),
    sc("写入缓存") +
      ": " +
      (usage.cacheWrite === null ? "—" : n(usage.cacheWrite)),
    sc("{0} 次请求", n(usage.requests)),
    sc("此次提问及后续响应的累计用量"),
  ].join(" · ");
  const renderEvent = (e: SessionEvent) => (
    <Event
      key={e.id}
      event={e}
      request={request}
      matched={e.id === turn.matchEventId}
      onEdit={onEditReply ? () => onEditReply(e) : undefined}
      onDelete={onDeleteReply ? () => onDeleteReply(e) : undefined}
    />
  );
  // Normal mode keeps the collected event order. Only adjacent tool calls share
  // a collapsible group; intermediate replies stay separate timeline entries.
  const timeline: ReactNode[] = [];
  let tools: SessionEvent[] = [];
  let commitsRendered = false;
  const closingIds = new Set((turn.closingEvents ?? []).map((e) => e.id));
  const flushTools = () => {
    if (!tools.length) return;
    timeline.push(
      <ToolGroup key={`tools-${tools[0].id}`} events={tools} request={request} matchEventId={turn.matchEventId} />,
    );
    tools = [];
  };
  for (const event of events) {
    if (!commitsRendered && (mode === "focused" || closingIds.has(event.id))) {
      flushTools();
      timeline.push(
        <CommitGroup
          key="commits"
          commits={turn.commits}
          onCommit={onCommit}
        />,
      );
      commitsRendered = true;
    }
    if (mode === "normal" && event.kind === "tool") tools.push(event);
    else {
      flushTools();
      timeline.push(renderEvent(event));
    }
  }
  flushTools();
  const activity = (
    <>
      {previous !== null && (
        <button
          className="session-more"
          disabled={loading}
          onClick={() => void load(true)}
        >
          {sc("加载之前的过程")}
        </button>
      )}
      {timeline}
      {error && <p role="alert">{systemMessage(error)}</p>}
      {next !== null && (
        <button
          className="session-more"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? sc("正在加载…") : error ? sc("重试") : sc("加载更多过程")}
        </button>
      )}
      {!commitsRendered && (
        <CommitGroup commits={turn.commits} onCommit={onCommit} />
      )}
    </>
  );
  if (turn.contextOnly)
    return mode === "focused" ? null : (
      <div className="session-context-entry">
        {turn.promptVisible !== false && <Message text={turn.prompt} />}
        {activity}
      </div>
    );
  return (
    <article
      className={`session-exchange${matched ? " search-match" : ""}`}
      data-turn-id={turn.id}
    >
      {turn.promptVisible !== false && <>
      <span className="session-prompt-node">
        <MessageSquare size={11} />
      </span>
      <div className="session-question">
        <Message text={turn.prompt || (turn.imageCount ? sc("图片提问（{0} 张）",turn.imageCount) : "—")}
          actions={onEdit && onDelete ? <SessionTurnActions onEdit={onEdit} onDelete={onDelete} /> : undefined}
          matched={matched && !turn.matchEventId} metadata={
        <span
          className="session-usage"
          title={usageTitle}
          aria-label={sc("模型、思考等级与 Token 用量")}
        >
          <code>{usage.models.join(", ") || "—"}</code>
          {!!usage.efforts.length && (
            <small>· {usage.efforts.join(", ")}</small>
          )}
          <span className="input">
            <ArrowDownToLine />
            {compact(usage.input)}
          </span>
          <span className="output">
            <ArrowUpFromLine />
            {compact(usage.output)}
          </span>
          <span className="cache">
            <Archive />
            {compact(usage.cache)}
          </span>
        </span>
          }>
          {turn.promptTruncated && turn.promptBlockId
            ? <Content eventId={turn.promptBlockId} kind="text" request={request} markdown />
            : undefined}
        </Message>
      </div>
      </>}
      {activity}
    </article>
  );
}

export function SessionsPage({
  workspace,
  api,
  onCommit,
  onShare,
  revision,
}: {
  workspace: { id: string; name: string };
  api: Api;
  onCommit: (commit: SessionCommit) => void;
  onShare?: (session: Selection) => void;
  revision?: string;
}) {
  const requestedSession = useRef<Selection | undefined>((() => {
    const query = new URLSearchParams(location.search);
    return query.get("provider") && query.get("session") ? { provider: query.get("provider")!, id: query.get("session")! } : undefined;
  })());
  const requestedTurnSession = useRef(requestedSession.current);
  const requestedTurn = useRef(new URLSearchParams(location.search).get("turn") || undefined);
  const [provider, setProvider] = useState("all"),
    [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [only, setOnly] = useState(false),
    [sort, setSort] = useState("activity");
  const [mode, setMode] = useState<TranscriptMode>(() =>
    localStorage.getItem("adit-transcript-mode") === "focused"
      ? "focused"
      : "normal",
  );
  const [list, setList] = useState<SessionList>(),
    [selected, setSelected] = useState<Selection | undefined>(requestedSession.current),
    [detail, setDetail] = useState<SessionDetail>();
  const [turnAction, setTurnAction] = useState<{ kind: 'edit' | 'delete'; turn: SessionTurn; session: Selection; reply?: SessionEvent }>();
  const [listError, setListError] = useState(""),
    [detailError, setDetailError] = useState(""),
    [listLoading, setListLoading] = useState(true),
    [detailLoading, setDetailLoading] = useState(false),
    [retry, setRetry] = useState(0),
    [mobileDetail, setMobileDetail] = useState(!!requestedSession.current);
  const detailScroll = useRef<HTMLDivElement>(null),
    listScroll = useRef<HTMLDivElement>(null),
    loadMoreSentinel = useRef<HTMLDivElement>(null),
    listInFlight = useRef(false),
    requestNumber = useRef(0),
    detailNumber = useRef(0),
    detailInFlight = useRef(false),
    prependScroll = useRef<{ height: number; top: number } | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    localStorage.setItem("adit-transcript-mode", mode);
  }, [mode]);
  const loadList = useCallback(async (offset = 0, signal?: AbortSignal, preserveSelection = false) => {
    if (offset && listInFlight.current) return;
    listInFlight.current = true;
    const current = ++requestNumber.current;
    setListLoading(true);
    setListError("");
    try {
      const d = await api<SessionList>(
        "/sessions?" +
          new URLSearchParams({
            workspaceId: workspace.id,
            provider,
            q: query,
            commits: only ? "1" : "0",
            sort,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            offset: String(offset),
          }),
        "GET",
        undefined,
        signal,
      );
      if (current !== requestNumber.current || signal?.aborted) return;
      setList((old) => ({
        ...d,
        items: offset ? [...(old?.items || []), ...d.items] : d.items,
      }));
      if (!offset && !preserveSelection) {
        const requested = requestedSession.current;
        requestedSession.current = undefined;
        setSelected((old) =>
          requested ? requested : old && d.items.some((s) => rowKey(s) === rowKey(old))
            ? old
            : d.items[0]
              ? { provider: d.items[0].provider, id: d.items[0].id, day: d.items[0].day }
              : undefined,
        );
        if (listScroll.current) listScroll.current.scrollTop = 0;
      }
    } catch (e) {
      if (!signal?.aborted && current === requestNumber.current)
        setListError(String(e));
    } finally {
      if (current === requestNumber.current) {
        listInFlight.current = false;
        if (!signal?.aborted) setListLoading(false);
      }
    }
  }, [api, workspace.id, provider, query, only, sort]);
  useEffect(() => {
    const c = new AbortController();
    void loadList(0, c.signal);
    return () => {
      c.abort();
      requestNumber.current++;
    };
  }, [loadList, retry, revision]);
  useEffect(() => {
    if (listLoading || listError || list?.nextOffset == null || !loadMoreSentinel.current) return;
    let active = true;
    const offset = list.nextOffset;
    const observer = new IntersectionObserver(entries => {
      if (active && entries.some(entry => entry.isIntersecting)) void loadList(offset);
    }, { root: listScroll.current, rootMargin: "0px 0px 120px 0px" });
    observer.observe(loadMoreSentinel.current);
    return () => { active = false; observer.disconnect(); };
  }, [list?.nextOffset, listLoading, listError, loadList]);
  const request = <T,>(path: string, params: Record<string, string> = {}) =>
    api<T>(
      "/sessions/" +
        path +
        "?" +
        new URLSearchParams({
          workspaceId: workspace.id,
          provider: selected!.provider,
          id: selected!.id,
          ...dayParams(selected),
          ...params,
        }),
    );
  const loadDetail = useCallback(async (
    offset?: number,
    signal?: AbortSignal,
    prepend = false,
  ) => {
    if (!selected || (offset !== undefined && detailInFlight.current)) return;
    detailInFlight.current = true;
    const current = ++detailNumber.current;
    setDetailLoading(true);
    setDetailError("");
    try {
      const d = await api<SessionDetail>(
        "/sessions/detail?" +
          new URLSearchParams({
            workspaceId: workspace.id,
            provider: selected.provider,
            id: selected.id,
            ...dayParams(selected),
            mode,
            q: query,
            ...(!query && requestedTurn.current && selected.provider === requestedTurnSession.current?.provider && selected.id === requestedTurnSession.current?.id
              ? { turnId: requestedTurn.current } : {}),
            ...(offset === undefined ? {} : { offset: String(offset) }),
          }),
        "GET",
        undefined,
        signal,
      );
      if (current !== detailNumber.current || signal?.aborted) return;
      if (prepend && detailScroll.current) prependScroll.current = {
        height: detailScroll.current.scrollHeight, top: detailScroll.current.scrollTop,
      };
      setDetail((old) =>
        prepend
          ? {
              ...d,
              nextOffset: old?.nextOffset ?? null,
              context: old?.context ?? d.context,
              contextNextOffset: old ? old.contextNextOffset : d.contextNextOffset,
              turns: mergeSessionTurns(d.turns, old?.turns || []),
            }
          : offset !== undefined && old
            ? {
                ...d,
                previousOffset: old.previousOffset,
                pageOffset: old.pageOffset,
                context: old.context,
                contextNextOffset: old.contextNextOffset,
                turns: mergeSessionTurns(old.turns, d.turns),
              }
            : d,
      );
    } catch (e) {
      if (!signal?.aborted && current === detailNumber.current)
        setDetailError(String(e));
    } finally {
      if (current === detailNumber.current) {
        detailInFlight.current = false;
        if (!signal?.aborted) setDetailLoading(false);
      }
    }
  }, [api, workspace.id, selected?.provider, selected?.id, selected?.day, mode, query]);
  useLayoutEffect(() => {
    const previous = prependScroll.current;
    if (previous && detailScroll.current) detailScroll.current.scrollTop = previous.top + detailScroll.current.scrollHeight - previous.height;
    prependScroll.current = null;
  }, [detail]);
  useEffect(() => {
    const c = new AbortController();
    setDetail(undefined);
    setDetailError("");
    detailInFlight.current = false;
    prependScroll.current = null;
    if (!selected) setDetailLoading(false);
    if (detailScroll.current) detailScroll.current.scrollTop = 0;
    void loadDetail(undefined, c.signal);
    return () => {
      c.abort();
      detailNumber.current++;
    };
  }, [loadDetail, retry, revision]);
  useEffect(() => {
    if (detail?.matchTurnId)
      (
        detailScroll.current?.querySelector(".search-event-match") ||
        detailScroll.current?.querySelector(".search-match")
      )?.scrollIntoView({ block: "start" });
  }, [detail?.session.id, detail?.matchTurnId]);
  const choose = (s: Selection) => {
    requestedTurn.current = undefined;
    setSelected(s);
    setMobileDetail(true);
  };
  const refreshAfterTurnChange = async () => {
    setTurnAction(undefined);
    if (!selected || !detail) return;
    const current = ++detailNumber.current;
    detailInFlight.current = true;
    setDetailLoading(true); setDetailError("");
    void loadList(0, undefined, true);
    try {
      let offset = detail.pageOffset;
      const end = detail.nextOffset ?? detail.totalEntries;
      const read = (at: number) => request<SessionDetail>("detail", { mode, offset: String(at) });
      let result = await read(offset);
      if (!result.turns.length && result.totalEntries && offset) {
        offset = Math.floor((result.totalEntries - 1) / 50) * 50;
        result = await read(offset);
      }
      while (result.nextOffset !== null && result.nextOffset < end) {
        const next = await read(result.nextOffset);
        result = { ...result, turns: mergeSessionTurns(result.turns, next.turns), nextOffset: next.nextOffset };
      }
      if (current === detailNumber.current) setDetail(result);
    } catch (e) { if (current === detailNumber.current) setDetailError(String(e)); }
    finally { if (current === detailNumber.current) { detailInFlight.current = false; setDetailLoading(false); } }
  };
  const reset = () => {
    setSearch("");
    setQuery("");
    setProvider("all");
    setOnly(false);
  };
  const [contextOpen, setContextOpen] = useState(false);
  const [contextLoading, setContextLoading] = useState(false);
  const loadContext = async () => {
    if (!detail || detail.contextNextOffset === null) return;
    const current = detailNumber.current;
    setContextLoading(true);
    try {
      const result = await request<{
        events: SessionEvent[];
        nextOffset: number | null;
      }>("context", { offset: String(detail.contextNextOffset) });
      if (current === detailNumber.current)
        setDetail((old) =>
          old && key(old.session) === key(detail.session)
            ? {
                ...old,
                context: [...old.context, ...result.events],
                contextNextOffset: result.nextOffset,
              }
            : old,
        );
    } catch (e) {
      if (current === detailNumber.current) setDetailError(String(e));
    } finally {
      setContextLoading(false);
    }
  };
  let previous = "";
  return (
    <section
      className={`sessions-page${mobileDetail ? " show-detail" : ""}`}
      aria-label={sc("会话")}
    >
      <div className="sessions-toolbar">
        <div className="sessions-segment session-agent-filters">
          <button
            className={provider === "all" ? "on" : ""}
            aria-pressed={provider === "all"}
            onClick={() => setProvider("all")}
          >
            {sc("全部")}
          </button>
          {(list?.providers || []).map((p) => (
            <button
              key={p.id}
              className={provider === p.id ? "on" : ""}
              aria-pressed={provider === p.id}
              onClick={() => setProvider(p.id)}
            >
              <AgentLabel provider={p.id} name={p.name} />
            </button>
          ))}
        </div>
        <label className="sessions-search">
          <Search size={14} />
          <input
            value={search}
            aria-label={sc("搜索所有 Agent 的提问、回复和命令")}
            placeholder={sc("搜索所有 Agent 的提问、回复和命令")}
            onChange={(e) => {
              setSearch(e.target.value);
              if (e.target.value) setMode("normal");
            }}
          />
          {search && (
            <button
              className="icon"
              aria-label={sc("清除筛选")}
              onClick={() => {
                setSearch("");
                setQuery("");
              }}
            >
              <X size={12} />
            </button>
          )}
        </label>
        <div className="sessions-toolbar-right">
          <div
            className="sessions-segment"
            role="group"
            aria-label={sc("会话内容时间线")}
          >
            {(["normal", "focused"] as const).map((m) => (
              <button
                key={m}
                className={mode === m ? "on" : ""}
                aria-pressed={mode === m}
                title={
                  m === "normal"
                    ? sc("显示提问、回复、计划和工具过程")
                    : sc("只看每次提问和最后回复")
                }
                onClick={() => setMode(m)}
              >
                {m === "normal" ? sc("普通") : sc("聚焦")}
              </button>
            ))}
          </div>
          <label className="sessions-sort">
            {sc("排序")}
            <select
              aria-label={sc("排序")}
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="activity">{sc("最近活动")}</option>
              <option value="started">{sc("最近开始")}</option>
              <option value="oldest">{sc("最早开始")}</option>
              <option value="messages">{sc("消息最多")}</option>
            </select>
          </label>
          <button
            className={`session-commits-filter ${only ? "on" : ""}`}
            aria-pressed={only}
            onClick={() => setOnly(!only)}
          >
            {sc("只看有提交的")}
          </button>
          <span className="sessions-summary">
            <CalendarDays size={12} />
            {list?.first
              ? sc("{0} 至今 · {1} 条消息", date(list.first), n(list.messages))
              : sc("{0} 条消息", n(list?.messages || 0))}
          </span>
        </div>
      </div>
      <div className="sessions-work">
        <div className="sessions-list" ref={listScroll} aria-busy={listLoading}>
          {listError && (
            <p role="alert">
              {systemMessage(listError)}{" "}
              <button onClick={() => setRetry((r) => r + 1)}>
                {sc("重试")}
              </button>
            </p>
          )}
          {!list?.items.length && !listLoading && !listError && (
            <div className="session-empty">
              <MessageSquare size={24} />
              <h3>
                {query || only || provider !== "all"
                  ? sc("没有匹配的会话")
                  : sc("暂无会话")}
              </h3>
              <p>
                {query || only || provider !== "all"
                  ? sc("试试其他关键词或筛选条件。")
                  : sc("整理后，这个工作目录的会话会显示在这里。")}
              </p>
              {(query || only || provider !== "all") && (
                <button onClick={reset}>{sc("清除筛选")}</button>
              )}
            </div>
          )}
          {list?.items.map((s, index) => {
            const day = s.day ? date(new Date(`${s.day}T12:00:00`).getTime()) : sc("日期未知");
            const heading = (s.day ?? "unknown") !== previous;
            previous = s.day ?? "unknown";
            const isSelected = !!selected && rowKey(selected) === rowKey(s);
            return (
              <div
                key={rowKey(s)}
                className={`${heading ? "session-date-start" : ""} ${!list.items[index + 1] || s.day !== list.items[index + 1].day ? "session-date-end" : ""}`}
              >
                {heading && <div className="session-day">{day}</div>}
                <div className="session-list-entry">
                  <span className="session-agent-node">
                    <AgentIcon provider={s.provider} />
                  </span>
                  <button
                    className={`session-row ${isSelected ? "on" : ""}`}
                    aria-pressed={isSelected}
                    onClick={() => choose({ provider: s.provider, id: s.id, day: s.day })}
                  >
                    <div className="session-row-heading">
                      <strong title={s.match ? `${s.title}\n${s.match.text}` : s.title}>
                        {s.title || sc("未命名会话")}
                      </strong>
                      {s.dayCount > 1 && s.dayIndex !== null && (
                        <span className="session-day-badge">{sc("第 {0}/{1} 天", s.dayIndex, s.dayCount)}</span>
                      )}
                    </div>
                    <div className="session-row-meta">
                      <span>{clock(s.startedAt, true)}–{clock(s.lastActivityAt, true)}</span>
                      <span>{sc("{0} 次提问", n(s.prompts))}</span>
                      <span title={s.unpriced
                        ? sc("{0} 条用量缺少价格或完整字段，未计入折算花费", s.unpriced)
                        : sc("按 API 价格折算 {0}", money(s.cost))}>
                        {sc("价格 {0}", money(s.cost))}{s.unpriced > 0 && s.cost !== null ? "*" : ""}
                      </span>
                    </div>
                  </button>
                </div>
              </div>
            );
          })}
          {listLoading && (
            <div className="session-muted">{sc("正在加载…")}</div>
          )}
          <div ref={loadMoreSentinel} className="session-list-sentinel" aria-hidden="true" />
        </div>
        <div className="session-detail" aria-busy={detailLoading}>
          <button
            className="session-back"
            onClick={() => setMobileDetail(false)}
          >
            <ArrowLeft size={14} />
            {sc("返回会话列表")}
          </button>
          {detailError && (
            <p role="alert">
              {systemMessage(detailError)}{" "}
              <button onClick={() => void loadDetail()}>{sc("重试")}</button>
            </p>
          )}
          {!detail && !detailError && (
            <div className="session-empty">
              {detailLoading ? sc("正在加载…") : sc("选择一个会话查看内容")}
            </div>
          )}
          {detail && (
            <>
              <div className="session-detail-heading">
                <h2>{detail.session.title || sc("未命名会话")}</h2>
                <button disabled={!onShare} onClick={() => onShare?.(detail.session)}>
                  <Share2 size={14} />
                  {sc("分享")}
                </button>
              </div>
              <div className="session-meta">
                <span>
                  <AgentLabel provider={detail.session.provider} name={list?.providers.find((p) => p.id === detail.session.provider)?.name} />
                </span>
                <span>
                  {date(detail.session.startedAt, true)} –{" "}
                  {clock(detail.session.lastActivityAt)}
                </span>
                <span>
                  {sc(
                    "{0} 次提问 · {1} 条消息",
                    n(detail.session.prompts),
                    n(detail.session.messages),
                  )}
                </span>
                <span>
                  <GitCommitHorizontal size={13} />
                  {sc("{0} 个提交", n(detail.session.commits))}
                  {!!detail.repositories?.length && (
                    <small className="session-repository-counts">
                      {detail.repositories
                        .map(
                          (r) =>
                            `${r.path.split(/[\\/]/).pop()} ${n(r.commits)}`,
                        )
                        .join(" · ")}
                    </small>
                  )}
                </span>
                <span
                  title={
                    detail.unpriced
                      ? sc(
                          "{0} 条用量缺少价格或完整字段，未计入折算花费",
                          detail.unpriced,
                        )
                      : undefined
                  }
                >
                  {sc("按 API 价格折算 {0}", money(detail.cost))}
                  {detail.unpriced > 0 ? " *" : ""}
                </span>
                {detail.models.map((model) => (
                  <code key={model}>{model}</code>
                ))}
              </div>
              <div
                className="session-events-scroll"
                ref={detailScroll}
                role="region"
                aria-label={sc("会话内容时间线")}
                tabIndex={0}
              >
                <div className="session-conversation">
                  {detail.children.length > 0 && (
                    <details className="session-children">
                      <summary>
                        {sc("子任务")} · {detail.children.length}
                      </summary>
                      {detail.children.map((c) => (
                        <button key={key(c)} onClick={() => choose(c)}>
                          <AgentIcon provider={c.provider} />
                          {c.title || sc("未命名会话")}
                          <ChevronRight size={12} />
                        </button>
                      ))}
                    </details>
                  )}
                  {mode === "normal" &&
                    (!!detail.context.length ||
                      detail.turns.some((t) => t.contextOnly)) && (
                      <details
                        className="session-context"
                        onToggle={(e) => setContextOpen(e.currentTarget.open)}
                      >
                        <summary>{sc("会话上下文")}</summary>
                        {contextOpen &&
                          detail.context.map((e) => (
                            <Event key={e.id} event={e} request={request} />
                          ))}
                        {contextOpen &&
                          detail.turns
                            .filter((t) => t.contextOnly)
                            .map((turn) => (
                              <SessionTurnView
                                key={turn.id}
                                turn={turn}
                                mode={mode}
                                request={request}
                                onCommit={onCommit}
                              />
                            ))}
                        {contextOpen && <AutoLoad cursor={detail.contextNextOffset} loading={contextLoading} error={detailError} load={loadContext} />}
                      </details>
                    )}
                  {query && mode === "focused" && (
                    <button
                      className="session-more"
                      onClick={() => setMode("normal")}
                    >
                      {sc("在普通模式查看搜索内容")}
                    </button>
                  )}
                  <AutoLoad cursor={detail.previousOffset} loading={detailLoading} error={detailError}
                    load={() => loadDetail(detail.previousOffset!, undefined, true)} />
                  {detail.turns
                    .filter((turn) => !turn.contextOnly)
                    .map((turn) => (
                      <SessionTurnView
                        key={`${key(detail.session)}:${mode}:${turn.id}`}
                        turn={turn}
                        mode={mode}
                        request={request}
                        onCommit={onCommit}
                        matched={detail.matchTurnId === turn.id}
                        onEdit={() => setTurnAction({ kind: 'edit', turn, session: { provider: detail.session.provider, id: detail.session.id } })}
                        onDelete={() => setTurnAction({ kind: 'delete', turn, session: { provider: detail.session.provider, id: detail.session.id } })}
                        onEditReply={reply => setTurnAction({ kind: 'edit', turn, reply, session: { provider: detail.session.provider, id: detail.session.id } })}
                        onDeleteReply={reply => setTurnAction({ kind: 'delete', turn, reply, session: { provider: detail.session.provider, id: detail.session.id } })}
                      />
                    ))}
                  <CommitGroup commits={detail.commits} onCommit={onCommit} />
                  {!detail.totalEntries && !detail.context.length && <p className="session-empty">{sc("此会话暂无对话内容")}</p>}
                  <AutoLoad cursor={detail.nextOffset} loading={detailLoading} error={detailError}
                    load={() => loadDetail(detail.nextOffset!)} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      {turnAction && <SessionTurnEditor key={`${key(turnAction.session)}:${turnAction.turn.id}:${turnAction.reply?.id || ''}:${turnAction.kind}`}
        kind={turnAction.kind} reply={!!turnAction.reply} prompt={turnAction.reply?.text ?? turnAction.turn.prompt}
        read={() => api<SessionTurnEdit>(`/sessions/${turnAction.reply ? 'reply' : 'turn'}/edit?` + new URLSearchParams({ workspaceId: workspace.id, provider: turnAction.session.provider, id: turnAction.session.id, turnId: turnAction.turn.id, ...(turnAction.reply ? { eventId: turnAction.reply.id } : {}) }))}
        mutate={(method, body) => api(`/sessions/${turnAction.reply ? 'reply' : 'turn'}?` + new URLSearchParams({ workspaceId: workspace.id, provider: turnAction.session.provider, id: turnAction.session.id, turnId: turnAction.turn.id, ...(turnAction.reply ? { eventId: turnAction.reply.id } : {}) }), method, body)}
        onClose={() => setTurnAction(undefined)} onDone={() => void refreshAfterTurnChange()} />}
    </section>
  );
}
