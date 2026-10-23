// Local service messages can come from saved jobs as well as new requests.
// Translate these known messages at display time, keeping paths and details intact.
export const systemMessages: Record<string, string> = {
  "未检测到 Git 仓库，无法创建项目或开始整理。请选择包含 Git 仓库的目录。": "No Git repository found. Select a directory containing a Git repository to create the project or start organizing.",
  "正在检查 Git 仓库…": "Checking Git repositories…",
  "未安装 GitHub 命令行工具，请安装并登录，或手动输入令牌。": "GitHub CLI is not installed. Install it and sign in, or enter a token manually.",
  "无法读取本机 GitHub 账号，请通过 GitHub 命令行工具登录 github.com 后重试。": "Could not read the local GitHub account. Sign in to github.com with GitHub CLI and try again.",
  "本机 GitHub 凭据不可用，请重新登录或手动输入令牌。": "The local GitHub credential is unavailable. Sign in again or enter a token manually.",
  "无法验证 GitHub 账号，请检查网络后重试。": "Unable to verify the GitHub account. Check your connection and try again.",
  "本机 GitHub 登录已失效，请重新登录后重试。": "The local GitHub sign-in has expired. Sign in again and retry.",
  "GitHub 暂时无法验证此账号，请稍后重试或手动输入令牌。": "GitHub could not verify this account. Try again later or enter a token manually.",
  "无法确认此凭据的 Gist 分享权限，请使用已授予 gist 权限的 GitHub 命令行登录，或手动输入令牌。": "Could not confirm Gist sharing permission for this credential. Use a GitHub CLI login with the gist scope or enter a token manually.",
  "此 GitHub 账号缺少 Gist 分享权限，请执行 gh auth refresh -h github.com -s gist 后重试。": "This GitHub account lacks Gist sharing permission. Run gh auth refresh -h github.com -s gist and try again.",
  "GitHub 返回的账号信息无效，未保存凭据。": "GitHub returned an invalid account. The credential was not saved.",
  "无法将 GitHub 凭据保存到本机安全存储，请重试。": "Unable to save the GitHub credential to secure local storage. Please try again.",
  "正在配置 GitHub 凭据，请稍候。": "GitHub credential setup is already in progress. Please wait.",
  "本地历史包含多个项目身份，请恢复原项目配置。": "Saved ADIT history contains multiple project identities. Restore the original project configuration.",
  "无法读取已保存的 ADIT 项目身份，请检查本地数据库。": "Unable to read the saved ADIT project identity. Check the local database.",
  "已保存的 ADIT 工作目录配置无法读取，请检查 .adit/workspace.json。": "The saved ADIT workspace configuration is unreadable. Check .adit/workspace.json.",
  "工作目录不可用，请在设置中更新目录。": "Workspace directory is unavailable. Update its path in Settings.",
  "项目已登记，请在设置中修改原工作目录。": "This project is already registered. Update its directory in Settings.",
  "所选目录的项目身份与已登记项目不一致，请选择原项目的新目录。": "Project identity conflicts with the registered workspace. Choose the original project's directory.",
  "仓库身份与已登记项目不一致。": "Repository identity conflicts with the registered project",
  "请等待当前工作目录整理结束后再修改目录。": "Wait for this workspace's organization to finish before changing its directory.",
  "请等待当前工作目录的后台任务结束后再修改目录。": "Wait for this workspace's background tasks to finish before changing its directory.",
  "原项目身份缺失，请恢复 .adit/project.json 后再登记。": "The original project identity is missing. Restore .adit/project.json before registering this project.",
  "目标仓库已有采集记录，请使用其现有工作目录。": "The target repository already has collected history. Choose its existing workspace.",
  "这轮对话已更新，请重新打开编辑窗口后重试。": "This conversation changed. Reopen the editor and try again.",
  "请选择需要修改的提问或回复正文。": "Select prompt or reply text to edit",
  "对话正文无效或过长，请检查后重试。": "Invalid conversation text",
  "提问不能为空。": "The prompt cannot be empty",
  "工作目录设置已更改，请刷新后再删除。": "Workspace settings changed. Reload before deleting.",
  "请等待此工作目录整理结束后再删除。": "Wait for this workspace's organization to finish before deleting it.",
  "请粘贴 Cloud 生成的设备 Token（adit_…）。": "Paste the device token generated in Cloud (adit_...).",
  "正在登录，请等待完成或取消后重试。": "A login is already in progress",
  "请输入有效的 Cloud 服务地址。": "Enter a valid Cloud server URL.",
  "设备 Token 无效或设备已移除，请在 Cloud 中重新生成。": "The device token is invalid or its device has been removed. Generate a new token in Cloud.",
  "无法连接 Cloud，请检查服务地址后重试。": "Unable to reach Cloud. Check the server address and try again.",
  "无法验证设备 Token，请重试。": "Unable to verify the device token. Please try again.",
  "登录已取消或账号已切换，请重试。": "Login cancelled or the account changed. Please try again.",
  "Cloud 未返回设备编号，Token 未保存。": "Cloud did not return a device ID. The token was not saved.",
  "切换服务前请先断开当前连接。": "Disconnect the current server before changing servers",
  "无法访问系统安全凭据存储。": "Unable to access secure Cloud credential storage",
  '请先勾选“登录电脑后自动启动”，再开启自动云同步': 'Enable "Start automatically when you sign in" before automatic cloud sync',
  "启动设置已在其他窗口更改，请刷新后保存。": "Startup settings changed. Reload before saving.",
  "当前系统不支持登录后自动启动": "Login startup is not supported on this platform",
  "无法找到已安装的 ADIT 程序": "The installed ADIT executable is unavailable",
  "登录启动注册失败": "Login startup registration failed",
  上次分析已中断: "The previous analysis was interrupted",
  提交分析服务已停止: "The commit analysis service has stopped",
  提交分析服务不可用: "The commit analysis service is unavailable",
  "采集记录已更新，将在下一次采集后重试未完成的提交分析":
    "Collected records have changed. Incomplete commit analysis will retry after the next collection",
  "已有分析结果已更新，将在下一次采集后重试未完成的提交分析":
    "Existing analysis results have changed. Incomplete commit analysis will retry after the next collection",
  "请先为该仓库配置 Git user.email，才能只整理自己的提交":
    "Configure Git user.email for this repository to organize only your own commits",
  提交分析失败: "Commit analysis failed",
  "缺少时间的写入记录 {0} 条；无法读取的备份 {1} 个。缺失部分不推断归属。":
    "{0} write records have no timestamp; {1} backups could not be read. Missing evidence is not used to infer authorship.",
  "公开价格更新失败，保留上次价格":
    "Public pricing update failed; previous prices retained",
  "未授权，请通过 adit serve 打开此页面。": "Unauthorized",
  "CLI 未在 PATH 中找到": "CLI was not found on PATH",
  无效的授权页面地址: "Invalid authorization URL",
  无法请求设备授权: "Unable to request device authorization",
  "授权失败、已过期或被拒绝，请重试。":
    "Authorization failed, expired or was denied. Please retry.",
  请求失败: "Request failed",
  "授权已过期，请重试": "Authorization expired",
  授权已取消: "Authorization denied",
  无法连接本地服务: "Failed to fetch",
};

function pattern(template: string) {
  return new RegExp(
    template
      .split(/\{\d+\}/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("(\\d+)"),
    "g",
  );
}
export const systemMessagePatterns = Object.entries(systemMessages).map(
  ([zh, en]) => ({
    zh,
    en,
    zhPattern: pattern(zh),
    enPattern: pattern(en),
  }),
);
