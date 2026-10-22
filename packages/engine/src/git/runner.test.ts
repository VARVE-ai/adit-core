import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGit } from "./runner.js";

describe("runGit", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "adit-runner-"));
  });

  afterAll(() => {
    // Windows may release Git's working-directory handle just after timeout completion.
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("keeps git's own stderr when git fails", async () => {
    const result = await runGit(["rev-parse", "--git-dir"], { cwd: dir });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not a git repository");
  });

  it("describes a missing working directory instead of returning an empty stderr", async () => {
    const missing = join(dir, "gone");
    const result = await runGit(["rev-parse", "--git-dir"], { cwd: missing });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("working directory not found");
    expect(result.stderr).toContain(missing);
  });

  it("describes a timeout instead of returning an empty stderr", async () => {
    // hash-object --stdin blocks on stdin, which the runner never closes.
    const result = await runGit(["hash-object", "--stdin"], { cwd: dir, timeout: 200 });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("git timed out after 200ms");
  });
});
