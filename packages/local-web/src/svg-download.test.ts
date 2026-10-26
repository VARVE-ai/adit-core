import { afterEach, expect, it, vi } from "vitest";
import { achievementDownload, badgeSvg, readmeCode } from "./achievement-export";
import { defaultProfilePreferences, profileDownload, profileItems, profileReadme, profileSvg, type ProfileData } from "./profile-export";
import { achievementRules } from "../../core/src/local-history/achievement-rules";
import type { AchievementItem, AchievementsData } from "../../core/src/local-history/achievements";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("downloads every profile and achievement variant as SVG with a matching filename and README link", async () => {
  vi.useFakeTimers();
  const link = {href: "", download: "", click: vi.fn(), remove: vi.fn()};
  vi.stubGlobal("document", {body: {append: vi.fn()}, createElement: (tag: string) => {
    expect(tag).toBe("a"); // SVG export must not require a canvas.
    return link;
  }});
  const blobs: Blob[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation(blob => {
    blobs.push(blob as Blob);
    return `blob:test-${blobs.length}`;
  });
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const check = async (filename: string, source: string, readme: string) => {
    const blob = blobs.at(-1)!;
    expect(blob.type).toBe("image/svg+xml;charset=utf-8");
    expect(await blob.text()).toBe(source);
    expect(link.download).toBe(filename);
    expect(readme).toContain(`.github/adit/${filename}`);
    expect(readme).not.toContain(".png");
  };
  const profile = {
    scope: {range: "all", first: "2026-10-01"},
    summary: {sessions: 3, prompts: 12, activeDays: 2, totalCommits: 5, linkedCommits: 2},
    profile: {through: "2026-10-02", repositories: 1, days: [], agents: [], models: [], submissionAnalyzed: true},
  } as unknown as ProfileData;
  for (const item of profileItems) {
    const prefs = {...defaultProfilePreferences(), selected: [item]};
    await profileDownload(profile, "中文工作区", prefs);
    await check(`${item}.svg`, profileSvg(profile, "中文工作区", prefs, item), profileReadme(prefs, "中文工作区"));
  }
  for (const rule of achievementRules) {
    for (const style of ["plain", "rich"] as const) {
      const item: AchievementItem = {
        key: rule.key, value: rule.thresholds[0], current: rule.thresholds[0], bestAt: 0, incomplete: 0, tier: 1,
        unlocks: [{id: rule.key, tier: 1, at: 0, discoveredAt: 0, unread: false}], evidence: [],
        options: {selected: true, style, showValue: true, showDate: true, showAgent: false, showPrompt: false},
      };
      const data = {status: "ready", workspaceName: "中文工作区", repositories: 1, timezone: "UTC", items: [item]} as AchievementsData;
      await achievementDownload(data, item.key);
      await check(`achv-${item.key}.svg`, badgeSvg(data, item), readmeCode([item]));
      await expect(achievementDownload({...data, items: [{...item, tier: 0}]}, item.key)).rejects.toThrow("No current unlocked selection");
    }
  }
  expect(blobs).toHaveLength(29);
  expect(link.click).toHaveBeenCalledTimes(29);
  expect(link.remove).toHaveBeenCalledTimes(29);
  vi.runAllTimers();
  expect(revoke).toHaveBeenCalledTimes(29);
});
