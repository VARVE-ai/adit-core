import { strToU8 } from "fflate";
import type { OverviewData } from "../../core/src/local-history/analytics";
import { pngBytes } from "./achievement-export";

export type ProfileData = OverviewData;
export const profileItems = [
  "card",
  "badge-commits",
  "badge-sessions",
  "badge-prompts",
  "badge-days",
  "badge-agents",
  "badge-model",
  "card-commits",
  "card-activity",
  "card-agents",
  "card-model",
] as const;
export type ProfileItem = (typeof profileItems)[number];
export type ProfilePreferences = {
  range: "all" | "30d";
  language: "en" | "zh";
  show: {
    activity: boolean;
    sessions: boolean;
    commits: boolean;
    agents: boolean;
    models: boolean;
    cost: boolean;
  };
  selected: ProfileItem[];
};
export function defaultProfilePreferences(): ProfilePreferences {
  return {
    range: "all",
    language: "en",
    show: {
      activity: true,
      sessions: true,
      commits: true,
      agents: true,
      models: true,
      cost: false,
    },
    selected: ["card"],
  };
}
export function readProfilePreferences(raw: string | null): ProfilePreferences {
  const defaults = defaultProfilePreferences();
  try {
    const p = JSON.parse(raw || "null");
    if (!p || typeof p !== "object") return defaults;
    return {
      range: p.range === "30d" ? "30d" : "all",
      language: p.language === "zh" ? "zh" : "en",
      show: Object.fromEntries(
        Object.entries(defaults.show).map(([key, value]) => [
          key,
          typeof p.show?.[key] === "boolean" ? p.show[key] : value,
        ]),
      ) as ProfilePreferences["show"],
      selected: Array.isArray(p.selected)
        ? [profileItems.find((k) => p.selected.includes(k)) || "card"]
        : defaults.selected,
    };
  } catch {
    return defaults;
  }
}
export const xml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
const textWidth = (text: string, size: number) =>
  Array.from(text).reduce(
    (n, c) => n + (c.charCodeAt(0) > 255 ? size : size * 0.55),
    0,
  );
const number = (value: number) => value.toLocaleString("en-US");
const pct = (n: number, total: number) =>
  total
    ? n > 0 && n / total < 0.01
      ? "<1%"
      : `${Math.round((n / total) * 100)}%`
    : "—";
export function profileDate(day: string | null, language: "en" | "zh" = "en") {
  return day && day !== "0000-01-01"
    ? new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
        timeZone: "UTC",
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(new Date(day + "T12:00:00Z"))
    : "—";
}
export function profileStart(data: ProfileData) {
  return data.scope.range === "all" ? data.scope.first : data.scope.from;
}
function profileRange(data: ProfileData, language: "en" | "zh", short = false) {
  const from = profileStart(data),
    to = data.profile.through;
  const format = (day: string, year: boolean) =>
    new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      ...(year ? { year: "numeric" as const } : {}),
    }).format(new Date(day + "T12:00:00Z"));
  return `${from ? format(from, from.slice(0, 4) !== to.slice(0, 4)) : "—"} – ${format(to, !short)}`;
}
const agentColor = (id: string) =>
  ({
    claude: "#e67b5d",
    codex: "#171717",
    cursor: "#7c6fd0",
    gemini: "#4385f5",
  })[id as "claude"] || "#5084db";
