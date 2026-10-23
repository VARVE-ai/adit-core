import { AgentLabel } from "./agent-label";
import { t, locale, systemMessage } from "./i18n";
import {
  number,
  compact,
  duration,
  month,
  day as fmtDay,
  weekday,
} from "./formatters";
import React, { useEffect, useState } from "react";
import {
  LockKeyhole,
  MessageSquare,
  Terminal,
  ChartNoAxesCombined,
  GitCommitHorizontal,
  ChevronRight,
  X,
  Award,
  ShieldCheck,
} from "lucide-react";
import type { OverviewData } from "../../core/src/local-history/analytics";
import "./overview.css";
import { dailyCostWindow, costAxisMaximum } from "./overview-chart-data";
import { type CloudSyncSummary } from "./overview-cloud-push";

type Workspace = {
  id: string;
  name: string;
  started: boolean;
  cloud: { enabled: boolean };
  cloudSync?: CloudSyncSummary;
  achievements?: { unread: number };
  inspection?: { pending: number };
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
const money = (n: number | null | undefined, decimals = 2) =>
  n == null
    ? "—"
    : n === 0
      ? decimals
        ? "$0.00"
        : "$0"
      : n < 10000
        ? t("不到 $0.01")
        : new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          }).format(n / 1e6);
const palette = [
  "#e38b08",
  "#4a83ef",
  "#a735e5",
  "#2eb9a2",
  "#dc6682",
  "#a5aa65",
];
const agentColors: Record<string, string> = {
  claude: "var(--overview-agent-claude)",
  codex: "var(--overview-agent-codex)",
  "vscode-copilot": "var(--overview-agent-copilot)",
  cursor: "var(--overview-agent-cursor)",
  grok: "var(--overview-agent-grok)",
};
const date = (at: number | string | null, zone?: string) =>
  at == null
    ? "—"
    : new Date(at).toLocaleString(locale(), {
        timeZone: zone,
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
function Legend() {
  return (
    <span className="overview-legend">
      {t("少")}{" "}
      {[0, 1, 2, 3, 4].map((n) => (
        <i className={`heat-${n}`} key={n} />
      ))}{" "}
      {t("多")}
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
      aria-label={t("{0} 年每天的活跃度", year)}
    >
      <span />
      {Array.from({ length: weeks }, (_, week) => {
        const d = data.activity.days
          .slice(Math.max(0, week * 7 - offset), (week + 1) * 7 - offset)
          .find((d) => d.date.endsWith("-01"));
        return (
          <span className="month" key={week}>
            {d ? month(Number(d.date.slice(5, 7))) : ""}
          </span>
        );
      })}
      {Array.from({ length: 7 }, (_, r) => (
        <React.Fragment key={r}>
          <span className="weekday">{weekday(r)}</span>
          {Array.from({ length: weeks }, (_, c) => {
            const d = data.activity.days[c * 7 + r - offset];
            return d ? (
              <span
                key={c}
                tabIndex={0}
                className={`heat heat-${d.state === "outside" ? "outside" : d.state === "unknown" ? "unknown" : d.count === 0 ? 0 : Math.max(1, Math.ceil((d.count / max) * 4))}`}
                title={`${d.date} ${d.state === "outside" ? t("不在筛选范围") : d.state === "unknown" ? t("没有记录") : t("{0} 条消息", d.count)}`}
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
  onAchievements,
  onInspection,
  onProfileCards,
}: {
  workspace: Workspace;
  jobs: Job[];
  api: Api;
  onSettings: () => void;
  onAchievements?: () => void;
  onInspection?: () => void;
  onProfileCards?: () => void;
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
      (data?.agents || []).map((a, i) => [
        a.id,
        agentColors[a.id] || palette[(i + 3) % palette.length],
      ]),
    );
  const agent = (id: string) => (
    <AgentLabel provider={id} name={names.get(id) || id} className="overview-agent" iconSize={11} />
  );
  if (!workspace.started)
    return (
      <div className="empty">
        <h2>{t("当前目录还没有整理")}</h2>
        <button onClick={onSettings}>{t("进入工作目录设置")}</button>
      </div>
    );
  const s = data?.summary,
    work = data?.work;
  const unavailable = t("该功能尚未接入，当前仅保留原型入口");
  const models = data?.costs.models || [],
    modelRows = models.slice(0, models.length > 8 ? 7 : 8),
    others = models.length > 8 ? models.slice(7) : [];
  if (others.length)
    modelRows.push({
      model: t("其他 {0} 个模型", others.length),
      amount: others.reduce((n, m) => n + m.amount, 0),
      requests: 0,
    });
  const maxModel = Math.max(1, ...modelRows.map((m) => m.amount)),
    maxHour = Math.max(1, ...(data?.activity.hours.map((h) => h.total) || []));
  const costDays = data
    ? dailyCostWindow(data.costs.daily, range, data.scope.to)
    : [];
  const hasDailyCost = costDays.some((d) => d.amount !== null);
  const maxCost = costAxisMaximum(costDays.map((d) => d.amount));
  const providerCosts = new Map<string, number>();
  for (const day of data?.costs.daily || [])
    for (const [id, amount] of Object.entries(day.providers))
      providerCosts.set(id, (providerCosts.get(id) || 0) + amount);
  const firstActiveHour = data?.activity.hours.find((h) => h.total > 0)?.hour;
  const start = data?.scope.first ? fmtDay(data.scope.first) : "—";
  return (
    <section
      className="overview-page"
      aria-label={t("概览")}
      aria-busy={loading}
    >
      <div className="overview-toolbar">
        {(loading || error) && (
          <div className="overview-feedback" role={error ? "alert" : "status"}>
            {error ? (
              <>
                {systemMessage(error)}
                <button onClick={() => setTick((t) => t + 1)}>{t("重试")}</button>
              </>
            ) : t("正在更新…")}
          </div>
        )}
        <div className="overview-segment">
          {[
            ["7d", t("最近 7 天")],
            ["30d", t("最近 30 天")],
            ["all", t("全部时间")],
          ].map(([v, l]) => (
            <button
              key={v}
              aria-pressed={range === v}
              className={range === v ? "on" : ""}
              onClick={() => setRange(v)}
            >
              {l}
            </button>
          ))}
        </div>
        <div className="overview-segment agent-filters">
          <button
            className={provider === "all" ? "on" : ""}
            aria-pressed={provider === "all"}
            onClick={() => setProvider("all")}
          >
            {t("全部 Agent")}
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
              aria-label={t("筛选 Agent")}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="all">{t("全部 Agent")}</option>
              {data?.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="overview-tools">
          <button disabled={!onAchievements} onClick={onAchievements}>
            <Award size={12} />
            {t("查看成就")}{!!workspace.achievements?.unread && <span className="achievement-unread">{workspace.achievements.unread}</span>} <ChevronRight size={12} />
          </button>
          <button disabled={!onInspection} onClick={onInspection} className={workspace.inspection?.pending ? "inspection-attention" : undefined}>
            <ShieldCheck size={12} />
            {t("查看体检结果")}{!!workspace.inspection?.pending && <span>{workspace.inspection.pending}</span>} <ChevronRight size={12} />
          </button>
        </div>
      </div>
      <div className="overview-badge-row">
        {[
          [
            "commits in AI sessions",
            s ? `${number(s.linkedCommits)}/${number(s.totalCommits)}` : "—",
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
            title={`${label}: ${value}${label === "commits in AI sessions" ? t("；已确认关联，其他提交仍可能未完成分析") : ""}`}
          >
            <span>{label}</span>
            <strong>{label === "AI agents" && value !== "—"
              ? data?.agents.filter((a) => provider === "all" || provider === a.id).map((a, index) => (
                  <React.Fragment key={a.id}>{index > 0 && " · "}{agent(a.id)}</React.Fragment>
                ))
              : value}</strong>
          </span>
        ))}
        <div className="overview-badge-actions">
          <button onClick={onProfileCards}>
            {t("看看所有样式")}
          </button>
        </div>
      </div>
      <div className="overview-cards">
        <Stat
          icon={<Terminal />}
          label={t("会话")}
          value={number(s?.sessions)}
          foot={t("{0}个子任务未计入", number(s?.subtasks))}
        />
        <Stat
          icon={<MessageSquare />}
          label={t("消息")}
          value={number(s?.messages)}
          foot={t("{0}最忙那天", number(data?.activity.busiest?.count))}
        />
        <Stat
          icon={<ChartNoAxesCombined />}
          label={t("活跃天数")}
          value={t("{0} 天", number(s?.activeDays))}
          foot={t("{0}天有记录", number(s?.recordDays))}
          title={t(
            "活跃指有真实用户提问；有记录天数按最早至最晚消息的观察跨度计算，不代表每天均完整采集",
          )}
        />
        <Stat
          icon={<LockKeyhole />}
          label={t("折算花费")}
          value={money(s?.estimatedCost)}
          foot={t("参考 API 花费")}
          title={t("按当前公开 API 价格折算，已知部分；不是实际账单")}
        />
        <Stat
          icon={<GitCommitHorizontal />}
          label={t("AI 会话里的提交")}
          value={
            s ? `${number(s.linkedCommits)} / ${number(s.totalCommits)}` : "—"
          }
          foot={
            s?.totalCommits
              ? t(
                  "{0}%关联到会话",
                  Math.round((s.linkedCommits / s.totalCommits) * 100),
                )
              : t("— 找到会话")
          }
          title={t(
            "只统计本人提交；仅已确认的提交会话关联，尚未完成全部分析。分母为当前目录和日期内全部本人提交，不随 Agent 筛选变化",
          )}
        />
        <Stat
          icon={<LockKeyhole />}
          label={t("平均每个提交")}
          value={money(s?.avgCommitCost)}
          foot={
            s?.withCommitRatio == null
              ? t("— 花在有提交的会话")
              : t("{0}%花在有提交的会话", Math.round(s.withCommitRatio * 100))
          }
          title={t(
            "按费用前 {0} 个会话中的已确认关联计算；部分分析，适合看趋势，不适合考核",
            data?.averageCommitCost.sampleSize || 0,
          )}
        />
      </div>
      <div className="overview-row overview-activity">
        <article>
          <Heading title={t("每天的活跃度")}>
            <span>{t("按消息数")}</span>
            <select
              value={year}
              aria-label={t("活跃度年份")}
              onChange={(e) => setYear(Number(e.target.value))}
            >
              {(data?.activity.years || [year]).map((y) => (
                <option key={y} value={y}>
                  {y} {t("年")}
                </option>
              ))}
            </select>
          </Heading>
          {data ? (
            <Heatmap data={data} />
          ) : (
            <div className="overview-placeholder">
              {loading ? t("正在读取本地记录…") : t("没有记录")}
            </div>
          )}
          <div className="overview-year-footer">
            <Legend />
            <span>
              {t("最忙的一天")}{" "}
              <b>
                {data?.activity.busiest
                  ? t(
                      "{0} · {1} 条消息",
                      fmtDay(data.activity.busiest.date),
                      number(data.activity.busiest.count),
                    )
                  : "—"}
              </b>
            </span>
            <span>
              {t(
                "{0} 天活跃，共记录 {1} 天",
                number(s?.activeDays),
                number(s?.recordDays),
              )}
            </span>
          </div>
        </article>
        <article>
          <Heading title={t("24 小时的活跃度")}>
            {t("按 {0} 天平均", number(s?.recordDays))}
          </Heading>
          <div className="overview-hours">
            <div className="overview-hour-peaks">
              {data?.activity.peakHours.map((h) => (
                <b key={h} style={{ left: `${((h + 0.5) / 24) * 100}%` }}>
                  {String(h).padStart(2, "0")}:00
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
                    title={t(
                      "{0} 点 · 平均每天 {1} 条消息",
                      h,
                      cell
                        ? cell.average > 0 && cell.average < 1
                          ? t("不到 1")
                          : number(Math.round(cell.average))
                        : "—",
                    )}
                  />
                );
              })}
            </div>
            <div className="overview-hour-ticks">
              {[0, 6, 12, 18, 24].map((h) => (
                <span key={h}>{String(h).padStart(2, "0")}:00</span>
              ))}
            </div>
          </div>
          <div className="overview-year-footer">
            <Legend />
            {firstActiveHour !== undefined && firstActiveHour > 0 && (
              <span>
                {t(
                  "{0} 前没有消息",
                  `${String(firstActiveHour).padStart(2, "0")}:00`,
                )}
              </span>
            )}
          </div>
        </article>
      </div>
      <div className="overview-row overview-costs">
        <article>
          <Heading title={t("每天的花费")}>
            <span>
              {range === "all"
                ? t("最近 90 天")
                : range === "7d"
                  ? t("最近 7 天")
                  : t("最近 30 天")}
            </span>
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
            {[0, 0.25, 0.5, 0.75, 1].map((r) => (
              <div
                key={r}
                className="overview-gridline"
                style={{ bottom: `${r * 100}%` }}
              >
                <span>
                  {money(Math.round(maxCost * r), maxCost >= 4e6 ? 0 : 2)}
                </span>
              </div>
            ))}
            <div className="overview-bars">
              {costDays.map((d) => (
                <div
                  className="overview-bar-slot"
                  key={d.date}
                  title={`${d.date} · ${d.amount === null ? t("没有已计价用量记录") : money(d.amount)}${Object.entries(d.providers || {}).map(([p, c]) => `\n${names.get(p) || p} · ${money(c)}`).join("")}`}
                >
                  <div className="overview-stack">
                    {[...Object.entries(d.providers || {})]
                      .sort(
                        ([a], [b]) =>
                          [...names.keys()].indexOf(a) -
                          [...names.keys()].indexOf(b),
                      )
                      .map(([p, c]) => (
                        <i
                          key={p}
                          title={`${names.get(p) || p} · ${money(c)}`}
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
            {!hasDailyCost && (
              <div className="overview-chart-empty">
                {loading ? t("正在计算…") : t("当前范围没有可计价的每日用量")}
              </div>
            )}
          </div>
          <div className="overview-chart-dates">
            {costDays
              .filter(
                (_, i) =>
                  i === 0 ||
                  i === costDays.length - 1 ||
                  i % Math.ceil(costDays.length / 6) === 0,
              )
              .map((d) => (
                <span key={d.date}>{fmtDay(d.date)}</span>
              ))}
          </div>
          <div
            className="overview-token"
            title={t(
              "Token 按顶部筛选范围统计；全部时间下柱状图只展示最近 90 天。",
            )}
          >
            {t(
              "{0} tokens · 读取缓存 {1} · 写入缓存 {2} · 新输入 {3} · 输出 {4}",
              compact(data?.usage.totals.total_tokens),
              compact(data?.usage.totals.cache_read_tokens),
              compact(data?.usage.totals.cache_write_tokens),
              compact(data?.usage.totals.uncached_input_tokens),
              compact(data?.usage.totals.output_tokens),
            )}
          </div>
        </article>
        <article>
          <Heading title={t("花费按模型")}>
            <span
              className="overview-provider-costs"
              title={`${t("价格更新时间：{0}", date(data?.costs.prices.fetchedAt ?? null, zone))} · ${t("已计价")} ${number(data?.usage.priced)} ${t("· 未计价")} ${number(data?.usage.unpriced)} · ${t("费用为已计价请求之和，不是订阅费或实付账单。缺失消息用量 {0} 条；子任务用量尚未合并，避免重复。{1}", data?.coverage.missingUsage || 0, systemMessage(data?.costs.prices.error || ""))}`}
            >
              {providerCosts.size ? [...providerCosts].map(([id, value], index) => (
                <React.Fragment key={id}>{index > 0 && " · "}{agent(id)} {money(value, value >= 1e6 ? 0 : 2)}</React.Fragment>
              )) : t("按当前公开 API 价格折算")}
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
                  <b title={money(m.amount)}>
                    {m.amount > 0 && m.amount < 10000
                      ? "<$0.01"
                      : money(m.amount, m.amount >= 1e6 ? 0 : 2)}
                  </b>
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
                {loading ? t("正在计算…") : t("暂无可计价模型")}
              </div>
            )}
          </div>
        </article>
      </div>
      <div className="overview-row overview-work">
        <article className="overview-longest-panel">
          <Heading title={t("连续干得最久的几次")}>
            {t("中间停顿超过 5 分钟的按 5 分钟算")}
          </Heading>
          <div className="overview-longest">
            {work?.longest.length ? (
              work.longest.map((turn, i) => (
                <button
                  key={turn.id}
                  className="overview-turn"
                  onClick={() => setDetail(turn)}
                >
                  <span>{i + 1}</span>
                  {agent(turn.provider)}
                  <strong title={turn.prompt}>{turn.prompt || "—"}</strong>
                  <small>{date(turn.started_at, zone)}</small>
                  <b>
                    {duration(turn.duration)
                      .replace(/(\d) h/g, "$1h")
                      .replace(/(\d) min/g, "$1m")}
                  </b>
                  <small>{t("{0} 条消息", number(turn.messages))}</small>
                </button>
              ))
            ) : (
              <div className="overview-placeholder">
                {loading ? t("正在读取…") : t("当前范围没有可计算的工作轮次")}
              </div>
            )}
          </div>
        </article>
        <article className="overview-work-summary">
          <Heading title={t("Agent 替你干的活")}>
            {t("从每次提问到这一轮最后一条消息")}
          </Heading>
          <div className="overview-hours-total">
            <b>{work ? number(work.duration / 3_600_000) : "—"}</b>
            <span>{t("小时")}</span>
            <small>
              {t("{0} 次提问 · 自 {1} 起", number(s?.prompts), start)}
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
                  ? t("不到 1 小时")
                  : t("{0}h", number(Math.round(p.duration / 3_600_000)))}
              </span>
            ))}
          </div>
          <div className="overview-work-facts">
            <span>{t("{0} 次工作超过 30 分钟", number(work?.over30m))}</span>
            <span
              title={`${t("按并行会话实例计数，长停顿只计前5分钟")}${work?.peakAt ? ` · ${date(work.peakAt, zone)}` : ""}`}
            >
              {t("最多 {0} 个 Agent 同时工作", number(work?.peak))}
            </span>
          </div>
        </article>
      </div>
      {detail && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="overview-turn-detail"
            role="dialog"
            aria-modal="true"
            aria-label={t("工作轮次详情")}
          >
            <button
              className="icon"
              autoFocus
              onClick={() => setDetail(undefined)}
              aria-label={t("关闭详情")}
            >
              <X size={18} />
            </button>
            <h2>{t("连续干得最久的几次")}</h2>
            <p>
              {agent(detail.provider)} · {date(detail.started_at, zone)} ·{" "}
              {duration(detail.duration)}
            </p>
            <p>{detail.prompt}</p>
            <p>
              {number(detail.messages)} {t("条消息 ·")}{" "}
              {detail.duration_status === "observed"
                ? t("时间完整")
                : t("时间可能不完整")}
            </p>
            <small>
              {t("会话：")}
              {detail.session_id}
              {t("；完整会话页面尚未开放。")}
            </small>
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
  title,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  foot: string;
  title?: string;
}) {
  return (
    <div className="overview-stat" title={title}>
      <span className="overview-stat-icon">{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        <span>{foot}</span>
      </div>
    </div>
  );
}
