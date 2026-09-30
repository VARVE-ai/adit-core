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

  it("reads a heredoc fed to `commit -F -` as the commit message", () => {
    const command = [
      "git add src && git commit -q -F - <<'MSG'",
      "feat: add heredoc support  ",
      "",
      "",
      "- git commit -m 'a body line, not a command'",
      "MSG",
      "git push origin main",
    ].join("\n");
    expect(parseGitCommands(command, "/repo")).toEqual([
      { operation: "add", cwd: "/repo" },
      {
        operation: "commit",
        cwd: "/repo",
        commitMessage: "feat: add heredoc support\n\n- git commit -m 'a body line, not a command'",
      },
      { operation: "push", cwd: "/repo" },
    ]);
  });

  it("gives each heredoc commit in one command its own message", () => {
    const command = [
      "git commit -q --file=- <<EOF",
      "fix: first",
      "EOF",
      "git add -A",
      "git commit -q -F - <<-'EOF'",
      "\tfix: second",
      "\tEOF",
    ].join("\n");
    expect(parseGitCommands(command, "/repo")).toEqual([
      { operation: "commit", cwd: "/repo", commitMessage: "fix: first" },
      { operation: "add", cwd: "/repo" },
      { operation: "commit", cwd: "/repo", commitMessage: "fix: second" },
    ]);
  });

  it("leaves the message null when the heredoc may expand or stdin is not a heredoc", () => {
    expect(parseGitCommands("git commit -F - <<EOF\nfix: $subject\nEOF", "/repo"))
      .toEqual([{ operation: "commit", cwd: "/repo", commitMessage: null }]);
    expect(parseGitCommands("git commit -F - <<'EOF'\nfix: $literal\nEOF", "/repo"))
      .toEqual([{ operation: "commit", cwd: "/repo", commitMessage: "fix: $literal" }]);
    expect(parseGitCommands("printf 'fix: piped' | git commit -F -", "/repo"))
      .toEqual([{ operation: "commit", cwd: "/repo", commitMessage: null }]);
    expect(parseGitCommands("echo $((1 << 2))\ngit commit -m 'fix: shift'", "/repo"))
      .toEqual([{ operation: "commit", cwd: "/repo", commitMessage: "fix: shift" }]);
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