const shift = (day: string, n: number) =>
  new Date(Date.parse(day + "T12:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);
export function profileDays(data: ProfileData) {
  const start = profileStart(data),
    end = data.profile.through;
  if (!start || start > end) return [];
  const values = new Map(data.profile.days.map((d) => [d.date, d.count]));
  const days: { date: string; count: number }[] = [];
  for (let date = start; date <= end; date = shift(date, 1))
    days.push({ date, count: values.get(date) || 0 });
  return days;
}
const colors = {
  bg: "#ffffff",
  fg: "#172033",
  muted: "#64748b",
  border: "#e2e8f0",
  blue: "#3478db",
};
const heatColors = ["#eef2f6", "#d4e5fc", "#a7cafa", "#6ca3ed", "#3478db"];
function text(
  x: number,
  y: number,
  value: string,
  size = 12,
  fill = colors.fg,
  weight = 400,
) {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}">${xml(value)}</text>`;
}
function svg(w: number, h: number, title: string, body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"><title>${xml(title)}</title><g font-family="system-ui,Segoe UI,Arial,sans-serif">${body}</g></svg>`;
}
function heatmap(data: ProfileData, x: number, y: number, compact = false) {
  const days = profileDays(data),
    offset = days.length
      ? new Date(days[0].date + "T12:00:00Z").getUTCDay()
      : 0;
  // Multiple yearly bands retain the whole selected history, without truncating it.
  const columns = Math.ceil((days.length + offset) / 7),
    bands = Math.max(1, Math.ceil(columns / 52));
  const cell = compact
    ? 3
    : Math.min(
        15,
        Math.max(2, Math.floor(190 / Math.min(52, Math.max(1, columns))) - 3),
      );
  const gap = compact ? 1 : Math.min(3, cell),
    step = cell + gap;
  const max = Math.max(1, ...days.map((d) => d.count));
  const body = days
    .map((d, i) => {
      const col = Math.floor((i + offset) / 7),
        band = Math.floor(col / 52);
      const level = d.count ? Math.max(1, Math.ceil((d.count / max) * 4)) : 0;
      return `<rect x="${x + (col % 52) * step}" y="${y + (((i + offset) % 7) + band * 9) * step}" width="${cell}" height="${cell}" rx="${Math.min(3, cell / 5)}" fill="${heatColors[level]}"><title>${d.date}: ${d.count} prompts</title></rect>`;
    })
    .join("");
  return {
    body,
    width: Math.min(52, Math.max(1, columns)) * step - gap,
    height: (bands * 9 - 2) * step - gap,
  };
}
function wrap(value: string, width: number, size: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of value.split(/(?<=\s)|(?=[·])/)) {
    if (line && textWidth(line + word, size) > width) {
      lines.push(line.trim());
      line = "";
    }
    // Handle unusually long model identifiers without clipping.
    for (const c of word) {
      if (textWidth(line + c, size) > width) {
        lines.push(line.trim());
        line = "";
      }
      line += c;
    }
  }
  if (line) lines.push(line.trim());
  return lines.length ? lines : ["—"];
}
export function profileSvg(
  data: ProfileData,
  workspaceName: string,
  preferences: ProfilePreferences,
  item: ProfileItem,
) {
  const s = data.summary,
    p = data.profile,
    zh = preferences.language === "zh";
  const tr = (en: string, cn: string) => (zh ? cn : en);
  const linked = p.submissionAnalyzed ? number(s.linkedCommits) : "—";
  const commits = `${linked} / ${number(s.totalCommits)}`;
  const top = p.models[0];
  const agents = p.agents.map((a) => a.name).join(" · ") || "—";
  const range = profileRange(data, preferences.language);
  const values = {
    commits: [tr("commits in AI sessions", "AI 会话中的提交"), commits],
    sessions: [tr("AI sessions", "AI 会话"), number(s.sessions)],
    prompts: [tr("AI prompts", "AI 提问"), number(s.prompts)],
    days: [tr("AI active days", "AI 活跃天数"), number(s.activeDays)],
    agents: [tr("AI agents", "AI Agent"), agents],
    model: [tr("top model", "最常用模型"), top?.model || "—"],
  };
  if (item.startsWith("badge-")) {
    const [label, value] = values[item.slice(6) as keyof typeof values];
    const left = Math.ceil(textWidth(label, 11) + 39),
      right = Math.ceil(textWidth(value, 11) + 16),
      w = left + right;
    return svg(
      w,
      20,
      `${label}: ${value}`,
      `<clipPath id="r"><rect width="${w}" height="20" rx="3"/></clipPath><g clip-path="url(#r)"><path fill="#4b5563" d="M0 0h${left}v20H0z"/><path fill="${colors.blue}" d="M${left} 0h${right}v20H${left}z"/></g>${text(7, 14, "{><}", 9, "#e2e8f0")}${text(31, 14, label, 11, "#fff")}${text(left + 8, 14, value, 11, "#fff")}`,
    );
  }
  if (item !== "card") {
    const kind = item.slice(5);
    const label =
      kind === "commits"
        ? tr("COMMITS MADE IN AI SESSIONS", "在 AI 会话里完成的提交")
        : kind === "activity"
          ? tr("AI ACTIVITY", "AI 活跃度")
          : kind === "agents"
            ? tr("AI AGENTS USED", "用过的 AI AGENT")
            : tr("MOST-USED MODEL", "最常用模型");
    const value =
      kind === "commits"
        ? commits
        : kind === "activity"
          ? `${number(s.activeDays)} ${tr("active days", "天活跃")}`
          : kind === "agents"
            ? agents
            : top?.model || "—";
    const secondary =
      kind === "commits"
        ? p.submissionAnalyzed
          ? pct(s.linkedCommits, s.totalCommits)
          : "—"
        : kind === "activity"
          ? number(s.prompts)
          : kind === "agents"
            ? number(s.sessions)
            : top
              ? pct(top.count, s.prompts)
              : "—";
    const sublabel =
      kind === "commits"
        ? tr("of commits", "提交占比")
        : kind === "activity"
          ? tr("prompts", "次提问")
          : kind === "agents"
            ? tr("sessions", "个会话")
            : tr("of prompts", "提问占比");
    const heat = heatmap(data, 12, 10, true),
      x = kind === "activity" ? 16 + Math.min(60, heat.width) : 56;
    const labelText =
      kind === "activity"
        ? `${label} · ${profileRange(data, preferences.language, true).toUpperCase()}`
        : label;
    const valueSize = kind === "agents" ? 13 : 18;
    const contentWidth = Math.max(
      textWidth(labelText, 9.5),
      textWidth(value, valueSize),
    );
    const split = Math.ceil(x + contentWidth + 18),
      w = split + Math.max(84, Math.ceil(textWidth(secondary, 15) + 28));
    const art =
      kind === "activity"
        ? `<svg x="12" y="10" width="${Math.min(60, heat.width)}" height="35" viewBox="12 10 ${heat.width || 1} ${heat.height || 1}">${heat.body}</svg>`
        : `<rect x="12" y="12" width="32" height="32" rx="6" fill="#eff5fe"/>${text(16, 32, "{><}", 11, colors.blue, 600)}`;
    return svg(
      w,
      56,
      `${label}: ${value}, ${secondary} ${sublabel}`,
      `<rect x=".5" y=".5" width="${w - 1}" height="55" rx="8" fill="${colors.bg}" stroke="${kind === "commits" ? "#bdd3f4" : colors.border}"/>${art}${text(x, 19, labelText, 9.5, colors.muted, 600)}${text(x, 40, value, valueSize, colors.fg, 600)}<path d="M${split} 12v32" stroke="${colors.border}"/>${text(split + 12, 27, secondary, 15, colors.fg, 700)}${text(split + 12, 43, sublabel, 10.5, colors.muted)}`,
    );
  }
  const show = preferences.show,
    heat = heatmap(data, 24, 71);
  const mainX =
    show.activity && profileDays(data).length ? 24 + heat.width + 30 : 24;
  const available = 876 - mainX;
  const metrics: [string, string][] = [];
  if (show.commits)
    metrics.push([
      commits,
      tr("commits made in AI sessions", "在 AI 会话里完成的提交"),
    ]);
  if (show.sessions)
    metrics.push(
      [number(s.sessions), tr("sessions", "会话")],
      [number(s.prompts), tr("prompts", "提问")],
    );
  if (show.activity)
    metrics.push([number(s.activeDays), tr("active days", "活跃天数")]);
  if (show.cost)
    metrics.push([
      s.estimatedCost === null ? "—" : `$${(s.estimatedCost / 1e6).toFixed(2)}`,
      tr("estimated cost", "折算花费"),
    ]);
  let body =
    text(24, 37, "{><}", 13, colors.muted) +
    text(
      64,
      37,
      workspaceName.length > 38
        ? workspaceName.slice(0, 35) + "…"
        : workspaceName,
      17,
      colors.fg,
      600,
    );
  const nameW = Math.min(textWidth(workspaceName, 17), 365),
    subX = 76 + nameW;
  body += text(
    subX,
    37,
    `${tr("AI-assisted development", "AI 辅助开发")} · ${p.repositories} ${tr("repositories", "个仓库")}`,
    13,
    colors.muted,
  );
  const rangeY = subX + 260 + textWidth(range, 12) > 876 ? 57 : 37;
  body += text(876 - textWidth(range, 12), rangeY, range, 12, colors.muted);
  const topY = rangeY === 57 ? 89 : 71;
  if (show.activity && profileDays(data).length) {
    body += `<g transform="translate(0,${topY - 71})">${heat.body}${text(24, 71 + heat.height + 18, tr("Less", "少"), 10, colors.muted)}${heatColors.map((color, i) => `<rect x="${52 + i * 13}" y="${71 + heat.height + 9}" width="10" height="10" rx="2" fill="${color}"/>`).join("")}${text(120, 71 + heat.height + 18, tr("More", "多"), 10, colors.muted)}</g>`;
  }
  let x = mainX,
    y = topY + 22;
  for (const [value, label] of metrics) {
    const w = Math.max(textWidth(value, 24), textWidth(label, 12)) + 34;
    if (x > mainX && x + w > 910) {
      x = mainX;
      y += 65;
    }
    body +=
      text(x, y, value, 24, colors.fg, 600) +
      text(x, y + 22, label, 12, colors.muted);
    x += w;
  }
  y += metrics.length ? 54 : 4;
  if (show.agents || show.models)
    body += `<path d="M${mainX} ${y - 17}H876" stroke="${colors.border}"/>`;
  const modelParts = p.models
    .slice(0, 3)
    .map((m) => `${m.model} ${pct(m.count, s.prompts)}`);
  if (p.models.length > 3)
    modelParts.push(
      tr(`${p.models.length - 3} others`, `其余 ${p.models.length - 3} 个`),
    );
  if (p.unknownModelPrompts)
    modelParts.push(
      tr(
        `Unknown ${pct(p.unknownModelPrompts, s.prompts)}`,
        `未知 ${pct(p.unknownModelPrompts, s.prompts)}`,
      ),
    );
  for (const [enabled, label, parts] of [
    [
      show.agents,
      tr("Agents", "Agent"),
      p.agents.map((a) => ({
        label: `${a.name} ${pct(a.count, s.prompts)}`,
        color: agentColor(a.id),
      })),
    ],
    [
      show.models,
      tr("Models", "模型"),
      modelParts.map((label) => ({ label, color: "" })),
    ],
  ] as const)
    if (enabled) {
      body += text(mainX, y, label, 12, colors.muted);
      let offset = mainX + 68;
      for (const part of parts.length ? parts : [{ label: "—", color: "" }]) {
        const width = textWidth(part.label, 12) + (part.color ? 14 : 0);
        if (offset > mainX + 68 && offset + width > 876) {
          offset = mainX + 68;
          y += 22;
        }
        if (part.color) {
          body += `<circle cx="${offset + 4}" cy="${y - 4}" r="4" fill="${part.color}"/>`;
          offset += 14;
        }
        const lines = wrap(part.label, available - 68, 12);
        for (const [i, line] of lines.entries()) {
          if (i) {
            y += 22;
            offset = mainX + 68;
          }
          body += text(offset, y, line, 12);
        }
        offset += textWidth(lines.at(-1) || "", 12) + 16;
      }
      y += 22;
    }
  y = Math.max(
    y,
    show.activity && profileDays(data).length
      ? topY + heat.height + 24
      : topY + 30,
  );
  const footer = tr(
    "Generated by ADIT from the author's local session history · counts the author's own commits on this machine",
    "由 ADIT 根据作者本地会话历史生成 · 只统计作者在这台电脑上的提交",
  );
  body += text(24, y + 20, footer, 11, colors.muted);
  return svg(
    900,
    y + 40,
    `${workspaceName} · ${tr("AI-assisted development", "AI 辅助开发")}`,
    `<rect x=".5" y=".5" width="899" height="${y + 39}" rx="8" fill="${colors.bg}" stroke="${colors.border}"/>${body}`,
  );
}
export function profileReadme(
  preferences: ProfilePreferences,
  workspaceName: string,
  format: "png" = "png",
) {
  const selected = profileItems.filter((k) => preferences.selected.includes(k)).slice(0, 1);
  const alt = xml(workspaceName).replace(/[\[\]\r\n]/g, " ");
  const plain = selected
    .filter((k) => k.startsWith("badge-"))
    .map(
      (k) =>
        `![${k === "badge-commits" ? "commits in AI sessions" : k.slice(6)}](.github/adit/${k}.${format})`,
    )
    .join("\n");
  const rich = selected
    .filter((k) => k.startsWith("card-"))
    .map(
      (k) =>
        `<img src=".github/adit/${k}.${format}" height="56" alt="${k.slice(5)}">`,
    )
    .join(" ");
  const wide = selected.includes("card")
    ? `## AI-assisted development\n\n![${alt} AI-assisted development](.github/adit/card.${format})`
    : "";
  return [plain, rich, wide].filter(Boolean).join("\n\n");
}
export async function profileFiles(
  data: ProfileData,
  name: string,
  preferences: ProfilePreferences,
  format: "png" = "png",
) {
  const items = profileItems.filter((k) => preferences.selected.includes(k)).slice(0, 1);
  if (!items.length) throw new Error("No images selected");
  const files: Record<string, Uint8Array> = {};
  for (const item of items) {
    const source = profileSvg(data, name, preferences, item);
    files[`.github/adit/${item}.${format}`] = await pngBytes(source);
  }
  files["README.md"] = strToU8(profileReadme(preferences, name, format));
  return files;
}
export async function profileDownload(
  data: ProfileData,
  name: string,
  preferences: ProfilePreferences,
  format: "png" = "png",
) {
  const files = await profileFiles(data, name, preferences, format),
    images = Object.keys(files).filter((k) => k !== "README.md");
  const blob = new Blob([new Uint8Array(files[images[0]])], { type: "image/png" });
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = images[0].split("/").pop()!;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
