import { getLanguage } from "./i18n";
export const inspectionCopy = {
  重试: "Retry",
  "点击查看此类结果，再次点击恢复确定结果":
    "Show this rule's results; click again to return to definite findings",
  "另有 {0} 处疑似结果，可点击上方虚线规则查看。":
    "There are also {0} candidate findings. Select a dashed rule above to review them.",
  历史对话体检: "History check",
  返回概览: "Back to overview",
  "整理时自动检查，只在本机进行":
    "Checked automatically during organization, locally only",
  重新检查: "Check again",
  取消检查: "Cancel check",
  "检查中 {0}/{1}": "Checking {0}/{1}",
  "正在遮盖搜索记录 {0}/{1}": "Masking search records {0}/{1}",
  "{0} 处": "{0} findings",
  "确定是密钥，需要处理": "Definite secrets need attention",
  未发现需要处理的确定密钥: "No definite secrets need attention",
  "检查了全部 {0} 个会话：你开的 {1} 个，加上 Agent 派出去的 {2} 个子任务；提问、回复、执行的命令和命令输出都在范围内。":
    "Checked all {0} sessions: {1} started by you and {2} agent subtasks. Prompts, responses, commands and command output are included.",
  "已检查 {0}/{1} 个会话，完整检查尚未完成。":
    "Checked {0}/{1} sessions. The full check is not complete.",
  "还没有采集到会话，整理后会自动检查。":
    "No collected sessions yet. History will be checked during organization.",
  私钥文件: "Private keys",
  "疑似：带密码的网址": "Candidate: password in URL",
  "疑似：登录令牌": "Candidate: login token",
  "疑似：像密钥的长串": "Candidate: secret-like string",
  需要处理: "Needs attention",
  已处理: "Handled",
  已忽略: "Ignored",
  疑似: "Candidate",
  确定: "Definite",
  "{0} 密钥": "{0} key",
  "其他会话里没有发现确定的密钥。":
    "No definite secrets were found in other sessions.",
  "没有发现确定的密钥。": "No definite secrets were found.",
  "暂时没有这类记录。": "No findings in this category.",
  选择左侧记录查看详情: "Select a finding to see its details",
  选择左侧会话查看详情: "Select a session to see its findings",
  "当前筛选 · {0} 处": "Current filter · {0} findings",
  全部标为已处理: "Mark all as handled",
  全部忽略: "Ignore all",
  全部恢复为需要处理: "Move all back to needs attention",
  "第 {0} 轮": "Turn {0}",
  提问: "Prompt",
  回复: "Response",
  执行的命令: "Command / tool input",
  命令输出: "Command output",
  "{0}出现在{1}里": "{0} found in {1}",
  当时执行的命令: "Command at the time",
  "Agent 写的用途：{0}": "Agent's description: {0}",
  "输出里的这一行（第 {0} 行）": "This line in the output (line {0})",
  "记录里的这一行（第 {0} 行）": "This line in the record (line {0})",
  建议这样处理: "Suggested actions",
  "去 {0} 控制台把这把密钥作废，换一把新的":
    "Revoke this key in the {0} console and replace it",
  "请确认是否为凭据；如果是，到对应平台作废并替换。":
    "Confirm whether this is a credential. If so, revoke and replace it with its provider.",
  "替换这份私钥，并撤销对应的访问权限。":
    "Replace this private key and revoke its associated access.",
  需要你自己操作: "Requires your action",
  "ADIT 已在自己的记录里遮盖这一处，搜索、在其他 Agent 里引用、分享都不会带出原文":
    "ADIT has masked this occurrence in its records. Search, references from other agents and sharing will not expose the original value.",
  已遮盖: "Masked",
  正在更新搜索中的遮盖内容: "Updating masked search content",
  "{0} 自己的记录文件里还有原文：":
    "The original value remains in {0}'s own record file:",
  打开所在文件夹: "Open containing folder",
  原始文件位置未记录或来自导入文件:
    "Original file location is unavailable or the session was imported",
  '这次是 Agent 为了看配置直接读了 .env。可以在项目规则里写上"不要读取 .env 文件"，以后少出这种情况。':
    "The agent read .env to inspect configuration. Add “Do not read .env files” to your project rules to reduce the chance of this happening again.",
  "已经换过了，标为已处理": "I've replaced it — mark as handled",
  "不是密钥，忽略": "Not a secret — ignore",
  恢复为需要处理: "Move back to needs attention",
  加载更多: "Load more",
  "读取失败，请重试": "Could not load results. Please retry.",
  "操作失败，请重试": "Could not complete the action. Please retry.",
  "读取中…": "Loading…",
  模型未记录: "Model not recorded",
  模型: "Model",
  思考等级: "Reasoning effort",
  "输入（不含缓存）": "Input (excluding cache)",
  输出: "Output",
  缓存命中: "Cache read",
  "上次检查未全部完成，可以重新检查。":
    "The last check did not finish completely. You can check again.",
  "检查已取消，已完成的结果已保留。":
    "Check cancelled. Completed results have been retained.",
  "确定仅表示符合密钥格式，未验证是否有效。未发现不代表没有敏感信息。":
    "Definite means the value matches a supported secret format; validity has not been checked. No findings does not guarantee the absence of sensitive data.",
} as const;
export function ic(
  key: keyof typeof inspectionCopy,
  ...values: (string | number)[]
) {
  const result = (getLanguage() === "zh" ? key : inspectionCopy[key]).replace(
    /\{(\d+)\}/g,
    (match, i) =>
      values[Number(i)] === undefined ? match : String(values[Number(i)]),
  );
  return getLanguage() === "en"
    ? result
        .replace(/\b1 findings\b/g, "1 finding")
        .replace(/\b1 turns\b/g, "1 turn")
        .replace(/\b1 occurrences\b/g, "1 occurrence")
        .replace(/\b1 sessions\b/g, "1 session")
    : result;
}
