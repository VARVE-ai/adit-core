import { useEffect, useState } from "react";
import { BookOpen, Download, Folder, RefreshCw } from "lucide-react";
import type { AchievementsData } from "../../core/src/local-history/achievements";
import type { ReadmePreview } from "../../cli/src/local/readme-preview";
import { ExportToolbar, type ExportTab } from "./export-toolbar";
import { ac } from "./achievement-copy";
import { pc } from "./profile-copy";
import { getLanguage } from "./i18n";
import {
  achievementName,
  badgeSvg,
  svgUrl,
} from "./achievement-export";
import {
  defaultProfilePreferences,
  profileDate,
  profileDays,
  profileDownload,
  profileItems,
  profileReadme,
  profileStart,
  profileSvg,
  readProfilePreferences,
  type ProfileData,
  type ProfileItem,
  type ProfilePreferences,
} from "./profile-export";
import "./achievements.css";
import "./profile-cards.css";

type Api = <T = any>(
  path: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;
type Workspace = {
  id: string;
  name: string;
  path: string;
  repositories: string[];
  providers: string[];
  version: number;
};
const itemLabel: Record<ProfileItem, string> = {
  card: "Wide card",
  "badge-commits": "commits in AI sessions",
  "badge-sessions": "AI sessions",
  "badge-prompts": "AI prompts",
  "badge-days": "AI active days",
  "badge-agents": "AI agents",
  "badge-model": "top model",
  "card-commits": "COMMITS MADE IN AI SESSIONS",
  "card-activity": "AI ACTIVITY",
  "card-agents": "AI AGENTS USED",
  "card-model": "MOST-USED MODEL",
};

export function ProfileCardsPage({
  workspace,
  api,
  tab,
  onOverview,
  onTab,
}: {
  workspace: Workspace;
  api: Api;
  tab: "profile-cards" | "badge-examples";
  onOverview: () => void;
  onTab: (tab: ExportTab) => void;
}) {
  const storageKey = `adit-profile-v1:${workspace.id}`;
  const [preferences, setPreferences] = useState(() => {
    try {
      return readProfilePreferences(localStorage.getItem(storageKey));
    } catch {
      return defaultProfilePreferences();
    }
  });
  const [data, setData] = useState<ProfileData>();
  const [achievements, setAchievements] = useState<AchievementsData>();
  const [readme, setReadme] = useState<ReadmePreview>();
  const [exampleRepository, setExampleRepository] = useState(
    workspace.repositories[0] || "",
  );
  const [error, setError] = useState("");
  const [exampleError, setExampleError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [feedback, setFeedback] = useState<"" | "preferences" | "download" | "export-error" | "copied" | "copy-error">("");
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const query = new URLSearchParams({
          workspaceId: workspace.id,
          range: preferences.range,
          timezone,
        });
        const result = await api<ProfileData>(
          `/overview?${query}`,
          "GET",
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setData(result);
          setError("");
          setLoading(false);
        }
      } catch {
        if (!controller.signal.aborted) {
          setError(pc("统计读取失败"));
          setLoading(false);
        }
      }
    };
    setLoading(true);
    setData(undefined);
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 30000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [workspace.id, workspace.version, preferences.range, refresh, timezone]);
  useEffect(() => {
    if (tab !== "badge-examples") return;
    const controller = new AbortController(),
      query = `?workspaceId=${encodeURIComponent(workspace.id)}`;
    setExampleError("");
    setReadme(undefined);
    void Promise.all([
      api<AchievementsData>(
        `/achievements${query}`,
        "GET",
        undefined,
        controller.signal,
      ),
      api<ReadmePreview>(
        `/readme-preview${query}&repository=${encodeURIComponent(exampleRepository)}`,
        "GET",
        undefined,
        controller.signal,
      ),
    ])
      .then(([a, r]) => {
        if (!controller.signal.aborted) {
          setAchievements(a);
          setReadme(r);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setExampleError(pc("统计读取失败"));
      });
    return () => controller.abort();
  }, [tab, workspace.id, workspace.version, refresh, exampleRepository]);
  function save(next: ProfilePreferences) {
    setPreferences(next);
    setFeedback("");
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      setFeedback("preferences");
    }
  }
  function select(item: ProfileItem) {
    save({
      ...preferences,
      selected: [item],
    });
  }
  const s = data?.summary,
    p = data?.profile;
  const ready = !!data && !!p && !loading && !error;
  const image = (item: ProfileItem, prefs = preferences) =>
    data && p ? (
      <img
        src={svgUrl(profileSvg(data, workspace.name, prefs, item))}
        alt={itemLabel[item]}
        className={item === "card" ? "profile-wide" : undefined}
      />
    ) : null;
  const selected = preferences.selected.length;
  const code = profileReadme(preferences, workspace.name);
  const since = data
    ? profileDate(profileStart(data), getLanguage())
    : undefined;
  const options: [keyof ProfilePreferences["show"], string, string][] = [
    [
      "activity",
      pc("每天的活跃度"),
      pc("按提问次数，{0} 天活跃", s?.activeDays ?? 0),
    ],
    [
      "sessions",
      pc("会话和提问次数"),
      pc("{0} 个会话 · {1} 次提问", s?.sessions ?? 0, s?.prompts ?? 0),
    ],
    [
      "commits",
      pc("在 AI 会话里完成的提交"),
      pc(
        "{0} 个里 {1} 个",
        s?.totalCommits ?? 0,
        p?.submissionAnalyzed ? (s?.linkedCommits ?? 0) : "—",
      ),
    ],
    ["agents", pc("用了哪些 Agent"), pc("按提问次数占比")],
    ["models", pc("用了哪些模型"), pc("前 3 个，其余合并")],
    ["cost", pc("花费"), pc("默认不显示")],
  ];
  return (
    <div className="achievements-page profile-page">
      <ExportToolbar
        tab={tab}
        name={workspace.name}
        since={since === "—" ? undefined : since}
        onOverview={onOverview}
        onTab={onTab}
      />
      {(error || exampleError) && (
        <div className="ach-error" role="alert">
          {error || exampleError}
          <button onClick={() => setRefresh((n) => n + 1)}>
            <RefreshCw size={12} />
            {ac("刷新")}
          </button>
        </div>
      )}
      {tab === "badge-examples" ? (
        <ReadmeExamples
          data={data}
          workspace={workspace}
          achievements={achievements}
          readme={readme}
          repository={exampleRepository}
          onRepository={setExampleRepository}
          loading={loading}
        />
      ) : (
        <div className="ach-work">
          <section className="ach-main profile-main">
            <div className="ach-heading">
              <h1>{pc("预览")}</h1>
              {p && (
                <span className="ach-status earned">
                  {ac("数字截至 {0}", profileDate(p.through, getLanguage()))}
                </span>
              )}
              {!preferences.show.cost && (
                <span className="ach-status">{pc("花费没有放进图里")}</span>
              )}
            </div>
            {loading && (
              <p role="status" className="ach-note">
                {pc("正在读取统计…")}
              </p>
            )}
            {data && !s?.sessions && (
              <p className="ach-note">
                {pc("尚无本地记录，整理后会显示真实数字。")}
              </p>
            )}
            <label className="profile-label">
              <input
                type="radio"
                name="profile-export-item"
                checked={preferences.selected.includes("card")}
                onChange={() => select("card")}
              />
              {pc("宽卡片")}
              <span>{pc("放进 README 的单独一节")}</span>
            </label>
            <div className="profile-wide-preview">{image("card")}</div>
            <div className="profile-label profile-small-label">
              {pc("小徽章")}
              <span>
                {pc("选择一个徽章，放在项目名下面")}
              </span>
            </div>
            <p className="profile-group">
              {pc("普通样式 · 和许可证、版本这类徽章同一个样子，排在同一行")}
            </p>
            <div className="profile-badges">
              {profileItems
                .filter((k) => k.startsWith("badge-"))
                .map((item) => (
                  <label key={item}>
                    <input
                      type="radio"
                      name="profile-export-item"
                      aria-label={itemLabel[item]}
                      checked={preferences.selected.includes(item)}
                      onChange={() => select(item)}
                    />
                    {image(item) || <span>{itemLabel[item]}</span>}
                  </label>
                ))}
            </div>
            <p className="profile-group rich">
              {pc("精美样式 · 大一号，带标志和两个数字，适合单独放一行")}
            </p>
            <div className="profile-badges rich">
              {profileItems
                .filter((k) => k.startsWith("card-"))
                .map((item) => (
                  <label key={item}>
                    <input
                      type="radio"
                      name="profile-export-item"
                      aria-label={itemLabel[item]}
                      checked={preferences.selected.includes(item)}
                      onChange={() => select(item)}
                    />
                    {image(item) || <span>{itemLabel[item]}</span>}
                  </label>
                ))}
            </div>
          </section>
          <aside className="ach-sidebar profile-sidebar">
            <div className="ach-side-scroll">
              <section>
                <h2>{pc("工作区")}</h2>
                <div className="profile-workspace">
                  <Folder size={14} />
                  <strong>{workspace.name}</strong>
                  <span title={workspace.path}>{workspace.path}</span>
                </div>
                <p className="ach-muted">
                  {workspace.repositories.length
                    ? pc(
                        "含 {0} 等 {1} 个仓库，图上是整个工作区的数字",
                        workspace.repositories[0].split(/[\\/]/).pop() || "",
                        workspace.repositories.length,
                      )
                    : pc("{0} 个仓库，图上是整个工作区的数字", 0)}
                </p>
              </section>
              <section className="profile-inline">
                <h2>{pc("统计范围")}</h2>
                <div className="ach-tabs">
                  {(["all", "30d"] as const).map((range) => (
                    <button
                      key={range}
                      aria-pressed={preferences.range === range}
                      onClick={() => save({ ...preferences, range })}
                    >
                      {range === "all" ? pc("全部记录") : pc("最近 30 天")}
                    </button>
                  ))}
                </div>
                <small>
                  {data && since !== "—"
                    ? pc(
                        "{0}起，共 {1} 天",
                        since || "",
                        profileDays(data).length,
                      )
                    : ac("暂无记录")}
                </small>
              </section>
              <section>
                <h2>{pc("宽卡片上显示")}</h2>
                {options.map(([key, label, hint]) => (
                  <label className="ach-option" key={key}>
                    <input
                      type="checkbox"
                      checked={preferences.show[key]}
                      onChange={(e) =>
                        save({
                          ...preferences,
                          show: {
                            ...preferences.show,
                            [key]: e.target.checked,
                          },
                        })
                      }
                    />
                    <span>{label}</span>
                    <small title={hint}>{hint}</small>
                  </label>
                ))}
              </section>
              <section className="profile-inline">
                <h2>{pc("图片文字")}</h2>
                <div className="ach-tabs">
                  {(["en", "zh"] as const).map((language) => (
                    <button
                      key={language}
                      aria-pressed={preferences.language === language}
                      onClick={() => save({ ...preferences, language })}
                    >
                      {language === "en" ? "English" : "中文"}
                    </button>
                  ))}
                </div>
                <small>
                  {preferences.language === "en"
                    ? pc("要放进的首页说明是英文")
                    : pc("要放进的首页说明是中文")}
                </small>
              </section>
              <section>
                <h2>{ac("怎么算的")}</h2>
                <p>
                  {pc(
                    "会话：你自己开的会话，不含 Agent 派出去的 {0} 个子任务",
                    s?.subtasks ?? 0,
                  )}
                </p>
                <p>
                  {pc(
                    "提交：{0} 个仓库里你在这台电脑上的提交，能找到提交它的会话才算",
                    workspace.repositories.length,
                  )}
                </p>
                {p && !p.submissionAnalyzed && (
                  <p className="ach-muted">{pc("提交关联尚未分析")}</p>
                )}
                <details>
                  <summary>{pc("按提问次数占比")}</summary>
                  {!!p?.unknownModelPrompts && (
                    <p className="ach-muted">
                      {pc(
                        "{0} 次提问未记录模型，占比保留为未知。",
                        p.unknownModelPrompts,
                      )}
                    </p>
                  )}
                  {!!p?.missingPromptDates && (
                    <p className="ach-muted">
                      {pc(
                        "{0} 次提问没有时间，未放进活跃度图。",
                        p.missingPromptDates,
                      )}
                    </p>
                  )}
                  <p>
                    {pc(
                      "模型按每轮第一条有模型信息的回复统计，同一轮只计一次。",
                    )}
                  </p>
                </details>
              </section>
              <section>
                <h2>{ac("放进 README")}</h2>
                <pre>
                  {code.split("\n").filter(Boolean).join("\n") ||
                    pc("请选择要导出的图片")}
                </pre>
                <p className="ach-muted">
                  {pc(
                    "只导出选中的一张 PNG 图片；放进仓库后由你自己提交，数字变了再导出一次覆盖",
                  )}
                </p>
              </section>
            </div>
            <footer className="ach-footer">
              <div>
                <button
                  className="primary"
                  disabled={!ready || !selected || exporting}
                  onClick={async () => {
                    setExporting(true);
                    setFeedback("");
                    try {
                      await profileDownload(
                        data!,
                        workspace.name,
                        preferences,
                      );
                      setFeedback("download");
                    } catch {
                      setFeedback("export-error");
                    } finally {
                      setExporting(false);
                    }
                  }}
                >
                  <Download size={14} />
                  {exporting ? ac("正在生成…") : pc("导出图片")}
                </button>
                <button
                  className="ach-link"
                  disabled={!ready || !selected}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(code);
                      setFeedback("copied");
                    } catch {
                      setFeedback("copy-error");
                    }
                  }}
                >
                  {ac("复制 README 代码")}
                </button>
              </div>
              {feedback && <small role="status">{feedback === "preferences" ? pc("偏好无法保存，刷新后将恢复默认设置。") : ac({download:"已生成下载文件","export-error":"导出失败，请重试",copied:"已复制","copy-error":"复制失败，请手动复制下面的代码"}[feedback] as Parameters<typeof ac>[0])}</small>}
            </footer>
          </aside>
        </div>
      )}
    </div>
  );
}

