import { getLanguage } from "./i18n";
const messages: Record<string, string> = {
  "The local database is busy. Try again shortly.": "本地数据库正在处理其他任务，请稍后重试。",
  "Configure a GitHub Gist token for this workspace first": "请先为当前工作目录配置 GitHub Gist 令牌",
  "The GitHub Gist token is invalid or expired": "GitHub Gist 令牌无效或已过期，请更新令牌",
  "GitHub denied publication or its rate limit was reached": "GitHub 拒绝发布或已达到请求频率限制，请检查权限后重试",
  "GitHub could not complete publication": "GitHub 未能完成发布，请稍后重试",
  "Could not confirm publication. Check the connection and try again.": "无法确认发布结果，请检查网络后重试；重试会先核对是否已发布",
  "The previous publication result is still unknown. Check your GitHub Gists before trying again.": "上次发布结果仍未确认，请先检查你的 GitHub Gist，避免重复发布",
  "The remote share no longer matches the reviewed preview. Check your GitHub Gist.": "远端内容与已检查的预览不一致，请检查你的 GitHub Gist",
  "The configured share reader must use a public HTTPS address": "分享阅读页必须配置公开的 HTTPS 地址",
  "Generation request belongs to different options": "生成请求对应的选项已变化，请重新生成",
  "Content changed. Review the current preview before publishing.": "内容已更新，请重新检查预览后发布",
  "Select at least one valid prompt": "至少选择一轮有效提问",
  "There is no content to share": "当前没有可分享的内容",
  "A share title of 1–500 characters is required": "请填写 1 到 500 个字符的分享标题",
  "Session not found": "找不到该会话",
  "Share not found": "找不到该分享记录",
  "PR description not found": "找不到该 PR 说明",
  "Select a project Markdown template": "请选择项目的 Markdown 模板",
  "Cannot read the selected Markdown template": "无法读取所选 Markdown 模板",
  "The selected range has no eligible commits": "所选范围没有可纳入的提交",
  "Cannot read this Git range. Check local refs and available commit objects.": "无法读取所选 Git 范围，请检查本地分支和提交对象是否完整",
  "Configure Git user.email for this repository first": "请先为此仓库配置 Git user.email",
  "Repository is outside this workspace": "该仓库不属于当前工作目录",
  "Publication processing was interrupted": "内容处理已中断，请重试",
  "System keychain is unavailable": "系统安全凭据存储不可用",
  "Unable to access the system keychain": "无法访问系统安全凭据存储",
  "Unable to unlock the saved Gist credential": "无法解锁已保存的 Gist 凭据",
  "Resolve the commit range again before generating": "提交范围已过期，请重新生成",
  "This session is too large to share at once. Select fewer prompts.": "此会话过大，请选择较少轮次进行分享",
};
export function publicationError(value: string) {
  if (value === "database is locked" || value === "database table is locked") value = "The local database is busy. Try again shortly.";
  if (getLanguage() !== "zh") return value;
  return messages[value] || value.replace(/^(\d+) selected commits have not been analyzed\. Collect and analyze them before including line statistics\.$/, "$1 个提交尚未完成分析，请先整理这些提交，再生成包含行数统计的说明。");
}
