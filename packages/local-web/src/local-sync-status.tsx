import { RefreshCw } from "lucide-react";
import { locale, systemMessage, t } from "./i18n";

type Job = {
  workspaceId: string;
  kind: string;
  status: string;
  endedAt?: string;
  error?: string;
};

export function LocalSyncStatus({
  workspaceId,
  jobs,
  pending,
  onRefresh,
}: {
  workspaceId: string;
  jobs: Job[];
  pending: boolean;
  onRefresh: () => void;
}) {
  const latest = jobs.find(
    (job) => job.workspaceId === workspaceId && job.kind === "collect",
  );
  const active = !!latest && ["running", "queued"].includes(latest.status);
  const lastFinished = jobs.find(
    (job) => job.workspaceId === workspaceId && job.kind === "collect" &&
      ["done", "partial"].includes(job.status),
  );
  const finishedAt = lastFinished?.endedAt
    ? new Date(lastFinished.endedAt).toLocaleString(locale(), {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : "—";

  return (
    <div className="local-sync">
      <span
        role="status"
        className={active ? "working" : latest?.status === "done" ? "synced" : ""}
        title={`${t("上次同步")} ${finishedAt}${latest?.error ? ` · ${systemMessage(latest.error)}` : ""}`}
      >
        <i className="local-status-dot" />
        {active
          ? t("本地整理中")
          : latest?.status === "done"
            ? t("本地已同步")
            : latest
              ? t("本地记录部分更新")
              : t("尚无本地同步记录")}
      </span>
      <button
        disabled={pending || active}
        onClick={onRefresh}
        title={t("重新读取当前工作目录的会话与提交记录")}
        aria-label={t("刷新当前工作目录的本地记录")}
      >
        <RefreshCw size={12} className={active || pending ? "spin" : ""} />
      </button>
    </div>
  );
}