function ReadmeExamples({
  data,
  workspace,
  achievements,
  readme,
  repository,
  onRepository,
  loading,
}: {
  data?: ProfileData;
  workspace: Workspace;
  achievements?: AchievementsData;
  readme?: ReadmePreview;
  repository: string;
  onRepository: (repository: string) => void;
  loading: boolean;
}) {
  const prefs = defaultProfilePreferences();
  const featured = ["marathon", "streak", "shipper"].flatMap(
    (key) => achievements?.items.filter((i) => i.key === key && i.tier) || [],
  );
  const unlocked = achievements?.items.filter((i) => i.tier).length || 0;
  const rich = featured.find((i) => i.key === "marathon");
  const img = (item: ProfileItem) =>
    data?.profile && (
      <img
        src={svgUrl(profileSvg(data, workspace.name, prefs, item))}
        alt={itemLabel[item]}
        className={item === "card" ? "profile-wide" : undefined}
      />
    );
  return (
    <div className="profile-examples">
      {(["light", "dark"] as const).map((theme) => (
        <article className={`profile-readme-pane ${theme}`} key={theme}>
          <div className="profile-readme-heading">
            <BookOpen size={14} />
            <strong>README.md</strong>
            <span>{theme === "light" ? pc("浅色背景") : pc("深色背景")}</span>
            {!!workspace.repositories.length && (
              <select
                aria-label={`README · ${theme}`}
                value={repository}
                onChange={(e) => onRepository(e.target.value)}
              >
                {workspace.repositories.map((path) => (
                  <option key={path} value={path}>
                    {path.split(/[\\/]/).pop()}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="profile-readme">
            <h1>{readme?.title || workspace.name}</h1>
            {loading && <p role="status">{pc("正在读取统计…")}</p>}
            <div className="profile-example-plain">{img("badge-commits")}</div>
            <div className="profile-example-rich">
              {img("card-commits")}
              {img("card-activity")}
            </div>
            {readme?.introduction.map((p, i) => (
              <p key={i}>
                {i === 0 && readme.leadBold ? <strong>{p}</strong> : p}
              </p>
            ))}
            {readme && !readme.repository && (
              <p>{pc("未找到本地 README，以下展示工作区的卡片和徽章。")}</p>
            )}
            <h2>AI-assisted development</h2>
            {img("card")}
            {data && !data.summary.sessions && (
              <p>{pc("尚无本地记录，整理后会显示真实数字。")}</p>
            )}
            <section className="profile-example-achievements">
              <h2>Achievements</h2>
              <p className="profile-example-summary">
                {achievements
                  ? pc(
                      "{0} 个成就已解锁 · 下方展示 {1} 个",
                      unlocked,
                      featured.length,
                    )
                  : ac("正在根据已有记录计算成就…")}
              </p>
              <div className="profile-example-plain">
                {achievements &&
                  featured.map((i) => (
                    <img
                      key={i.key}
                      src={svgUrl(
                        badgeSvg(
                          achievements,
                          {
                            ...i,
                            options: {
                              ...i.options,
                              showValue: true,
                              showDate: false,
                              showAgent: false,
                              showPrompt: false,
                            },
                          },
                          "plain",
                        ),
                      )}
                      alt={achievementName(i.key)}
                    />
                  ))}
              </div>
              {achievements && rich && (
                <div className="profile-example-rich">
                  <img
                    src={svgUrl(
                      badgeSvg(
                        achievements,
                        {
                          ...rich,
                          options: {
                            ...rich.options,
                            showValue: true,
                            showDate: true,
                            showAgent: false,
                            showPrompt: false,
                          },
                        },
                        "rich",
                      ),
                    )}
                    alt={achievementName(rich.key)}
                  />
                </div>
              )}
              {achievements?.status === "ready" && !unlocked && (
                <p>{pc("尚未解锁成就")}</p>
              )}
            </section>
            {readme?.sectionTitle && <h2>{readme.sectionTitle}</h2>}
            {readme?.sectionTable?.length && (
              <table>
                <thead>
                  <tr>
                    {readme.sectionTable[0].map((cell, i) => (
                      <th key={i}>{cell}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {readme.sectionTable.slice(1).map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {readme?.sectionItem && (
              <ol>
                <li>{readme.sectionItem}</li>
              </ol>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
