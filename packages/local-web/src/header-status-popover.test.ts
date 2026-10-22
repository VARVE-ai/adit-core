import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HeaderStatusPopover } from "./header-status-popover";

let renderer: ReactTestRenderer;
let doc: EventTarget;
let win: EventTarget;
let triggerFocus: ReturnType<typeof vi.fn>;
let actionFocus: ReturnType<typeof vi.fn>;
beforeEach(() => {
  doc = new EventTarget(); win = Object.assign(new EventTarget(), { innerWidth: 360 });
  vi.stubGlobal("document", doc); vi.stubGlobal("window", win);
  triggerFocus = vi.fn(); actionFocus = vi.fn();
});
afterEach(() => { act(() => renderer?.unmount()); vi.unstubAllGlobals(); });

function render() {
  const action = vi.fn();
  act(() => {
    renderer = create(React.createElement(HeaderStatusPopover, {
      title: "Local collection", label: "Local collection · Updated", workspaceName: "Adit",
      icon: React.createElement("span"), status: "done",
      children: React.createElement("button", { onClick: action }, "Collect again"),
    }), { createNodeMock: element => ({
      getBoundingClientRect: () => ({ left: 300 }),
      contains: () => false,
      querySelector: () => ({ focus: actionFocus }),
      focus: element.props.className === "icon header-status-trigger" ? triggerFocus : vi.fn(),
    }) });
  });
  return action;
}
const trigger = () => renderer.root.findByProps({ className: "icon header-status-trigger" });
const region = () => renderer.root.findAllByProps({ role: "region" });

it("opens without running the action, positions within a narrow viewport and restores focus on Escape", () => {
  const action = render();
  expect(region()).toHaveLength(0);
  act(() => trigger().props.onClick());
  expect(action).not.toHaveBeenCalled();
  expect(actionFocus).toHaveBeenCalledOnce();
  expect(region()[0].props.style.left).toBe(-272);
  expect(trigger().props["aria-controls"]).toBe(region()[0].props.id);
  act(() => region()[0].findByType("button").props.onClick());
  expect(action).toHaveBeenCalledOnce();
  act(() => renderer.root.findByProps({ className: "header-status" }).props.onKeyDown({ key: "Escape", preventDefault: vi.fn() }));
  expect(region()).toHaveLength(0);
  expect(triggerFocus).toHaveBeenCalledOnce();
});

it.each(["pointerdown", "focusin", "resize"])("closes after %s outside the popup", event => {
  render();
  act(() => trigger().props.onClick());
  act(() => { (event === "resize" ? win : doc).dispatchEvent(new Event(event)); });
  expect(region()).toHaveLength(0);
  expect(trigger().props["aria-expanded"]).toBe(false);
});
