import { AgentLabel } from "./agent-label";
import { Fragment, useEffect, useRef, useState } from "react";
import { Award, Download, LockKeyhole, RefreshCw } from "lucide-react";
import type {
  AchievementItem,
  AchievementsData,
} from "../../core/src/local-history/achievements";
import type { AchievementKey } from "../../core/src/local-history/achievement-rules";
import { ac } from "./achievement-copy";
import {
  achievementDate,
  achievementDescription,
  achievementDownload,
  achievementName,
  achievementValue,
  agentName,
  badgeMetric,
  badgeSvg,
  earnedAt,
  readmeCode,
  ruleFor,
  svgUrl,
} from "./achievement-export";
import "./achievements.css";
import { ExportToolbar, type ExportTab } from "./export-toolbar";

type Api = <T = any>(
  path: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;
const Pips = ({ tier }: { tier: number }) => (
  <span className="ach-pips" aria-label={`${tier}/3`}>
    {[1, 2, 3].map((n) => (
      <i key={n} className={n <= tier ? "earned" : ""} />
    ))}
  </span>
);
export function AchievementsPage({
  workspace,
  api,
  onOverview,
  onTab,
}: {
  workspace: {
    id: string;
    name: string;
    version: number;
    providers?: string[];
  };
  api: Api;
  onOverview: () => void;
  onTab: (tab: ExportTab) => void;
}) {
  const [data, setData] = useState<AchievementsData>();
  const [focus, setFocus] = useState<AchievementKey>("marathon");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState<"copied" | "download" | "">("");
  const [saving, setSaving] = useState(false),
    [exporting, setExporting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const writing = useRef(false),
    displayed = useRef(new Set<string>());
  const sidebarScroll = useRef<HTMLDivElement>(null);
  const focusInitialized = useRef(false);
  const focusAchievement = (key: AchievementKey) => {
    focusInitialized.current = true;
    setFocus(key);
    setFeedback("");
    sidebarScroll.current?.scrollTo({ top: 0 });
  };
  const endpoint = (suffix = "") =>
    `/achievements${suffix}?workspaceId=${encodeURIComponent(workspace.id)}`;
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      if (writing.current || document.hidden) return;
      try {
        const result = await api<AchievementsData>(
          endpoint(),
          "GET",
          undefined,
          controller.signal,
        );
        if (!writing.current) {
          setData(result);
          setError("");
        }
      } catch {
        if (!controller.signal.aborted) setError(ac("成就读取失败"));
      }
    };
    void load();
    const timer = window.setInterval(load, 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [workspace.id, workspace.version, refresh]);
  useEffect(() => {
    if (!data || data.status !== "ready" || focusInitialized.current) return;
    const initial =
      data.items.find((i) => i.tier && i.options.selected) ||
      data.items.find((i) => i.tier) ||
      data.items[0];
    if (initial) focusAchievement(initial.key);
  }, [data]);
  useEffect(() => {
    if (!data || data.status !== "ready") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const keys = new Set(
          entries
            .filter((e) => e.isIntersecting)
            .map((e) => (e.target as HTMLElement).dataset.achievement),
        );
        const ids = data.items
          .filter((i) => keys.has(i.key))
          .flatMap((i) =>
            i.unlocks
              .filter((u) => u.unread && !displayed.current.has(u.id))
              .map((u) => u.id),
          );
        if (!ids.length) return;
        ids.forEach((id) => displayed.current.add(id));
        void api(endpoint("/acknowledge"), "POST", { ids }).catch(() =>
          ids.forEach((id) => displayed.current.delete(id)),
        );
      },
      { threshold: 0.25 },
    );
    document
      .querySelectorAll(".ach-row[data-achievement]")
      .forEach((row) => observer.observe(row));
    return () => observer.disconnect();
  }, [data]);
  const save = async (input: Record<string, unknown>) => {
    if (writing.current) return;
    writing.current = true;
    setSaving(true);
    setError("");
    setFeedback("");
    const previous = data;
    setData((current) =>
      current
        ? {
            ...current,
            ...(typeof input.notify === "boolean"
              ? { notify: input.notify }
              : {}),
            items: current.items.map((i) =>
              i.key === input.key
                ? { ...i, options: { ...i.options, ...input } }
                : input.selected === true ? { ...i, options: { ...i.options, selected: false } } : i,
            ),
          }
        : current,
    );
    try {
      setData(
        await api<AchievementsData>(endpoint("/preferences"), "PATCH", input),
      );
    } catch {
      setData(previous);
      setError(ac("保存失败，请重试"));
    } finally {
      writing.current = false;
      setSaving(false);
    }
  };
  const item = data?.items.find((i) => i.key === focus);
  const unlocked = data?.items.filter((i) => i.tier) || [],
    locked = data?.items.filter((i) => !i.tier) || [];
  const selected = unlocked.filter((i) => i.options.selected && i.key === focus);
  const ready = data?.status === "ready";
  const date = (at: number | null, time = false) =>
    achievementDate(at, data?.timezone || "UTC", time);
  const renderRow = (i: AchievementItem) => {
    const rule = ruleFor(i.key),
      next = rule.thresholds[i.tier] ?? rule.thresholds[2];
    return (
      <div
        className={`ach-row${focus === i.key ? " focused" : ""}${!i.tier ? " locked" : ""}`}
        key={i.key}
        data-achievement={i.key}
      >
        <input
          type="radio"
          name="achievement-export-item"
          aria-label={achievementName(i.key)}
          checked={!!i.tier && i.options.selected}
          disabled={!i.tier || !ready || saving}
          onChange={() => {
            focusAchievement(i.key);
            void save({ key: i.key, selected: true });
          }}
        />
        <button
          className="ach-row-body"
          aria-pressed={focus === i.key}
          disabled={saving || exporting}
          onClick={() => {
            focusAchievement(i.key);
            if (i.tier && ready && !i.options.selected) void save({ key: i.key, selected: true });
          }}
        >
          <span className="ach-mini">
            <span>
              {i.tier ? "{><}" : <LockKeyhole size={12} />}{" "}
              {rule.name.toLowerCase()}
            </span>
            <b>{badgeMetric(i.key, i.tier ? i.value : rule.thresholds[0])}</b>
          </span>
          <span className="ach-row-copy">
            <strong>{achievementName(i.key)}</strong>
            <span>
              {i.value === null
                ? ac("暂无记录")
                : i.tier
                  ? achievementDescription(i)
                  : `${achievementDescription({ ...i, value: rule.thresholds[0] })} · ${ac("已到 {0}", achievementValue(i.key, i.value))}`}
              {i.bestAt !== null && <> · {date(i.bestAt)}</>}
            </span>
          </span>
          <span className="ach-row-level">
            {i.tier ? (
              <Pips tier={i.tier} />
            ) : (
              <span className="ach-progress">
                <i
                  style={{
                    width: `${Math.min(100, ((i.value || 0) / next) * 100)}%`,
                  }}
                />
              </span>
            )}
            <small>
              {i.tier === 3
                ? ac("已满级")
                : i.tier
                  ? ac("下一级 {0}", achievementValue(i.key, next))
                  : ac(
                      "还差 {0}",
                      achievementValue(
                        i.key,
                        Math.max(0, next - (i.value || 0)),
                      ),
                    )}
            </small>
          </span>
        </button>
      </div>
    );
  };
  return (
    <div className="achievements-page">
      <ExportToolbar
        tab="achievements"
        name={workspace.name}
        since={data?.firstAt != null ? date(data.firstAt) : undefined}
        onOverview={onOverview}
        onTab={onTab}
      />
      {error && (
        <div className="ach-error" role="alert">
          {error}
          <button onClick={() => setRefresh((n) => n + 1)}>
            <RefreshCw size={12} />
            {ac("刷新")}
          </button>
        </div>
      )}
      <div className="ach-work">
        <section className="ach-main">
          <>
            <div className="ach-heading">
              <h1>{ac("成就")}</h1>
              <span className="ach-status earned">
                {ac("已解锁 {0} 个", unlocked.length)}
              </span>
              <span className="ach-status">
                {ac("还有 {0} 个快到了", locked.length)}
              </span>
              {data?.evaluatedAt && (
                <span className="ach-status">
                  {ac("数字截至 {0}", date(data.evaluatedAt))}
                </span>
              )}
            </div>
            {ready && data.firstAt !== null && (
              <div className="ach-note">
                <Award size={16} />
                <span>
                  {ac(
                    "第一次整理完，按 {0}以来的记录补发了 {1} 个成就，日期是当时达成的那一天；以后再达成新的一级，概览工具行会提示一次。",
                    date(data.firstAt),
                    data.backfillCount,
                  )}
                </span>
              </div>
            )}
            {!data || data.status === "pending" ? (
              <p role="status" className="ach-note">
                {ac("正在根据已有记录计算成就…")}
              </p>
            ) : data.status === "failed" ? (
              <p role="alert" className="ach-note">
                {ac("成就更新失败，保留上次结果。下次整理时会重试。")}
              </p>
            ) : null}
            {!!data?.sourceErrors && (
              <p className="ach-muted">
                {ac("部分来源尚未完成，以下成绩仅包含已确认的记录。")}
              </p>
            )}
            <h2 className="ach-group">{ac("已解锁 · 选择要放进项目首页的成就")}</h2>
            <div className="ach-list">
              {unlocked.map(renderRow)}
              {!unlocked.length && (
                <p className="ach-empty">
                  {ac("尚未解锁成就，整理本地记录后会显示真实进度。")}
                </p>
              )}
            </div>
            <h2 className="ach-group">{ac("快解锁了")}</h2>
            <div className="ach-list">
              {locked.map(renderRow)}
              {ready && !locked.length && (
                <p className="ach-empty">{ac("全部成就均已解锁")}</p>
              )}
            </div>
          </>
        </section>
        <div className="ach-sidebar">
          {data && item && (
            <>
              <div className="ach-side-scroll" ref={sidebarScroll}>
                <section>
                  <h2>{ac("选中的成就")}</h2>
                  <div className="ach-selected">
                    <strong>{achievementName(item.key)}</strong>
                    <Pips tier={item.tier} />
                    <span className="ach-muted ach-thresholds">
                      {item.tier
                        ? ac(
                            "第 {0} 级，三级是 {1}",
                            item.tier,
                            ruleFor(item.key)
                              .thresholds.map((n) =>
                                achievementValue(item.key, n),
                              )
                              .join(" / "),
                          )
                        : ac(
                            "尚未解锁；三级是 {0}",
                            ruleFor(item.key)
                              .thresholds.map((n) =>
                                achievementValue(item.key, n),
                              )
                              .join(" / "),
                          )}
                    </span>
                  </div>
                  <p>
                    {item.value === null
                      ? ac("暂无记录")
                      : achievementDescription(item)}
                    {item.evidence[0]?.provider && (
                      <> · <AgentLabel provider={item.evidence[0].provider} /></>
                    )}
                  </p>
                  {item.key === "streak" && (
                    <p className="ach-muted">
                      {ac("当前连续 {0} 个工作日", item.current || 0)}
                    </p>
                  )}
                  {item.key === "marathon" && item.evidence[0] && (
                    <p className="ach-evidence">
                      {date(item.evidence[0].at, true)}
                      {item.evidence[0].prompt && (
                        <> · “{item.evidence[0].prompt}”</>
                      )}
                      {item.evidence[0].messages && (
                        <> · {ac("{0} 条消息", item.evidence[0].messages)}</>
                      )}
                    </p>
                  )}
                  {!!item.incomplete && (
                    <p className="ach-coverage">
                      {ac(
                        "{0} 条记录无法完整核实，当前显示已确认的成绩。",
                        item.incomplete,
                      )}
                    </p>
                  )}
                  {item.unlocks.length > 0 && (
                    <details>
                      <summary>{ac("达成日期")}</summary>
                      {item.bestAt !== null && (
                        <p className="ach-muted">
                          {ac("最高成绩发生于 {0}", date(item.bestAt, true))}
                        </p>
                      )}
                      {item.unlocks.map((u) => (
                        <p
                          key={u.id}
                          title={ac(
                            "本次识别于 {0}",
                            date(u.discoveredAt, true),
                          )}
                        >
                          {ac("第 {0} 级达成于 {1}", u.tier, date(u.at))}
                        </p>
                      ))}
                    </details>
                  )}
                  {item.evidence.some((e) => e.timeSource === "git") && (
                    <p className="ach-muted">{ac("提交时间来自 Git 记录")}</p>
                  )}
                </section>
                <section>
                  <h2>{ac("两种样式")}</h2>
                  <div className={`ach-styles${!item.tier ? " locked" : ""}`}>
                    {(["plain", "rich"] as const).map((style) => (
                      <label key={style}>
                        <span>
                          <input
                            type="radio"
                            name="badge-style"
                            checked={item.options.style === style}
                            disabled={saving}
                            onChange={() => void save({ key: item.key, style })}
                          />
                          {ac(style === "plain" ? "普通" : "精美")}
                        </span>
                        <img
                          src={svgUrl(badgeSvg(data, item, style))}
                          alt={`${achievementName(item.key)} · ${ac(style === "plain" ? "普通" : "精美")}`}
                        />
                      </label>
                    ))}
                  </div>
                </section>
                <section>
                  <h2>{ac("徽章上显示")}</h2>
                  {(
                    [
                      [
                        "showValue",
                        ac(
                          ruleFor(item.key).unit === "duration"
                            ? "时长"
                            : "成绩",
                        ),
                        achievementValue(item.key, item.value),
                      ],
                      ["showDate", ac("达成日期"), date(earnedAt(item))],
                      [
                        "showAgent",
                        ac("用的哪个 Agent"),
                        [
                          ...new Set(
                            item.evidence.map((e) => agentName(e.provider)),
                          ),
                        ].join(", ") || "—",
                      ],
                      ["showPrompt", ac("提问原文"), ac("默认不带")],
                    ] as const
                  ).map(([key, label, hint]) => (
                    <label className="ach-option" key={key}>
                      <input
                        type="checkbox"
                        checked={item.options[key]}
                        disabled={
                          saving ||
                          (key === "showPrompt" && !item.evidence[0]?.prompt)
                        }
                        onChange={(e) =>
                          void save({ key: item.key, [key]: e.target.checked })
                        }
                      />
                      <span>{label}</span>
                      <small title={hint}>{key === "showAgent" && item.evidence.length
                        ? [...new Set(item.evidence.map((e) => e.provider))].map((provider, index) => (
                            <Fragment key={provider || "unknown"}>{index > 0 && ", "}<AgentLabel provider={provider || ""} /></Fragment>
                          ))
                        : hint}</small>
                    </label>
                  ))}
                  {item.options.showPrompt && item.evidence[0]?.prompt && (
                    <div className="ach-prompt">
                      <small>{ac("提问预览（已脱敏）")}</small>
                      <p>{item.evidence[0].prompt}</p>
                    </div>
                  )}
                </section>
                <section>
                  <h2>{ac("解锁提示")}</h2>
                  <label className="ach-option ach-notify">
                    <span>{ac("达成新的一级时，在概览工具行提示一次")}</span>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={data.notify}
                      disabled={saving}
                      onChange={(e) => void save({ notify: e.target.checked })}
                    />
                  </label>
                </section>
                <section>
                  <h2>{ac("怎么算的")}</h2>
                  <p className="ach-muted">
                    {ac(
                      "连续干活：从提问到这一轮最后一条消息，中间停顿超过 5 分钟的按 5 分钟算",
                    )}
                  </p>
                  <p className="ach-muted">
                    {ac("工作日：周一到周五，周末不算中断")}
                  </p>
                  <p className="ach-muted">
                    {ac("当前工作目录 · {0} 个仓库", data.repositories)} ·{" "}
                    {data.timezone}
                  </p>
                </section>
                <section>
                  <h2>{ac("放进 README")}</h2>
                  <pre>
                    {selected.length
                      ? readmeCode(selected)
                      : ac("请选择已解锁的成就")}
                  </pre>
                  <p className="ach-muted">
                    {ac(
                      "将下载的图片放到项目的 .github/adit/ 目录，再粘贴下面的代码。",
                    )}
                  </p>
                </section>
              </div>
              <footer className="ach-footer">
                <div>
                  <button
                    className="primary"
                    disabled={!ready || !selected.length || saving || exporting}
                    onClick={async () => {
                      setExporting(true);
                      setError("");
                      try {
                        const current = await api<AchievementsData>(endpoint());
                        setData(current);
                        await achievementDownload(current, focus);
                        setFeedback("download");
                      } catch {
                        setError(ac("导出失败，请重试"));
                      } finally {
                        setExporting(false);
                      }
                    }}
                  >
                    <Download size={14} />
                    {ac(exporting ? "正在生成…" : "导出成就徽章")}
                  </button>
                  <button
                    className="ach-link"
                    disabled={!ready || !selected.length || saving || exporting}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(
                          readmeCode(selected),
                        );
                        setFeedback("copied");
                      } catch {
                        setError(ac("复制失败，请手动复制下面的代码"));
                      }
                    }}
                  >
                    {ac(feedback === "copied" ? "已复制" : "复制 README 代码")}
                  </button>
                </div>
                <small role="status">
                  {feedback === "download"
                    ? ac("已生成下载文件")
                    : ac("导出选中的成就，格式为 PNG。")}
                </small>
              </footer>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
