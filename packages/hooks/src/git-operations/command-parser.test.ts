import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
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
      .toEqual([{ operation: "status", cwd: resolve("/work/packages/cloud") }]);
  });

  it("treats backslash-newline as a line continuation", () => {
    expect(parseGitCommands(
      "git add src/a.ts && \\\ngit commit -q -m \"fix: a\" && \\\ngit push origin main",
      "/repo",
    )).toEqual([
      { operation: "add", cwd: "/repo" },
      { operation: "commit", cwd: "/repo", commitMessage: "fix: a" },
      { operation: "push", cwd: "/repo" },
    ]);
    expect(parseGitCommands("git \\\ncommit -m 'fix: joined'", "/repo"))
      .toEqual([{ operation: "commit", cwd: "/repo", commitMessage: "fix: joined" }]);
    expect(parseGitCommands("echo 'not \\\ngit commit'", "/repo")).toEqual([]);
  });

  it("ignores commands that merely contain the word git", () => {
    expect(parseGitCommands("printf git && npm run git:check", "/repo")).toEqual([]);
  });

  it("preserves Windows directory separators in quoted and unquoted Git commands", () => {
    expect(parseGitCommands('git -C "C:\\work\\my repo" commit -m fix', "/fallback"))
      .toEqual([{ operation: "commit", cwd: resolve("/fallback", "C:\\work\\my repo"), commitMessage: "fix" }]);
    expect(parseGitCommands("cd C:\\work\\repo && git commit -m fix", "/fallback"))
      .toEqual([{ operation: "commit", cwd: resolve("/fallback", "C:\\work\\repo"), commitMessage: "fix" }]);
  });
});
