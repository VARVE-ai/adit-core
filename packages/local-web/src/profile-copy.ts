import { getLanguage } from "./i18n";
const copy = {
  预览: "Preview",
  宽卡片: "Wide card",
  小徽章: "Small badges",
  徽章样式: "Badge style",
  普通: "Plain",
  精美: "Rich",
  "AI 会话": "AI sessions",
  "AI 提问": "AI prompts",
  "AI 活跃天数": "AI active days",
  最常用模型: "Most-used model",
  "能关联到 AI 会话的提交数 / 全部提交数": "Commits linked to AI sessions / all commits",
  "你自己开启的会话，不含子任务": "Sessions you started, excluding subtasks",
  "向 Agent 发起的提问总次数": "Total prompts sent to Agents",
  "有 AI 会话活动的天数": "Days with AI session activity",
  "统计范围内使用过的 Agent": "Agents used within the selected range",
  "按提问次数统计，使用最多的模型": "The most-used model by prompt count",
  "放进 README 的单独一节": "Place in its own README section",
  花费没有放进图里: "Cost is not included in the images",
  "选择一个徽章，放在项目名下面":
    "Select one badge to place below the project name",
  "普通样式 · 和许可证、版本这类徽章同一个样子，排在同一行":
    "Plain · Like license and version badges, placed on the same line",
  "精美样式 · 大一号，带标志和两个数字，适合单独放一行":
    "Rich · Larger, with a logo and two figures, suited to a separate line",
  工作区: "Workspace",
  统计范围: "Range",
  全部记录: "All records",
  "最近 30 天": "Last 30 days",
  "含 {0} 等 {1} 个仓库，图上是整个工作区的数字":
    "Includes {0} and {1} repositories in total; images show the whole workspace",
  "{0} 个仓库，图上是整个工作区的数字":
    "{0} repositories; images show the whole workspace",
  "{0}起，共 {1} 天": "Since {0}, {1} days",
  宽卡片上显示: "Show on wide card",
  每天的活跃度: "Daily activity",
  "按提问次数，{0} 天活跃": "By prompts, {0} active days",
  会话和提问次数: "Sessions and prompts",
  "{0} 个会话 · {1} 次提问": "{0} sessions · {1} prompts",
  "在 AI 会话里完成的提交": "Commits made in AI sessions",
  "{0} 个里 {1} 个": "{1} of {0}",
  "用了哪些 Agent": "Agents used",
  按提问次数占比: "Share of prompts",
  用了哪些模型: "Models used",
  "前 3 个，其余合并": "Top 3, others combined",
  花费: "Cost",
  默认不显示: "Off by default",
  "会话：你自己开的会话，不含 Agent 派出去的 {0} 个子任务":
    "Sessions: sessions you started, excluding {0} subtasks delegated by Agents",
  "提交：{0} 个仓库里你在这台电脑上的提交，能找到提交它的会话才算":
    "Commits: your own commits on this machine across {0} repositories; counted as linked only when the submitting session is found",
  "只导出选中的一张 SVG 图片；放进仓库后由你自己提交，数字变了再导出一次覆盖":
    "Export the selected image as SVG; commit it yourself, then export again when figures change",
  导出图片: "Export image",
  请选择要导出的图片: "Select an image to export first",
  "浅色与深色背景 · 同一套卡片和徽章":
    "Light and dark backgrounds · the same cards and badges",
  浅色背景: "Light background",
  深色背景: "Dark background",
  "尚无本地记录，整理后会显示真实数字。":
    "No local records yet. Organize your history to see real figures.",
  "正在读取统计…": "Loading statistics…",
  统计读取失败: "Could not load statistics",
  "未找到本地 README，以下展示工作区的卡片和徽章。":
    "No local README found. Workspace cards and badges are shown below.",
  "{0} 个成就已解锁 · 下方展示 {1} 个":
    "{0} achievements unlocked · {1} featured below",
  尚未解锁成就: "No achievements unlocked yet",
  提交关联尚未分析: "Submission associations have not been analyzed",
  "{0} 次提问未记录模型，占比保留为未知。":
    "The model is unknown for {0} prompts; that share remains unknown.",
  "{0} 次提问没有时间，未放进活跃度图。":
    "{0} prompts have no timestamp and are excluded from the activity chart.",
  "模型按每轮第一条有模型信息的回复统计，同一轮只计一次。":
    "Models use the first identified assistant response per turn, counted once per prompt.",
  "偏好无法保存，刷新后将恢复默认设置。":
    "Preferences could not be saved. Reloading will restore defaults.",
} as const;
export function pc(key: keyof typeof copy, ...values: (string | number)[]) {
  return (getLanguage() === "zh" ? key : copy[key]).replace(
    /\{(\d+)\}/g,
    (_, n) => String(values[Number(n)] ?? ""),
  );
}
