import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OverviewPage } from "./overview";
import { AgentFilters } from "./agent-filters";
import { AgentLabel } from "./agent-label";
import { setLanguage } from "./i18n";

const agents = [
  { id: "vscode-copilot", name: "VSCode Copilot" },
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "deepseek-tui", name: "DeepSeek Harness" },
  { id: "cursor", name: "Cursor" },
];
const data = {
  scope: { workspaceId: "test", year: 2026, activityRange: "12m", to: "2026-10-27" },
  agents,
  summary: {},
  activity: { days: [], hours: [], years: [2026], peakHours: [], period: {} },
  costs: { daily: [], models: [], prices: {} },
  usage: { totals: {} },
  coverage: {},
  averageCommitCost: {},
};
let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("document", Object.assign(new EventTarget(), { documentElement: { lang: "en" } }));
  vi.stubGlobal("localStorage", { getItem: () => "en", setItem() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  setLanguage("en");
});
afterEach(() => { act(() => renderer?.unmount()); vi.unstubAllGlobals(); });

it("keeps three overview agents visible and applies overflow selection without resetting the time range", async () => {
  const api = vi.fn(async (url: string) => url.startsWith("/overview?") ? data : {});
  await act(async () => {
    renderer = create(React.createElement(OverviewPage, {
      workspace: { id: "test", name: "Test", started: true, cloud: { enabled: false } },
      jobs: [], api: api as any, onSettings() {}, onNavigate() {},
    }), { createNodeMock: () => ({ focus() {}, getBoundingClientRect: () => ({ width: 800 }) }) });
  });
  const filters = () => renderer.root.findByType(AgentFilters);
  expect(filters().findAllByType(AgentLabel).map(n => n.props.provider)).toEqual(agents.slice(0, 3).map(a => a.id));
  await act(async () => renderer.root.findByProps({ className: "overview-segment" }).findAllByType("button")[0].props.onClick());
  await act(async () => filters().findByProps({ "aria-haspopup": "menu" }).props.onClick());
  expect(filters().findAllByProps({ role: "menuitemradio" })).toHaveLength(2);
  await act(async () => filters().findAllByProps({ role: "menuitemradio" })[0].props.onClick());
  const last = api.mock.calls.filter(([url]) => url.startsWith("/overview?")).at(-1)![0];
  expect(Object.fromEntries(new URL(last, "http://localhost").searchParams)).toMatchObject({
    range: "7d", provider: "deepseek-tui", activityRange: "12m",
  });
  expect(filters().findByProps({ "aria-haspopup": "menu" }).findByType(AgentLabel).props.name).toBe("DeepSeek Harness");
  expect(renderer.root.findByProps({ className: "overview-agent-legend" }).findAllByType(AgentLabel).map(n => n.props.provider)).toEqual(["deepseek-tui"]);
  await act(async () => filters().findAllByType("button")[0].props.onClick());
  expect(filters().props.value).toBe("all");
});
