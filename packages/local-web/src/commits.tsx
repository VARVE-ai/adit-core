import { AgentLabel } from "./agent-label";
import { PlatformIcon } from "./platform-icon";
import { agentName } from "./achievement-export";
import { t, locale, systemMessage } from "./i18n";
import React, { useEffect, useState } from "react";
import {
  GitCommitHorizontal,
  ChevronRight,
  Search,
} from "lucide-react";
import "./commits.css";
import { CommitConversation, SessionLink, sessionHref, type CommitRecord } from "./commit-conversation";

type Commit = {
  repository: string;
  sha: string;
  subject: string;
  authoredAt: number | null;
  branch: string | null;
  analyzed: boolean;
  sourceCount: number | null;
  files: {
    path: string;
    additions: number | null;
    deletions: number | null;
    binary: number;
  }[];
  record: CommitRecord | null;
};
type Analysis = {
  runId: string | null;
  status: string;
  finishedAt: number | null;
  completed: number;
  total: number;
  stale: boolean;
  error: string | null;
};
type Data = { repositories: string[]; commits: Commit[]; analysis: Analysis };
type Sources = {
  analysis: Analysis;
  eligible: number | null;
  matched: number | null;
  moved: number | null;
  unknown: number | null;
  coverage: string;
  sources: {
    provider: string;
    sessionId: string;
    title: string;
    certain: number;
    likely: number;
    possible: number;
    files: { path: string; lines: number }[];
    alternatives: { provider: string; sessionId: string; title: string }[];
  }[];
};
const name = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const agents: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
};
const date = (at: number | null, full = false) =>
  at
    ? new Date(at).toLocaleString(
        locale(),
        full
          ? {
              month: "long",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }
          : { month: "long", day: "numeric" },
      )
    : t("时间未知");
