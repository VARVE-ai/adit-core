import type {
  AchievementsData,
  AchievementItem,
} from "../../core/src/local-history/achievements";
import {
  achievementRules,
  type AchievementKey,
} from "../../core/src/local-history/achievement-rules";
import { ac } from "./achievement-copy";
import { getLanguage, locale } from "./i18n";

export const ruleFor = (key: AchievementKey) =>
  achievementRules.find((r) => r.key === key)!;
export const achievementName = (key: AchievementKey) =>
  getLanguage() === "zh" ? ruleFor(key).zh : ruleFor(key).name;
export const agentName = (name?: string) =>
  ({
    codex: "Codex",
    claude: "Claude Code",
    cursor: "Cursor",
    "vscode-copilot": "GitHub Copilot",
  })[name || ""] ||
  name ||
  "Agent";
export const earnedAt = (item: AchievementItem) =>
  item.unlocks.find((u) => u.tier === item.tier)?.at ?? null;
export const achievementDate = (
  at: number | null,
  timezone: string,
  time = false,
) =>
  at === null
    ? ac("日期未知")
    : new Intl.DateTimeFormat(locale(), {
        timeZone: timezone,
        year: "numeric",
        month: "short",
        day: "numeric",
        ...(time ? ({ hour: "2-digit", minute: "2-digit" } as const) : {}),
      }).format(at);
