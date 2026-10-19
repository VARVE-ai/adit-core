import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  LockKeyhole,
  MessageSquare,
  Terminal,
  ChartNoAxesCombined,
  GitCommitHorizontal,
  Share2,
  ChevronRight,
  RefreshCw,
  Globe,
  X,
} from "lucide-react";
import type { OverviewData } from "../../core/src/local-history/analytics";
import "./overview.css";

type Workspace = {
  id: string;
  name: string;
  started: boolean;
  cloud: { enabled: boolean };
};
type Job = {
  id: string;
  workspaceId: string;
  kind: string;
  status: string;
  endedAt?: string;
  error?: string;
};
type Api = <T = any>(
  path: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;
const number = (n: number | null | undefined) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(n);
const compact = (n: number | null | undefined) =>
  n == null
    ? "—"
    : n >= 1e8
      ? `${number(n / 1e8)} 亿`
      : n >= 1e4
        ? `${number(n / 1e4)} 万`
        : number(n);
const money = (n: number | null | undefined) =>
  n == null
    ? "—"
    : n === 0
      ? "$0"
      : n < 10000
        ? "不到 $0.01"
        : new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
            maximumFractionDigits: n >= 1e6 ? 0 : 2,
          }).format(n / 1e6);
const duration = (n: number) =>
  n >= 3_600_000
    ? `${Math.floor(n / 3_600_000)} 小时 ${Math.floor((n % 3_600_000) / 60_000)} 分`
    : n > 0
      ? `${Math.max(1, Math.floor(n / 60_000))} 分`
      : "0 分";
