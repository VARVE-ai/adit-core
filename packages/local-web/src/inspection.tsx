import { AgentLabel } from "./agent-label";
import { PlatformIcon } from "./platform-icon";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ShieldCheck,
  Info,
  ArrowDownToLine,
  ArrowUpFromLine,
  Database,
  Loader2,
  ChevronRight,
  Terminal,
  MessageSquare,
} from "lucide-react";
import type {
  InspectionData,
  InspectionDetail,
  InspectionFinding,
  InspectionStatus,
  InspectionSessionSummary,
} from "../../core/src/local-history/inspection";
import { ic, inspectionCopy } from "./inspection-copy";
import { locale } from "./i18n";
import { agentName } from "./achievement-export";
import "./inspection.css";
import {
  inspectionSessionKey,
  readInspectionResults,
  type InspectionApi as Api,
} from "./inspection-results";
const statusLabels = {
  pending: "需要处理",
  handled: "已处理",
  ignored: "已忽略",
} as const;
const locations = {
  prompt: "提问",
  response: "回复",
  tool_input: "执行的命令",
  tool_output: "命令输出",
} as const;
const date = (at: number | null) =>
  at === null
    ? "—"
    : new Date(at).toLocaleString(locale(), {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
const location = (item: InspectionFinding) =>
  ic(locations[item.location as keyof typeof locations] || "回复");
const count = (n: number | null) =>
  n === null ? "—" : n.toLocaleString(locale());
const day = (at: number | null) =>
  at === null ? ic("日期未知") : new Date(at).toLocaleDateString(locale(), {
    month: "short", day: "numeric",
    ...(new Date(at).getFullYear() !== new Date().getFullYear() ? { year: "numeric" as const } : {}),
  }).replace(/(\d)([年月日])/g, "$1 $2 ").trim();
const clock = (at: number | null) =>
  at === null ? "—" : new Date(at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function InspectionPage({
  workspace,
  api,
  onOverview,
}: {
  workspace: { id: string; version: number; providers?: string[] };
  api: Api;
  onOverview: () => void;
}) {
  const [data, setData] = useState<InspectionData>();
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState<InspectionStatus>("pending");
  const [error, setError] = useState<"read" | "action" | "">("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [rule, setRule] = useState("");
  const [offset, setOffset] = useState(0);
  const writing = useRef(false);
  const readVersion = useRef(0);
  const endpoint = (suffix = "") =>
    `/inspection${suffix}?workspaceId=${encodeURIComponent(workspace.id)}`;
  const sessions = data?.sessions || [];
  const selectedSession = sessions.find(
    (session) => inspectionSessionKey(session) === selected,
  );
  useEffect(() => {
    setData(undefined);
    setSelected("");
    setOffset(0);
  }, [workspace.id]);
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading || writing.current || document.hidden) return;
      loading = true;
      const version = readVersion.current;
      try {
        const next = await readInspectionResults(
          api,
          `${endpoint()}&view=sessions`,
          status,
          rule,
          controller.signal,
          offset,
        );
        if (
          !writing.current &&
          version === readVersion.current &&
          !controller.signal.aborted
        ) {
          setData(next);
          const groups = next.sessions || [];
          setSelected((current) =>
            groups.some((group) => inspectionSessionKey(group) === current)
              ? current
              : groups[0]
                ? inspectionSessionKey(groups[0])
                : "",
          );
          setError((current) => (current === "action" ? current : ""));
        }
      } catch {
        if (!controller.signal.aborted) setError("read");
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = window.setInterval(load, 3000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [workspace.id, workspace.version, status, revision, rule, offset]);
  const act = async (suffix: string, body: unknown = {}) => {
    if (writing.current) return;
    writing.current = true;
    readVersion.current += 1;
    setBusy(true);
    setError("");
    try {
      await api(endpoint(suffix), "POST", body);
    } catch {
      setError("action");
    } finally {
      writing.current = false;
      setBusy(false);
      if (suffix !== "/folder") setRevision((n) => n + 1);
    }
  };
  const actOnSession = async (nextStatus: InspectionStatus) => {
    if (writing.current || !selectedSession) return;
    writing.current = true;
    readVersion.current += 1;
    setBusy(true);
    setError("");
    try {
      await api(endpoint("/session-status"), "PATCH", {
        provider: selectedSession.provider,
        sessionId: selectedSession.sessionId,
        from: status,
        status: nextStatus,
        rule,
      });
    } catch {
      setError("action");
    } finally {
      writing.current = false;
      setBusy(false);
      setOffset(0);
      setRevision((n) => n + 1);
    }
  };
  const label = (rule: string) => {
    const value = data?.rules.find((r) => r.id === rule)?.label || rule;
    return value in inspectionCopy
      ? ic(value as keyof typeof inspectionCopy)
      : ic("{0} 密钥", value);
  };
  const running =
    data?.run && ["queued", "running", "indexing"].includes(data.run.status);
  const complete = !!data && data.checked === data.total && data.maskReady;
  return (
    <section className="inspection-page">
      <div className="inspection-toolbar">
        <button className="inspection-link" onClick={onOverview}>
          <ArrowLeft size={14} />
          {ic("返回概览")}
        </button>
        <span className="inspection-divider">|</span>
        <span className="inspection-heading">
          <ShieldCheck size={14} />
          {ic("历史对话体检")}
        </span>
        <span className="inspection-muted">
          {ic("整理时自动检查，只在本机进行")}
        </span>
        <div className="inspection-toolbar-end">
          {running && (
            <>
              <span role="status">
                <Loader2 size={13} className="spin" />
                {ic(
                  data!.run!.status === "indexing"
                    ? "正在遮盖搜索记录 {0}/{1}"
                    : "检查中 {0}/{1}",
                  data!.run!.completed,
                  data!.run!.total,
                )}
              </span>
              <button
                className="inspection-link"
                disabled={busy}
                onClick={() => void act("/cancel")}
              >
                {ic("取消检查")}
              </button>
            </>
          )}
          <button
            className="inspection-link"
            disabled={busy || !!running}
            onClick={() => void act("/scan")}
          >
            {ic("重新检查")}
          </button>
        </div>
      </div>
      {error && (
        <div className="inspection-error" role="alert">
          {ic(error === "read" ? "读取失败，请重试" : "操作失败，请重试")}
          <button
            className="inspection-link"
            onClick={() => {
              setError("");
              setRevision((n) => n + 1);
            }}
          >
            {ic("重试")}
          </button>
        </div>
      )}
      <div className="inspection-work">
        <div className="inspection-list">
          <div className="inspection-summary">
            <div className="inspection-big">
              <b>{data ? ic("{0} 处", data.pendingDefinite) : "—"}</b>
              <span
                title={ic(
                  "确定仅表示符合密钥格式，未验证是否有效。未发现不代表没有敏感信息。",
                )}
                className={`inspection-status ${data?.pendingDefinite ? "warn" : "ok"}`}
              >
                {ic(
                  !data
                    ? "读取中…"
                    : data.pendingDefinite
                      ? "确定是密钥，需要处理"
                      : complete
                        ? "未发现需要处理的确定密钥"
                        : "历史对话体检",
                )}
              </span>
            </div>
            <p>
              {!data
                ? ic("读取中…")
                : !data.total
                  ? ic("还没有采集到会话，整理后会自动检查。")
                  : complete
                    ? ic(
                        "检查了全部 {0} 个会话：你开的 {1} 个，加上 Agent 派出去的 {2} 个子任务；提问、回复、执行的命令和命令输出都在范围内。",
                        data.total,
                        data.main,
                        data.children,
                      )
                    : ic(
                        "已检查 {0}/{1} 个会话，完整检查尚未完成。",
                        data.checked,
                        data.total,
                      )}
            </p>
            {data?.run &&
              ["partial", "failed", "interrupted", "cancelled"].includes(
                data.run.status,
              ) && (
                <p role="status">
                  {ic(
                    data.run.status === "cancelled"
                      ? "检查已取消，已完成的结果已保留。"
                      : "上次检查未全部完成，可以重新检查。",
                  )}
                </p>
              )}
            <div className="inspection-rules">
              {data?.rules.map((r) => (
                <button
                  className={`${r.confidence === "candidate" ? "candidate" : ""} ${rule === r.id ? "active" : ""}`}
                  aria-pressed={rule === r.id}
                  disabled={busy}
                  title={ic("点击查看此类结果，再次点击恢复确定结果")}
                  onClick={() => {
                    setSelected("");
                    setData(undefined);
                    setOffset(0);
                    setRule((current) => (current === r.id ? "" : r.id));
                  }}
                  key={r.id}
                >
                  {r.label in inspectionCopy
                    ? ic(r.label as keyof typeof inspectionCopy)
                    : r.label}
                </button>
              ))}
            </div>
          </div>
          <div
            className="inspection-tabs"
            role="tablist"
            aria-label={ic("历史对话体检")}
          >
            {(Object.keys(statusLabels) as InspectionStatus[]).map((s) => (
              <button
                role="tab"
                aria-selected={status === s}
                disabled={busy}
                className={status === s ? "on" : ""}
                key={s}
                onClick={() => {
                  setStatus(s);
                  setOffset(0);
                  setSelected("");
                  setData(undefined);
                }}
              >
                {ic(statusLabels[s])} {data?.counts[s] ?? "—"}
              </button>
            ))}
          </div>
          <div className="inspection-session-list" role="tabpanel">
            {sessions.map((session, index) => (
              <div key={inspectionSessionKey(session)}>
                {(index === 0 || day(session.occurredAt) !== day(sessions[index - 1].occurredAt)) && (
                  <div className="inspection-day">{day(session.occurredAt)}</div>
                )}
                <div className="inspection-session-entry">
                  <span className="inspection-agent-node" aria-hidden="true">
                    <PlatformIcon platform={session.provider} size={12} />
                  </span>
                  <button
                    className={`inspection-item ${selected === inspectionSessionKey(session) ? "selected" : ""}`}
                    aria-pressed={selected === inspectionSessionKey(session)}
                    disabled={busy}
                    onClick={() => setSelected(inspectionSessionKey(session))}
                  >
                    <span className="inspection-item-title" title={session.title}>
                      <strong>{session.title}</strong>
                      <span className="inspection-session-count">
                        {ic("{0} 处", session.count)}
                      </span>
                    </span>
                    <span className="inspection-item-meta">
                      <span>{agentName(session.provider)}</span>
                      <span title={date(session.occurredAt)}>{clock(session.occurredAt)}</span>
                      <span
                        className={`inspection-status ${status === "pending" ? "warn" : "ok"}`}
                      >
                        {ic(statusLabels[status])}
                      </span>
                      <span className="inspection-item-rules" title={session.rules.map(label).join(" · ")}>{session.rules.map(label).join(" · ")}</span>
                    </span>
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="inspection-empty">
            {!data
              ? ic("读取中…")
              : sessions.length
                ? status === "pending" &&
                  complete &&
                  data.pendingDefinite === 1 &&
                  !rule &&
                  data.counts.handled === 0 &&
                  data.counts.ignored === 0 &&
                  data.nextOffset === null
                  ? ic("其他会话里没有发现确定的密钥。")
                  : null
                : status === "pending" &&
                    complete &&
                    data.total &&
                    !rule &&
                    data.counts.handled === 0 &&
                    data.counts.ignored === 0
                  ? ic("没有发现确定的密钥。")
                  : ic("暂时没有这类记录。")}
            {!rule && status === "pending" && !!data?.pendingCandidate && (
              <p>
                {ic(
                  "另有 {0} 处疑似结果，可点击上方虚线规则查看。",
                  data.pendingCandidate,
                )}
              </p>
            )}
          </div>
          {data?.nextOffset != null && (
            <button
              className="inspection-more"
              disabled={busy}
              onClick={() => setOffset(data.nextOffset!)}
            >
              {ic("加载更多")}
            </button>
          )}
        </div>
        <div
          className="inspection-detail"
          role="complementary"
          aria-live="polite"
        >
          {!selectedSession ? (
            <div className="inspection-detail-empty">
              {ic(!data ? "读取中…" : "选择左侧会话查看详情")}
            </div>
          ) : (
            <>
              <div className="inspection-session-heading">
                <h2>{selectedSession.title}</h2>
                <div className="inspection-meta">
                  <span><AgentLabel provider={selectedSession.provider} /></span>
                  <span>{ic(statusLabels[status])}</span>
                  <span>{ic("当前筛选 · {0} 处", selectedSession.count)}</span>
                </div>
                <div className="inspection-actions">
                  {status === "pending" ? (
                    <>
                      <button
                        disabled={busy}
                        onClick={() => void actOnSession("handled")}
                      >
                        {busy && <Loader2 size={13} className="spin" />}
                        {ic("全部标为已处理")}
                      </button>
                      <button
                        className="inspection-link"
                        disabled={busy}
                        onClick={() => void actOnSession("ignored")}
                      >
                        {ic("全部忽略")}
                      </button>
                    </>
                  ) : (
                    <button
                      disabled={busy}
                      onClick={() => void actOnSession("pending")}
                    >
                      {busy && <Loader2 size={13} className="spin" />}
                      {ic("全部恢复为需要处理")}
                    </button>
                  )}
                </div>
              </div>
              <InspectionSessionCards
                key={`${workspace.id}:${selected}:${status}:${rule}`}
                session={selectedSession}
                api={api}
                endpoint={endpoint()}
                detailEndpoint={endpoint("/detail")}
                status={status}
                rule={rule}
                data={data!}
                label={label}
                revision={revision}
                busy={busy}
                onFolder={(id) => void act("/folder", { id })}
              />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function InspectionSessionCards({
  session,
  api,
  endpoint,
  detailEndpoint,
  status,
  rule,
  data,
  label,
  revision,
  busy,
  onFolder,
}: {
  session: InspectionSessionSummary;
  api: Api;
  endpoint: string;
  detailEndpoint: string;
  status: InspectionStatus;
  rule: string;
  data: InspectionData;
  label: (rule: string) => string;
  revision: number;
  busy: boolean;
  onFolder: (id: string) => void;
}) {
  const [results, setResults] = useState<InspectionData>();
  const [offset, setOffset] = useState(0);
  const [cardLimit, setCardLimit] = useState(10);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    void readInspectionResults(
      api,
      `${endpoint}&provider=${encodeURIComponent(session.provider)}&sessionId=${encodeURIComponent(session.sessionId)}`,
      status,
      rule,
      controller.signal,
      offset,
    )
      .then((next) => {
        if (!controller.signal.aborted) setResults(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    endpoint,
    session.provider,
    session.sessionId,
    session.count,
    status,
    rule,
    offset,
    revision,
    data.run?.finishedAt,
    retry,
  ]);
  return (
    <div className="inspection-cards">
      {failed && (
        <div className="inspection-error" role="alert">
          {ic("读取失败，请重试")}
          <button
            className="inspection-link"
            onClick={() => setRetry((n) => n + 1)}
          >
            {ic("重试")}
          </button>
        </div>
      )}
      {!results && loading && (
        <div className="inspection-card-loading">{ic("读取中…")}</div>
      )}
      {results?.items.slice(0, cardLimit).map((item) => (
        <InspectionFindingCard
          key={item.id}
          finding={item}
          api={api}
          endpoint={detailEndpoint}
          data={data}
          label={label}
          revision={revision}
          busy={busy}
          onFolder={onFolder}
        />
      ))}
      {results &&
        (cardLimit < results.items.length || results.nextOffset !== null) && (
          <button
            className="inspection-more"
            disabled={loading}
            onClick={() => {
              if (
                cardLimit >= results.items.length &&
                results.nextOffset !== null
              )
                setOffset(results.nextOffset);
              setCardLimit((n) => n + 10);
            }}
          >
            {ic(loading ? "读取中…" : "加载更多")}
          </button>
        )}
    </div>
  );
}

function InspectionFindingCard({
  finding,
  api,
  endpoint,
  data,
  label,
  revision,
  busy,
  onFolder,
}: {
  finding: InspectionFinding;
  api: Api;
  endpoint: string;
  data: InspectionData;
  label: (rule: string) => string;
  revision: number;
  busy: boolean;
  onFolder: (id: string) => void;
}) {
  const [detail, setDetail] = useState<InspectionDetail>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    void api<InspectionDetail>(
      `${endpoint}&id=${encodeURIComponent(finding.id)}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((next) => {
        if (!controller.signal.aborted) setDetail(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [
    endpoint,
    finding.id,
    finding.status,
    data.maskReady,
    data.run?.finishedAt,
    revision,
    retry,
  ]);
  return (
    <article
      className="inspection-card"
      aria-label={ic("{0}出现在{1}里", label(finding.rule), location(finding))}
    >
      <span className="inspection-finding-node" aria-hidden="true">
        {finding.location.startsWith("tool_") ? <Terminal size={12} /> : <MessageSquare size={12} />}
      </span>
      {failed ? (
        <div className="inspection-error" role="alert">
          {ic("读取失败，请重试")}
          <button
            className="inspection-link"
            onClick={() => setRetry((n) => n + 1)}
          >
            {ic("重试")}
          </button>
        </div>
      ) : !detail ? (
        <div className="inspection-card-loading">{ic("读取中…")}</div>
      ) : (
        <details className="inspection-finding-content" open>
          <summary>
            <h3>{ic("{0}出现在{1}里", label(detail.rule), location(detail))}</h3>
            <ChevronRight size={14} aria-hidden="true" />
          </summary>
          <div className="inspection-meta">
            <span><AgentLabel provider={detail.provider} /></span>
            <span>{date(detail.occurredAt)}</span>
            <span>{detail.turn ? ic("第 {0} 轮", detail.turn) : "—"}</span>
            <span>{location(detail)}</span>
            {detail.confidence === "candidate" && <span>{ic("疑似")}</span>}
          </div>
          {detail.command && (
            <section className="inspection-section">
              <div className="inspection-event-heading">
                <h5>{ic("当时执行的命令")}</h5>
                <span className="inspection-usage">
                  <span title={ic("模型")}>
                    {detail.model || ic("模型未记录")}
                  </span>
                  <span title={ic("思考等级")}>· {detail.effort || "—"}</span>
                  <span title={ic("输入（不含缓存）")}>
                    <ArrowDownToLine size={12} />
                    {count(detail.input)}
                  </span>
                  <span title={ic("输出")}>
                    <ArrowUpFromLine size={12} />
                    {count(detail.output)}
                  </span>
                  <span title={ic("缓存命中")}>
                    <Database size={12} />
                    {count(detail.cache)}
                  </span>
                </span>
              </div>
              <div className="inspection-command">
                <pre>
                  <span>$ </span>
                  {detail.command}
                </pre>
                {detail.description && (
                  <div>{ic("Agent 写的用途：{0}", detail.description)}</div>
                )}
              </div>
            </section>
          )}
          <section className="inspection-section">
            <h5>
              {ic(
                detail.location === "tool_output"
                  ? "输出里的这一行（第 {0} 行）"
                  : "记录里的这一行（第 {0} 行）",
                detail.line,
              )}
            </h5>
            <pre className="inspection-line">{detail.context}</pre>
          </section>
          <details className="inspection-section inspection-guidance">
            <summary>{ic("建议这样处理")}</summary>
            <div className="inspection-steps">
              <div className="inspection-step">
                <span className="n">1</span>
                <span>
                  {detail.confidence === "candidate"
                    ? ic("请确认是否为凭据；如果是，到对应平台作废并替换。")
                    : detail.rule === "private-key-block"
                      ? ic("替换这份私钥，并撤销对应的访问权限。")
                      : ic("到对应平台作废并替换密钥。")}
                </span>
                <span className="inspection-status warn">
                  {ic("需要你自己操作")}
                </span>
              </div>
              <div className="inspection-step">
                <span className="n">2</span>
                <span>
                  {ic(
                    detail.maskReady
                      ? "ADIT 已在自己的记录里遮盖这一处，搜索、在其他 Agent 里引用、分享都不会带出原文"
                      : "正在更新搜索中的遮盖内容",
                  )}
                </span>
                {detail.maskReady && (
                  <span className="inspection-status ok">{ic("已遮盖")}</span>
                )}
              </div>
              <div className="inspection-step">
                <span className="n">3</span>
                <span>
                  {detail.source && !detail.source.startsWith("import:") ? (
                    <>
                      {ic(
                        "{0} 自己的记录文件里还有原文：",
                        agentName(detail.provider),
                      )}
                      <code>{detail.source}</code>
                    </>
                  ) : (
                    ic("原始文件位置未记录或来自导入文件")
                  )}
                </span>
                {detail.source && !detail.source.startsWith("import:") && (
                  <button
                    className="inspection-link"
                    disabled={busy}
                    onClick={() => onFolder(detail.id)}
                  >
                    {ic("打开所在文件夹")}
                  </button>
                )}
              </div>
            </div>
          </details>
          {detail.envRead && (
            <p className="inspection-tip">
              <Info size={14} />
              {ic(
                '这次是 Agent 为了看配置直接读了 .env。可以在项目规则里写上"不要读取 .env 文件"，以后少出这种情况。',
              )}
            </p>
          )}
        </details>
      )}
    </article>
  );
}
