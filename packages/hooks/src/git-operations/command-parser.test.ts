import { describe, expect, it } from "vitest";
import { parseGitCommands } from "./command-parser.js";

describe("parseGitCommands", () => {
  it("extracts ordered operations from a compound command", () => {
    expect(parseGitCommands("git add src/a.ts && git commit -m 'fix: a' && git push origin main", "/repo"))
      .toEqual([
        { operation: "add", cwd: "/repo" },
        { operation: "commit", cwd: "/repo", commitMessage: "fix: a" },
        { operation: "push", cwd: "/repo" },
      ]);
  });

  it("extracts only literal commit messages", () => {
    expect(parseGitCommands(
      "git commit -m 'fix: title' -m 'body text'",
      "/repo",
    )).toEqual([{
      operation: "commit",
      cwd: "/repo",
      commitMessage: "fix: title\n\nbody text",
    }]);
    expect(parseGitCommands('git commit -m "$commit_message"', "/repo"))
      .toEqual([{ operation: "commit", cwd: "/repo", commitMessage: null }]);
    expect(parseGitCommands("git commit --file message.txt", "/repo"))
      .toEqual([{ operation: "commit", cwd: "/repo", commitMessage: null }]);
  });

  it("tracks cd and git -C without treating quoted text as a command", () => {
    expect(parseGitCommands("echo 'git commit'\ncd packages/core && git -C ../cloud status | head", "/work"))
      .toEqual([{ operation: "status", cwd: "/work/packages/cloud" }]);
  });

  it("ignores commands that merely contain the word git", () => {
    expect(parseGitCommands("printf git && npm run git:check", "/repo")).toEqual([]);
  });
});
