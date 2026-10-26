import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { fitOverviewBadges, OverviewBadges } from "./overview-badges";
import { defaultProfilePreferences, profileBadgePairs, profileSvg, type ProfileData } from "./profile-export";
import { badgeSvg, svgUrl } from "./achievement-export";
import { achievementRules } from "../../core/src/local-history/achievement-rules";
import type { AchievementsData } from "../../core/src/local-history/achievements";

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
const workspace = {id: "test", name: "Test"};
const data = {
  scope: {workspaceId: "test", range: "all", first: "2026-10-01"},
  summary: {sessions: 143, prompts: 3118, activeDays: 20, totalCommits: 476, linkedCommits: 147},
  profile: {through: "2026-10-26", repositories: 1, days: [], agents: [{id: "codex", name: "Codex", count: 3118}], models: [{model: "gpt-6", count: 3118}], submissionAnalyzed: true},
} as unknown as ProfileData;
const achievements: AchievementsData = {
  workspaceId: "test", workspaceName: "Test", timezone: "UTC", repositories: 1, status: "ready",
  evaluatedAt: 0, firstAt: 0, sourceErrors: 0, error: null, revision: "1", notify: true, unread: 0, backfillCount: 8,
  items: achievementRules.map(rule => ({
    key: rule.key, value: rule.thresholds[0], current: rule.thresholds[0], bestAt: null, tier: 1, incomplete: 0, unlocks: [],
    evidence: [{at: 0, prompt: "private prompt", messages: 1}],
    options: {selected: false, style: "rich", showValue: false, showDate: true, showAgent: true, showPrompt: true},
  })),
};
it("fills the available row with whole badges, including exact fits and skipping oversized items", () => {
  const items = [{width: 100}, {width: 300}, {width: 80}];
  expect(fitOverviewBadges(items, 186)).toEqual([items[0], items[2]]);
  expect(fitOverviewBadges(items, 185)).toEqual([items[0]]);
  expect(fitOverviewBadges(items, 80)).toEqual([items[2]]);
  expect(fitOverviewBadges(items, 0)).toEqual([]);
  expect(fitOverviewBadges(items, 492)).toEqual(items);
});
it("reuses all six profile badges and unlocked achievements, responds to width changes without querying again", async () => {
  let width = 5000;
  let resize = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect = disconnect;
  });
  vi.stubGlobal("localStorage", {getItem: () => null});
  const api = vi.fn(async () => achievements);
  const onProfileCards = vi.fn();
  await act(async () => {
    renderer = create(React.createElement(OverviewBadges, {workspace, data, api: api as any, refresh: "1", onProfileCards}), {
      createNodeMock: element => element.props.className === "overview-badge-list" ? {getBoundingClientRect: () => ({width})} : null,
    });
  });
  const images = () => renderer!.root.findAllByType("img");
  const fullImages = images().map(img => img.props.src);
  expect(images()).toHaveLength(14);
  for (const [i, [plain]] of profileBadgePairs.entries()) {
    expect(fullImages[i]).toBe(svgUrl(profileSvg(data, "Test", defaultProfilePreferences(), plain)));
  }
  for (const [i, item] of achievements.items.entries()) {
    expect(fullImages[i + 6]).toBe(svgUrl(badgeSvg(achievements, {...item, options: {...item.options, showValue: true, showDate: false, showAgent: false, showPrompt: false}}, "plain")));
    expect(decodeURIComponent(fullImages[i + 6])).not.toContain("private prompt");
  }
  const widths = images().map(img => img.props.width);
  expect(widths.every(w => w > 0)).toBe(true);
  for (width of [1100, 600, 180, 0, 5000]) {
    act(() => resize());
    const visible = images();
    expect(visible.reduce((sum, img) => sum + img.props.width, 0) + Math.max(0, visible.length - 1) * 6).toBeLessThanOrEqual(width);
    for (const hiddenWidth of widths.filter((_, i) => !visible.some(img => img.props.src === fullImages[i]))) {
      const used = visible.reduce((sum, img) => sum + img.props.width + 6, 0);
      expect(used + hiddenWidth).toBeGreaterThan(width);
    }
    expect(renderer!.root.findAllByType("button")).toHaveLength(1);
  }
  expect(images()).toHaveLength(14);
  expect(api).toHaveBeenCalledTimes(1);
  act(() => renderer!.root.findByType("button").props.onClick());
  expect(onProfileCards).toHaveBeenCalledOnce();
  api.mockResolvedValue({...achievements, items: achievements.items.map(item => ({...item, tier: 0}))});
  await act(async () => renderer!.update(React.createElement(OverviewBadges, {workspace, data, api: api as any, refresh: "2", onProfileCards})));
  expect(images()).toHaveLength(6);
  act(() => renderer!.unmount());
  expect(disconnect).toHaveBeenCalledOnce();
});
it("does not display the previous workspace's badges while a new workspace is loading", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("localStorage", {getItem: () => null});
  const api = vi.fn(async () => achievements);
  await act(async () => {
    renderer = create(React.createElement(OverviewBadges, {workspace, data, api: api as any, refresh: "1"}), {
      createNodeMock: () => ({getBoundingClientRect: () => ({width: 5000})}),
    });
  });
  expect(renderer!.root.findAllByType("img")).toHaveLength(14);
  await act(async () => renderer!.update(React.createElement(OverviewBadges, {workspace: {...workspace, id: "other"}, data, api: api as any, refresh: "1"})));
  expect(renderer!.root.findAllByType("img")).toHaveLength(0);
});