export function achievementValue(key: AchievementKey, value: number | null) {
  if (value === null) return "—";
  const n = new Intl.NumberFormat(locale()).format(value);
  switch (ruleFor(key).unit) {
    case "duration": {
      const h = Math.floor(value / 3600000),
        m = Math.floor((value % 3600000) / 60000);
      return !m
        ? ac("{0} 小时", h)
        : !h
          ? ac("{0} 分钟", m)
          : ac("{0} 小时 {1} 分", h, m);
    }
    case "agents":
      return ac("{0} 个", n);
    case "workdays":
      return ac("{0} 个工作日", n);
    case "commits":
      return ac("{0} 个提交", n);
    case "commands":
      return ac("{0} 条命令", n);
    case "runs":
      return ac("{0} 次", n);
    case "days":
      return ac("{0} 天", n);
  }
}
export function badgeMetric(key: AchievementKey, value: number | null) {
  if (value === null) return "—";
  const n = new Intl.NumberFormat("en-US").format(value),
    hours = Math.floor(value / 3600000),
    minutes = Math.floor((value % 3600000) / 60000);
  switch (key) {
    case "marathon":
      return `${hours}h ${minutes}m on one prompt`;
    case "multitasker":
      return `${n} agents at once`;
    case "streak":
      return `${n} workdays`;
    case "shipper":
      return `${n} commits in one session`;
    case "commander":
      return `${n} commands run`;
    case "hands-off":
      return `${n} runs over 30 min`;
    case "centurion":
      return `${hours} agent hours`;
    case "full-month":
      return `${n} active days`;
  }
}
export function achievementDescription(item: AchievementItem) {
  const n = new Intl.NumberFormat(locale()).format(item.value || 0);
  switch (item.key) {
    case "marathon":
      return ac(
        "一句话让 Agent 连续干了 {0}",
        achievementValue(item.key, item.value),
      );
    case "multitasker":
      return ac("同时有 {0} 个 Agent 在干活", n);
    case "streak":
      return ac("连续 {0} 个工作日都在用 Agent", n);
    case "shipper":
      return ac(
        "一个 {0} 会话里交了 {1} 个提交",
        agentName(item.evidence[0]?.provider),
        n,
      );
    case "commander":
      return ac("Agent 替你跑了 {0} 条命令", n);
    case "hands-off":
      return ac("{0} 次一句话让 Agent 干了半小时以上", n);
    case "centurion":
      return ac("Agent 替你干满 {0}", achievementValue(item.key, item.value));
    case "full-month":
      return ac("用 Agent 满 {0} 天", n);
  }
}
const xml = (value: string) =>
  value.replace(
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
const width = (text: string) =>
  Array.from(text).reduce(
    (sum, c) => sum + (c.charCodeAt(0) > 255 ? 12 : 6.5),
    0,
  );
export function badgeSvg(
  data: AchievementsData,
  item: AchievementItem,
  style = item.options.style,
) {
  const o = item.options,
    name = ruleFor(item.key).name.toLowerCase();
  const parts: string[] = [];
  if (o.showValue)
    parts.push(
      badgeMetric(
        item.key,
        item.tier ? item.value : ruleFor(item.key).thresholds[0],
      ),
    );
  const date = earnedAt(item),
    dateText =
      date === null
        ? "Date unknown"
        : new Intl.DateTimeFormat("en-US", {
            timeZone: data.timezone,
            month: "short",
            day: "numeric",
            year: "numeric",
          }).format(date);
  if (o.showDate && item.tier && style === "plain") parts.push(dateText);
  if (o.showAgent)
    parts.push(
      [...new Set(item.evidence.map((e) => agentName(e.provider)))].join(
        ", ",
      ) || "—",
    );
  if (o.showPrompt && item.evidence[0]?.prompt)
    parts.push(item.evidence[0].prompt);
  const level = item.tier ? `LEVEL ${item.tier} OF 3` : "LOCKED";
  const detail = parts.join(" · ") || level;
  const title = `${name} · ${level} · ${detail}`;
  const font = "system-ui,Segoe UI,Arial,sans-serif";
  if (style === "plain") {
    const left = Math.ceil(width(name) + 42),
      right = Math.ceil(width(detail) + 24),
      w = left + right;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" viewBox="0 0 ${w} 20" role="img"><title>${xml(title)}</title><clipPath id="r"><rect width="${w}" height="20" rx="3"/></clipPath><g clip-path="url(#r)"><path fill="#292929" d="M0 0h${left}v20H0z"/><path fill="#c67400" d="M${left} 0h${right}v20H${left}z"/></g><g font-family="${font}" font-size="11"><text x="7" y="14" fill="#e2e8f0" font-size="9">{&gt;&lt;}</text><text x="34" y="14" fill="#ffffff">${xml(name)}</text><text x="${left + 12}" y="14" fill="#ffffff">${xml(detail)}</text></g></svg>`;
  }
  const lines = [detail];
  if (width(detail) * 1.5 > 282) {
    lines.length = 0;
    let line = "";
    for (const c of detail) {
      if (width(line + c) * 1.5 > 282) {
        lines.push(line);
        line = "";
      }
      line += c;
    }
    if (line) lines.push(line);
  }
  const h = 56 + (lines.length - 1) * 22;
  const shortDate =
    date === null
      ? "Unknown"
      : new Intl.DateTimeFormat("en-US", {
          timeZone: data.timezone,
          month: "short",
          day: "numeric",
        }).format(date);
  const year =
    date === null
      ? ""
      : new Intl.DateTimeFormat("en-US", {
          timeZone: data.timezone,
          year: "numeric",
        }).format(date);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="${h}" viewBox="0 0 440 ${h}" role="img"><title>${xml(title)}</title><rect x=".5" y=".5" width="439" height="${h - 1}" rx="8" fill="#ffffff" stroke="#d89a43"/><rect x="12" y="12" width="32" height="32" rx="6" fill="#c67400"/><circle cx="28" cy="24" r="6" fill="none" stroke="#ffffff" stroke-width="1.5"/><path d="m24 29-1 8 5-3 5 3-1-8" fill="none" stroke="#ffffff" stroke-width="1.5"/><g font-family="${font}"><text x="56" y="14" fill="#64748b" font-size="9.5" font-weight="600">${xml(name.toUpperCase())} · ${level}</text>${lines.map((line, i) => `<text x="56" y="${34 + i * 22}" fill="#172033" font-size="18" font-weight="600">${xml(line)}</text>`).join("")}<text x="56" y="${h - 7}" fill="#64748b" font-size="9">ADIT · ${xml(data.workspaceName.slice(0, 36))} · ${data.repositories} repos</text>${o.showDate && item.tier ? `<path d="M350 12v${h - 24}" stroke="#d89a43"/><text x="394" y="26" text-anchor="middle" fill="#172033" font-size="15" font-weight="700">${xml(shortDate)}</text><text x="394" y="42" text-anchor="middle" fill="#64748b" font-size="10.5">${xml(year)}</text>` : ""}</g></svg>`;
}
export const svgUrl = (svg: string) =>
  "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
export const readmeCode = (items: AchievementItem[], format: "png" = "png") =>
  items
    .slice(0, 1)
    .map(
      (i) => `![${ruleFor(i.key).name}](.github/adit/achv-${i.key}.${format})`,
    )
    .join("\n");
export async function pngBytes(svg: string): Promise<Uint8Array> {
  const img = new Image();
  img.src = svgUrl(svg);
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.width * 2;
  canvas.height = img.height * 2;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("PNG unavailable"))),
      "image/png",
    ),
  );
  return new Uint8Array(await blob.arrayBuffer());
}
export async function achievementDownload(
  data: AchievementsData,
  expectedKey: AchievementKey,
) {
  const items = data.items.filter((i) => i.tier && i.options.selected);
  if (data.status !== "ready" || items.length !== 1 || items[0].key !== expectedKey)
    throw new Error("No current unlocked selection");
  const bytes = await pngBytes(badgeSvg(data, items[0]));
  const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = `achv-${items[0].key}.png`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