export function CommitsPage({
  workspace,
  api,
  onNavigate,
}: {
  workspace: { id: string; providers: string[] };
  onNavigate?: (url: string) => void;
  api: <T = any>(
    path: string,
    method?: string,
    body?: unknown,
    signal?: AbortSignal,
  ) => Promise<T>;
}) {
  const [data, setData] = useState<Data>();
  const [error, setError] = useState("");
  const [repo, setRepo] = useState(() => new URLSearchParams(location.search).get("repository") || "");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(() => {
    const params = new URLSearchParams(location.search);
    return params.get("sha") ? `${params.get("repository") || ""}@${params.get("sha")}` : "";
  });
  const [limit, setLimit] = useState(50);
  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      api<Data>(
        `/commits?workspaceId=${encodeURIComponent(workspace.id)}`,
        "GET",
        undefined,
        controller.signal,
      )
        .then((d) => {
          setData(d);
          setError("");
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(String(e));
        });
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [workspace.id]);
  useEffect(() => {
    setLimit(50);
  }, [repo, filter, query]);
  const rows = (data?.commits || []).filter(
    (c) =>
      (!repo || c.repository === repo) &&
      (filter === "all" ||
        (filter === "linked" ? !!c.record : c.analyzed && !c.record)) &&
      (!query ||
        `${c.subject} ${c.sha}`.toLowerCase().includes(query.toLowerCase())),
  );
  const current =
    rows.find((c) => c.repository + "@" + c.sha === selected) || rows[0];
  const [sources, setSources] = useState<Sources>();
  const [sourceError, setSourceError] = useState("");
  useEffect(() => {
    setSources(undefined);
    setSourceError("");
    if (!current) return;
    const abort = new AbortController();
    void api<Sources>(
      `/commits/sources?${new URLSearchParams({ workspaceId: workspace.id, repository: current.repository, sha: current.sha })}`,
      "GET",
      undefined,
      abort.signal,
    )
      .then((s) => {
        if (!abort.signal.aborted) {
          setSources(s);
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setSourceError(String(e));
      });
    return () => abort.abort();
  }, [workspace.id, current?.repository, current?.sha, data?.analysis.runId]);
  let previous = "";
  return (
    <section className="commits-page" aria-label={t("提交")}>
      <div className="commits-toolbar">
        <div className="commits-segment">
          <button className={!repo ? "on" : ""} onClick={() => setRepo("")}>
            {t("全部仓库")}
          </button>
          {data?.repositories.map((r) => (
            <button
              key={r}
              className={repo === r ? "on" : ""}
              onClick={() => setRepo(r)}
            >
              {name(r)}
            </button>
          ))}
        </div>
        <div className="commits-segment">
          {[
            ["all", t("全部")],
            ["linked", t("有提交会话")],
            ["unlinked", t("未找到提交会话")],
          ].map(([f, label]) => (
            <button
              key={f}
              className={filter === f ? "on" : ""}
              onClick={() => setFilter(f)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="commits-search">
          <Search size={14} />
          <input
            placeholder={t("搜索提交说明或编号")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span className="commits-summary">
          {data?.commits.length
            ? t(
                "{0}以来 ",
                date(
                  Math.min(
                    ...data.commits.map((c) => c.authoredAt || Infinity),
                  ),
                ),
              )
            : ""}
          <b>{data?.commits.length ?? "—"}</b> {t("个提交，")}
          <b>
            {data?.analysis.runId
              ? data.commits.filter((c) => c.record).length
              : "—"}
          </b>{" "}
          {t("个找到提交会话")}
        </span>
      </div>
      {error && (
        <p className="error" role="alert">
          {systemMessage(error)}
        </p>
      )}
      {data && data.analysis.status !== "done" && (
        <p className="commit-note" role="status">
          {data.analysis.status === "running"
            ? t(
                "正在整理提交关联 {0} / {1}",
                data.analysis.completed,
                data.analysis.total,
              )
            : data.analysis.status === "failed"
              ? t(
                  "提交关联分析失败：{0}",
                  (data.analysis.error && systemMessage(data.analysis.error)) ||
                    t("请重新整理"),
                )
              : t("等待整理提交关联")}
          {data.analysis.stale ? t(" · 当前显示上次完成的结果") : ""}
        </p>
      )}
      <div className="commits-work">
        <div className="commits-list" aria-label={t("提交列表")}>
          {!data ? (
            <p className="commits-empty">{t("正在读取本地提交…")}</p>
          ) : !rows.length ? (
            <p className="commits-empty">
              {data.commits.length
                ? t("没有符合筛选条件的提交")
                : t("暂未找到提交记录")}
            </p>
          ) : (
            rows.slice(0, limit).map((c) => {
              const day = date(c.authoredAt);
              const heading = previous !== day;
              previous = day;
              return (
                <React.Fragment key={c.repository + c.sha}>
                  {heading && <div className="commits-day">{day}</div>}
                  <div className="commits-rail">
                    <span className="commits-node">
                      <GitCommitHorizontal size={13} />
                    </span>
                    <button
                      className={`commit-choice ${current === c ? "on" : ""}`}
                      aria-pressed={current === c}
                      aria-controls="commit-detail-panel"
                      onClick={() => {
                        setSelected(c.repository + "@" + c.sha);
                      }}
                    >
                      <div className="commit-heading">
                        <ChevronRight size={14} />
                        <strong>{c.subject}</strong>
                      </div>
                      <div className="commit-meta">
                        <code>{c.sha.slice(0, 7)}</code>
                        <span>{name(c.repository)}</span>
                        <span>
                          ·{" "}
                          {c.authoredAt
                            ? new Date(c.authoredAt).toLocaleTimeString(
                                locale(),
                                { hour: "2-digit", minute: "2-digit" },
                              )
                            : "—"}
                        </span>
                      </div>
                      <div className="commit-relations">
                        <span>
                          {t("提交：")}{" "}
                          {c.record ? (
                            <>
                              <b><AgentLabel provider={c.record.provider} name={agents[c.record.provider]} /></b>{" "}
                              · {c.record.title}
                            </>
                          ) : c.analyzed ? (
                            t("未找到提交会话")
                          ) : (
                            t("等待分析")
                          )}
                        </span>
                        <span>
                          {t("代码来源：")}
                          {c.sourceCount === null
                            ? t("未分析")
                            : t("{0} 个会话", c.sourceCount)}{" "}
                          <ChevronRight size={12} />
                        </span>
                      </div>
                    </button>
                  </div>
                </React.Fragment>
              );
            })
          )}
          {rows.length > limit && (
            <button
              className="commits-more"
              onClick={() => setLimit((n) => n + 50)}
            >
              {t("加载更多")}
            </button>
          )}
        </div>
        <div
          className="commit-detail"
          id="commit-detail-panel"
          role="region"
          aria-label={t("选中提交的详情")}
        >
          {current ? (
            <>
              <h2>{current.subject}</h2>
              <div className="commit-detail-meta">
                <code>{current.sha.slice(0, 7)}</code>
                <span>{name(current.repository)}</span>
                <span>{date(current.authoredAt, true)}</span>
                <span>
                  {current.files.length} {t("个文件")}
                </span>
                <code
                  className="commit-branch"
                  aria-label={t("分支：{0}", current.branch || "—")}
                  title={
                    current.branch
                      ? t("Git 提交记录中的分支：{0}", current.branch)
                      : t("未记录提交时的分支")
                  }
                >
                  {current.branch || "—"}
                </code>
              </div>
              <section>
                <h4>{t("提交记录")}</h4>
                {current.record ? (
                  <CommitConversation key={current.repository + current.sha}
                    workspaceId={workspace.id} record={current.record} sha={current.sha} subject={current.subject}
                    api={api} onNavigate={onNavigate} />
                ) : (
                  <>
                    <p>
                      {current.analyzed ? t("未找到提交会话") : t("等待分析")}
                    </p>
                    <p className="commit-note">
                      {t(
                        "当前记录无法定位提交操作发生在哪个会话，代码来源单独判断。",
                      )}
                    </p>
                  </>
                )}
              </section>
              <section>
                <h4>
                  {t("代码来源")}{" "}
                  {sources && (
                    <small>
                      {sources.sources.length} {t("个会话")}
                    </small>
                  )}
                </h4>
                <details className="commit-submitted-files">
                  <summary>{t("查看提交文件")}</summary>
                  {current.files.map((f) => (
                    <div className="commit-file" key={f.path}>
                      <code>{f.path}</code>
                      <span>
                        {f.binary
                          ? t("二进制")
                          : `+${f.additions ?? "—"} −${f.deletions ?? "—"}`}
                      </span>
                    </div>
                  ))}
                </details>
                <div className={sources?.sources.length && !sourceError && sources.eligible !== null ? "commit-source-list" : "commit-source-empty"}>
                  {sourceError ? (
                    <span role="alert">
                      {t("代码来源分析失败：")}
                      {systemMessage(sourceError)}
                    </span>
                  ) : !sources ? (
                    t("正在读取代码来源…")
                  ) : sources.eligible === null ? (
                    t("等待整理代码来源")
                  ) : !sources.sources.length ? (
                    t("暂未在会话记录中匹配到代码来源。")
                  ) : (
                    sources.sources.map((s) => (
                      <article
                        className="commit-source-entry"
                        key={s.provider + s.sessionId}
                      >
                        <div className="commit-source-heading">
                          <span className="commit-source-node" title={agents[s.provider] || agentName(s.provider)}>
                            <PlatformIcon platform={s.provider} size={12} />
                          </span>
                          <SessionLink className="commit-source-title" href={sessionHref(workspace.id, s.provider, s.sessionId)} onNavigate={onNavigate} title={s.title}>
                            <span>{s.title}</span><ChevronRight size={13} />
                          </SessionLink>
                          <span className="commit-source-meta">
                            <span>{agents[s.provider] || agentName(s.provider)}</span>
                            <strong className="commit-line-total">{s.certain + s.likely + s.possible} {t("行")}</strong>
                          </span>
                        </div>
                        <details className="commit-source-files">
                          <summary>{t("查看匹配文件")}</summary>
                          {s.files.map((f) => (
                            <div className="commit-file" key={f.path}>
                              <code>{f.path}</code>
                              <span>
                                {f.lines} {t("行")}
                              </span>
                            </div>
                          ))}
                        </details>
                        {!!s.alternatives.length && (
                          <details className="commit-source-alternatives">
                            <summary>{t("也写过这些内容")}</summary>
                            {s.alternatives.map((a) => (
                              <p key={a.provider + a.sessionId}>
                                <AgentLabel provider={a.provider} name={agents[a.provider]} /> · {a.title}
                                <br />
                                <small>
                                  {t("候选会话，不重复计入匹配行数")}
                                </small>
                              </p>
                            ))}
                          </details>
                        )}
                      </article>
                    ))
                  )}
                </div>
                <p className="commit-note">
                  {t(
                    "仅统计纳入比对的新增代码行；生成文件和过短的行不参与。来源不明不代表人工编写。",
                  )}
                </p>
                {sources && (
                  <p className="commit-note">
                    {systemMessage(sources.coverage)}
                  </p>
                )}
                <div className="commit-source-scope">
                  <span>{t("纳入比对")} <b>{sources?.eligible ?? "—"}</b> {t("行")}</span>
                  <span>{t("匹配到")} <b>{sources?.matched ?? "—"}</b> {t("行")}</span>
                </div>
              </section>
              <section>
                <h4>{t("关联依据")}</h4>
                <div className="commit-basis">
                  <span>{t("提交会话")}</span>
                  {current.record ? (
                    <>
                      <em>
                        {current.record.method === "hash"
                          ? t("编号一致")
                          : current.record.method === "subject_time"
                            ? t("说明与时间相近")
                            : t("历史编号变更")}
                      </em>
                      <span>
                        {current.record.method === "hash"
                          ? t(
                              "会话中的提交编号与仓库记录 {0} 一致。",
                              current.sha.slice(0, 7),
                            )
                          : current.record.method === "subject_time"
                            ? t("提交说明相同，提交操作时间与仓库记录相近。")
                            : t(
                                "提交说明相同，原编号 {0} 已不在当前提交历史中。",
                                current.record.matchedSha || "—",
                              )}
                      </span>
                    </>
                  ) : (
                    <span>{t("尚无可用的提交操作匹配依据。")}</span>
                  )}
                </div>
                <div className="commit-basis">
                  <span>{t("代码来源")}</span>
                  <span>
                    {t(
                      "按写入内容匹配；逐字匹配、多个候选和近似匹配分别标注，不用提交编号判断代码来源。",
                    )}
                  </span>
                </div>
              </section>
            </>
          ) : (
            <p className="commits-empty">{t("选择提交查看详情")}</p>
          )}
        </div>
      </div>
    </section>
  );
}