const palette = [
  "#b27350",
  "#468b83",
  "#6b8fbc",
  "#9678b4",
  "#b89848",
  "#6d9b60",
];
const date = (at: number | string | null, zone?: string) =>
  at == null
    ? "—"
    : new Date(at).toLocaleString("zh-CN", {
        timeZone: zone,
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
function Legend() {
  return (
    <span className="overview-legend">
      少{" "}
      {[0, 1, 2, 3, 4].map((n) => (
        <i className={`heat-${n}`} key={n} />
      ))}{" "}
      多 <i className="heat-unknown" /> 没有记录
    </span>
  );
}
function Heatmap({ data }: { data: OverviewData }) {
  const year = data.scope.year,
    start = new Date(Date.UTC(year, 0, 1)),
    offset = (start.getUTCDay() + 6) % 7,
    weeks = Math.ceil((offset + data.activity.days.length) / 7),
    max = Math.max(1, ...data.activity.days.map((d) => d.count));
  return (
    <div
      className="overview-year"
      style={{ gridTemplateColumns: `18px repeat(${weeks},minmax(0,1fr))` }}
      aria-label={`${year} 年每天的活跃度`}
    >
      <span />
      {Array.from({ length: weeks }, (_, week) => {
        const d = data.activity.days
          .slice(Math.max(0, week * 7 - offset), (week + 1) * 7 - offset)
          .find((d) => d.date.endsWith("-01"));
        return (
          <span className="month" key={week}>
            {d ? `${Number(d.date.slice(5, 7))} 月` : ""}
          </span>
        );
      })}
      {Array.from({ length: 7 }, (_, r) => (
        <React.Fragment key={r}>
          <span className="weekday">{"一二三四五六日"[r]}</span>
          {Array.from({ length: weeks }, (_, c) => {
            const d = data.activity.days[c * 7 + r - offset];
            return d ? (
              <span
                key={c}
                tabIndex={0}
                className={`heat heat-${d.state === "outside" ? "outside" : d.state === "unknown" ? "unknown" : d.count === 0 ? 0 : Math.max(1, Math.ceil((d.count / max) * 4))}`}
                title={`${d.date} ${d.state === "outside" ? "不在筛选范围" : d.state === "unknown" ? "没有记录" : `${d.count} 条消息`}`}
              />
            ) : (
              <span key={c} />
            );
          })}
        </React.Fragment>
      ))}
    </div>
  );
}
export function OverviewPage({
  workspace,
  jobs,
  api,
  onSettings,
}: {
  workspace: Workspace;
  jobs: Job[];
  api: Api;
  onSettings: () => void;
}) {
  const [range, setRange] = useState("all"),
    [provider, setProvider] = useState("all"),
    [year, setYear] = useState(new Date().getFullYear()),
    [data, setData] = useState<OverviewData>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [tick, setTick] = useState(0),
    [detail, setDetail] = useState<OverviewData["work"]["longest"][number]>();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const latest = jobs.find(
      (j) => j.workspaceId === workspace.id && j.kind === "collect",
    ),
    active = latest && ["running", "queued"].includes(latest.status);
  useEffect(() => {
    setProvider("all");
    setData(undefined);
    setError("");
  }, [workspace.id]);
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const query = new URLSearchParams({
      workspaceId: workspace.id,
      range,
      provider,
      year: String(year),
      timezone: zone,
    });
    void api<OverviewData>(
      `/overview?${query}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [workspace.id, range, provider, year, tick, latest?.id, latest?.status]);
  useEffect(() => {
    const timer = setInterval(
      () => setTick((t) => t + 1),
      active ? 5000 : 60000,
    );
    return () => clearInterval(timer);
  }, [workspace.id, active]);
  useEffect(() => {
    if (!detail) return;
    const previous = document.activeElement as HTMLElement | null;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetail(undefined);
      if (e.key === "Tab") {
        e.preventDefault();
        document
          .querySelector<HTMLButtonElement>(".overview-turn-detail .icon")
          ?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [detail]);
  const names = new Map(data?.agents.map((a) => [a.id, a.name]) || []),
    colors = new Map(
      (data?.agents || []).map((a, i) => [a.id, palette[i % palette.length]]),
    );
  const agent = (id: string) => (
    <span className="overview-agent">
      <i style={{ background: colors.get(id) || palette[0] }} />
      {names.get(id) || id}
    </span>
  );
  const refresh = async () => {
    setError("");
    try {
      await api(`/workspaces/${workspace.id}/collect`, "POST");
      setTick((t) => t + 1);
    } catch (e) {
      setError(String(e));
    }
  };
  if (!workspace.started)
    return (
      <div className="empty">
        <h2>当前目录还没有整理</h2>
        <button onClick={onSettings}>进入工作目录设置</button>
      </div>
    );
  const s = data?.summary,
    work = data?.work;
  const unavailable = "该功能尚未接入，当前仅保留原型入口";
  const models = data?.costs.models || [],
    modelRows = models.slice(0, 5),
    others = models.slice(5);
  if (others.length)
    modelRows.push({
      model: `其他 ${others.length} 个模型`,
      amount: others.reduce((n, m) => n + m.amount, 0),
      requests: 0,
    });
  const maxModel = Math.max(1, ...modelRows.map((m) => m.amount)),
    maxHour = Math.max(1, ...(data?.activity.hours.map((h) => h.total) || []));
  const costDays = data?.costs.daily || [],
    maxCost = Math.max(
      1,
      ...costDays.map((d) =>
        Object.values(d.providers).reduce((n, c) => n + c, 0),
      ),
    );
  const fmtDay = (d: string) =>
    `${Number(d.slice(5, 7))} 月 ${Number(d.slice(8, 10))} 日`;
  const start = data?.scope.first ? fmtDay(data.scope.first) : "—";
  const lastFinished = jobs.find(
    (j) =>
      j.workspaceId === workspace.id &&
      j.kind === "collect" &&
      ["done", "partial"].includes(j.status),
  );
  const statusTarget = document.getElementById("overview-header-status");
  const syncStatus = (
    <div className="overview-sync">
      <span className={active ? "working" : ""}>
        ●{" "}
        {active
          ? "本地整理中"
          : latest?.status === "done"
            ? "本地已同步"
            : latest
              ? "本地记录部分更新"
              : "尚无本地同步记录"}
      </span>
      <span>
        上次同步{" "}
        {lastFinished?.endedAt ? date(lastFinished.endedAt, zone) : "—"}
      </span>
      <button
        disabled={active}
        onClick={refresh}
        title="重新读取当前工作目录的会话与提交记录"
        aria-label="刷新当前工作目录的本地记录"
      >
        <RefreshCw size={12} className={active ? "spin" : ""} />
        刷新
      </button>
      {loading && <span>正在更新…</span>}
      {error && (
        <span role="alert">
          {error} <button onClick={() => setTick((t) => t + 1)}>重试</button>
        </span>
      )}
      {latest?.error && <span title={latest.error}>部分来源未完成</span>}
    </div>
  );
  return (
    <section className="overview-page" aria-label="概览" aria-busy={loading}>
      <div className="overview-toolbar">
        <div className="overview-segment">
          {[
            ["7d", "最近 7 天"],
            ["30d", "最近 30 天"],
            ["all", "全部"],
          ].map(([v, l]) => (
            <button
              key={v}
              aria-pressed={range === v}
              className={range === v ? "on" : ""}
              onClick={() => setRange(v)}
            >
              {l}
              {v === "all" && data?.scope.first && <small>{start}起</small>}
            </button>
          ))}
        </div>
        <div className="overview-segment agent-filters">
          <button
            className={provider === "all" ? "on" : ""}
            aria-pressed={provider === "all"}
            onClick={() => setProvider("all")}
          >
            全部 Agent
          </button>
          {(data?.agents || []).length <= 4 ? (
            (data?.agents || []).map((a) => (
              <button
                key={a.id}
                className={provider === a.id ? "on" : ""}
                aria-pressed={provider === a.id}
                onClick={() => setProvider(a.id)}
              >
                {agent(a.id)}
              </button>
            ))
          ) : (
            <select
              aria-label="筛选 Agent"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="all">全部 Agent</option>
              {data?.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="overview-tools">
          <button disabled title={unavailable}>
            查看成就 <ChevronRight size={12} />
          </button>
          <button disabled title={unavailable}>
            查看体检结果 <ChevronRight size={12} />
          </button>
          <span title="实际云端推送尚未接入；不受日期和 Agent 筛选影响">
            待推送 — 个会话、— 个提交
          </span>
          <button disabled title="云端推送尚未接入">
            <Globe size={12} />
            立即推送
          </button>
        </div>
      </div>
      {statusTarget && createPortal(syncStatus, statusTarget)}
      <div className="overview-mobile-sync">{syncStatus}</div>
      <div className="overview-badge-row">
        {[
          [
            "commits in AI sessions",
            s ? `${s.linkedCommits}/${s.totalCommits}` : "—",
          ],
          ["AI sessions", number(s?.sessions)],
          ["AI prompts", number(s?.prompts)],
          ["AI active days", number(s?.activeDays)],
          [
            "AI agents",
            data?.agents
              .filter((a) => provider === "all" || provider === a.id)
              .map((a) => a.name)
              .join(" · ") || "—",
          ],
          ["top model", s?.topModel || "—"],
        ].map(([label, value]) => (
          <span
            key={label}
            className="overview-badge"
            title={`${label}: ${value}${label === "commits in AI sessions" ? "；已确认关联，其他提交仍可能未完成分析" : ""}`}
          >
            <span>
              <b>{"{><}"}</b>
              {label}
            </span>
            <strong>{value}</strong>
          </span>
        ))}
        <div className="overview-badge-actions">
          <button disabled title={unavailable}>
            看看所有样式
          </button>
          <button disabled title={unavailable}>
            <Share2 size={12} />
            放进项目首页
          </button>
        </div>
      </div>
      <div className="overview-cards">
        <Stat
          icon={<Terminal />}
          label="会话"
          value={number(s?.sessions)}
          foot={`${number(s?.subtasks)}个子任务未计入`}
        />
        <Stat
          icon={<MessageSquare />}
          label="消息"
          value={number(s?.messages)}
          foot={`${number(data?.activity.busiest?.count)}最忙那天`}
        />
        <Stat
          icon={
            <span className="mini-heat">
              {data?.activity.days
                .filter((d) => d.state !== "outside")
                .slice(-49)
                .map((d) => (
                  <i
                    key={d.date}
                    className={`heat-${d.count ? Math.min(4, Math.ceil(d.count / 100)) : "unknown"}`}
                  />
                ))}
            </span>
          }
          label="活跃天数"
          value={`${number(s?.activeDays)} 天`}
          foot={`${number(s?.recordDays)}天有记录`}
          title="活跃指有真实用户提问；有记录天数按最早至最晚消息的观察跨度计算，不代表每天均完整采集"
        />
        <Stat
          icon={<ChartNoAxesCombined />}
          label="折算花费"
          locked
          value={money(s?.estimatedCost)}
          foot={`${money(costDays.length ? Math.max(...costDays.map((d) => Object.values(d.providers).reduce((n, c) => n + c, 0))) : null)}最多一天`}
          title="按当前公开 API 价格折算，已知部分；不是实际账单"
        />
        <Stat
          icon={<GitCommitHorizontal />}
          label="AI 会话里的提交"
          value={s ? `${s.linkedCommits} / ${s.totalCommits}` : "—"}
          foot={
            s?.totalCommits
              ? `${Math.round((s.linkedCommits / s.totalCommits) * 100)}%找到会话 · 部分分析`
              : "— 找到会话"
          }
          blue
          title="只统计本人提交；仅已确认的提交会话关联，尚未完成全部分析。分母为当前目录和日期内全部本人提交，不随 Agent 筛选变化"
        />
        <Stat
          icon={<GitCommitHorizontal />}
          label="平均每个提交"
          locked
          value={
            s?.avgCommitCost == null ? "—" : `约 ${money(s.avgCommitCost)}`
          }
          foot={
            s?.withCommitRatio == null
              ? "— 花在有提交的会话"
              : `${Math.round(s.withCommitRatio * 100)}%花在有提交的会话`
          }
          title={`按费用前 ${data?.averageCommitCost.sampleSize || 0} 个会话中的已确认关联计算；部分分析，适合看趋势，不适合考核`}
        />
      </div>
      <div className="overview-row overview-activity">
        <article>
          <Heading title="每天的活跃度">
            <span>按消息数</span>
            <select
              value={year}
              aria-label="活跃度年份"
              onChange={(e) => setYear(Number(e.target.value))}
            >
              {(data?.activity.years || [year]).map((y) => (
                <option key={y} value={y}>
                  {y} 年
                </option>
              ))}
            </select>
          </Heading>
          {data ? (
            <Heatmap data={data} />
          ) : (
            <div className="overview-placeholder">
              {loading ? "正在读取本地记录…" : "没有记录"}
            </div>
          )}
          <div className="overview-year-footer">
            <Legend />
            <span>
              最忙的一天{" "}
              <b>
                {data?.activity.busiest
                  ? `${fmtDay(data.activity.busiest.date)} · ${number(data.activity.busiest.count)} 条消息`
                  : "—"}
              </b>
            </span>
            <span>
              有记录的 {number(s?.recordDays)} 天里{" "}
              <b>活跃 {number(s?.activeDays)} 天</b>
            </span>
          </div>
        </article>
        <article>
          <Heading title="24 小时的活跃度">
            按有记录的 {number(s?.recordDays)} 天平均
          </Heading>
          <div className="overview-hours">
            <div className="overview-hour-peaks">
              {data?.activity.peakHours.map((h) => (
                <b key={h} style={{ left: `${((h + 0.5) / 24) * 100}%` }}>
                  {h} 点
                </b>
              ))}
            </div>
            <div className="overview-hour-strip">
              {Array.from({ length: 24 }, (_, h) => {
                const cell = data?.activity.hours[h];
                return (
                  <span
                    tabIndex={0}
                    key={h}
                    className={`heat-${cell?.total ? Math.max(1, Math.ceil((cell.total / maxHour) * 4)) : 0}`}
                    title={`${h} 点 · 平均每天 ${cell ? (cell.average > 0 && cell.average < 1 ? "不到 1" : number(Math.round(cell.average))) : "—"} 条消息`}
                  />
                );
              })}
            </div>
            <div className="overview-hour-ticks">
              {[0, 6, 12, 18, 24].map((h) => (
                <span key={h}>{h} 点</span>
              ))}
            </div>
          </div>
          <div className="overview-year-footer">
            <Legend />
          </div>
        </article>
      </div>
      <div className="overview-row overview-work">
        <article>
          <Heading title="Agent 替你干的活">
            从每次提问到这一轮最后一条消息
          </Heading>
          <div className="overview-hours-total">
            <b>{work ? number(work.duration / 3_600_000) : "—"}</b>
            <span>小时</span>
            <small>
              {start}以来 · {number(s?.prompts)} 次提问
            </small>
          </div>
          <div className="overview-work-bar">
            {work?.byProvider.map((p) => (
              <i
                key={p.provider}
                style={{
                  width: `${work.duration ? (p.duration / work.duration) * 100 : 0}%`,
                  background: colors.get(p.provider),
                }}
              />
            ))}
          </div>
          <div className="overview-work-legend">
            {work?.byProvider.map((p) => (
              <span key={p.provider}>
                {agent(p.provider)}{" "}
                {p.duration < 3_600_000
                  ? "不到 1 小时"
                  : `${number(Math.round(p.duration / 3_600_000))} 小时`}
              </span>
            ))}
          </div>
          <div className="overview-work-facts">
            <span>
              一句话干了半小时以上 <b>{number(work?.over30m)} 次</b>
            </span>
            <span title="按并行会话实例计数，长停顿只计前5分钟">
              最多同时在干活 <b>{number(work?.peak)} 个 Agent</b>
              {work?.peakAt ? `（${date(work.peakAt, zone)}）` : ""}
            </span>
          </div>
        </article>
        <article>
          <Heading title="连续干得最久的几次">
            中间停顿超过 5 分钟的按 5 分钟算
          </Heading>
          <div className="overview-longest">
            {work?.longest.length ? (
              work.longest.map((t, i) => (
                <button
                  key={t.id}
                  className="overview-turn"
                  onClick={() => setDetail(t)}
                >
                  <span>{i + 1}</span>
                  {agent(t.provider)}
                  <strong title={t.prompt}>{t.prompt || "—"}</strong>
                  <small>{date(t.started_at, zone)}</small>
                  <b>{duration(t.duration)}</b>
                  <small>{number(t.messages)} 条消息</small>
                </button>
              ))
            ) : (
              <div className="overview-placeholder">
                {loading ? "正在读取…" : "当前范围没有可计算的工作轮次"}
              </div>
            )}
          </div>
        </article>
      </div>
      <div className="overview-row overview-costs">
        <article>
          <Heading title="每天的花费">
            <span className="overview-agent-legend">
              {data?.agents
                .filter((a) => provider === "all" || provider === a.id)
                .slice(0, 5)
                .map((a) => (
                  <React.Fragment key={a.id}>{agent(a.id)}</React.Fragment>
                ))}
            </span>
          </Heading>
          <div className="overview-cost-chart">
            {[0, 0.5, 1].map((r) => (
              <div
                key={r}
                className="overview-gridline"
                style={{ bottom: `${r * 100}%` }}
              >
                <span>{money(Math.round(maxCost * r))}</span>
              </div>
            ))}
            <div className="overview-bars">
              {costDays.map((d) => (
                <div
                  className="overview-bar-slot"
                  key={d.date}
                  title={`${d.date} ${money(Object.values(d.providers).reduce((n, c) => n + c, 0))}`}
                >
                  <div className="overview-stack">
                    {Object.entries(d.providers).map(([p, c]) => (
                      <i
                        key={p}
                        style={{
                          height: `${(c / maxCost) * 100}%`,
                          background: colors.get(p),
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {!costDays.length && (
              <div className="overview-chart-empty">
                {loading ? "正在计算…" : "当前范围没有可计价的每日用量"}
              </div>
            )}
          </div>
          <div className="overview-chart-dates">
            <span>{costDays[0]?.date || "—"}</span>
            <span>{costDays.at(-1)?.date || "—"}</span>
          </div>
          <div className="overview-token">
            共 <b>{compact(data?.usage.totals.total_tokens)}</b> token：读取缓存{" "}
            <b>{compact(data?.usage.totals.cache_read_tokens)}</b> · 写入缓存{" "}
            {compact(data?.usage.totals.cache_write_tokens)} · 新输入{" "}
            {compact(data?.usage.totals.uncached_input_tokens)} · 输出{" "}
            {compact(data?.usage.totals.output_tokens)}
          </div>
        </article>
        <article>
          <Heading title="花费按模型">
            <span
              title={`价格更新时间：${date(data?.costs.prices.fetchedAt ?? null, zone)}`}
            >
              按当前公开 API 价格折算
            </span>
          </Heading>
          <div className="overview-models">
            {modelRows.length ? (
              modelRows.map((m) => (
                <div className="overview-model" key={m.model}>
                  <span title={m.model}>{m.model}</span>
                  <span className="overview-model-track">
                    <i style={{ width: `${(m.amount / maxModel) * 100}%` }} />
                  </span>
                  <b>{money(m.amount)}</b>
                  <small>
                    {s?.estimatedCost
                      ? Math.round((m.amount / s.estimatedCost) * 100)
                      : 0}
                    %
                  </small>
                </div>
              ))
            ) : (
              <div className="overview-placeholder">
                {loading ? "正在计算…" : "暂无可计价模型"}
              </div>
            )}
          </div>
          <div
            className="overview-coverage"
            title={`费用为已计价请求之和，不是订阅费或实付账单。缺失消息用量 ${data?.coverage.missingUsage || 0} 条；子任务用量尚未合并，避免重复。${data?.costs.prices.error || ""}`}
          >
            已计价 {number(data?.usage.priced)} · 未计价{" "}
            {number(data?.usage.unpriced)}
            {data?.coverage.missingUsage
              ? ` · ${number(data.coverage.missingUsage)} 条消息缺用量`
              : ""}
            {data?.coverage.childUsageExcluded ? " · 子任务用量未合并" : ""} ·
            缺失项显示 —
          </div>
        </article>
      </div>
      {detail && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="overview-turn-detail"
            role="dialog"
            aria-modal="true"
            aria-label="工作轮次详情"
          >
            <button
              className="icon"
              autoFocus
              onClick={() => setDetail(undefined)}
              aria-label="关闭详情"
            >
              <X size={18} />
            </button>
            <h2>连续干得最久的几次</h2>
            <p>
              {agent(detail.provider)} · {date(detail.started_at, zone)} ·{" "}
              {duration(detail.duration)}
            </p>
            <p>{detail.prompt}</p>
            <p>
              {number(detail.messages)} 条消息 ·{" "}
              {detail.duration_status === "observed"
                ? "时间完整"
                : "时间可能不完整"}
            </p>
            <small>会话：{detail.session_id}；完整会话页面尚未开放。</small>
          </section>
        </div>
      )}
    </section>
  );
}
function Heading({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="overview-heading">
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  );
}
function Stat({
  icon,
  label,
  value,
  foot,
  locked,
  blue,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  foot: string;
  locked?: boolean;
  blue?: boolean;
  title?: string;
}) {
  return (
    <div className={`overview-stat${blue ? " blue" : ""}`} title={title}>
      <span className="overview-stat-icon">{icon}</span>
      <div>
        <small>
          {label}
          {locked && <LockKeyhole size={10} />}
        </small>
        <strong>{value}</strong>
        <span>{foot}</span>
      </div>
    </div>
  );
}
