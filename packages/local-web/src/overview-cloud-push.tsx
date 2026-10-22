import { Globe } from "lucide-react";
import { t } from "./i18n";
import { number } from "./formatters";

export type CloudSyncSummary = {
  status?: string;
  pending?: { state: "ready"; sessions: number; commits: number } |
    { state: "disabled" | "disconnected" | "uninitialized" | "unverified"; sessions: null; commits: null };
};

export function OverviewCloudPush({ enabled, sync, accountState, onPush, onSettings, onAccount }: {
  enabled: boolean; sync?: CloudSyncSummary; accountState?: string;
  onPush?: () => void; onSettings: () => void; onAccount: () => void;
}) {
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
    <button disabled={!action || running} onClick={action}>
      <Globe size={12} />{running ? t("正在同步新记录…") : label}
    </button>
  </span>;
}
