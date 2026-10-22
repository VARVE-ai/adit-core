import {
  ArrowLeft,
  Award,
  BookOpen,
  ChartNoAxesCombined,
  LockKeyhole,
} from "lucide-react";
import { ac } from "./achievement-copy";
import { pc } from "./profile-copy";
export type ExportTab = "profile-cards" | "achievements" | "badge-examples";
export function ExportToolbar({
  tab,
  name,
  since,
  onOverview,
  onTab,
}: {
  tab: ExportTab;
  name: string;
  since?: string;
  onOverview: () => void;
  onTab: (tab: ExportTab) => void;
}) {
  return (
    <div className="ach-toolbar">
      <button className="ach-link" onClick={onOverview}>
        <ArrowLeft size={14} />
        {ac("返回概览")}
      </button>
      <span className="ach-divider" />
      <nav className="ach-tabs" aria-label={ac("档案卡和徽章")}>
        {(
          [
            ["profile-cards", "档案卡和徽章", ChartNoAxesCombined],
            ["achievements", "成就", Award],
            ["badge-examples", "应用示例", BookOpen],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            aria-current={tab === key ? "page" : undefined}
            onClick={() => onTab(key)}
          >
            <Icon size={14} />
            {ac(label)}
          </button>
        ))}
      </nav>
      <span className="ach-since">
        {name}
        {since && <> · {ac("{0}以来", since)}</>}
      </span>
      <span className="ach-local">
        <LockKeyhole size={12} />
        {tab === "badge-examples"
          ? pc("浅色与深色背景 · 同一套卡片和徽章")
          : ac("图片只在本机生成，不上传任何内容")}
      </span>
    </div>
  );
}
