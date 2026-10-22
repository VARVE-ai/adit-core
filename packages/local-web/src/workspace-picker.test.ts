import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePicker } from "./workspace-picker";
import { setLanguage } from "./i18n";

const workspaces = [
  { id: "adit", name: "Adit", path: "/Users/test/Developer/adit" },
  { id: "bro", name: "Bro", path: "/Users/test/Developer/workbench" },
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
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
function render(options = workspaces) {
  const onSelect = vi.fn();
  act(() => {
    renderer = create(React.createElement(WorkspacePicker, { workspaces: options, selectedId: "adit", onSelect }), {
      createNodeMock: element => {
        const node = {
          props: element.props,
          focus: () => { doc.activeElement = node; },
          contains: (target: unknown) => nodes.includes(target as typeof node),
          querySelectorAll: () => nodes.filter(n => n.props.role === "menuitemradio"),
        };
        nodes.push(node);
        return node;
      },
    });
  });
  return onSelect;
}
const trigger = () => renderer.root.findByProps({ className: "workspace-picker-trigger" });
const menu = () => renderer.root.findByProps({ role: "menu" });
const input = () => renderer.root.findByType("input");
function key(value: string) {
  act(() => { menu().props.onKeyDown({ key: value, target: doc.activeElement, preventDefault: vi.fn() }); });
}

describe("custom workspace picker", () => {
  it("filters names and paths, indicates selection and selects without a native select", () => {
    const onSelect = render();
    expect(renderer.root.findAllByType("select")).toHaveLength(0);
    act(() => trigger().props.onClick());
    expect(renderer.root.findByProps({ role: "menuitemradio", "aria-checked": true }).props.title).toBe(workspaces[0].path);
    act(() => input().props.onChange({ target: { value: "WORKBENCH" } }));
    const option = renderer.root.findByProps({ role: "menuitemradio" });
    expect(option.props.title).toBe(workspaces[1].path);
    act(() => option.props.onClick());
    expect(onSelect).toHaveBeenCalledWith("bro");
    expect(trigger().props["aria-expanded"]).toBe(false);
    act(() => trigger().props.onClick());
    expect(input().props.value).toBe("");
    act(() => input().props.onChange({ target: { value: "adit" } }));
    expect(renderer.root.findByProps({ role: "menuitemradio" }).props["aria-checked"]).toBe(true);
  });

  it("supports arrow navigation and Escape with focus restored to the trigger", () => {
    render();
    act(() => trigger().props.onKeyDown({ key: "ArrowDown", preventDefault: vi.fn() }));
    // Test-renderer creates referenced nodes only; request the row DOM nodes as a browser would.
    renderer.root.findAllByProps({ role: "menuitemradio" }).forEach(row => {
      const node = { props: row.props, focus: () => { doc.activeElement = node; } };
      nodes.push(node);
    });
    expect((doc.activeElement as typeof nodes[number]).props["aria-label"]).toBe("Search workspaces…");
    key("ArrowDown");
    expect((doc.activeElement as typeof nodes[number]).props.title).toBe(workspaces[0].path);
    key("ArrowDown");
    expect((doc.activeElement as typeof nodes[number]).props.title).toBe(workspaces[1].path);
    key("Home");
    expect((doc.activeElement as typeof nodes[number]).props.title).toBe(workspaces[0].path);
    key("Escape");
    expect(trigger().props["aria-expanded"]).toBe(false);
    expect((doc.activeElement as typeof nodes[number]).props.className).toBe("workspace-picker-trigger");
  });

  it("closes on outside interaction and shows an empty search result", () => {
    render();
    act(() => trigger().props.onClick());
    act(() => input().props.onChange({ target: { value: "missing" } }));
    expect(renderer.root.findByProps({ role: "status" }).children).toEqual(["No matching workspaces"]);
    act(() => { doc.dispatchEvent(new Event("pointerdown")); });
    expect(trigger().props["aria-expanded"]).toBe(false);
  });

  it("shows an empty workspace state", () => {
    render([]);
    act(() => trigger().props.onClick());
    expect(renderer.root.findByProps({ role: "status" }).children).toEqual(["No workspaces yet"]);
  });
});
