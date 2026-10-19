import React, { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import {
  GitCommitHorizontal,
  ChevronRight,
  Search,
  Share2,
} from "lucide-react";
import "./commits.css";

type Commit = {
  repository: string;
  sha: string;
  subject: string;
  authoredAt: number | null;
  analyzed: boolean;
  sourceCount: number | null;
  files: {
    path: string;
    additions: number | null;
    deletions: number | null;
    binary: number;
  }[];
  record: null | {
    provider: string;
    title: string;
    ordinal: number | null;
    at: number | null;
    command: string;
    prompt: string;
    method: string;
    matchedSha: string | null;
  };
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
        "zh-CN",
        full
          ? {
              month: "long",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }
          : { month: "long", day: "numeric" },
      )
    : "时间未知";
export function CommitsPage({
  workspace,
  api,
}: {
  workspace: { id: string; providers: string[] };
  api: <T = any>(
    path: string,
    method?: string,
    body?: unknown,
    signal?: AbortSignal,
  ) => Promise<T>;
}) {
  const [data, setData] = useState<Data>();
  const [error, setError] = useState("");
  const [repo, setRepo] = useState("");
  const [filter, setFilter] = useState("全部");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [limit, setLimit] = useState(50);
  const [event, setEvent] = useState(false);
  const badgeDialog = useRef<HTMLDialogElement>(null);
  const [badgeError, setBadgeError] = useState("");
  const badgeLabel = `${data?.analysis.runId?data.commits.filter((c) => c.record).length:'—'}/${data?.commits.length ?? '—'}`;
  const badgeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="238" height="20" role="img" aria-label="commits in AI sessions: ${badgeLabel}"><rect width="238" height="20" rx="3" fill="#555"/><path d="M168 0h67q3 0 3 3v14q0 3-3 3h-67z" fill="#059669"/><g fill="#fff" font-family="Verdana,sans-serif" font-size="11" text-anchor="middle"><text x="84" y="14">commits in AI sessions</text><text x="203" y="14">${badgeLabel}</text></g></svg>`;
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
      (filter === "全部" ||
        (filter === "有提交会话" ? !!c.record : c.analyzed&&!c.record)) &&
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
    <section className="commits-page" aria-label="提交">
      {document.getElementById("overview-header-status") &&
        createPortal(
          <span className="commit-connected">
            已接入{" "}
            {workspace.providers.map((p) => agents[p] || p).join("、") || "—"}
          </span>,
          document.getElementById("overview-header-status")!,
        )}
      <div className="commits-toolbar">
        <div className="commits-segment">
          <button className={!repo ? "on" : ""} onClick={() => setRepo("")}>
            全部仓库
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
          {["全部", "有提交会话", "未找到提交会话"].map((f) => (
            <button
              key={f}
              className={filter === f ? "on" : ""}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <label className="commits-search">
          <Search size={14} />
          <input
            placeholder="搜索提交说明或编号"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span className="commits-summary">
          {data?.commits.length
            ? `${date(Math.min(...data.commits.map((c) => c.authoredAt || Infinity)))}以来 `
            : ""}
          <b>{data?.commits.length ?? "—"}</b> 个提交，
          <b>{data?.analysis.runId?data.commits.filter((c) => c.record).length : "—"}</b>{" "}
          个找到提交会话
        </span>
        <button disabled={!data?.analysis.runId} onClick={() => badgeDialog.current?.showModal()}>
          <Share2 size={14} />
          做成徽章
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data && data.analysis.status !== "done" && (
        <p className="commit-note" role="status">
          {data.analysis.status === "running"
            ? `正在整理提交关联 ${data.analysis.completed} / ${data.analysis.total}`
            : data.analysis.status === "failed"
              ? `提交关联分析失败：${data.analysis.error || "请重新整理"}`
              : "等待整理提交关联"}
          {data.analysis.stale ? " · 当前显示上次完成的结果" : ""}
        </p>
      )}
      <div className="commits-work">
        <div className="commits-list" aria-label="提交列表">
          {!data ? (
            <p className="commits-empty">正在读取本地提交…</p>
          ) : !rows.length ? (
            <p className="commits-empty">
              {data.commits.length
                ? "没有符合筛选条件的提交"
                : "暂未找到提交记录"}
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
                        setEvent(false);
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
                                "zh-CN",
                                { hour: "2-digit", minute: "2-digit" },
                              )
                            : "—"}
                        </span>
                      </div>
                      <div className="commit-relations">
                        <span>
                          提交：{" "}
                          {c.record ? (
                            <>
                              <b className={"agent-" + c.record.provider}>
                                {agents[c.record.provider] || c.record.provider}
                              </b>{" "}
                              · {c.record.title}
                            </>
                          ) : c.analyzed ? (
                            "未找到提交会话"
                          ) : (
                            "等待分析"
                          )}
                        </span>
                        <span>
                          代码来源：
                          {c.sourceCount === null
                            ? "未分析"
                            : `${c.sourceCount} 个会话`}{" "}
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
              加载更多
            </button>
          )}
        </div>
        <div
          className="commit-detail"
          id="commit-detail-panel"
          role="region"
          aria-label="选中提交的详情"
        >
          {current ? (
            <>
              <h2>{current.subject}</h2>
              <div className="commit-detail-meta">
                <code>{current.sha.slice(0, 7)}</code>
                <span>{name(current.repository)}</span>
                <span>{date(current.authoredAt, true)}</span>
                <span>{current.files.length} 个文件</span>
              </div>
              <section>
                <h4>提交记录</h4>
                {current.record ? (
                  <>
                    <div className="commit-session">
                      <b className={"agent-" + current.record.provider}>
                        {agents[current.record.provider] ||
                          current.record.provider}
                      </b>
                      <strong>{current.record.title}</strong>
                    </div>
                    <p className="commit-note">
                      {current.record.ordinal
                        ? `第 ${current.record.ordinal} 轮提问 · `
                        : ""}
                      {date(current.record.at, true)}
                    </p>
                    <button
                      onClick={() => {
                        setEvent(true);
                        requestAnimationFrame(() => {
                          const element =
                            document.getElementById("commit-event");
                          element?.scrollIntoView({
                            block: "nearest",
                            behavior: "smooth",
                          });
                          element?.focus({ preventScroll: true });
                        });
                      }}
                    >
                      <ChevronRight size={12} />
                      定位提交事件
                    </button>
                    {(event || current.record.prompt) && (
                      <blockquote
                        id="commit-event"
                        tabIndex={-1}
                        className={event ? "located" : ""}
                      >
                        {current.record.prompt ||
                          "在会话记录中找到关联的提交操作"}
                      </blockquote>
                    )}
                    <details open={event || undefined}>
                      <summary>查看提交命令</summary>
                      <pre>{current.record.command}</pre>
                    </details>
                  </>
                ) : (
                  <>
                    <p>{current.analyzed ? "未找到提交会话" : "等待分析"}</p>
                    <p className="commit-note">
                      当前记录无法定位提交操作发生在哪个会话，代码来源单独判断。
                    </p>
                  </>
                )}
              </section>
              <section>
                <h4>
                  代码来源{" "}
                  {sources && <small>{sources.sources.length} 个会话</small>}
                </h4>
                <div className="commit-source-scope">
                  纳入比对 <b>{sources?.eligible ?? "—"}</b> 行{" "}
                  <span>
                    匹配到 <b>{sources?.matched ?? "—"}</b> 行
                  </span>
                </div>
                <div className="commit-source-empty">
                  {sourceError ? (
                    <span role="alert">代码来源分析失败：{sourceError}</span>
                  ) : !sources ? (
                    "正在读取代码来源…"
                  ) : sources.eligible === null ? (
                    "等待整理代码来源"
                  ) : !sources.sources.length ? (
                    "暂未在会话记录中匹配到代码来源。"
                  ) : (
                    sources.sources.map((s) => (
                      <article
                        className="commit-source-entry"
                        key={s.provider + s.sessionId}
                      >
                        <div className="commit-session">
                          <b className={"agent-" + s.provider}>
                            {agents[s.provider] || s.provider}
                          </b>
                          <strong className="commit-line-total">
                            {s.certain + s.likely + s.possible} 行
                          </strong>
                        </div>
                        <div className="commit-source-title">{s.title}</div>
                        <div className="commit-source-levels">
                          {!!s.certain && <em>确定 {s.certain} 行</em>}
                          {!!s.likely && <em>较确定 {s.likely} 行</em>}
                          {!!s.possible && (
                            <em className="possible">可能 {s.possible} 行</em>
                          )}
                        </div>
                        <details>
                          <summary>查看匹配文件</summary>
                          {s.files.map((f) => (
                            <div className="commit-file" key={f.path}>
                              <code>{f.path}</code>
                              <span>{f.lines} 行</span>
                            </div>
                          ))}
                        </details>
                        {!!s.alternatives.length && (
                          <details>
                            <summary>也写过这些内容</summary>
                            {s.alternatives.map((a) => (
                              <p key={a.provider + a.sessionId}>
                                {agents[a.provider] || a.provider} · {a.title}
                                <br />
                                <small>候选会话，不重复计入匹配行数</small>
                              </p>
                            ))}
                          </details>
                        )}
                      </article>
                    ))
                  )}
                </div>
                <div className="commit-other">
                  <span>复制或挪动</span>
                  <span>{sources?.moved ?? "—"} 行</span>
                </div>
                <div className="commit-other">
                  <span>来源不明</span>
                  <span>{sources?.unknown ?? "—"} 行</span>
                </div>
                <p className="commit-note">
                  仅统计纳入比对的新增代码行；生成文件和过短的行不参与。来源不明不代表人工编写。
                </p>
                {sources && <p className="commit-note">{sources.coverage}</p>}
                <details>
                  <summary>查看提交文件</summary>
                  {current.files.map((f) => (
                    <div className="commit-file" key={f.path}>
                      <code>{f.path}</code>
                      <span>
                        {f.binary
                          ? "二进制"
                          : `+${f.additions ?? "—"} −${f.deletions ?? "—"}`}
                      </span>
                    </div>
                  ))}
                </details>
              </section>
              <section>
                <h4>关联依据</h4>
                <div className="commit-basis">
                  <span>提交会话</span>
                  {current.record ? (
                    <>
                      <em>
                        {current.record.method === "hash"
                          ? "编号一致"
                          : current.record.method === "subject_time"
                            ? "说明与时间相近"
                            : "历史编号变更"}
                      </em>
                      <span>
                        {current.record.method === "hash"
                          ? `会话中的提交编号与仓库记录 ${current.sha.slice(0, 7)} 一致。`
                          : current.record.method === "subject_time"
                            ? "提交说明相同，提交操作时间与仓库记录相近。"
                            : `提交说明相同，原编号 ${current.record.matchedSha || "—"} 已不在当前提交历史中。`}
                      </span>
                    </>
                  ) : (
                    <span>尚无可用的提交操作匹配依据。</span>
                  )}
                </div>
                <div className="commit-basis">
                  <span>代码来源</span>
                  <span>
                    按写入内容匹配；逐字匹配、多个候选和近似匹配分别标注，不用提交编号判断代码来源。
                  </span>
                </div>
              </section>
            </>
          ) : (
            <p className="commits-empty">选择提交查看详情</p>
          )}
        </div>
      </div>
      <dialog
        ref={badgeDialog}
        className="commit-badge-dialog"
        aria-labelledby="commit-badge-title"
      >
        <h2 id="commit-badge-title">做成徽章</h2>
        <img
          alt={`commits in AI sessions ${badgeLabel}`}
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(badgeSvg)}`}
        />
        <p className="commit-note">按当前工作目录的提交记录生成。</p>
        <pre>![commits in AI sessions](.github/adit/badge-commits.svg)</pre>
        {badgeError && (
          <p role="alert" className="error">
            {badgeError}
          </p>
        )}
        <div>
          <a
            className="commit-badge-download"
            download="badge-commits.svg"
            href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(badgeSvg)}`}
          >
            下载 SVG
          </a>
          <button
            onClick={() => {
              void navigator.clipboard
                .writeText(
                  "![commits in AI sessions](.github/adit/badge-commits.svg)",
                )
                .catch(() => setBadgeError("无法复制，请手动复制上方内容。"));
            }}
          >
            复制 Markdown
          </button>
          <button onClick={() => badgeDialog.current?.close()}>关闭</button>
        </div>
      </dialog>
    </section>
  );
}
