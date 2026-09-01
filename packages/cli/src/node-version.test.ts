import { describe, expect, it } from "vitest";

import {
  REQUIRED_NODE_MAJOR,
  isSupportedNodeVersion,
  unsupportedNodeVersionMessage,
} from "./node-version.js";

describe("isSupportedNodeVersion", () => {
  it("accepts the required major and newer", () => {
    expect(isSupportedNodeVersion(`${REQUIRED_NODE_MAJOR}.0.0`)).toBe(true);
    expect(isSupportedNodeVersion(`${REQUIRED_NODE_MAJOR + 2}.11.1`)).toBe(
      true,
    );
  });

  it("rejects older majors", () => {
    expect(isSupportedNodeVersion("18.20.4")).toBe(false);
    expect(isSupportedNodeVersion("16.13.0")).toBe(false);
    expect(isSupportedNodeVersion(`${REQUIRED_NODE_MAJOR - 1}.9.9`)).toBe(
      false,
    );
  });

  it("rejects unparsable version strings", () => {
    expect(isSupportedNodeVersion("")).toBe(false);
    expect(isSupportedNodeVersion("not-a-version")).toBe(false);
  });
});

describe("unsupportedNodeVersionMessage", () => {
  it("names the current version, the requirement, and the fix", () => {
    const message = unsupportedNodeVersionMessage("18.20.4");
    expect(message).toContain("v18.20.4");
    expect(message).toContain(`Node.js ${REQUIRED_NODE_MAJOR} or newer`);
    expect(message).toContain("npm install -g @varveai/adit-cli");
  });
});
