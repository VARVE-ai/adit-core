import { getLanguage } from "./i18n";
export const achievementCopy = {
  成就: "Achievements",
  返回概览: "Back to overview",
  档案卡和徽章: "Profile cards & badges",
  应用示例: "Examples",
  "图片只在本机生成，不上传任何内容":
    "Images are generated locally. Nothing is uploaded.",
  "{0}以来": "Since {0}",
  "已解锁 {0} 个": "{0} unlocked",
  "还有 {0} 个快到了": "{0} more to unlock",
  "数字截至 {0}": "Figures as of {0}",
  "第一次整理完，按 {0}以来的记录补发了 {1} 个成就，日期是当时达成的那一天；以后再达成新的一级，概览工具行会提示一次。":
    "After the first organization, {1} achievements were awarded from records since {0}, dated to when they were earned. Each new level will trigger a one-time notice in the overview toolbar.",
  "已解锁 · 选择要放进项目首页的成就":
    "Unlocked · Select an achievement for your README",
  快解锁了: "Coming up next",
  全部成就均已解锁: "All achievements unlocked",
  "尚未解锁成就，整理本地记录后会显示真实进度。":
    "No achievements unlocked yet. Organize your local records to see your progress.",
  "正在根据已有记录计算成就…":
    "Calculating achievements from your existing records…",
  "成就更新失败，保留上次结果。下次整理时会重试。":
    "Achievement update failed. Previous results are retained; the next collection will retry.",
  "部分来源尚未完成，以下成绩仅包含已确认的记录。":
    "Some sources are incomplete. Figures below include confirmed records only.",
  "{0} 条记录无法完整核实，当前显示已确认的成绩。":
    "{0} records could not be fully verified. This is the confirmed result.",
  选中的成就: "Selected achievement",
  两种样式: "Two styles",
  普通: "Plain",
  精美: "Rich",
  徽章上显示: "Show on badge",
  时长: "Duration",
  成绩: "Value",
  达成日期: "Date earned",
  "用的哪个 Agent": "Agent used",
  提问原文: "Original prompt",
  默认不带: "Off by default",
  解锁提示: "Unlock notifications",
  "达成新的一级时，在概览工具行提示一次":
    "Show a one-time notice in the overview toolbar when a new level is earned",
  怎么算的: "How it is calculated",
  "连续干活：从提问到这一轮最后一条消息，中间停顿超过 5 分钟的按 5 分钟算":
    "Continuous work: from the prompt to the last message in that turn, with gaps longer than 5 minutes capped at 5 minutes",
  "工作日：周一到周五，周末不算中断":
    "Workdays: Monday to Friday; weekends do not break a streak",
  "放进 README": "Add to README",
  导出成就徽章: "Export achievement badge",
  "复制 README 代码": "Copy README code",
  已复制: "Copied",
  "正在生成…": "Generating…",
  请选择已解锁的成就: "Select an unlocked achievement first",
  "将下载的图片放到项目的 .github/adit/ 目录，再粘贴下面的代码。":
    "Place the downloaded images in your project's .github/adit/ folder, then paste the code below.",
  "导出选中的成就，格式为 PNG。":
    "Export the selected achievement as PNG.",
  导出格式: "Export format",
  "第 {0} 级，三级是 {1}": "Level {0}; thresholds: {1}",
  "尚未解锁；三级是 {0}": "Locked; thresholds: {0}",
  "下一级 {0}": "Next: {0}",
  已满级: "Max level",
  "还差 {0}": "{0} to go",
  "已到 {0}": "Reached {0}",
  日期未知: "Date unknown",
  暂无记录: "No records yet",
  "{0} 小时 {1} 分": "{0}h {1}m",
  "{0} 个": "{0}",
  "{0} 天": "{0} days",
  "{0} 个工作日": "{0} workdays",
  "{0} 个提交": "{0} commits",
  "{0} 条命令": "{0} commands",
  "{0} 次": "{0} runs",
  "{0} 小时": "{0}h",
  "{0} 分钟": "{0}m",
  "一句话让 Agent 连续干了 {0}": "One prompt kept an Agent working for {0}",
  "同时有 {0} 个 Agent 在干活": "{0} Agent instances working at once",
  "连续 {0} 个工作日都在用 Agent": "Used Agents for {0} consecutive workdays",
  "一个 {0} 会话里交了 {1} 个提交": "{1} commits submitted in one {0} session",
  "Agent 替你跑了 {0} 条命令": "Agents ran {0} commands for you",
  "{0} 次一句话让 Agent 干了半小时以上":
    "{0} prompts kept Agents working for over half an hour",
  "Agent 替你干满 {0}": "Agents have worked {0} for you",
  "用 Agent 满 {0} 天": "Used Agents on {0} days",
  "最高成绩发生于 {0}": "Best result recorded on {0}",
  "第 {0} 级达成于 {1}": "Level {0} earned on {1}",
  "本次识别于 {0}": "Discovered on {0}",
  "当前连续 {0} 个工作日": "Current streak: {0} workdays",
  "{0} 条消息": "{0} messages",
  "提交时间来自 Git 记录": "Submission time comes from Git history",
  "当前工作目录 · {0} 个仓库": "Current workspace · {0} repositories",
  "提问预览（已脱敏）": "Prompt preview (redacted)",
  暂未实现: "Not available yet",
  刷新: "Refresh",
  成就读取失败: "Could not load achievements",
  "保存失败，请重试": "Could not save. Please retry.",
  "导出失败，请重试": "Could not export. Please retry.",
  已生成下载文件: "Download generated",
  "复制失败，请手动复制下面的代码":
    "Copy failed. Copy the code below manually.",
  成就应用示例: "Achievement examples",
  你选中的成就放进项目首页后的效果:
    "How your selected achievements will look in a project README",
  查看成就: "View achievements",
} as const;
export function ac(
  key: keyof typeof achievementCopy,
  ...values: (string | number)[]
) {
  return (getLanguage() === "zh" ? key : achievementCopy[key]).replace(
    /\{(\d+)\}/g,
    (_, n) => String(values[Number(n)] ?? ""),
  );
}
