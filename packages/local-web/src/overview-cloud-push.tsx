import { Cloud, CloudOff, Globe } from "lucide-react";
import { locale, systemMessage, t } from "./i18n";
import { number } from "./formatters";
import { HeaderStatusPopover } from "./header-status-popover";

export type CloudSyncSummary = {
  status?: string;
  endedAt?: string;
  error?: string;
  pending?: { state: "ready"; sessions: number; commits: number } |
    { state: "disabled" | "disconnected" | "uninitialized" | "unverified"; sessions: null; commits: null };
};

type CloudPushProps = {
  enabled: boolean; sync?: CloudSyncSummary; accountState?: string;
  onPush?: () => void; onSettings: () => void; onAccount: () => void;
  pending?: boolean;
};

export function CloudSyncStatus(props: CloudPushProps & { workspaceName: string }) {
  const running = ["queued", "running"].includes(props.sync?.status || "");
  const needsAccount = !!props.accountState && props.accountState !== "valid";
  const warning = props.enabled && (needsAccount || ["failed", "partial"].includes(props.sync?.status || ""));
  const summary = !props.enabled ? t("未开启云端存储") : needsAccount ? t("请先连接云端账号。")
    : running ? t("正在同步新记录…") : props.sync?.status === "failed" ? t("同步失败")
    : props.sync?.status === "partial" ? t("部分记录待同步")
    : props.sync?.status === "done" ? t("同步完成") : t("尚未同步");
  return <HeaderStatusPopover title={t("云端存储")} workspaceName={props.workspaceName}
    label={`${t("云端存储")} · ${summary}`} icon={props.enabled ? <Cloud size={16} /> : <CloudOff size={16} />}
    status={!props.enabled ? undefined : running ? "working" : warning ? "warning" : props.sync?.status === "done" ? "done" : undefined}>
    {props.enabled && <p role="status" className="header-status-summary">{summary}</p>}
    {props.enabled && props.sync?.endedAt && <p className="muted">{t("上次同步")} {new Date(props.sync.endedAt).toLocaleString(locale())}</p>}
    {props.enabled && props.sync?.error && <p className="error">{systemMessage(props.sync.error)}</p>}
    <OverviewCloudPush {...props} />
    <p className="muted">{t("按当前工作目录同步；不受日期和 Agent 筛选影响")}</p>
  </HeaderStatusPopover>;
}

export function OverviewCloudPush({ enabled, sync, accountState, onPush, onSettings, onAccount, pending: busy }: CloudPushProps) {
  const running = ["queued", "running"].includes(sync?.status || "");
  const pending = sync?.pending;
  const needsAccount = !!accountState && accountState !== "valid";
  let summary: string, label: string = t("立即推送"), action = onPush;
  let title = t("按当前工作目录同步；不受日期和 Agent 筛选影响");
  if (!enabled) {
    summary = t("未开启云端存储"); label = t("开启云端存储"); action = onSettings;
  } else if (needsAccount) {
    summary = t("请先连接云端账号。"); label = t("登录云端"); action = onAccount;
  } else if (!accountState) {
    summary = t("正在读取云端账号状态…"); action = undefined;
  } else if (pending?.state === "ready") {
    summary = t("待推送 {0} 个会话、{1} 个提交", number(pending.sessions), number(pending.commits));
    title += `；${t("提问可以先推送，回复产生后再增量补传。")}`;
  } else {
    summary = running ? t("正在核对云端历史…") : t("待核对云端历史");
    title += `；${t("推送时先核对云端历史，已上传的记录不会重复推送。")}`;
  }
  return <span className="overview-cloud-quick" title={title}>
    <span role="status">{summary}</span>
    <button disabled={!action || running || busy} onClick={action}>
      <Globe size={12} />{running ? t("正在同步新记录…") : label}
    </button>
  </span>;
}
