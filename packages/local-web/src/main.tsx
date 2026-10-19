import React, { useEffect, useState, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  Folder,
  FolderPlus,
  ChevronRight,
  ArrowLeft,
  RefreshCw,
  Terminal,
  Settings,
  Globe,
  ChartNoAxesCombined,
  MessageSquare,
  GitCommitHorizontal,
  GitPullRequest,
  Share2,
  Moon,
  Sun,
  X,
  ExternalLink,
  Save,
  Pencil,
  ShieldCheck,
  Loader2,
  Trash2,
  UserRound,
} from "lucide-react";
import "./style.css";
import { AditMark } from "./adit-mark";
import { OverviewPage } from "./overview";
import { CommitsPage } from "./commits";

type Workspace = {
  id: string;
  name: string;
  path: string;
  version: number;
  started: boolean;
  providers: string[];
  repositories: string[];
  counts: Record<string, number>;
  gistConfigured: boolean;
  cloud: { enabled: boolean; mode: "manual" | "automatic"; interval: number };
};
type Provider = {
  id: string;
  name: string;
  paths: string[];
  homesSupported: boolean;
  enabled: boolean;
  supported: boolean;
  format: string;
  homes: string[];
  version: number;
};
const providerOrder: Record<string, number> = {
  claude: 0,
  codex: 1,
  "deepseek-tui": 2,
  cursor: 3,
  gemini: 4,
  opencode: 5,
};
type Job = {
  id: string;
  workspaceId: string;
  kind: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  error?: string;
  providers?: Record<string, number>;
  repositories?: { path: string; count: number | null; error?: string }[];
  progress?: { files: number; updated: number };
};
type Schedule = {
  enabled: boolean;
  interval: number;
  version: number;
  nextAt?: string;
};
type State = { workspaces: Workspace[]; schedule: Schedule; jobs: Job[] };
type AccountData = {
  connected: boolean;
  server: string;
  auth: "valid" | "expired" | "disconnected";
  account?: string;
  reachable?: boolean | null;
  checkedAt?: string;
  attempt?: {
    status: string;
    verificationUrl?: string;
    userCode?: string;
    error?: string;
  };
};
const emptyState: State = {
  workspaces: [],
  schedule: { enabled: true, interval: 5, version: 0 },
  jobs: [],
};
async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/local${path}`, {
    method,
    signal,
    headers: { "content-type": "application/json", "x-adit-local": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
const time = (value?: string) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "尚未整理";
const labels: Record<string, string> = {
  queued: "排队中",
  running: "整理中",
  done: "整理完成",
  partial: "部分失败",
  failed: "整理失败",
  interrupted: "整理已中断",
};
function Badge({
  status,
  children,
}: {
  status?: string;
  children?: React.ReactNode;
}) {
  return (
    <span className={`badge ${status || ""}`}>
      {status === "running" && <Loader2 size={12} className="spin" />}
      {children || labels[status || ""] || status}
    </span>
  );
}
function Toggle({
  checked,
  onChange,
  label,
  statusFirst = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  statusFirst?: boolean;
}) {
  return (
    <label className={`toggle-label${statusFirst ? " status-first" : ""}`}>
      <input
        className="switch"
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
      <span>
        {statusFirst
          ? checked
            ? "已启用"
            : "已停用"
          : checked
            ? "已开启"
            : "已关闭"}
      </span>
    </label>
  );
}
function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button className="icon" title={title} aria-label={title} onClick={onClick}>
      {children}
    </button>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const items = Array.from(
          dialog.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]",
          ) || [],
        );
        const first = items[0],
          last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <IconButton title="关闭" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>
        {children}
      </section>
    </div>
  );
}
function Browser({
  initial,
  onSelect,
  onClose,
}: {
  initial: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<{
    path: string;
    parent: string;
    entries: { name: string; path: string }[];
    drives: string[];
  }>();
  const [error, setError] = useState("");
  const [value, setValue] = useState(initial);
  const load = async (path: string) => {
    try {
      setError("");
      const d = await api("/directories/list", "POST", { path });
      setData(d);
      setValue(d.path);
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    void load(initial);
  }, []);
  return (
    <Modal title="选择工作目录" onClose={onClose}>
      <div className="browser-path">
        {!!data?.drives.length && (
          <select
            aria-label="磁盘"
            value={
              data.drives.find((drive) =>
                data.path.toLowerCase().startsWith(drive.toLowerCase()),
              ) || ""
            }
            onChange={(e) => void load(e.target.value)}
          >
            <option value="" disabled>
              选择磁盘
            </option>
            {data.drives.map((drive) => (
              <option key={drive} value={drive}>
                {drive}
              </option>
            ))}
          </select>
        )}
        <input
          aria-label="目录路径"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void load(value);
          }}
        />
        <button onClick={() => void load(value)}>打开</button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="directory-list">
        {data && (
          <button
            disabled={data.parent === data.path}
            onClick={() => void load(data.parent)}
          >
            <ArrowLeft size={15} />
            上一级
          </button>
        )}
        {data?.entries.map((entry) => (
          <button key={entry.path} onClick={() => void load(entry.path)}>
            <Folder size={16} />
            <span>{entry.name}</span>
            <ChevronRight size={14} />
          </button>
        ))}
      </div>
      <footer>
        <button onClick={onClose}>取消</button>
        <button
          className="primary"
          disabled={!data}
          onClick={() => {
            if (data) onSelect(data.path);
          }}
        >
          选择此目录
        </button>
      </footer>
    </Modal>
  );
}
function App() {
  const [state, setState] = useState<State>(emptyState);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [account, setAccount] = useState<AccountData>();
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [route, setRoute] = useState(
    location.pathname === "/" ? "/settings/workspaces" : location.pathname,
  );
  const [busy, setBusy] = useState(false);
  const [dark, setDark] = useState(
    localStorage.getItem("adit-theme") === "dark",
  );
  const [dirty, setDirty] = useState(false);
  const refresh = useCallback(async () => {
    setState(await api("/state"));
  }, []);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const hash = new URLSearchParams(location.hash.slice(1));
        const token = hash.get("token");
        if (token) {
          history.replaceState(null, "", location.pathname);
          await api("/session", "POST", { token });
        }
        await refresh();
        if (alive) setReady(true);
        try {
          const a = await api<AccountData>("/account");
          if (alive) setAccount(a);
        } catch (e) {
          if (alive) setError(String(e));
        }
        try {
          const p = await api<Provider[]>("/providers");
          if (alive) setProviders(p);
        } catch (e) {
          if (alive) setError(String(e));
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => {
      void refresh().catch((e) => setError(String(e)));
    }, 2000);
    return () => clearInterval(timer);
  }, [ready]);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("adit-theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    const pop = () => {
      if (dirty && !confirm("存在未保存的修改，是否离开？")) {
        history.pushState(null, "", route);
        return;
      }
      setDirty(false);
      setRoute(location.pathname);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [dirty, route]);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [dirty]);
  const go = (path: string, discard = false) => {
    if (!discard && dirty && !confirm("存在未保存的修改，是否离开？")) return;
    setDirty(false);
    history.pushState(null, "", path);
    setRoute(path);
    setError("");
  };
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const isOverview = route.startsWith("/overview/");
  const isCommits = route.startsWith("/commits/");
  const isWorkspacePage = isOverview || isCommits;
  const id = route.match(
    /^\/(?:settings\/workspaces|overview|commits)\/([^/]+)$/,
  )?.[1];
  const selected = state.workspaces.find((w) => w.id === id);
  const previousStarted = useRef<Record<string, boolean>>({});
  useEffect(() => {
    if (!ready) return;
    if (location.pathname === "/" && state.workspaces.some((w) => w.started))
      go(`/overview/${state.workspaces.find((w) => w.started)!.id}`);
    if (
      selected?.started &&
      previousStarted.current[selected.id] === false &&
      route.startsWith("/settings/workspaces/") &&
      !dirty
    )
      go(`/overview/${selected.id}`);
    previousStarted.current = Object.fromEntries(
      state.workspaces.map((w) => [w.id, w.started]),
    );
  }, [state.workspaces, ready, route, dirty]);
  const nav = [
    ["workspaces", "工作目录", Folder],
    ["providers", "接入的 Agent", Terminal],
    ["account", "数据云端", Globe],
    ["cli", "ADIT CLI", Terminal],
  ] as const;
  return (
    <>
      <header className="top">
        <a
          className="brand"
          href="/settings/workspaces"
          onClick={(e) => {
            e.preventDefault();
            go("/settings/workspaces");
          }}
        >
          <AditMark />
          <strong>ADIT</strong>
        </a>
        <nav aria-label="主导航">
          {(
            [
              ["概览", ChartNoAxesCombined],
              ["会话", MessageSquare],
              ["提交", GitCommitHorizontal],
              ["分享", Share2],
              ["PR 说明", GitPullRequest],
            ] as const
          ).map(([n, Icon]) => (
            <button
              key={n}
              disabled={
                !["概览", "提交"].includes(n) ||
                !state.workspaces.some((w) => w.started)
              }
              className={
                (n === "概览" && isOverview) || (n === "提交" && isCommits)
                  ? "selected"
                  : ""
              }
              title={
                ["概览", "提交"].includes(n) ? `当前工作目录的${n}` : "尚未开放"
              }
              onClick={() => {
                const w = selected?.started
                  ? selected
                  : state.workspaces.find((w) => w.started);
                if (w) go(`/${n === "提交" ? "commits" : "overview"}/${w.id}`);
              }}
            >
              <Icon size={16} />
              {n}
            </button>
          ))}
          <button
            className={!isWorkspacePage ? "selected" : ""}
            onClick={() => go("/settings/workspaces")}
          >
            <Settings size={16} />
            设置
          </button>
        </nav>
        <div className="top-right">
          {isWorkspacePage && <div id="overview-header-status" />}
          <div className="workspace-picker">
            <Folder size={16} aria-hidden="true" />
            <select
              aria-label="当前工作目录"
              value={selected?.id || ""}
              onChange={(e) => {
                if (e.target.value)
                  go(
                    isWorkspacePage &&
                      state.workspaces.find((w) => w.id === e.target.value)
                        ?.started
                      ? `/${isCommits ? "commits" : "overview"}/${e.target.value}`
                      : `/settings/workspaces/${e.target.value}`,
                  );
              }}
            >
              <option value="">工作目录</option>
              {state.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            {selected && (
              <span className="path" title={selected.path}>
                {selected.path}
              </span>
            )}
          </div>
          <IconButton
            title={dark ? "浅色主题" : "深色主题"}
            onClick={() => setDark(!dark)}
          >
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </IconButton>
        </div>
      </header>
      <div className={`layout${isWorkspacePage ? " overview-layout" : ""}`}>
        {!isWorkspacePage && (
          <aside>
            <h1>设置</h1>
            {nav.map(([key, name, Icon]) => (
              <button
                key={key}
                className={route.includes(`/settings/${key}`) ? "active" : ""}
                aria-current={
                  route.includes(`/settings/${key}`) ? "page" : undefined
                }
                onClick={() => go(`/settings/${key}`)}
              >
                <Icon size={16} />
                {name}
                {key === "account" && account?.connected && (
                  <span className="nav-status">已连接</span>
                )}
              </button>
            ))}
          </aside>
        )}
        <main>
          {error && (
            <div role="alert" className="error banner">
              <span>{error}</span>
              <IconButton title="关闭提示" onClick={() => setError("")}>
                <X size={15} />
              </IconButton>
            </div>
          )}
          {!ready ? (
            <div className="empty">
              <Settings size={32} />
              <h2>{error ? "无法连接本地服务" : "正在连接"}</h2>
              {error ? (
                <p>请通过 adit serve 打开此页面。</p>
              ) : (
                <Loader2 className="spin" />
              )}
            </div>
          ) : isCommits && selected ? (
            <CommitsPage key={selected.id} workspace={selected} api={api} />
          ) : isOverview && selected ? (
            <OverviewPage
              key={selected.id}
              workspace={selected}
              jobs={state.jobs}
              api={api}
              onSettings={() => go(`/settings/workspaces/${selected.id}`)}
            />
          ) : (
            <fieldset
              disabled={busy}
              className={`page-content${route === "/settings/workspaces" ? " workspace-home" : id ? " workspace-detail" : ""}`}
            >
              {route === "/settings/workspaces" && (
                <>
                  <div className="page-heading">
                    <div>
                      <h2>工作目录</h2>
                    </div>
                    <button
                      className="primary"
                      onClick={() => go("/settings/workspaces/new")}
                    >
                      <FolderPlus size={15} />
                      添加工作目录
                    </button>
                  </div>
                  <p className="workspace-summary">
                    管理这台电脑上的工作目录，选择一个目录查看和调整它的设置。
                  </p>
                  <div className="table-scroll">
                    <table className="workspace-table">
                      <colgroup>
                        <col style={{ width: "40%" }} />
                        <col style={{ width: "7.5%" }} />
                        <col style={{ width: "7.5%" }} />
                        <col style={{ width: "19%" }} />
                        <col style={{ width: "19%" }} />
                        <col style={{ width: "7%" }} />
                      </colgroup>
                      <thead>
                        <tr>
                          <th scope="col">名字 / 路径</th>
                          <th scope="col">仓库</th>
                          <th scope="col">会话</th>
                          <th scope="col">整理状态</th>
                          <th scope="col">云端同步</th>
                          <th scope="col" aria-label="操作" />
                        </tr>
                      </thead>
                      <tbody>
                        {state.workspaces.map((w) => {
                          const job = state.jobs.find(
                            (j) =>
                              j.workspaceId === w.id && j.kind === "collect",
                          );
                          return (
                            <tr key={w.id}>
                              <td>
                                <button
                                  className="link"
                                  onClick={() =>
                                    go(`/settings/workspaces/${w.id}`)
                                  }
                                >
                                  <Folder size={16} />
                                  {w.name}
                                </button>
                                <div className="path" title={w.path}>
                                  {w.path}
                                </div>
                              </td>
                              <td>{w.repositories.length}</td>
                              <td>
                                {w.started
                                  ? Object.entries(w.counts)
                                      .filter(
                                        ([p]) =>
                                          w.providers.includes(p) ||
                                          [
                                            "claude-ai",
                                            "chatgpt",
                                            "gemini-apps",
                                          ].includes(p),
                                      )
                                      .reduce((n, [, v]) => n + v, 0)
                                  : "还没有整理"}
                              </td>
                              <td>
                                <Badge
                                  status={w.started ? "done" : job?.status}
                                >
                                  {w.started
                                    ? "整理完成"
                                    : job
                                      ? undefined
                                      : "未整理"}
                                </Badge>
                              </td>
                              <td>
                                {w.cloud.enabled ? (
                                  <>
                                    <span>
                                      {w.cloud.mode === "manual"
                                        ? "手动"
                                        : `自动 · 每 ${w.cloud.interval} 分钟`}
                                    </span>
                                    <small>推送未接入</small>
                                  </>
                                ) : (
                                  "未开启"
                                )}
                              </td>
                              <td>
                                <button
                                  className="text-action"
                                  title="查看详情"
                                  onClick={() =>
                                    go(`/settings/workspaces/${w.id}`)
                                  }
                                >
                                  查看详情
                                  <ChevronRight size={14} />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                        {state.workspaces.length === 0 && (
                          <tr className="workspace-empty-row">
                            <td colSpan={6}>
                              <div className="workspace-empty">
                                <Folder size={28} aria-hidden="true" />
                                <span>暂无工作目录</span>
                              </div>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <p className="repo-hint">
                    共 {state.workspaces.length} 个工作目录 ·
                    各目录的数据与设置独立管理。
                  </p>
                </>
              )}
              {id && (
                <WorkspaceEditor
                  key={id}
                  workspace={selected}
                  fresh={id === "new"}
                  providers={providers}
                  account={account}
                  state={state}
                  go={go}
                  act={act}
                  setDirty={setDirty}
                  onSaved={(saved) =>
                    setState((s) => ({
                      ...s,
                      workspaces: [
                        ...s.workspaces.filter((w) => w.id !== saved.id),
                        saved,
                      ],
                    }))
                  }
                />
              )}
              {route === "/settings/providers" && (
                <div className="provider-page">
                  <div className="page-heading">
                    <h2>接入的 Agent</h2>
                    <div className="provider-refresh">
                      <IconButton
                        title="重新检查"
                        onClick={() =>
                          void act(async () =>
                            setProviders(await api("/providers")),
                          )
                        }
                      >
                        <RefreshCw size={15} />
                      </IconButton>
                    </div>
                  </div>
                  <p className="provider-summary">
                    选择要读取和整理哪些 Agent
                    的会话记录，并查看它们的记录目录。
                  </p>
                  <div className="provider-list">
                    {[...providers]
                      .sort(
                        (a, b) =>
                          (providerOrder[a.id] ?? 6) -
                          (providerOrder[b.id] ?? 6),
                      )
                      .map((p) => (
                        <ProviderRow
                          key={`${p.id}:${p.version}`}
                          provider={p}
                          act={act}
                          onSaved={(saved) =>
                            setProviders((ps) =>
                              ps.map((x) =>
                                x.id === p.id ? { ...x, ...saved } : x,
                              ),
                            )
                          }
                        />
                      ))}
                  </div>
                  {!providers.length && (
                    <p className="muted">整理引擎尚未就绪</p>
                  )}
                  <ConversationImport workspaces={state.workspaces} act={act} />
                </div>
              )}
              {route === "/settings/account" && (
                <Account act={act} data={account} onChange={setAccount} />
              )}
              {route === "/settings/cli" && <Runtime state={state} act={act} />}
            </fieldset>
          )}
        </main>
      </div>
    </>
  );
}
type Act = (fn: () => Promise<void>) => Promise<void>;
function ConversationImport({
  workspaces,
  act,
}: {
  workspaces: Workspace[];
  act: Act;
}) {
  const [provider, setProvider] = useState("claude-ai");
  const [workspaceId, setWorkspaceId] = useState("");
  const [path, setPath] = useState("");
  const [result, setResult] = useState("");
  const [unassigned, setUnassigned] = useState<
    { provider: string; id: string; title: string; messages: number }[]
  >([]);
  const [sessionId, setSessionId] = useState("");
  return (
    <section className="provider-homes">
      <h3>导入会话</h3>
      <p className="muted">将导出文件中的会话导入指定工作目录。</p>
      <label>
        来源
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="claude-ai">Claude.ai</option>
          <option value="chatgpt">ChatGPT</option>
          <option value="gemini-apps">Gemini Apps</option>
        </select>
      </label>
      <label>
        工作目录
        <select
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value)}
        >
          <option value="">选择工作目录</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        导出文件路径
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={
            provider === "gemini-apps"
              ? "Takeout HTML 文件路径"
              : "JSON 导出文件路径"
          }
        />
      </label>
      <button
        disabled={!workspaceId || !path.trim()}
        onClick={() =>
          void act(async () => {
            setResult("");
            const imported = await api<{ imported: number }>(
              "/imports",
              "POST",
              { provider, workspaceId, path },
            );
            setResult(`已导入 ${imported.imported} 个会话`);
          })
        }
      >
        导入会话
      </button>
      {result && <p role="status">{result}</p>}
      <details
        onToggle={(e) => {
          if (e.currentTarget.open)
            void act(async () =>
              setUnassigned(await api("/sessions/unassigned")),
            );
        }}
      >
        <summary>未归属会话</summary>
        {!unassigned.length ? (
          <p className="muted">暂无未归属会话</p>
        ) : (
          <>
            <label>
              会话
              <select
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
              >
                <option value="">选择会话</option>
                {unassigned.map((s) => (
                  <option
                    key={JSON.stringify([s.provider, s.id])}
                    value={JSON.stringify([s.provider, s.id])}
                  >
                    {s.provider} · {s.title} · {s.messages} 条消息
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={!workspaceId || !sessionId}
              onClick={() =>
                void act(async () => {
                  const [provider, id] = JSON.parse(sessionId) as string[];
                  await api("/sessions/assign", "POST", {
                    provider,
                    id,
                    workspaceId,
                  });
                  setUnassigned(await api("/sessions/unassigned"));
                  setSessionId("");
                  setResult("已归属到所选工作目录");
                })
              }
            >
              归属到所选工作目录
            </button>
          </>
        )}
      </details>
    </section>
  );
}
function WorkspaceEditor({
  workspace,
  fresh,
  providers,
  account,
  state,
  go,
  act,
  setDirty,
  onSaved,
}: {
  workspace?: Workspace;
  fresh: boolean;
  providers: Provider[];
  account?: AccountData;
  state: State;
  go: (path: string, discard?: boolean) => void;
  act: Act;
  setDirty: (v: boolean) => void;
  onSaved: (workspace: Workspace) => void;
}) {
  const [form, setForm] = useState<Workspace>(
    workspace || {
      id: "",
      name: "",
      path: "",
      version: 0,
      started: false,
      providers: [],
      repositories: [],
      counts: {},
      gistConfigured: false,
      cloud: { enabled: false, mode: "manual", interval: 5 },
    },
  );
  const [editing, setEditing] = useState(fresh);
  const [browser, setBrowser] = useState(false);
  const [cloudEditing, setCloudEditing] = useState(false);
  const [discovery, setDiscovery] = useState("");
  const [providerLimit, setProviderLimit] = useState(6);
  useEffect(() => setProviderLimit(6), [form.path]);
  const [token, setToken] = useState("");
  const [gist, setGist] = useState(workspace?.gistConfigured || false);
  useEffect(() => {
    if (workspace && !editing) setForm(workspace);
  }, [workspace?.version, workspace?.started, editing]);
  const job = discovery
    ? state.jobs.find((j) => j.id === discovery)
    : state.jobs.find(
        (j) =>
          j.workspaceId === workspace?.id &&
          j.kind === "collect" &&
          (!workspace.started || j.status === "done"),
      );
  const collectionRunning = state.jobs.some(
    (j) =>
      j.workspaceId === workspace?.id &&
      j.kind === "collect" &&
      ["queued", "running"].includes(j.status),
  );
  const discoveryDone = state.jobs.find(
    (j) => j.id === discovery && ["done", "partial"].includes(j.status),
  );
  useEffect(() => {
    if (discoveryDone && fresh) {
      setForm((f) => ({
        ...f,
        providers: providers
          .filter(
            (p) => p.enabled && (discoveryDone.providers?.[p.id] || 0) > 0,
          )
          .map((p) => p.id),
        repositories: (discoveryDone.repositories || [])
          .filter((r) => !r.error)
          .map((r) => r.path),
      }));
      setDirty(true);
    }
  }, [discoveryDone?.id, discoveryDone?.status]);
  const change = (next: Partial<Workspace>) => {
    setForm((f) => ({ ...f, ...next }));
    setDirty(true);
  };
  const scan = async (path = form.path) => {
    const result = await api<Job>("/discoveries", "POST", { path });
    setDiscovery(result.id);
  };
  const save = async (collect = false) => {
    const result = await api<Workspace>(
      fresh ? "/workspaces" : `/workspaces/${form.id}`,
      fresh ? "POST" : "PATCH",
      form,
    );
    setDirty(false);
    const savedWorkspace = { ...form, ...result };
    setForm(savedWorkspace);
    onSaved(savedWorkspace);
    setDiscovery("");
    setEditing(false);
    if (collect) await api(`/workspaces/${result.id}/collect`, "POST", {});
    if (fresh) go(`/settings/workspaces/${result.id}`, true);
  };
  if (!fresh && !workspace) return <p>工作目录不存在</p>;
  const knownRepos =
    job?.repositories ||
    form.repositories.map((path) => ({ path, count: null }));
  const cursorPending =
    !!job?.error &&
    [
      "cursor-ide: Cursor IDE transcript contains an unfinished bubble; retry on the next collection",
      "cursor-ide: Cursor IDE transcript has missing bubbles; previous archive retained",
    ].includes(job.error);
  const providerCounts = job?.providers || form.counts;
  const orderedProviders = [...providers].sort(
    (a, b) =>
      Number((providerCounts[b.id] || 0) > 0) -
        Number((providerCounts[a.id] || 0) > 0) ||
      Number(form.providers.includes(b.id)) -
        Number(form.providers.includes(a.id)),
  );
  return (
    <>
      <button className="back" onClick={() => go("/settings/workspaces")}>
        <ArrowLeft size={14} />
        全部工作目录
      </button>
      <div className="page-heading">
        <div>
          <h2>工作目录</h2>
          {workspace?.started && !discovery ? (
            <Badge status="done" />
          ) : job ? (
            cursorPending && job.status === "partial" ? (
              <span className="muted">部分记录待重试</span>
            ) : (
              <Badge status={job.status} />
            )
          ) : (
            <span className="muted">
              {workspace?.started ? "已配置" : "还没有整理"}
            </span>
          )}
        </div>
        {!editing && (
          <button
            onClick={() => {
              setForm(workspace || form);
              setEditing(true);
            }}
          >
            <Pencil size={14} />
            编辑
          </button>
        )}
        {editing && workspace?.started && (
          <button
            className="primary"
            disabled={!form.path || !form.name.trim()}
            onClick={() => void act(() => save())}
          >
            保存
          </button>
        )}
      </div>
      <p className="page-description">
        ADIT 会读取这台电脑上各个 Agent
        自己保存的对话记录，把在这个目录里发生的会话和提交整理到一起，之后在任何一个
        Agent 里都能查。选好目录后，概览、会话和提交才有内容。
      </p>
      <section className="settings-rows">
        <div className="field">
          <label htmlFor="workspace-name">名字</label>
          <input
            id="workspace-name"
            value={form.name}
            disabled={!editing}
            onChange={(e) => change({ name: e.target.value })}
            maxLength={200}
          />
        </div>
        <div className="field">
          <label htmlFor="workspace-path">目录</label>
          <div className="input-actions">
            <input
              id="workspace-path"
              value={form.path}
              disabled={!editing}
              onChange={(e) => change({ path: e.target.value })}
            />
            {editing && (
              <>
                <IconButton title="选择目录" onClick={() => setBrowser(true)}>
                  <Folder size={16} />
                </IconButton>
                <button
                  disabled={!form.path}
                  onClick={() => void act(() => scan())}
                >
                  <RefreshCw size={14} />
                  发现
                </button>
              </>
            )}
          </div>
        </div>
      </section>
      {job && (
        <div className="progress-row">
          {cursorPending && job.status === "partial" ? (
            <span className="muted">部分记录待重试</span>
          ) : (
            <Badge status={job.status} />
          )}
          {job.progress && (
            <span>
              已检查 {job.progress.files} 个文件，更新 {job.progress.updated} 个
            </span>
          )}
          <span className="muted">{time(job.endedAt || job.startedAt)}</span>
          {job.error && (
            <span className={cursorPending ? "muted" : "error"}>
              {cursorPending
                ? "Cursor IDE 有会话记录尚未写入完整，将在下次整理时重试；其他来源可正常整理。"
                : job.error}
            </span>
          )}
        </div>
      )}
      <section className="workspace-setting">
        <h3>Git 仓库</h3>
        <div className="workspace-options">
          <div className="selection-summary">
            {form.repositories.length} 个已选
          </div>
          {knownRepos.length ? (
            knownRepos.map((r) => (
              <label className="selection-row" key={r.path}>
                <input
                  type="checkbox"
                  disabled={!editing}
                  checked={form.repositories.includes(r.path)}
                  onChange={(e) =>
                    change({
                      repositories: e.target.checked
                        ? [...form.repositories, r.path]
                        : form.repositories.filter((p) => p !== r.path),
                    })
                  }
                />
                <span className="path" title={r.path}>
                  {r.path}
                </span>
                <span className="muted">
                  {r.count === null ? "未统计" : `${r.count} 个提交`}
                </span>
              </label>
            ))
          ) : (
            <p className="muted">
              {job?.status === "running" ? "正在发现仓库" : "尚未发现仓库"}
            </p>
          )}
        </div>
      </section>
      <section className="workspace-setting">
        <h3>会话记录</h3>
        <div className="workspace-options">
          <div className="selection-summary">
            {form.providers.length} 个来源已选
          </div>
          <p className="repo-hint">
            只读取并整理勾选来源在这个目录里的会话记录。
          </p>
          {orderedProviders.slice(0, providerLimit).map((p) => (
            <label className="selection-row" key={p.id}>
              <input
                type="checkbox"
                disabled={!editing || !p.enabled}
                checked={form.providers.includes(p.id)}
                onChange={(e) =>
                  change({
                    providers: e.target.checked
                      ? [...form.providers, p.id]
                      : form.providers.filter((id) => id !== p.id),
                  })
                }
              />
              <span>{p.name}</span>
              <span className="muted">
                {!p.supported
                  ? "暂未支持"
                  : !p.enabled
                    ? "已停用"
                    : (providerCounts[p.id] || 0) > 0
                      ? `${providerCounts[p.id]} 个会话`
                      : "未发现"}
              </span>
            </label>
          ))}
          {providerLimit < orderedProviders.length && (
            <button
              className="provider-load-more"
              onClick={() => setProviderLimit((limit) => limit + 6)}
            >
              加载更多（剩余 {orderedProviders.length - providerLimit} 个来源）
            </button>
          )}
          {providerLimit > 6 && (
            <button
              className="provider-load-more"
              onClick={() => setProviderLimit(6)}
            >
              收起
            </button>
          )}
        </div>
      </section>
      <section className="workspace-setting workspace-sharing">
        <h3>会话分享</h3>
        <div className="workspace-options">
          <p className="repo-hint">
            配置 GitHub 令牌，用于将本工作目录的会话发布为 GitHub Gist。
          </p>
          <div className="session-share-status">
            <span>状态</span>
            <Badge status={gist ? "done" : ""}>
              {gist ? "已配置" : "未配置"}
            </Badge>
          </div>
          <div className="input-actions session-share-token">
            <input
              type="password"
              autoComplete="new-password"
              aria-label="GitHub 令牌"
              placeholder="ghp_..."
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={fresh}
            />
            <button
              className="primary"
              disabled={fresh || !token.trim()}
              onClick={() =>
                void act(async () => {
                  await api(`/workspaces/${form.id}/gist-credential`, "PUT", {
                    token,
                  });
                  setToken("");
                  setGist(true);
                })
              }
            >
              保存令牌
            </button>
          </div>
        </div>
      </section>
      <section className="workspace-setting workspace-cloud">
        <h3>云端存储</h3>
        <div className="workspace-options">
          <div className="directory-cloud-line">
            <span className="label">状态</span>
            <Badge>{form.cloud.enabled ? "推送未接入" : "未开启"}</Badge>
            <span className="muted">
              {account?.account
                ? `通过云端账号 ${account.account} 存储`
                : account?.connected
                  ? "云端账号已连接"
                  : "云端账号未连接"}
            </span>
          </div>
          <div className="directory-cloud-line">
            <span className="label">云端项目</span>
            <span>尚未关联</span>
            <span className="muted">首次推送时自动创建</span>
            <button
              className="text-action cloud-row-action"
              disabled
              title="尚未关联云端项目"
            >
              在云端查看
            </button>
          </div>
          <div className="directory-cloud-line">
            <span className="label">同步方式</span>
            <span>
              {form.cloud.mode === "automatic"
                ? `自动同步 · ${form.cloud.interval === 60 ? "每小时" : `每 ${form.cloud.interval} 分钟`}`
                : "手动同步"}
            </span>
            <button
              className="text-action cloud-row-action"
              aria-expanded={cloudEditing}
              onClick={() => {
                setCloudEditing(!cloudEditing);
                setEditing(true);
              }}
            >
              调整频率
            </button>
          </div>
          <div className="directory-cloud-line">
            <span className="label">最近同步</span>
            <span>尚未同步</span>
          </div>
          <div className="directory-cloud-line">
            <span className="label">下次同步</span>
            <span>未安排</span>
          </div>
          <div hidden={!cloudEditing}>
            <fieldset disabled={!editing}>
              <div className="field">
                <span>开启云端存储</span>
                <Toggle
                  label="开启云端存储"
                  checked={form.cloud.enabled}
                  onChange={(enabled) =>
                    change({ cloud: { ...form.cloud, enabled } })
                  }
                />
              </div>
              <div className="field">
                <span>同步方式</span>
                <div className="segments">
                  {(["manual", "automatic"] as const).map((mode) => (
                    <label
                      key={mode}
                      className={form.cloud.mode === mode ? "active" : ""}
                    >
                      <input
                        type="radio"
                        name="cloud-mode"
                        checked={form.cloud.mode === mode}
                        onChange={() =>
                          change({ cloud: { ...form.cloud, mode } })
                        }
                      />
                      {mode === "manual" ? "手动同步" : "自动同步新记录"}
                    </label>
                  ))}
                </div>
              </div>
              <div className="field">
                <label htmlFor="cloud-frequency">同步频率</label>
                <select
                  id="cloud-frequency"
                  disabled={form.cloud.mode !== "automatic"}
                  value={form.cloud.interval}
                  onChange={(e) =>
                    change({
                      cloud: {
                        ...form.cloud,
                        interval: Number(e.target.value),
                      },
                    })
                  }
                >
                  {[5, 15, 30, 60].map((n) => (
                    <option key={n} value={n}>
                      {n === 60 ? "每小时" : `每 ${n} 分钟`}
                    </option>
                  ))}
                </select>
              </div>
            </fieldset>
          </div>
          <p className="repo-hint">
            尚未同步，本机记录保留。配置仅保存在本机，云端推送暂未接入。
          </p>
          <div className="directory-cloud-actions">
            <button className="primary" disabled title="云端推送暂未接入">
              立即同步
            </button>
            <button disabled title="云端推送暂未接入">
              暂停自动同步
            </button>
          </div>
        </div>
      </section>
      <p className="workspace-local-note">
        <ShieldCheck size={14} aria-hidden="true" />
        {form.cloud.enabled
          ? "当前目录已保存云端存储配置，云端推送暂未接入，记录仅保存在本机。"
          : "当前目录尚未开启云端存储，记录仅保存在本机；连接账号不会自动上传。"}
      </p>
      {!workspace?.started && (
        <footer className="form-footer workspace-start">
          <button
            className="primary"
            disabled={
              !form.path ||
              !form.name.trim() ||
              (!form.providers.length && !form.repositories.length) ||
              collectionRunning ||
              ["queued", "running"].includes(job?.status || "")
            }
            onClick={(event) => {
              event.currentTarget.closest("main")?.scrollTo({
                top: 0,
                behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
                  .matches
                  ? "instant"
                  : "smooth",
              });
              void act(async () => {
                if (editing) await save(true);
                else await api(`/workspaces/${form.id}/collect`, "POST", {});
              });
            }}
          >
            开始整理
          </button>
          <span className="muted">大约需要 1 分钟</span>
        </footer>
      )}
      {browser && (
        <Browser
          initial={form.path}
          onClose={() => setBrowser(false)}
          onSelect={(path) => {
            change({
              path,
              name: form.name || path.split(/[\\/]/).pop() || path,
            });
            setBrowser(false);
            void act(() => scan(path));
          }}
        />
      )}
    </>
  );
}
function ProviderRow({
  provider: p,
  act,
  onSaved,
}: {
  provider: Provider;
  act: Act;
  onSaved: (p: Provider) => void;
}) {
  const [home, setHome] = useState("");
  const primaryHomes = ["claude", "codex"].includes(p.id);
  const [showHomes, setShowHomes] = useState(
    primaryHomes || p.homes.length > 0,
  );
  const save = (next: Partial<Provider>) =>
    void act(async () =>
      onSaved(await api(`/providers/${p.id}`, "PATCH", { ...p, ...next })),
    );
  return (
    <section className="provider">
      <div className="provider-details">
        <div className="provider-name-row">
          <h3>{p.name}</h3>
          {p.homesSupported && !primaryHomes && (
            <button
              className={`icon provider-config${showHomes ? " expanded" : ""}`}
              title={`${p.name} 备用主目录`}
              aria-label={`${p.name} 备用主目录设置`}
              aria-expanded={showHomes}
              aria-controls={`homes-${p.id}`}
              onClick={() => setShowHomes(!showHomes)}
            >
              <Settings size={14} />
            </button>
          )}
        </div>
        <div className="provider-paths">
          {p.paths.map((path) => (
            <div key={path} className="path" title={path}>
              {path}
            </div>
          ))}
          {!p.paths.length && p.supported && (
            <span className="muted">未配置目录</span>
          )}
        </div>
        {p.homesSupported && (
          <div
            className="provider-homes"
            id={`homes-${p.id}`}
            hidden={!showHomes}
          >
            <label className="provider-homes-title" htmlFor={`home-${p.id}`}>
              备用主目录
            </label>
            <div>
              {p.homes.map((path) => (
                <div className="input-actions" key={path}>
                  <span className="path">{path}</span>
                  <IconButton
                    title="移除备用主目录"
                    onClick={() => {
                      if (confirm("移除这个备用主目录配置？不会删除原始文件。"))
                        save({ homes: p.homes.filter((h) => h !== path) });
                    }}
                  >
                    <X size={14} />
                  </IconButton>
                </div>
              ))}
              <div className="input-actions provider-add">
                <input
                  id={`home-${p.id}`}
                  aria-label={`${p.name} 备用主目录`}
                  placeholder="备用主目录路径"
                  value={home}
                  onChange={(e) => setHome(e.target.value)}
                />
                <button
                  disabled={!home.trim()}
                  onClick={() =>
                    void act(async () => {
                      onSaved(
                        await api(`/providers/${p.id}`, "PATCH", {
                          ...p,
                          homes: [...p.homes, home],
                        }),
                      );
                      setHome("");
                    })
                  }
                >
                  添加主目录
                </button>
              </div>
              <p className="provider-home-count">
                使用了多个账号或自定义存储位置时，在这里添加其他主目录。
              </p>
            </div>
          </div>
        )}
      </div>
      {p.supported ? (
        <Toggle
          label={`${p.name} 启用`}
          checked={p.enabled}
          onChange={(enabled) => save({ enabled })}
          statusFirst
        />
      ) : (
        <Badge>暂未支持</Badge>
      )}
    </section>
  );
}
function Account({
  act,
  data,
  onChange: setData,
}: {
  act: Act;
  data?: AccountData;
  onChange: (data: AccountData) => void;
}) {
  const [server, setServer] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const current = await api<AccountData>("/account");
        if (!alive) return;
        setData(current);
        setServer(current.server);
        if (current.connected) {
          setChecking(true);
          const checked = await api<AccountData>("/account/check", "POST", {});
          if (alive) setData(checked);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setChecking(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (data?.attempt?.status !== "pending") return;
    let alive = true;
    let loading = false;
    const timer = setInterval(() => {
      if (loading) return;
      loading = true;
      void (async () => {
        try {
          let next = await api<AccountData>("/account");
          if (next.attempt?.status === "done")
            next = await api<AccountData>("/account/check", "POST", {});
          if (alive) {
            setData(next);
            setServer(next.server);
          }
        } catch (e) {
          if (alive) setError(e instanceof Error ? e.message : String(e));
        } finally {
          loading = false;
        }
      })();
    }, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [data?.attempt?.status]);
  const check = async () => {
    setChecking(true);
    setError("");
    try {
      setData(await api<AccountData>("/account/check", "POST", {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };
  if (!data)
    return error ? (
      <p role="alert" className="error">
        {error}
      </p>
    ) : (
      <Loader2 className="spin" />
    );
  const pending = data.attempt?.status === "pending";
  const connected =
    data.connected && data.auth === "valid" && data.reachable === true;
  const lastChecked = data.checkedAt
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(data.checkedAt))
    : "尚未检查";
  return (
    <div className="account-page">
      <div className="page-heading">
        <div>
          <h2>数据云端</h2>
          <Badge status={data.connected ? "done" : ""}>
            {data.connected ? "已连接" : "未连接"}
          </Badge>
        </div>
      </div>
      <p className="page-description">
        管理这台电脑与云端账号的连接。各工作目录是否上传及同步频率，在工作目录详情中设置。
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <section className="settings-rows" aria-busy={checking}>
        {!data.connected && (
          <div className="field">
            <label htmlFor="server-url">服务地址</label>
            <input
              id="server-url"
              value={server}
              onChange={(e) => setServer(e.target.value)}
            />
          </div>
        )}
        <div className="field">
          <span>云端账号</span>
          <div className="account-value">
            <span className="cloud-avatar" aria-hidden="true">
              {data.account ? (
                Array.from(data.account)[0].toUpperCase()
              ) : (
                <UserRound size={14} />
              )}
            </span>
            <span className="account-name">
              {data.account || (data.connected ? "账号名称未返回" : "未登录")}
            </span>
            {data.connected && (
              <Badge status={data.auth === "valid" ? "done" : "partial"}>
                {data.auth === "valid" ? "已登录" : "授权待更新"}
              </Badge>
            )}
          </div>
        </div>
        <div className="field">
          <span>本机账号连接</span>
          <div className="account-value">
            <Badge
              status={
                connected ? "done" : data.reachable === false ? "failed" : ""
              }
            >
              {!data.connected
                ? "未连接"
                : checking
                  ? "检查中"
                  : connected
                    ? "连接正常"
                    : data.auth === "expired"
                      ? "需要重新授权"
                      : data.reachable === false
                        ? "连接异常"
                        : "待检查"}
            </Badge>
          </div>
        </div>
        <div className="field">
          <span>账号授权</span>
          <Badge
            status={
              data.auth === "valid"
                ? "done"
                : data.auth === "expired"
                  ? "partial"
                  : ""
            }
          >
            {data.auth === "valid"
              ? "有效"
              : data.auth === "expired"
                ? "需要刷新授权"
                : "未连接"}
          </Badge>
        </div>
        <div className="field">
          <span>云端服务</span>
          <Badge
            status={
              data.reachable === true
                ? "done"
                : data.reachable === false
                  ? "failed"
                  : ""
            }
          >
            {checking
              ? "检查中"
              : data.reachable === undefined || data.reachable === null
                ? "未检查"
                : data.reachable
                  ? "可连接"
                  : "连接失败"}
          </Badge>
        </div>
        <div className="field">
          <span>最近检查</span>
          <div className="account-value">
            <span>{lastChecked}</span>
            <button
              className="text-action account-check"
              disabled={checking || pending}
              onClick={() => void check()}
            >
              {checking ? "检查中" : "重新检查"}
            </button>
          </div>
        </div>
      </section>
      {data.attempt?.status === "pending" && (
        <section>
          <h3>等待浏览器授权</h3>
          {data.attempt.verificationUrl && (
            <>
              <a
                className="button"
                href={data.attempt.verificationUrl}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={14} />
                打开授权页面
              </a>
              <code className="device-code">{data.attempt.userCode}</code>
            </>
          )}
          <button
            onClick={() =>
              void act(async () =>
                setData(await api("/account/login", "DELETE", {})),
              )
            }
          >
            取消授权
          </button>
        </section>
      )}
      {data.attempt?.error && <p className="error">{data.attempt.error}</p>}
      <footer className="account-actions">
        <button
          className="primary"
          onClick={() =>
            void act(async () => {
              await api("/account/login", "POST", { server });
              setData(await api("/account"));
            })
          }
          disabled={pending || checking || !server.trim()}
        >
          {data.connected ? "切换账号" : "连接云端账号"}
        </button>
        {data.connected && (
          <button
            disabled={checking || pending}
            onClick={() => {
              if (confirm("断开当前账号？本地历史和配置将保留。"))
                void act(async () =>
                  setData(await api("/account/logout", "POST", {})),
                );
            }}
          >
            断开连接
          </button>
        )}
        <a
          className="text-action"
          href={data.server}
          target="_blank"
          rel="noreferrer"
        >
          打开云端
        </a>
      </footer>
      <p className="account-footnote">
        连接账号不会自动上传数据；云端推送暂未接入。
      </p>
    </div>
  );
}
function Runtime({ state, act }: { state: State; act: Act }) {
  const [runtime, setRuntime] = useState<any>();
  useEffect(() => {
    void api("/runtime").then(setRuntime);
  }, []);
  const save = (next: Partial<Schedule>) =>
    void act(async () => {
      await api("/collection/schedule", "PATCH", {
        ...state.schedule,
        ...next,
      });
    });
  const jobs = state.jobs.filter((j) => j.kind === "collect");
  const active = jobs.find((j) => ["queued", "running"].includes(j.status));
  const last = jobs.find((j) => j.endedAt);
  return (
    <>
      <div className="page-heading">
        <h2>ADIT CLI</h2>
        <button
          onClick={() =>
            void act(async () => setRuntime(await api("/runtime")))
          }
        >
          <RefreshCw size={14} />
          重新检查
        </button>
      </div>
      <p className="page-description">
        查看这台电脑上的 ADIT 安装情况，管理本地数据采集，以及各 Agent
        的接入状态。
      </p>
      <section className="settings-rows">
        <div className="field">
          <span>当前状态</span>
          <Badge status={runtime?.cli?.path ? "done" : ""}>
            {!runtime
              ? "检测中"
              : runtime.cli?.path
                ? "已安装 · 可调用"
                : "PATH 中未找到"}
          </Badge>
        </div>
        <div className="field">
          <span>当前版本</span>
          <span>
            {runtime?.version || "检测中"}
            <small>当前后台服务版本</small>
          </span>
        </div>
        <div className="field">
          <span>安装位置</span>
          <code className="path">
            {runtime?.cli?.path || runtime?.cli?.error || "检测中"}
          </code>
        </div>
        <div className="field">
          <span>最近检查</span>
          <span>{runtime?.checkedAt ? time(runtime.checkedAt) : "检测中"}</span>
        </div>
      </section>
      <section>
        <h3>
          本地数据采集 <span className="muted">所有已添加的工作目录</span>
        </h3>
        <p className="repo-hint">自动读取本地新增的会话和提交记录。</p>
        <div className="field">
          <span>自动采集</span>
          <div className="field-value">
            <Toggle
              label="自动采集"
              checked={state.schedule.enabled}
              onChange={(enabled) => save({ enabled })}
            />
            <span className="muted">关闭后仅手动采集</span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="collection-frequency">采集频率</label>
          <div className="field-value">
            <select
              id="collection-frequency"
              value={state.schedule.interval}
              onChange={(e) => save({ interval: Number(e.target.value) })}
            >
              {[1, 5, 15, 30].map((n) => (
                <option value={n} key={n}>
                  每 {n} 分钟
                </option>
              ))}
            </select>
            <span className="muted">默认每 5 分钟</span>
          </div>
        </div>
        <div className="field">
          <span>运行状态</span>
          <Badge status={active?.status}>
            {active
              ? undefined
              : state.schedule.enabled
                ? "等待采集"
                : "自动采集已关闭"}
          </Badge>
        </div>
        <div className="field">
          <span>上次采集</span>
          <span>
            {time(last?.endedAt)} {last && <Badge status={last.status} />}
          </span>
        </div>
        <div className="field">
          <span>下次采集</span>
          <span>
            {state.schedule.nextAt ? time(state.schedule.nextAt) : "未安排"}
          </span>
        </div>
        <footer>
          <button
            disabled={!!active || !state.workspaces.some((w) => w.started)}
            onClick={() =>
              void act(async () => {
                await api("/collection/run", "POST", {});
              })
            }
          >
            <RefreshCw size={14} />
            立即采集
          </button>
          <span className="muted">
            仅更新本机数据；云端上传在工作目录中设置。
          </span>
        </footer>
      </section>
      <section>
        <h3>Skill 安装情况</h3>
        <p className="repo-hint">
          Skill 全局安装，所有工作目录共用，让 Agent 知道如何使用 ADIT
          查询历史、记忆、报告和任务。
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Skill</th>
                <th>Claude Code</th>
                <th>Codex / Agents</th>
              </tr>
            </thead>
            <tbody>
              {runtime?.skills?.map((s: any) => (
                <tr key={s.name}>
                  <td>
                    <span>
                      {{
                        "adit-history": "历史会话与提交",
                        "adit-memory": "个人与项目记忆",
                        "adit-reports": "工作报告与用量",
                        "adit-tasks": "任务管理",
                      }[s.name as string] || s.name}
                    </span>
                    <small>
                      <code>{s.name}</code>
                    </small>
                  </td>
                  {s.platforms.map((p: any) => (
                    <td key={p.platform} title={p.path}>
                      <Badge status={p.status === "installed" ? "done" : ""}>
                        {
                          {
                            installed: "已安装",
                            modified: "内容有修改",
                            missing: "未安装",
                            inaccessible: "无法访问",
                          }[p.status as string]
                        }
                      </Badge>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
