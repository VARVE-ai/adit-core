import { AgentLabel } from "./agent-label";
import { WorkspacePicker } from "./workspace-picker";
import { t, locale, useLanguage, systemMessage } from "./i18n";
import React, { useEffect, useState, useCallback, useRef, lazy, Suspense } from "react";
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
  KeyRound,
  ChartNoAxesCombined,
  MessageSquare,
  GitCommitHorizontal,
  GitBranch,
  GitPullRequest,
  Share2,
  Moon,
  Sun,
  Languages,
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
import { CloudSyncStatus, type CloudSyncSummary } from "./overview-cloud-push";
import { CommitsPage } from "./commits";
import { AchievementsPage } from "./achievements";
import { ProfileCardsPage } from "./profile-cards";
import { InspectionPage } from "./inspection";
import { ic } from "./inspection-copy";
import { ac } from "./achievement-copy";
import { LocalSyncStatus } from "./local-sync-status";
import {CollectionRowProgress,progressCount,progressSum,type RowProgress} from "./collection-progress";
import { SharingPage } from "./sharing";
import { PrDescriptionsPage } from "./pr-descriptions";
import "./app-header.css";
const SessionsPage = lazy(() => import("./sessions").then(module => ({ default: module.SessionsPage })));

type RepositoryInfo = { path: string; count: number | null; error?: string; skipReason?: "missing-git-email" };
type Workspace = {
  id: string;
  name: string;
  path: string;
  directoryAvailable?: boolean;
  version: number;
  started: boolean;
  providers: string[];
  repositories: string[];
  repositoryInfo?: RepositoryInfo[];
  counts: Record<string, number>;
  gistConfigured: boolean;
  achievements?: { unread: number };
  cloud: { enabled: boolean; mode: "manual" | "automatic"; interval: number };
  cloudSync?: CloudSyncSummary & { startedAt?: string; endedAt?: string; events?: number; commits?: number; error?: string; warnings?: string[]; nextAt?: string | null; serverProjectId?: string };
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
  pending?: Record<string, number>;
  phase?: "git" | "sessions" | "inspection" | "analysis" | "achievements";
  sourceProgress?:Record<string,RowProgress>;
  repositoryProgress?:Record<string,RowProgress>;
  activeRepository?:string;
  repositories?: RepositoryInfo[];
  progress?: { files: number; updated: number };
};
type Schedule = {
  enabled: boolean;
  interval: number;
  version: number;
  nextAt?: string;
};
type LoginStartup = { enabled: boolean; supported: boolean; version: number };
type State = {
  workspaces: Workspace[];
  schedule: Schedule;
  jobs: Job[];
  startup?: LoginStartup;
};
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
    ? new Date(value).toLocaleString(locale(), {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : t("尚未整理");
const labels = (): Record<string, string> => ({
  queued: t("排队中"),
  running: t("整理中"),
  done: t("整理完成"),
  partial: t("部分失败"),
  failed: t("整理失败"),
  interrupted: t("整理已中断"),
});
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
      {children || labels()[status || ""] || status}
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
            ? t("已启用")
            : t("已停用")
          : checked
            ? t("已开启")
            : t("已关闭")}
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
          <IconButton title={t("关闭")} onClick={onClose}>
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
    <Modal title={t("选择工作目录")} onClose={onClose}>
      <div className="browser-path">
        {!!data?.drives.length && (
          <select
            aria-label={t("磁盘")}
            value={
              data.drives.find((drive) =>
                data.path.toLowerCase().startsWith(drive.toLowerCase()),
              ) || ""
            }
            onChange={(e) => void load(e.target.value)}
          >
            <option value="" disabled>
              {t("选择磁盘")}
            </option>
            {data.drives.map((drive) => (
              <option key={drive} value={drive}>
                {drive}
              </option>
            ))}
          </select>
        )}
        <input
          aria-label={t("目录路径")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void load(value);
          }}
        />
        <button onClick={() => void load(value)}>{t("打开")}</button>
      </div>
      {error && (
        <p role="alert" className="error">
          {systemMessage(error)}
        </p>
      )}
      <div className="directory-list">
        {data && (
          <button
            disabled={data.parent === data.path}
            onClick={() => void load(data.parent)}
          >
            <ArrowLeft size={15} />
            {t("上一级")}
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
        <button onClick={onClose}>{t("取消")}</button>
        <button
          className="primary"
          disabled={!data}
          onClick={() => {
            if (data) onSelect(data.path);
          }}
        >
          {t("选择此目录")}
        </button>
      </footer>
    </Modal>
  );
}
export function App() {
  const [language, setLanguage] = useLanguage();
  const [state, setState] = useState<State>(emptyState);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [account, setAccount] = useState<AccountData>();
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [route, setRoute] = useState(
    location.pathname === "/" ? "/settings/workspaces" : location.pathname,
  );
  const [busy, setBusy] = useState(false);
  const [deletingWorkspace, setDeletingWorkspace] = useState<Workspace>();
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deletePreview,setDeletePreview] = useState<{sharedSessions:number;sharedRepositories:number}>();
  useEffect(() => {
    setDeletePreview(undefined);
    if (!deletingWorkspace) return;
    const controller=new AbortController();
    void api<{sharedSessions:number;sharedRepositories:number}>(`/workspaces/${deletingWorkspace.id}/deletion-preview`,"GET",undefined,controller.signal)
      .then(setDeletePreview).catch(e=>{if(!controller.signal.aborted)setDeleteError(String(e));});
    return ()=>controller.abort();
  },[deletingWorkspace?.id]);
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
  const fastProgress=route.startsWith("/settings/workspaces/")&&state.jobs.some(job=>["queued","running"].includes(job.status));
  useEffect(() => {
    if (!ready) return;
    let pending=false;
    const timer = setInterval(() => {
      if(pending)return;pending=true;
      void refresh().catch((e) => setError(String(e))).finally(()=>{pending=false;});
    }, fastProgress?500:2000);
    return () => clearInterval(timer);
  }, [ready,fastProgress]);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("adit-theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    const pop = () => {
      if (dirty && !confirm(t("存在未保存的修改，是否离开？"))) {
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
    if (!discard && dirty && !confirm(t("存在未保存的修改，是否离开？")))
      return;
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
  const isSessions = route.startsWith("/sessions/");
  const isShareReview = route.startsWith("/share-review/");
  const isSharing = route.startsWith("/share/");
  const isPrCreate = route.startsWith("/pr-create/");
  const isPr = route.startsWith("/pr/");
  const isInspection = route.startsWith("/inspection/");
  const isAchievements = route.startsWith("/achievements/");
  const isProfileCards = route.startsWith("/profile-cards/");
  const isBadgeExamples = route.startsWith("/badge-examples/");
  const isExportPage = isAchievements || isProfileCards || isBadgeExamples;
  const isWorkspacePage = isOverview || isSessions || isCommits || isExportPage || isInspection || isShareReview || isSharing || isPr || isPrCreate;
  useEffect(() => {
    document.title = `ADIT Local · ${isSharing || isShareReview ? t("分享") : isPr || isPrCreate ? t("PR 说明") : isInspection ? ic("历史对话体检") : isProfileCards ? ac("档案卡和徽章") : isBadgeExamples ? ac("应用示例") : isAchievements ? ac("成就") : isOverview ? t("概览") : isSessions ? t("会话") : isCommits ? t("提交") : t("设置")}`;
  }, [route, language]);
  const id = route.match(
    /^\/(?:settings\/workspaces|overview|sessions|commits|achievements|profile-cards|badge-examples|inspection|share|share-review|pr|pr-create)\/([^/?]+)(?:\?.*)?$/,
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
    ["workspaces", t("工作目录"), Folder],
    ["providers", t("接入的 Agent"), Terminal],
    ["account", t("数据云端"), Globe],
    ["cli", "ADIT CLI", Terminal],
  ] as const;
  return (
    <>
      <header className="top">
        <a
          className="brand"
          aria-label="ADIT Local"
          href="/settings/workspaces"
          onClick={(e) => {
            e.preventDefault();
            go("/settings/workspaces");
          }}
        >
          <AditMark />
          <strong>ADIT Local</strong>
        </a>
        <nav aria-label={t("主导航")}>
          {(
            [
              ["overview", t("概览"), ChartNoAxesCombined],
              ["sessions", t("会话"), MessageSquare],
              ["commits", t("提交"), GitCommitHorizontal],
              ["share", t("分享"), Share2],
              ["pr", t("PR 说明"), GitPullRequest],
            ] as const
          ).map(([key, n, Icon]) => (
            <button
              key={key}
              disabled={
                !state.workspaces.some((w) => w.started)
              }
              className={
                (key === "overview" && (isOverview || isExportPage || isInspection)) ||
                (key === "sessions" && (isSessions || isShareReview)) ||
                (key === "commits" && isCommits) ||
                (key === "share" && isSharing) ||
                (key === "pr" && (isPr || isPrCreate))
                  ? "selected"
                  : ""
              }
              title={
                t("当前工作目录的{0}", n)
              }
              onClick={() => {
                const w = selected?.started
                  ? selected
                  : state.workspaces.find((w) => w.started);
                if (w) go(`/${key}/${w.id}`);
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
            {t("设置")}
          </button>
        </nav>
        <div className="top-right">
          {selected?.started && selected.directoryAvailable !== false && (
            <LocalSyncStatus
              key={selected.id}
              workspaceId={selected.id}
              workspaceName={selected.name}
              jobs={state.jobs}
              pending={busy}
              onRefresh={() => void act(async () => {
                await api(`/workspaces/${selected.id}/collect`, "POST");
              })}
            />
          )}
          {selected && <CloudSyncStatus key={`${selected.id}:${route}`} workspaceName={selected.name}
            enabled={selected.cloud.enabled} sync={selected.cloudSync} accountState={account?.auth} pending={busy}
            onSettings={() => go(`/settings/workspaces/${selected.id}`)} onAccount={() => go("/settings/account")}
            onPush={account?.auth === "valid" && selected.cloud.enabled ? () => void act(async () => {
              await api(`/workspaces/${selected.id}/sync`, "POST", {});
            }) : undefined} />}
          <IconButton
            title={dark ? t("浅色主题") : t("深色主题")}
            onClick={() => setDark(!dark)}
          >
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </IconButton>
          <button type="button" className="icon language-switch"
            title={t(language === "en" ? "切换为中文" : "切换为英文")}
            aria-label={t(language === "en" ? "切换为中文" : "切换为英文")}
            onClick={() => setLanguage(language === "en" ? "zh" : "en")}>
            <Languages size={16} aria-hidden="true" />
          </button>
          <WorkspacePicker workspaces={state.workspaces} selectedId={selected?.id}
            onSelect={(workspaceId) => go(
              isWorkspacePage && state.workspaces.find(w => w.id === workspaceId)?.started
                ? `/${isSharing || isShareReview ? "share" : isPr || isPrCreate ? "pr" : isInspection ? "inspection" : isSessions ? "sessions" : isCommits ? "commits" : isAchievements ? "achievements" : isProfileCards ? "profile-cards" : isBadgeExamples ? "badge-examples" : "overview"}/${workspaceId}`
                : `/settings/workspaces/${workspaceId}`,
            )} />
        </div>
      </header>
      <div
        className={`layout${isWorkspacePage ? " overview-layout" : ""}${isOverview ? " overview-dashboard" : ""}`}
      >
        {!isWorkspacePage && (
          <aside aria-label={t("设置")}>
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
                  <span className="nav-status">{t("已连接")}</span>
                )}
              </button>
            ))}
          </aside>
        )}
        <main>
          {selected?.directoryAvailable === false && (
            <div role="status" className="directory-warning">
              <Folder size={16} aria-hidden="true" />
              <span>{t("工作目录不可用，请在设置中更新目录。")}</span>
              {isWorkspacePage && <button className="link" onClick={() => go(`/settings/workspaces/${selected.id}`)}>{t("更新目录")}</button>}
            </div>
          )}
          {error && (
            <div role="alert" className="error banner">
              <span>{systemMessage(error)}</span>
              <IconButton title={t("关闭提示")} onClick={() => setError("")}>
                <X size={15} />
              </IconButton>
            </div>
          )}
          {!ready ? (
            <div className="empty">
              <Settings size={32} />
              <h2>{error ? t("无法连接本地服务") : t("正在连接")}</h2>
              {error ? (
                <p>{t("请通过 adit serve 打开此页面。")}</p>
              ) : (
                <Loader2 className="spin" />
              )}
            </div>
          ) : (isSharing || isShareReview) && selected ? (
            <SharingPage key={`${selected.id}:${isShareReview}:${route}`} workspace={selected} api={api} review={isShareReview} onNavigate={go} />
          ) : (isPr || isPrCreate) && selected ? (
            <PrDescriptionsPage key={`${selected.id}:${isPrCreate}:${route}`} workspace={selected} api={api} create={isPrCreate} onNavigate={go} />
          ) : (isProfileCards || isBadgeExamples) && selected ? (
            <ProfileCardsPage key={selected.id} workspace={selected} api={api} tab={isBadgeExamples ? "badge-examples" : "profile-cards"} onOverview={() => go(`/overview/${selected.id}`)} onTab={(tab) => go(`/${tab}/${selected.id}`)}/>
          ) : isInspection && selected ? (
            <InspectionPage key={selected.id} workspace={selected} api={api} onOverview={() => go(`/overview/${selected.id}`)}/>
          ) : isAchievements && selected ? (
            <AchievementsPage key={selected.id} workspace={selected} api={api} onOverview={() => go(`/overview/${selected.id}`)} onTab={(tab) => go(`/${tab}/${selected.id}`)} />
          ) : isCommits && selected ? (
            <CommitsPage key={selected.id} workspace={selected} api={api} />
          ) : isSessions && selected ? (
            <Suspense fallback={<div className="empty"><Loader2 className="spin" /></div>}>
            <SessionsPage key={selected.id} workspace={selected} api={api} revision={state.jobs.find(job=>job.workspaceId===selected.id&&job.kind==='collect'&&['done','partial'].includes(job.status))?.id} onCommit={(commit) => go(`/commits/${selected.id}?${new URLSearchParams({repository:commit.repository,sha:commit.sha})}`)} onShare={(session) => go(`/share-review/${selected.id}?${new URLSearchParams({provider:session.provider,session:session.id})}`)} />
            </Suspense>
          ) : isOverview && selected ? (
            <OverviewPage
              key={selected.id}
              workspace={selected}
              jobs={state.jobs}
              api={api}
              onSettings={() => go(`/settings/workspaces/${selected.id}`)}
              onAchievements={() => go(`/achievements/${selected.id}`)}
              onInspection={() => go(`/inspection/${selected.id}`)}
              onProfileCards={() => go(`/profile-cards/${selected.id}`)}
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
                      <h2>{t("工作目录")}</h2>
                    </div>
                    <button
                      className="primary"
                      onClick={() => go("/settings/workspaces/new")}
                    >
                      <FolderPlus size={15} />
                      {t("添加工作目录")}
                    </button>
                  </div>
                  <p className="page-description">
                    {t(
                      "管理这台电脑上的工作目录，选择一个目录查看和调整它的设置。",
                    )}
                  </p>
                  <div className="workspace-list-scroll">
                    <ul className="workspace-list" aria-label={t("工作目录")}>
                      {state.workspaces.map((w) => {
                        const job = state.jobs.find(
                          (j) => j.workspaceId === w.id && j.kind === "collect",
                        );
                        return (
                          <li className="workspace-list-row" key={w.id}>
                            <button
                              className="link workspace-list-name"
                              title={w.name}
                              onClick={() => go(`/settings/workspaces/${w.id}`)}
                            >
                              <Folder size={16} />
                              <span>{w.name}</span>
                            </button>
                            <span className="path workspace-list-path" title={w.path}>
                              <bdi dir="ltr">{w.path}</bdi>
                            </span>
                            {w.directoryAvailable === false && (
                              <span className="directory-unavailable">{t("目录不可用")}</span>
                            )}
                            <span className="workspace-list-stat">
                              {w.repositories.length} <span>{t("仓库")}</span>
                            </span>
                            <span className="workspace-list-stat">
                              {w.started ? (
                                <>
                                  {Object.entries(w.counts)
                                    .filter(
                                      ([p]) => w.providers.includes(p) ||
                                        ["claude-ai", "chatgpt", "gemini-apps"].includes(p),
                                    )
                                    .reduce((n, [, v]) => n + v, 0)}
                                  {" "}<span>{t("会话")}</span>
                                </>
                              ) : t("还没有整理")}
                            </span>
                            <Badge status={w.started ? "done" : job?.status}>
                              {w.started ? t("整理完成") : job ? undefined : t("未整理")}
                            </Badge>
                            <span className="workspace-list-cloud">
                              <span>{t("云端同步")}</span>
                              {w.cloud.enabled ? (
                                <>
                                  <span>
                                    {w.cloud.mode === "manual"
                                      ? t("手动")
                                      : t("自动 · 每 {0} 分钟", w.cloud.interval)}
                                  </span>
                                  <span>·</span>
                                  <span>{t(w.cloudSync?.status === "done" ? "同步完成" : w.cloudSync?.status === "failed" ? "同步失败" : w.cloudSync?.status === "partial" ? "部分记录待同步" : ["queued", "running"].includes(w.cloudSync?.status || "") ? "正在同步新记录…" : "尚未同步")}</span>
                                </>
                              ) : <span>{t("未开启")}</span>}
                            </span>
                            <div className="workspace-row-actions">
                              <button className="text-action" onClick={() => go(`/settings/workspaces/${w.id}`)}>
                                {t("查看详情")}<ChevronRight size={14} />
                              </button>
                            </div>
                          </li>
                        );
                      })}
                      {state.workspaces.length === 0 && (
                        <li className="workspace-empty">
                          <Folder size={28} aria-hidden="true" />
                          <span>{t("暂无工作目录")}</span>
                        </li>
                      )}
                    </ul>
                  </div>
                  <p className="repo-hint">
                    {t("共")} {state.workspaces.length}{" "}
                    {t("个工作目录 · 各目录的数据与设置独立管理。")}
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
              {route.startsWith("/settings/workspaces/") && selected && (
                <footer className="workspace-delete-footer">
                  <button className="workspace-delete" onClick={() => {
                    setDeleteError("");
                    setDeletingWorkspace(selected);
                  }}>
                    <Trash2 size={15} aria-hidden="true" />
                    {t("删除工作目录")}
                  </button>
                </footer>
              )}
              {route === "/settings/providers" && (
                <div className="provider-page">
                  <div className="page-heading">
                    <h2>{t("接入的 Agent")}</h2>
                    <button
                      onClick={() =>
                        void act(async () =>
                          setProviders(await api("/providers")),
                        )
                      }
                    >
                      <RefreshCw size={14} />
                      {t("重新检查")}
                    </button>
                  </div>
                  <p className="page-description">
                    {t(
                      "选择要读取和整理哪些 Agent 的会话记录，并查看它们的记录目录。",
                    )}
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
                    <p className="muted">{t("整理引擎尚未就绪")}</p>
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
      {deletingWorkspace && (
        <Modal title={t("删除工作目录")} onClose={() => {
          if (!deletePending) setDeletingWorkspace(undefined);
        }}>
          <p>{t("删除项目“{0}”？", deletingWorkspace.name)}</p>
          <p className="workspace-delete-path">{deletingWorkspace.path}</p>
          <p className="muted">{t("将删除此项目在本机 ADIT 中保存的会话、提交、统计、分析结果、分享记录和配置，并停止自动整理与同步。尚未同步的本地修改也会删除。")}</p>
          <p className="muted">{t("云端数据和已发布的分享不会删除。项目文件、Git 仓库和 Agent 原始记录会保留。")}</p>
          {deletePreview && (deletePreview.sharedSessions>0 || deletePreview.sharedRepositories>0) && <p className="muted">{t("其他项目仍在使用的共享记录会保留，仅解除与此项目的关联。")}</p>}
          {deleteError && <p role="alert" className="danger">{systemMessage(deleteError)}</p>}
          <footer>
            <button disabled={deletePending} onClick={() => setDeletingWorkspace(undefined)}>{t("取消")}</button>
            <button className="workspace-delete-confirm" disabled={deletePending || !deletePreview} onClick={async () => {
              if (deletePending) return;
              setDeletePending(true);
              setDeleteError("");
              try {
                await api(`/workspaces/${deletingWorkspace.id}`, "DELETE", { version: deletingWorkspace.version });
                try { localStorage.removeItem(`adit-profile-v1:${deletingWorkspace.id}`); } catch { /* Browser storage may be unavailable. */ }
                setState(s => ({ ...s,
                  workspaces: s.workspaces.filter(w => w.id !== deletingWorkspace.id),
                  jobs: s.jobs.filter(j => j.workspaceId !== deletingWorkspace.id),
                }));
                setDeletingWorkspace(undefined);
                go("/settings/workspaces", true);
                await refresh().catch(e => setError(e instanceof Error ? e.message : String(e)));
              } catch (e) {
                setDeleteError(e instanceof Error ? e.message : String(e));
              } finally {
                setDeletePending(false);
              }
            }}>{deletePending ? t("正在删除") : t("删除本地项目")}</button>
          </footer>
        </Modal>
      )}
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
  const [result, setResult] = useState<number | "assigned" | null>(null);
  const [unassigned, setUnassigned] = useState<
    { provider: string; id: string; title: string; messages: number }[]
  >([]);
  const [sessionId, setSessionId] = useState("");
  return (
    <section className="provider-homes">
      <h3>{t("导入会话")}</h3>
      <p className="muted">{t("将导出文件中的会话导入指定工作目录。")}</p>
      <div className="field">
        <label htmlFor="import-provider">{t("来源")}</label>
        <select id="import-provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="claude-ai">Claude.ai</option>
          <option value="chatgpt">ChatGPT</option>
          <option value="gemini-apps">Gemini Apps</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="import-workspace">{t("工作目录")}</label>
        <select
          id="import-workspace"
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value)}
        >
          <option value="">{t("选择工作目录")}</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="import-path">{t("导出文件路径")}</label>
        <input
          id="import-path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={
            provider === "gemini-apps"
              ? t("Takeout HTML 文件路径")
              : t("JSON 导出文件路径")
          }
        />
      </div>
      <button
        disabled={!workspaceId || !path.trim()}
        onClick={() =>
          void act(async () => {
            setResult(null);
            const imported = await api<{ imported: number }>(
              "/imports",
              "POST",
              { provider, workspaceId, path },
            );
            setResult(imported.imported);
          })
        }
      >
        {t("导入会话")}
      </button>
      {result !== null && (
        <p role="status">
          {result === "assigned"
            ? t("已归属到所选工作目录")
            : t("已导入 {0} 个会话", result)}
        </p>
      )}
      <details
        onToggle={(e) => {
          if (e.currentTarget.open)
            void act(async () =>
              setUnassigned(await api("/sessions/unassigned")),
            );
        }}
      >
        <summary>{t("未归属会话")}</summary>
        {!unassigned.length ? (
          <p className="muted">{t("暂无未归属会话")}</p>
        ) : (
          <>
            <label>
              {t("会话")}
              <select
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
              >
                <option value="">{t("选择会话")}</option>
                {unassigned.map((s) => (
                  <option
                    key={JSON.stringify([s.provider, s.id])}
                    value={JSON.stringify([s.provider, s.id])}
                  >
                    {s.provider} · {s.title} · {s.messages} {t("条消息")}
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
                  setResult("assigned");
                })
              }
            >
              {t("归属到所选工作目录")}
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
  const [cloudDraft, setCloudDraft] = useState<Workspace["cloud"] | null>(null);
  const [cloudSaving, setCloudSaving] = useState(false);
  const [workspaceDirty, setWorkspaceDirty] = useState(false);
  const savedCloud = workspace?.cloud ?? form.cloud;
  const cloudForm = fresh ? form.cloud : cloudDraft ?? savedCloud;
  const cloudDirty = !!cloudDraft && (cloudDraft.enabled !== savedCloud.enabled || cloudDraft.mode !== savedCloud.mode || cloudDraft.interval !== savedCloud.interval);
  useEffect(() => setDirty(workspaceDirty || cloudDirty), [workspaceDirty, cloudDirty]);
  const sync = state.workspaces.find(w => w.id === workspace?.id)?.cloudSync;
  const syncing = sync?.status === "queued" || sync?.status === "running";
  const [startupBusy, setStartupBusy] = useState(false);
  const startup = state.startup ?? {
    enabled: false,
    supported: false,
    version: 0,
  };
  useEffect(() => {
    if (!startup.enabled) {
      setForm((f) => ({ ...f, cloud: { ...f.cloud, mode: "manual" } }));
      setCloudDraft((draft) => draft ? { ...draft, mode: "manual" } : null);
    }
  }, [startup.enabled, startup.version]);
  const changeStartup = async (enabled: boolean) => {
    setStartupBusy(true);
    try {
      await act(async () => {
        await api("/startup", "PATCH", { enabled, version: startup.version });
        if (!enabled) {
          // The global change also pauses saved settings for this directory.
          const current = form.id
            ? await api<Workspace>(`/workspaces/${form.id}`)
            : undefined;
          setForm((f) => ({
            ...f,
            version: current?.version ?? f.version,
            cloud: { ...f.cloud, mode: "manual" },
          }));
        }
      });
    } finally {
      setStartupBusy(false);
    }
  };
  const [discovery, setDiscovery] = useState("");
  const discoverySelection = useRef({id:"",repositories:false,providers:false,choices:new Map<string,boolean>()});
  const [providerLimit, setProviderLimit] = useState(6);
  useEffect(() => setProviderLimit(6), [form.path]);
  const [token, setToken] = useState("");
  const [gist, setGist] = useState(workspace?.gistConfigured || false);
  const [gistImporting, setGistImporting] = useState(false);
  const [gistAccount, setGistAccount] = useState("");
  const [gistImportError, setGistImportError] = useState("");
  useEffect(() => {
    if (workspace && !editing) setForm(workspace);
  }, [workspace?.version, workspace?.started, workspace?.directoryAvailable, editing]);
  const job = discovery
    ? state.jobs.find((j) => j.id === discovery)
    : state.jobs.find(j=>j.workspaceId===workspace?.id && j.kind==="collect" && ["queued","running"].includes(j.status)) || state.jobs.find(
        (j) =>
          j.workspaceId === workspace?.id &&
          j.kind === "collect",
      );
  const collectionRunning = state.jobs.some(
    (j) =>
      j.workspaceId === workspace?.id &&
      j.kind === "collect" &&
      ["queued", "running"].includes(j.status),
  );
  const firstCollection=useRef<string|null>(null);
  useEffect(()=>{
    if(!workspace?.started&&job?.kind==="collect"&&["queued","running"].includes(job.status))firstCollection.current=job.id;
    if(workspace?.started&&job?.status==="done"&&firstCollection.current===job.id&&!editing&&!discovery){firstCollection.current=null;go(`/overview/${workspace.id}`);}
  },[workspace?.started,job?.id,job?.status,editing,discovery]);
  useEffect(() => {
    if (job?.id === discovery && fresh) {
      if(discoverySelection.current.id!==discovery)discoverySelection.current={id:discovery,repositories:false,providers:false,choices:new Map()};
      const selection=discoverySelection.current;
      const applyRepositories=!selection.repositories && job.repositories!==undefined;
      const applyProviders=!selection.providers && ["done","partial"].includes(job.status);
      if(!applyRepositories&&!applyProviders)return;
      selection.repositories ||= applyRepositories;selection.providers ||= applyProviders;
      setForm((f) => ({
        ...f,
        providers: applyProviders ? providers
          .filter(
            (p) => p.enabled && (selection.choices.get(p.id) ?? (job.providers?.[p.id] || 0) > 0),
          )
          .map((p) => p.id) : f.providers,
        repositories: applyRepositories ? (job.repositories || [])
          .filter((r) => !r.error && !r.skipReason)
          .map((r) => r.path) : f.repositories,
      }));
      setWorkspaceDirty(true);
    }
  }, [job?.id, job?.status, job?.repositories, discovery, fresh]);
  const change = (next: Partial<Workspace>) => {
    if(next.path!==undefined&&next.path!==form.path)setDiscovery("");
    if(next.providers&&discovery)for(const p of providers)if(next.providers.includes(p.id)!==form.providers.includes(p.id))discoverySelection.current.choices.set(p.id,next.providers.includes(p.id));
    setForm((f) => ({ ...f, ...next }));
    setWorkspaceDirty(true);
  };
  const changeCloud = (cloud: Workspace["cloud"]) => {
    if (fresh) change({ cloud });
    else setCloudDraft(cloud);
  };
  const closeCloudSettings = () => {
    setCloudDraft(null);
    setCloudEditing(false);
  };
  const persistCloudSettings = async (cloud: Workspace["cloud"]) => {
    if (!workspace) return;
    setCloudSaving(true);
    try {
      const saved = await api<Workspace>(`/workspaces/${workspace.id}`, "PATCH", { version: workspace.version, cloud });
      setForm((f) => ({ ...f, version: saved.version, cloud: saved.cloud }));
      onSaved(saved);
      return saved;
    } finally { setCloudSaving(false); }
  };
  const saveCloudSettings = async () => {
    await persistCloudSettings(cloudForm);
    closeCloudSettings();
  };
  const changeCloudEnabled = async (enabled: boolean) => {
    if (fresh) { change({ cloud: { ...form.cloud, enabled } }); return; }
    const saved = await persistCloudSettings({ ...savedCloud, enabled });
    if (saved) setCloudDraft(draft => draft ? { ...draft, enabled: saved.cloud.enabled } : null);
  };
  const scan = async (path = form.path) => {
    const result = await api<Job>("/discoveries", "POST", { path });
    setDiscovery(result.id);
  };
  const save = async (collect = false, navigate = true) => {
    const result = await api<Workspace>(
      fresh ? "/workspaces" : `/workspaces/${form.id}`,
      fresh ? "POST" : "PATCH",
      form,
    );
    setWorkspaceDirty(false);
    const savedWorkspace = { ...form, ...result };
    setForm(savedWorkspace);
    onSaved(savedWorkspace);
    setDiscovery("");
    setEditing(false);
    if (collect) await api(`/workspaces/${result.id}/collect`, "POST", {});
    if (fresh && navigate) go(`/settings/workspaces/${result.id}`, true);
    return savedWorkspace;
  };
  const startCloudSync = async () => {
    // The shared sync executor already collects and analyzes before uploading.
    // A new directory only needs registration here, never a second collector.
    const target = fresh ? await save(false, false) : workspace!;
    try { await api(`/workspaces/${target.id}/sync`, "POST", {}); }
    finally {
      // Registration remains valid even if starting sync fails; retries must
      // use that saved identity instead of attempting to register it again.
      if (fresh) go(`/settings/workspaces/${target.id}`, true);
    }
  };
  if (!fresh && !workspace) return <p>{t("工作目录不存在")}</p>;
  const syncBlockedReason = !savedCloud.enabled ? t("请先开启云端存储。")
    : !account ? t("正在读取云端账号状态…")
    : account.auth === "expired" ? t("云端登录已失效，请重新登录。")
    : account.auth !== "valid" ? t("请先连接云端账号。")
    : fresh && (!form.name.trim() || !form.path.trim()) ? t("请先填写工作目录的名称和路径。")
    : fresh && !form.providers.length && !form.repositories.length ? t("请至少选择一个 Git 仓库或会话来源。")
    : fresh && ["queued", "running"].includes(job?.status || "") ? t("请等待发现完成后再同步。")
    : workspace?.directoryAvailable === false ? t("工作目录不可用，请在设置中更新目录。") : "";
  const knownRepos: RepositoryInfo[] = [...new Map([
    ...form.repositories.map(path=>({path,count:null as number|null})),
    ...(form.path === workspace?.path ? workspace.repositoryInfo || [] : []),
    ...(job?.repositories || []).filter(r => discovery || form.repositories.includes(r.path) || r.path.replaceAll("\\","/").toLowerCase().startsWith(form.path.replaceAll("\\","/").replace(/\/$/,"").toLowerCase()+"/")),
  ].map(r=>[r.path,r])).values()];
  const cursorPending =
    !!job?.error &&
    [
      "cursor-ide: Cursor IDE transcript contains an unfinished bubble; retry on the next collection",
      "cursor-ide: Cursor IDE transcript has missing bubbles; previous archive retained",
    ].includes(job.error);
  const providerCounts = job?.providers || form.counts;
  const showCollectionProgress=!editing&&job?.kind==="collect"&&!!(job.sourceProgress||job.repositoryProgress);
  const progressActive=!!job&&["queued","running"].includes(job.status);
  const selectedRepos=knownRepos.filter(r=>form.repositories.includes(r.path));
  const repositorySummary=progressSum(selectedRepos.filter(r=>!r.skipReason).map(r=>job?.repositoryProgress?.[r.path]));
  const sessionSummary=progressSum(form.providers.map(id=>job?.sourceProgress?.[id]));
  const collectionStage=job?.phase==="sessions"?t("正在读取会话记录…"):job?.phase==="git"?t("正在读取 Git 提交…"):job?.phase==="inspection"?t("正在检查敏感信息…"):job?.phase==="analysis"?t("正在比对提交来源…"):job?.phase==="achievements"?t("正在更新概览和成就…"):t("等待整理");
  const discoveryLabel = job?.kind === "discover"
    ? ["running","queued"].includes(job.status) ? t("发现中") : job.status === "done" ? t("发现完成") : job.status === "partial" ? t("发现完成，部分来源未能读取") : t("发现已中断")
    : undefined;
  const orderedProviders = [...providers].sort(
    (a, b) =>
      Number((providerCounts[b.id] || 0) > 0) -
        Number((providerCounts[a.id] || 0) > 0) ||
      Number(!!job?.pending?.[b.id]) - Number(!!job?.pending?.[a.id]) ||
      Number(form.providers.includes(b.id)) -
        Number(form.providers.includes(a.id)),
  );
  return (
    <>
      <button className="back" onClick={() => go("/settings/workspaces")}>
        <ArrowLeft size={14} />
        {t("全部工作目录")}
      </button>
      <div className="page-heading">
        <div>
          <h2>{t("工作目录")}</h2>
          {workspace?.started && !discovery ? (
            <Badge status="done" />
          ) : job ? (
            cursorPending && job.status === "partial" ? (
              <span className="muted">{t("部分记录待重试")}</span>
            ) : (
              <Badge status={job.status}>{discoveryLabel || (showCollectionProgress&&progressActive?t("正在整理"):undefined)}</Badge>
            )
          ) : (
            <span className="muted">
              {workspace?.started ? t("已配置") : t("还没有整理")}
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
            {t("编辑")}
          </button>
        )}
        {editing && workspace?.started && (
          <button
            className="primary"
            disabled={!form.path || !form.name.trim() || collectionRunning}
            onClick={() => void act(async () => { await save(); })}
          >
            {t("保存")}
          </button>
        )}
      </div>
      <p className="page-description">
        {showCollectionProgress&&progressActive&&!workspace?.started?t("已经整理好的会话可以先看，剩下的会在后台继续，全部整理完后直接进入概览。"):t(
          "ADIT 会读取这台电脑上各个 Agent 自己保存的对话记录，把在这个目录里发生的会话和提交整理到一起，之后在任何一个 Agent 里都能查。选好目录后，概览、会话和提交才有内容。",
        )}
      </p>
      <section className="settings-rows">
        <div className="field">
          <label htmlFor="workspace-name">{t("名字")}</label>
          <input
            id="workspace-name"
            value={form.name}
            disabled={!editing}
            onChange={(e) => change({ name: e.target.value })}
            maxLength={200}
          />
        </div>
        <div className="field">
          <label htmlFor="workspace-path">{t("目录")}</label>
          <div className="input-actions">
            <input
              id="workspace-path"
              value={form.path}
              disabled={!editing}
              onChange={(e) => change({ path: e.target.value })}
            />
            {editing && (
              <>
                <IconButton
                  title={t("选择目录")}
                  onClick={() => setBrowser(true)}
                >
                  <Folder size={16} />
                </IconButton>
                <button
                  disabled={!form.path || (job?.kind === "discover" && ["queued","running"].includes(job.status))}
                  onClick={() => void act(() => scan())}
                >
                  <RefreshCw size={14} />
                  {t("发现")}
                </button>
              </>
            )}
          </div>
          {!fresh && editing && <p className="repo-hint">{t("目录改名或移动后，在这里选择新目录并保存。项目身份和已有记录会保留，已选仓库按原相对位置更新。")}</p>}
        </div>
      </section>
      {job && (!showCollectionProgress || job.error || (progressActive&&(["inspection","achievements"].includes(job.phase||"")||(job.phase==="analysis"&&!job.activeRepository)))) && (
        <div className="progress-row">
          {cursorPending && job.status === "partial" ? (
            <span className="muted">{t("部分记录待重试")}</span>
          ) : (
            <Badge status={job.status}>{discoveryLabel}</Badge>
          )}
          {job.kind === "discover" ? (
            <span>{["queued","running"].includes(job.status)
              ? job.phase === "sessions" ? t("Git 仓库已显示，正在读取会话元信息…") : t("正在发现仓库")
              : t("完整正文解析和分析将在“开始整理”时执行。")}</span>
          ) : showCollectionProgress ? progressActive?<span>{collectionStage}</span>:null : job.progress && (
            <span>
              {t("已检查")} {job.progress.files} {t("个文件，更新")}{" "}
              {job.progress.updated} {t("个")}
            </span>
          )}
          <span className="muted">{time(job.endedAt || job.startedAt)}</span>
          {job.error && (
            <span className={cursorPending ? "muted" : "error"}>
              {cursorPending
                ? t(
                    "Cursor IDE 有会话记录尚未写入完整，将在下次整理时重试；其他来源可正常整理。",
                  )
                : systemMessage(job.error)}
            </span>
          )}
        </div>
      )}
      <section className="workspace-setting">
        <h3>{t("Git 仓库")}</h3>
        <div className="workspace-options">
          <div className={`selection-summary${showCollectionProgress?" collection-summary":""}`}>
            {showCollectionProgress?<><span>{t("比对 {0} 个仓库的提交来源",form.repositories.length)}</span><span>{progressCount(repositorySummary,"commits")}</span></>:<>{form.repositories.length} {t("个已选")}</>}
          </div>
          {knownRepos.length ? (
            (showCollectionProgress?knownRepos.filter(r=>form.repositories.includes(r.path)||r.skipReason):knownRepos).map((r) => (
              <label className={`selection-row repository-row${showCollectionProgress?" collection-item":""}`} key={r.path}>
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
                {showCollectionProgress&&<GitBranch className="muted" size={14}/>}
                <span className="path" title={r.path}>
                  {showCollectionProgress?r.path.replaceAll("\\","/").split("/").filter(Boolean).at(-1):r.path}
                </span>
                {showCollectionProgress&&!r.skipReason?<CollectionRowProgress progress={job.repositoryProgress?.[r.path]} unit="commits" active={progressActive}/>:<span className={`muted${r.skipReason ? " repository-note" : ""}`}>
                  {r.skipReason === "missing-git-email"
                    ? t("缺少 Git user.email，无法提取提交信息；已跳过。")
                    : r.count === null ? t("未统计") : t("{0} 个提交", r.count)}
                </span>}
              </label>
            ))
          ) : (
            <p className="muted">
              {job?.status === "running" && !job.repositories
                ? t("正在发现仓库")
                : t("尚未发现仓库")}
            </p>
          )}
          {showCollectionProgress&&<p className="repo-hint">{t("点击右上角“编辑”，调整纳入管理的 Git 仓库。")}</p>}
        </div>
      </section>
      <section className="workspace-setting">
        <h3>{t("会话记录")}</h3>
        <div className="workspace-options">
          <div className={`selection-summary${showCollectionProgress?" collection-summary":""}`}>
            {showCollectionProgress?<><span>{t("读取 {0} 个 Agent 的记录",form.providers.length)}</span><span>{progressCount(sessionSummary,"sessions")}</span></>:<>{form.providers.length} {t("个来源已选")}</>}
          </div>
          {!showCollectionProgress&&<p className="repo-hint">
            {t("只读取并整理勾选来源在这个目录里的会话记录。")}
          </p>}
          {(showCollectionProgress?providers.filter(p=>form.providers.includes(p.id)):orderedProviders.slice(0, providerLimit)).map((p) => (
            <label className={`selection-row${showCollectionProgress?" collection-item":""}`} key={p.id}>
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
              <AgentLabel className="collection-provider" provider={p.id} name={p.name} />
              {showCollectionProgress?<CollectionRowProgress progress={job.sourceProgress?.[p.id]} unit="sessions" active={progressActive}/>:<span className="muted">
                {!p.supported
                  ? t("暂未支持")
                  : !p.enabled
                    ? t("已停用")
                    : (providerCounts[p.id] || 0) > 0
                      ? job?.pending?.[p.id] ? t("已确认 {0} 个会话，其余待整理时确认", providerCounts[p.id]) : t("{0} 个会话", providerCounts[p.id])
                      : job?.pending?.[p.id] ? t("发现记录，所属目录待整理时确认")
                      : job?.kind === "discover" && ["queued","running"].includes(job.status) ? t("正在读取元信息") : t("未发现")}
              </span>}
            </label>
          ))}
          {showCollectionProgress&&<p className="repo-hint">{t("点击右上角“编辑”，调整需要读取的会话记录。")}</p>}
          {!showCollectionProgress&&providerLimit < orderedProviders.length && (
            <button
              className="provider-load-more"
              onClick={() => setProviderLimit((limit) => limit + 6)}
            >
              {t("加载更多（剩余")} {orderedProviders.length - providerLimit}{" "}
              {t("个来源）")}
            </button>
          )}
          {!showCollectionProgress&&providerLimit > 6 && (
            <button
              className="provider-load-more"
              onClick={() => setProviderLimit(6)}
            >
              {t("收起")}
            </button>
          )}
        </div>
      </section>
      <section className="workspace-setting workspace-sharing">
        <h3>{t("会话分享")}</h3>
        <div className="workspace-options">
          <p className="repo-hint">
            {t("配置 GitHub 令牌，用于将本工作目录的会话发布为 GitHub Gist。")}
          </p>
          <div className="session-share-status">
            <span>{t("状态")}</span>
            <Badge status={gist ? "done" : ""}>
              {gist ? t("已配置") : t("未配置")}
            </Badge>
            <button className="session-share-local-account" disabled={fresh || gistImporting}
              onClick={() => {
                if (gistImporting) return;
                setGistImporting(true);
                setGistImportError("");
                void act(async () => {
                  try {
                    const result = await api<{ configured: boolean; account: string }>(`/workspaces/${form.id}/gist-credential`, "POST", {});
                    setGist(result.configured);
                    setGistAccount(result.account);
                    setToken("");
                  } catch (error) {
                    setGistImportError(error instanceof Error ? error.message : String(error));
                  } finally { setGistImporting(false); }
                });
              }}>
              {gistImporting && <Loader2 size={14} className="spin" aria-hidden="true" />}
              {gistImporting ? t("正在检查 GitHub 账号…") : t("使用本机 GitHub 账号")}
            </button>
          </div>
          {gistImportError && <p role="alert" className="error">{systemMessage(gistImportError)}</p>}
          {gistAccount && <p role="status" className="repo-hint">{t("已连接 GitHub 账号 {0}，分享权限检查通过。", gistAccount)}</p>}
          <div className="input-actions session-share-token">
            <input
              type="password"
              autoComplete="new-password"
              aria-label={t("GitHub 令牌")}
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
                  setGistAccount("");
                  setGistImportError("");
                })
              }
            >
              {t("保存令牌")}
            </button>
          </div>
        </div>
      </section>
      <section className="workspace-setting workspace-cloud">
        <h3>{t("云端存储")}</h3>
        <div className="workspace-options">
          <div className="directory-cloud-line">
            <span className="label">{t("状态")}</span>
            <Badge>{!savedCloud.enabled ? t("未开启") : syncing ? t("正在同步新记录…") : sync?.status === "done" ? t("同步完成") : sync?.status === "failed" ? t("同步失败") : sync?.status === "partial" ? t("部分记录待同步") : t("已开启")}</Badge>
            <span className="muted">
              {account?.account
                ? t("通过云端账号 {0} 存储", account.account)
                : account?.connected
                  ? t("云端账号已连接")
                  : t("云端账号未连接")}
            </span>
            <label className="cloud-storage-toggle">
              <span>{t("开启云端存储")}</span>
              <input className="switch" type="checkbox" aria-label={t("开启云端存储")}
                checked={savedCloud.enabled} disabled={cloudSaving || startupBusy || syncing}
                onChange={event => void act(() => changeCloudEnabled(event.target.checked))} />
            </label>
          </div>
          <div className="directory-cloud-line">
            <span className="label">{t("云端项目")}</span>
            <span>{sync?.serverProjectId ? workspace?.name : t("尚未关联")}</span>
            {!sync?.serverProjectId && <span className="muted">{t("首次推送时自动创建")}</span>}
            <button
              className="text-action cloud-row-action"
              disabled={!sync?.serverProjectId}
              title={sync?.serverProjectId ? t("在云端查看") : t("尚未关联云端项目")}
              onClick={() => { if (account?.server && sync?.serverProjectId) window.open(`${account.server}/dashboard?projectId=${encodeURIComponent(sync.serverProjectId)}`, "_blank", "noopener,noreferrer"); }}
            >
              {t("在云端查看")}
            </button>
          </div>
          <div className="directory-cloud-line">
            <span className="label">{t("同步方式")}</span>
            <span>
              {savedCloud.mode === "automatic"
                ? t(
                    "自动同步 · {0}",
                    savedCloud.interval === 60
                      ? t("每小时")
                      : t("每 {0} 分钟", savedCloud.interval),
                  )
                : t("手动同步")}
            </span>
            <button
              className="text-action cloud-row-action"
              aria-expanded={cloudEditing}
              aria-controls="cloud-settings"
              disabled={cloudSaving}
              onClick={() => {
                if (cloudEditing) closeCloudSettings();
                else setCloudEditing(true);
              }}
            >
              {t("调整频率")}
            </button>
          </div>
          <div className="directory-cloud-line">
            <span className="label">{t("最近同步")}</span>
            <span>{sync?.endedAt ? new Date(sync.endedAt).toLocaleString() : t("尚未同步")}</span>
          </div>
          <div className="directory-cloud-line">
            <span className="label">{t("下次同步")}</span>
            <span>{sync?.nextAt ? new Date(sync.nextAt).toLocaleString() : t("未安排")}</span>
          </div>
          {cloudEditing && <div id="cloud-settings" className="cloud-settings">
            <div className="field">
              <label className="startup-option">
                <input
                  type="checkbox"
                  checked={startup.enabled}
                  disabled={startupBusy || !startup.supported || syncing || cloudSaving}
                  onChange={(event) => void changeStartup(event.target.checked)}
                />
                <span>{t("登录电脑后自动启动")}</span>
              </label>
            </div>
            <p className="repo-hint">
              {startup.supported
                ? t(
                    "此选项对本机所有目录立即生效。勾选后才可自动同步；取消勾选会暂停所有目录的自动同步，仍可手动同步。",
                  )
                : t("当前系统不支持登录后自动启动，可使用手动同步。")}
            </p>
            <fieldset disabled={syncing || cloudSaving}>
              <div className="field">
                <span>{t("同步方式")}</span>
                <div className="segments">
                  {(["manual", "automatic"] as const).map((mode) => (
                    <label
                      key={mode}
                      className={cloudForm.mode === mode ? "active" : ""}
                    >
                      <input
                        type="radio"
                        name="cloud-mode"
                        disabled={
                          mode === "automatic" &&
                          (!startup.enabled || startupBusy)
                        }
                        checked={cloudForm.mode === mode}
                        onChange={() =>
                          changeCloud({ ...cloudForm, mode })
                        }
                      />
                      {mode === "manual" ? t("手动同步") : t("自动同步新记录")}
                    </label>
                  ))}
                </div>
              </div>
              <div className="field">
                <label htmlFor="cloud-frequency">{t("同步频率")}</label>
                <select
                  id="cloud-frequency"
                  disabled={cloudForm.mode !== "automatic"}
                  value={cloudForm.interval}
                  onChange={(e) =>
                    changeCloud({ ...cloudForm, interval: Number(e.target.value) })
                  }
                >
                  {[5, 15, 30, 60].map((n) => (
                    <option key={n} value={n}>
                      {n === 60 ? t("每小时") : t("每 {0} 分钟", n)}
                    </option>
                  ))}
                </select>
              </div>
            </fieldset>
            {!fresh && <div className="directory-cloud-actions cloud-settings-actions">
              <button className="primary" disabled={cloudSaving || startupBusy || syncing || !cloudDirty}
                onClick={() => void act(saveCloudSettings)}>{t("保存")}</button>
              <button disabled={cloudSaving} onClick={closeCloudSettings}>{t("取消")}</button>
            </div>}
          </div>}
          <p className="repo-hint">
            {syncing ? t("正在同步新记录…") : sync?.error || (sync?.status === "done" || sync?.status === "partial"
              ? t("已同步 {0} 条记录、{1} 个提交", sync.events || 0, sync.commits || 0) : t("尚未同步，本机记录保留。"))}
            {sync?.warnings?.map(warning => <span key={warning} className="repo-hint">{warning}</span>)}
          </p>
          <div className="directory-cloud-actions">
            <button className="primary" disabled={syncing || cloudSaving || !!syncBlockedReason}
              title={syncBlockedReason || undefined}
              onClick={() => void act(startCloudSync)}>
              {t("立即同步")}
            </button>
            <button disabled={syncing || cloudSaving || workspace?.cloud.mode !== "automatic"}
              onClick={() => void act(async () => {
                const saved = await api<Workspace>(`/workspaces/${workspace!.id}`, "PATCH", { version: workspace!.version, cloud: { ...workspace!.cloud, mode: "manual" } });
                setForm(f => ({ ...f, version: saved.version, cloud: saved.cloud })); setCloudDraft(null); onSaved(saved);
              })}>
              {t("暂停自动同步")}
            </button>
          </div>
          {(syncBlockedReason || fresh) && <p className="repo-hint cloud-sync-hint">
            {syncBlockedReason || t("点击后会先保存工作目录、整理本地记录，再同步到云端。")}
          </p>}
        </div>
      </section>
      <p className="workspace-local-note">
        <ShieldCheck size={14} aria-hidden="true" />
        {savedCloud.enabled
          ? t(
              "仅同步新增的提问、最终回复、提交及用量。工具记录保留在本机。",
            )
          : t(
              "当前目录尚未开启云端存储，记录仅保存在本机；连接账号不会自动上传。",
            )}
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
              (!editing && workspace?.directoryAvailable === false) ||
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
            {t("开始整理")}
          </button>
          <span className="muted">{t("大约需要 1 分钟")}</span>
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
          <h3><AgentLabel provider={p.id} name={p.name} /></h3>
          {p.homesSupported && !primaryHomes && (
            <button
              className={`icon provider-config${showHomes ? " expanded" : ""}`}
              title={t("{0} 备用主目录", p.name)}
              aria-label={t("{0} 备用主目录设置", p.name)}
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
            <span className="muted">{t("未配置目录")}</span>
          )}
        </div>
        {p.homesSupported && (
          <div
            className="provider-homes"
            id={`homes-${p.id}`}
            hidden={!showHomes}
          >
            <label className="provider-homes-title" htmlFor={`home-${p.id}`}>
              {t("备用主目录")}
            </label>
            <div>
              {p.homes.map((path) => (
                <div className="input-actions" key={path}>
                  <span className="path">{path}</span>
                  <IconButton
                    title={t("移除备用主目录")}
                    onClick={() => {
                      if (
                        confirm(t("移除这个备用主目录配置？不会删除原始文件。"))
                      )
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
                  aria-label={t("{0} 备用主目录", p.name)}
                  placeholder={t("备用主目录路径")}
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
                  {t("添加主目录")}
                </button>
              </div>
              <p className="provider-home-count">
                {t("使用了多个账号或自定义存储位置时，在这里添加其他主目录。")}
              </p>
            </div>
          </div>
        )}
      </div>
      {p.supported ? (
        <Toggle
          label={t("{0} 启用", p.name)}
          checked={p.enabled}
          onChange={(enabled) => save({ enabled })}
          statusFirst
        />
      ) : (
        <Badge>{t("暂未支持")}</Badge>
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
  const [loginOpen, setLoginOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [deviceToken, setDeviceToken] = useState("");
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenError, setTokenError] = useState("");
  const closeToken = () => {
    if (tokenSaving) return;
    setTokenOpen(false);
    setDeviceToken("");
    setTokenError("");
  };
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
        {systemMessage(error)}
      </p>
    ) : (
      <Loader2 className="spin" />
    );
  const pending = data.attempt?.status === "pending";
  const connected =
    data.connected && data.auth === "valid" && data.reachable === true;
  const lastChecked = data.checkedAt
    ? new Intl.DateTimeFormat(locale(), {
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(data.checkedAt))
    : t("尚未检查");
  return (
    <div className="account-page">
      <div className="page-heading">
        <div>
          <h2>{t("数据云端")}</h2>
          <Badge status={data.connected ? "done" : ""}>
            {data.connected ? t("已连接") : t("未连接")}
          </Badge>
        </div>
      </div>
      <p className="page-description">
        {t(
          "管理这台电脑与云端账号的连接。各工作目录是否上传及同步频率，在工作目录详情中设置。",
        )}
      </p>
      {error && (
        <p role="alert" className="error">
          {systemMessage(error)}
        </p>
      )}
      <section className="settings-rows" aria-busy={checking}>
        <div className="field">
          <span>{t("云端账号")}</span>
          <div className="account-value">
            <span className="cloud-avatar" aria-hidden="true">
              {data.account ? (
                Array.from(data.account)[0].toUpperCase()
              ) : (
                <UserRound size={14} />
              )}
            </span>
            <span className="account-name">
              {data.account ||
                (data.connected ? t("账号名称未返回") : t("未登录"))}
            </span>
            {data.connected && (
              <Badge status={data.auth === "valid" ? "done" : "partial"}>
                {data.auth === "valid" ? t("已登录") : t("授权待更新")}
              </Badge>
            )}
          </div>
        </div>
        <div className="field">
          <span>{t("本机账号连接")}</span>
          <div className="account-value">
            <Badge
              status={
                connected ? "done" : data.reachable === false ? "failed" : ""
              }
            >
              {!data.connected
                ? t("未连接")
                : checking
                  ? t("检查中")
                  : connected
                    ? t("连接正常")
                    : data.auth === "expired"
                      ? t("需要重新授权")
                      : data.reachable === false
                        ? t("连接异常")
                        : t("待检查")}
            </Badge>
          </div>
        </div>
        <div className="field">
          <span>{t("账号授权")}</span>
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
              ? t("有效")
              : data.auth === "expired"
                ? t("需要刷新授权")
                : t("未连接")}
          </Badge>
        </div>
        <div className="field">
          <span>{t("云端服务")}</span>
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
              ? t("检查中")
              : data.reachable === undefined || data.reachable === null
                ? t("未检查")
                : data.reachable
                  ? t("可连接")
                  : t("连接失败")}
          </Badge>
        </div>
        <div className="field">
          <span>{t("最近检查")}</span>
          <div className="account-value">
            <span>{lastChecked}</span>
            <button
              className="text-action account-check"
              disabled={checking || pending}
              onClick={() => void check()}
            >
              {checking ? t("检查中") : t("重新检查")}
            </button>
          </div>
        </div>
      </section>
      {data.attempt?.status === "pending" && (
        <section>
          <h3>{t("等待浏览器授权")}</h3>
          {data.attempt.verificationUrl && (
            <>
              <a
                className="button"
                href={data.attempt.verificationUrl}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={14} />
                {t("打开授权页面")}
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
            {t("取消授权")}
          </button>
        </section>
      )}
      {data.attempt?.error && (
        <p className="error">{systemMessage(data.attempt.error)}</p>
      )}
      <footer className="account-actions">
        <button
          className="primary"
          onClick={() => setLoginOpen(true)}
          disabled={pending || checking || !server.trim()}
        >
          {data.connected ? t("切换账号") : t("连接云端账号")}
        </button>
        {data.connected && (
          <button
            disabled={checking || pending}
            onClick={() => {
              if (confirm(t("断开当前账号？本地历史和配置将保留。")))
                void act(async () =>
                  setData(await api("/account/logout", "POST", {})),
                );
            }}
          >
            {t("断开连接")}
          </button>
        )}
        <a
          className="text-action"
          href={data.server}
          target="_blank"
          rel="noreferrer"
        >
          {t("打开云端")}
        </a>
      </footer>
      {loginOpen && (
        <Modal title={t("选择登录方式")} onClose={() => setLoginOpen(false)}>
          <div className="cloud-login-methods">
            <button className="cloud-login-method" aria-label={t("浏览器授权")} onClick={() => {
              setLoginOpen(false);
              void act(async () => {
                await api("/account/login", "POST", { server });
                setData(await api("/account"));
              });
            }}>
              <Globe size={20} aria-hidden="true" />
              <span><strong>{t("浏览器授权")}</strong><small>{t("在浏览器中登录 Cloud 并确认授权。")}</small></span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
            <button className="cloud-login-method" aria-label={t("使用设备 Token")} onClick={() => {
              setLoginOpen(false);
              setTokenOpen(true);
            }}>
              <KeyRound size={20} aria-hidden="true" />
              <span><strong>{t("使用设备 Token")}</strong><small>{t("使用在 Cloud 中创建设备时生成的 Token。")}</small></span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
        </Modal>
      )}
      {tokenOpen && (
        <Modal title={t("使用设备 Token")} onClose={closeToken}>
          <form className="cloud-token-form" onSubmit={event => {
            event.preventDefault();
            if (tokenSaving || !deviceToken.trim()) return;
            setTokenSaving(true);
            setTokenError("");
            void api<AccountData>("/account/token", "POST", { server, token: deviceToken.trim() })
              .then(next => {
                setData(next);
                setServer(next.server);
                setError("");
                setDeviceToken("");
                setTokenOpen(false);
              })
              .catch(e => setTokenError(e instanceof Error ? e.message : String(e)))
              .finally(() => setTokenSaving(false));
          }}>
            <p className="muted">{t("先在 Cloud 中创建设备并复制 Token，再粘贴到这里连接。")}</p>
            <div className="field">
              <label htmlFor="cloud-device-token">{t("设备 Token")}</label>
              <input id="cloud-device-token" type="password" autoComplete="off" spellCheck={false}
                placeholder={t("粘贴 Cloud 生成的 adit_… Token")} required maxLength={8192}
                value={deviceToken} disabled={tokenSaving} onChange={e => setDeviceToken(e.target.value)} />
            </div>
            {tokenError && <p role="alert" className="error">{systemMessage(tokenError)}</p>}
            <footer>
              <button type="button" className="cloud-login-back" disabled={tokenSaving} onClick={() => {
                closeToken();
                setLoginOpen(true);
              }}><ArrowLeft size={14} aria-hidden="true" />{t("返回")}</button>
              <button type="button" disabled={tokenSaving} onClick={closeToken}>{t("取消")}</button>
              <button type="submit" className="primary" disabled={tokenSaving || !deviceToken.trim()}>
                {tokenSaving ? t("验证中…") : t("保存并连接")}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      <p className="account-footnote">
        {t("连接账号后，按各工作目录的云端存储及同步设置上传新增记录。")}
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
          {t("重新检查")}
        </button>
      </div>
      <p className="page-description">
        {t(
          "查看这台电脑上的 ADIT 安装情况，管理本地数据采集，以及各 Agent 的接入状态。",
        )}
      </p>
      <section className="settings-rows">
        <div className="field">
          <span>{t("当前状态")}</span>
          <Badge status={runtime?.cli?.path ? "done" : ""}>
            {!runtime
              ? t("检测中")
              : runtime.cli?.path
                ? t("已安装 · 可调用")
                : t("PATH 中未找到")}
          </Badge>
        </div>
        <div className="field">
          <span>{t("当前版本")}</span>
          <span>
            {runtime?.version || t("检测中")}
            <small>{t("当前后台服务版本")}</small>
          </span>
        </div>
        <div className="field">
          <span>{t("安装位置")}</span>
          <code className="path">
            {runtime?.cli?.path ||
              (runtime?.cli?.error && systemMessage(runtime.cli.error)) ||
              t("检测中")}
          </code>
        </div>
        <div className="field">
          <span>{t("最近检查")}</span>
          <span>
            {runtime?.checkedAt ? time(runtime.checkedAt) : t("检测中")}
          </span>
        </div>
      </section>
      <section>
        <h3>
          {t("本地数据采集")}{" "}
          <span className="muted">{t("所有已添加的工作目录")}</span>
        </h3>
        <p className="repo-hint">{t("自动读取本地新增的会话和提交记录。")}</p>
        <div className="field">
          <span>{t("自动采集")}</span>
          <div className="field-value">
            <Toggle
              label={t("自动采集")}
              checked={state.schedule.enabled}
              onChange={(enabled) => save({ enabled })}
            />
            <span className="muted">{t("关闭后仅手动采集")}</span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="collection-frequency">{t("采集频率")}</label>
          <div className="field-value">
            <select
              id="collection-frequency"
              value={state.schedule.interval}
              onChange={(e) => save({ interval: Number(e.target.value) })}
            >
              {[1, 5, 15, 30].map((n) => (
                <option value={n} key={n}>
                  {t("每")} {n} {t("分钟")}
                </option>
              ))}
            </select>
            <span className="muted">{t("默认每 5 分钟")}</span>
          </div>
        </div>
        <div className="field">
          <span>{t("运行状态")}</span>
          <Badge status={active?.status}>
            {active
              ? undefined
              : state.schedule.enabled
                ? t("等待采集")
                : t("自动采集已关闭")}
          </Badge>
        </div>
        <div className="field">
          <span>{t("上次采集")}</span>
          <span>
            {time(last?.endedAt)} {last && <Badge status={last.status} />}
          </span>
        </div>
        <div className="field">
          <span>{t("下次采集")}</span>
          <span>
            {state.schedule.nextAt ? time(state.schedule.nextAt) : t("未安排")}
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
            {t("立即采集")}
          </button>
          <span className="muted">
            {t("仅更新本机数据；云端上传在工作目录中设置。")}
          </span>
        </footer>
      </section>
      <section>
        <h3>{t("Skill 安装情况")}</h3>
        <p className="repo-hint">
          {t(
            "Skill 全局安装，所有工作目录共用，让 Agent 知道如何使用 ADIT 查询历史、记忆、报告和任务。",
          )}
        </p>
        <div className="table-scroll">
          <table className="settings-table">
            <thead>
              <tr>
                <th>Skill</th>
                <th><AgentLabel provider="claude" /></th>
                <th><AgentLabel provider="codex" /> / Agents</th>
              </tr>
            </thead>
            <tbody>
              {runtime?.skills?.map((s: any) => (
                <tr key={s.name}>
                  <td>
                    <span>
                      {{
                        "adit-history": t("历史会话与提交"),
                        "adit-memory": t("个人与项目记忆"),
                        "adit-reports": t("工作报告与用量"),
                        "adit-tasks": t("任务管理"),
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
                            installed: t("已安装"),
                            modified: t("内容有修改"),
                            missing: t("未安装"),
                            inaccessible: t("无法访问"),
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
