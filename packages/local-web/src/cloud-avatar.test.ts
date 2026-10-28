import React from "react";
import { act, create } from "react-test-renderer";
import { expect, it } from "vitest";
import { CloudAvatar } from "./cloud-avatar";

it("shows the Cloud avatar, falls back on failure and resets for another account", () => {
  const renderer = create(React.createElement(CloudAvatar, { key: "first", account: "Alice", image: "https://example.test/alice.png" }));
  expect(renderer.root.findByType("img").props.src).toBe("https://example.test/alice.png");
  act(() => renderer.root.findByType("img").props.onError());
  expect(renderer.root.findAllByType("img")).toHaveLength(0);
  expect(renderer.root.findByType("span").children).toEqual(["A"]);
  act(() => renderer.update(React.createElement(CloudAvatar, { key: "second", account: "Bob", image: "https://example.test/bob.png" })));
  expect(renderer.root.findByType("img").props.src).toBe("https://example.test/bob.png");
  act(() => renderer.unmount());
});

it("uses initials without an avatar and rejects non-HTTP image sources", () => {
  const renderer = create(React.createElement(CloudAvatar, { account: "Alice", image: "javascript:alert(1)" }));
  expect(renderer.root.findAllByType("img")).toHaveLength(0);
  expect(renderer.root.findByType("span").children).toEqual(["A"]);
  act(() => renderer.unmount());
});
