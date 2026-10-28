import React, { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentFilters } from "./agent-filters";
import { AgentLabel } from "./agent-label";
import { setLanguage } from "./i18n";

const providers = [
  { id: "claude", name: "Claude Code", count: 20 },
  { id: "codex", name: "Codex", count: 40 },
  { id: "cursor", name: "Cursor", count: 10 },
  { id: "deepseek-tui", name: "DeepSeek Harness", count: 4 },
  { id: "vscode", name: "VSCode Copilot", count: 2 },
];
let renderer: ReactTestRenderer;
let nodes: Array<{ props: Record<string, any>; focus: () => void }>;
let doc: EventTarget & { activeElement: unknown; documentElement: { lang: string } };
beforeEach(() => {
  nodes = [];
  doc = Object.assign(new EventTarget(), { activeElement: null, documentElement: { lang: "en-US" } });
  vi.stubGlobal("document", doc);
  setLanguage("en");
});
afterEach(() => { act(() => renderer?.unmount()); vi.unstubAllGlobals(); });

function render(available = providers) {
  const onChange = vi.fn();
  function Harness() {
    const [value, setValue] = useState("all");
    return React.createElement(AgentFilters, { providers: available, value,
      onChange: id => { onChange(id); setValue(id); } });
  }
  act(() => {
    renderer = create(React.createElement(Harness), { createNodeMock: element => {
      const node = { props: element.props, focus: () => { doc.activeElement = node; },
        contains: (target: unknown) => nodes.includes(target as typeof node) };
      nodes.push(node);
      return node;
    } });
  });
  return onChange;
}
const trigger = () => renderer.root.findByProps({ "aria-haspopup": "menu" });
const menu = () => renderer.root.findByProps({ role: "menu" });
const options = () => renderer.root.findAllByProps({ role: "menuitemradio" });
const active = () => (doc.activeElement as typeof nodes[number]).props;
const press = (key: string) => act(() => menu().props.onKeyDown({ key, preventDefault: vi.fn() }));

it("keeps the three most-used agents visible in their original order and preserves overflow selection", () => {
  const onChange = render();
  expect(renderer.root.findAllByType(AgentLabel).map(n => n.props.provider)).toEqual(["claude", "codex", "cursor"]);
  expect(trigger().children).toContain("More · 2");
  act(() => trigger().props.onClick());
  expect(options().map(n => n.findByType(AgentLabel).props.provider)).toEqual(["deepseek-tui", "vscode"]);
  act(() => options()[0].props.onClick());
  expect(onChange).toHaveBeenLastCalledWith("deepseek-tui");
  expect(trigger().findByType(AgentLabel).props.name).toBe("DeepSeek Harness");
  expect(trigger().props["aria-expanded"]).toBe(false);
  act(() => trigger().props.onClick());
  expect(options()[0].props["aria-checked"]).toBe(true);
  expect(active()["aria-checked"]).toBe(true);
  press("Escape");
  act(() => renderer.root.findAllByType("button")[0].props.onClick());
  expect(onChange).toHaveBeenLastCalledWith("all");
  expect(trigger().children).toContain("More · 2");
});

it("uses counts rather than vendor names to choose shortcuts, without mutating the provider list", () => {
  const available = providers.map(p => ({ ...p, count: p.id === "vscode" ? 100 : p.count }));
  render(available);
  expect(renderer.root.findAllByType(AgentLabel).map(n => n.props.provider)).toEqual(["claude", "codex", "vscode"]);
  expect(available.map(p => p.id)).toEqual(providers.map(p => p.id));
});

it("supports keyboard navigation, Escape and dismissal outside the menu", () => {
  render();
  act(() => trigger().props.onKeyDown({ key: "ArrowUp", preventDefault: vi.fn() }));
  expect(active()["aria-checked"]).toBe(false);
  const last = doc.activeElement;
  press("Home");
  expect(doc.activeElement).not.toBe(last);
  press("ArrowDown");
  expect(doc.activeElement).toBe(last);
  press("ArrowDown");
  expect(doc.activeElement).not.toBe(last);
  press("End");
  expect(doc.activeElement).toBe(last);
  press("Escape");
  expect(trigger().props["aria-expanded"]).toBe(false);
  expect(active()["aria-haspopup"]).toBe("menu");
  for (const event of ["pointerdown", "focusin"]) {
    act(() => trigger().props.onClick());
    act(() => { doc.dispatchEvent(new Event(event)); });
    expect(trigger().props["aria-expanded"]).toBe(false);
  }
});

it.each([0, 1, 2, 3])("does not show an empty menu for %s agents", count => {
  render(providers.slice(0, count));
  expect(renderer.root.findAllByType("button")).toHaveLength(count + 1);
  expect(renderer.root.findAllByProps({ "aria-haspopup": "menu" })).toHaveLength(0);
});

it("translates the collapsed trigger and menu in Chinese", () => {
  setLanguage("zh");
  render();
  expect(trigger().children).toContain("更多 · 2");
  act(() => trigger().props.onClick());
  expect(menu().props["aria-label"]).toBe("更多 Agent");
});
