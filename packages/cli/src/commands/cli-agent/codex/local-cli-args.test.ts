import { describe, expect, it } from "vitest";
import { codexRestartArgs } from "./local-cli-args.js";

describe("codexRestartArgs", () => {
  it.each([
    { args: [], expected: [] },
    { args: ["resume"], expected: [] },
    { args: ["resume", "old-session", "initial task"], expected: [] },
    { args: ["fork", "--last", "--all", "initial task"], expected: [] },
    { args: ["--last", "--all", "--include-non-interactive"], expected: [] },
    { args: ["--enable", "hooks", "resume"], expected: ["--enable", "hooks"] },
    { args: ["--model", "resume", "resume", "old-session"], expected: ["--model", "resume"] },
    { args: ["-m", "resume", "initial task"], expected: ["-m", "resume"] },
    { args: ["--model=resume", "initial task"], expected: ["--model=resume"] },
    { args: ["-mresume", "initial task"], expected: ["-mresume"] },
    {
      args: ["-c", "model_reasoning_effort=high", '--config=model="resume"', "-cfeatures.hooks=true", "initial task"],
      expected: ["-c", "model_reasoning_effort=high", '--config=model="resume"', "-cfeatures.hooks=true"],
    },
    {
      args: ["--config", "hooks.SessionStart=[{hooks=[{command='resume --last'}]}]", "initial task"],
      expected: ["--config", "hooks.SessionStart=[{hooks=[{command='resume --last'}]}]"],
    },
    {
      args: ["--profile", "work", "--sandbox", "read-only", "--ask-for-approval", "on-request", "initial task"],
      expected: ["--profile", "work", "--sandbox", "read-only", "--ask-for-approval", "on-request"],
    },
    {
      args: ["-p", "work", "-s", "workspace-write", "-a", "never", "--no-alt-screen", "--search", "initial task"],
      expected: ["-p", "work", "-s", "workspace-write", "-a", "never", "--no-alt-screen", "--search"],
    },
    {
      args: ["--cd", "C:/my project", "--add-dir", "C:/other project", "initial task"],
      expected: ["--cd", "C:/my project", "--add-dir", "C:/other project"],
    },
    {
      args: ["--oss", "--local-provider", "ollama", "--disable", "feature", "initial task"],
      expected: ["--oss", "--local-provider", "ollama", "--disable", "feature"],
    },
    {
      args: ["--remote", "ws://localhost:9000", "--remote-auth-token-env", "CODEX_TOKEN", "--strict-config", "resume"],
      expected: ["--remote", "ws://localhost:9000", "--remote-auth-token-env", "CODEX_TOKEN", "--strict-config"],
    },
    { args: ["--image", "a.png,b.png", "initial task"], expected: [] },
    { args: ["--image=a.png", "-ib.png", "-i", "c.png", "initial task"], expected: [] },
    { args: ["--enable", "hooks", "--", "--model", "initial task"], expected: ["--enable", "hooks"] },
  ])("retains only reusable options from $args", ({ args, expected }) => {
    const original = [...args];
    expect(codexRestartArgs(args)).toEqual(expected);
    expect(args).toEqual(original);
  });
});
