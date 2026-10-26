import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGit } from "@varveai/adit-engine";
import { collectRemoteBranchSnapshot } from "./git-collector.js";

it("reads actual remote additions and deletions despite stale local refs", async () => {
  const root = mkdtempSync(join(tmpdir(), "adit-branch-snapshot-"));
  const repository = join(root, "repository"), remote = join(root, "remote.git");
  mkdirSync(repository);mkdirSync(remote);
  const git = async (args: string[], cwd = repository) => {
    const result = await runGit(args, { cwd });
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  try {
    await git(["init", "--bare"], remote);
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Branch Test"]);
    await git(["config", "user.email", "test@example.invalid"]);
    await git(["remote", "add", "origin", remote]);
    expect((await collectRemoteBranchSnapshot(repository)).branches).toEqual([]);
    writeFileSync(join(repository, "file.txt"), "test\n");
    await git(["add", "file.txt"]);await git(["commit", "-m", "Initial commit"]);
    await git(["push", "origin", "main"]);
    await git(["branch", "feature/stale"]);
    await git(["push", "origin", "feature/stale"]);
    expect((await collectRemoteBranchSnapshot(repository)).branches.map(branch => branch.name)).toEqual(["feature/stale", "main"]);
    await git(["push", "origin", "--delete", "feature/stale"]);
    await git(["update-ref", "refs/remotes/origin/feature/stale", "HEAD"]);
    expect((await collectRemoteBranchSnapshot(repository)).branches.map(branch => branch.name)).toEqual(["main"]);
    expect(await git(["show-ref", "--verify", "refs/heads/feature/stale"])).toContain("feature/stale");
    expect(await git(["show-ref", "--verify", "refs/remotes/origin/feature/stale"])).toContain("feature/stale");
  } finally {rmSync(root, { recursive: true, force: true });}
});
