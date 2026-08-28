import { describe, expect, it } from "vitest";
import { parseGitCommands } from "./command-parser.js";

describe("parseGitCommands", () => {
  it("extracts ordered operations from a compound command", () => {
    expect(parseGitCommands("git add src/a.ts && git commit -m 'fix: a' && git push origin main", "/repo"))
      .toEqual([
        { operation: "add", cwd: "/repo" },
        { operation: "commit", cwd: "/repo" },
        { operation: "push", cwd: "/repo" },
      ]);
  });

  it("tracks cd and git -C without treating quoted text as a command", () => {
    expect(parseGitCommands("echo 'git commit'\ncd packages/core && git -C ../cloud status | head", "/work"))
      .toEqual([{ operation: "status", cwd: "/work/packages/cloud" }]);
  });

  it("ignores commands that merely contain the word git", () => {
    expect(parseGitCommands("printf git && npm run git:check", "/repo")).toEqual([]);
  });
});
