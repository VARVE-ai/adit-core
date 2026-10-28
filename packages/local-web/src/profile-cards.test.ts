import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { ProfileCardsPage } from "./profile-cards";
import { setLanguage } from "./i18n";

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
it("keeps all six list previews plain while preserving style, metric selection and wide card across reload", async () => {
  const storage = new Map<string, string>([["adit-profile-v1:test", '{"language":"zh"}']]);
  vi.stubGlobal("localStorage", {getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value)});
  vi.stubGlobal("window", {setInterval: () => 1, clearInterval: () => {}});
  setLanguage("zh");
  const api = vi.fn(async () => ({
    scope: {range: "all", first: "2026-10-01"},
    summary: {sessions: 4, prompts: 10, activeDays: 2, totalCommits: 3, linkedCommits: 2},
    profile: {through: "2026-10-02", repositories: 1, days: [], agents: [], models: [], submissionAnalyzed: true},
  }));
  const mount = async () => {
    await act(async () => { renderer = create(React.createElement(ProfileCardsPage, {
      workspace: {id: "test", name: "Test", path: "/test", repositories: [], providers: [], version: 1},
      api: api as any, tab: "profile-cards", onOverview() {}, onTab() {},
    })); });
  };
  await mount();
  const radios = () => renderer!.root.findAllByProps({name: "profile-export-item"});
  const style = (label: string) => renderer!.root.findByProps({name: "profile-badge-style", "aria-label": label});
  const wide = renderer!.root.findByProps({className: "profile-wide"}).props.src;
  const listImages = () => renderer!.root.findByProps({className: "profile-badges"}).findAllByType("img").map(img => img.props.src);
  const plainListImages = listImages();
  expect(radios()).toHaveLength(7);
  expect(renderer!.root.findAllByType("button").some(b => b.children.includes("English") || b.children.includes("中文"))).toBe(false);
  expect(decodeURIComponent(wide)).toContain("AI-assisted development");
  expect(decodeURIComponent(wide)).not.toContain("AI 辅助开发");
  await act(async () => style("精美").props.onChange());
  expect(radios()[0].props.checked).toBe(true);
  for (const radio of radios().slice(1)) {
    const name = radio.props["aria-label"];
    await act(async () => radio.props.onChange());
    const previews = renderer!.root.findByProps({className: "ach-styles"}).findAllByType("img");
    expect(previews).toHaveLength(2);
    const previewSources = previews.map(img => img.props.src);
    for (const label of ["普通", "精美"]) {
      await act(async () => style(label).props.onChange());
      expect(radios().filter(r => r.props.checked).map(r => r.props["aria-label"])).toEqual([name]);
      expect(radios()).toHaveLength(7);
      expect(renderer!.root.findByProps({className: "ach-styles"}).findAllByType("img").map(img => img.props.src)).toEqual(previewSources);
      const selectedRow = radios().find(r => r.props.checked)!.parent!;
      expect(selectedRow.findByType("img").props.src).toBe(previewSources[0]);
      expect(listImages()).toEqual(plainListImages);
      expect(renderer!.root.findByType("pre").children.join("")).toContain(label === "精美" ? "/card-" : "/badge-");
    }
  }
  expect(renderer!.root.findByProps({className: "profile-wide"}).props.src).toBe(wide);
  expect(api).toHaveBeenCalledTimes(1);
  act(() => renderer!.unmount());
  await mount();
  expect(style("精美").props.checked).toBe(true);
  expect(listImages()).toEqual(plainListImages);
  expect(radios().find(r => r.props.checked)?.props["aria-label"]).toBe("最常用模型");
  expect(renderer!.root.findByType("pre").children.join("")).toContain("card-model.svg");
});
