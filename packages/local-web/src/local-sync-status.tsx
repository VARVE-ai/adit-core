import { Monitor, RefreshCw } from "lucide-react";
import { locale, systemMessage, t } from "./i18n";
import { HeaderStatusPopover } from "./header-status-popover";

type Job = {
  workspaceId: string;
  kind: string;
  status: string;
  endedAt?: string;
  error?: string;
};

export function LocalSyncStatus({
  workspaceId,
  workspaceName,
  jobs,
  pending,
  onRefresh,
}: {
  workspaceId: string;
  workspaceName?: string;
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

  const summary = active
    ? t("本地采集中")
    : latest?.status === "done" ? t("本地采集完成")
    : latest?.status === "failed" ? t("采集失败")
    : latest ? t("本地采集部分完成") : t("尚无本地采集记录");
  return (
    <HeaderStatusPopover title={t("本地采集")} workspaceName={workspaceName}
      label={`${t("本地采集")} · ${summary}`} icon={<Monitor size={16} />}
      status={active ? "working" : latest?.status === "done" ? "done" : latest ? "warning" : undefined}>
      <p role="status" className="header-status-summary">{summary}</p>
      <p className="muted">{t("上次采集")} {finishedAt}</p>
      {latest?.error && <p className="error">{systemMessage(latest.error)}</p>}
      <p className="muted">{t("仅更新本机的会话与提交记录，不会上传到云端。")}</p>
      <div className="header-status-actions">
        <button
          disabled={pending || active}
          onClick={onRefresh}
          title={t("重新采集当前工作目录的会话与提交记录")}
          aria-label={t("重新采集当前工作目录的本地记录")}
        >
          <RefreshCw size={14} className={active || pending ? "spin" : ""} />{t("重新采集")}
        </button>
      </div>
    </HeaderStatusPopover>
  );
}
