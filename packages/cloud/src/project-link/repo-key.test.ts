import { describe, expect, it } from "vitest";
import { normalizeGitHubRepoKey } from "./repo-key.js";

describe("normalizeGitHubRepoKey", () => {
  it.each([
    ["https://github.com/VARVE-ai/adit-cloud.git", "github:varve-ai/adit-cloud"],
    ["http://github.com/VARVE-ai/adit-cloud", "github:varve-ai/adit-cloud"],
    ["git@github.com:VARVE-ai/adit-cloud.git", "github:varve-ai/adit-cloud"],
    ["ssh://git@github.com/VARVE-ai/adit-cloud.git", "github:varve-ai/adit-cloud"],
    ["https://github.com/VARVE-ai/adit-cloud/", "github:varve-ai/adit-cloud"],
  ])("normalizes %s", (remoteUrl, expected) => {
    expect(normalizeGitHubRepoKey(remoteUrl)).toBe(expected);
  });

  it.each([
    null,
    "",
    "git@gitlab.com:VARVE-ai/adit-cloud.git",
    "https://github.com/VARVE-ai",
    "not-a-url",
  ])("returns null for unsupported remote %s", (remoteUrl) => {
    expect(normalizeGitHubRepoKey(remoteUrl)).toBeNull();
  });
});
