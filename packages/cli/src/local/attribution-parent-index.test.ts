import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AttributionGitObjects } from "./attribution-git-objects.js";
import { AttributionParentIndex, parentSourceFile } from "./attribution-parent-index.js";
import { parentMatchingLines, type ParentScanTiming } from "./attribution-parent-lines.js";

it("reuses immutable files while respecting exact parent membership, duplicate lines, exclusions and attributes", async () => {
  const root = mkdtempSync(join(tmpdir(), "adit-parent-index-")),
    objects = new AttributionGitObjects();
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.hooksPath=NUL", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    });
  const commit = () => {
    git("add", ".");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD").trim();
  };
  try {
    git("init", "-b", "fixture");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    writeFileSync(
      join(root, "a.ts"),
      "export const sharedValue = 1;\nexport const oldValue = 2;\n",
    );
    writeFileSync(join(root, "copy.ts"), "export const sharedValue = 1;\n");
    writeFileSync(join(root, "binary.bin"), "\0\nexport const binaryValue = 3;\n");
    writeFileSync(join(root, "hidden.ts"), "export const hiddenValue = 4;\n");
    writeFileSync(join(root, "forced.bin"), "\0\nexport const forcedValue = 5;\n");
    writeFileSync(join(root, ".gitattributes"), "hidden.ts -diff\nforced.bin diff\n");
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/generated.ts"), "export const generatedValue = 6;\n");
    const first = commit();
    git("rm", "a.ts");
    const second = commit();
    git("rm", "copy.ts");
    writeFileSync(join(root, "branch.ts"), "export const branchValue = 7;\n");
    const third = commit();
    const paths = [".", ":(exclude,glob)**/dist/**"];
    const wanted = new Set([
      "export const sharedValue = 1;",
      "export const oldValue = 2;",
      "export const binaryValue = 3;",
      "export const hiddenValue = 4;",
      "export const forcedValue = 5;",
      "export const generatedValue = 6;",
      "export const branchValue = 7;",
    ]);
    const index = new AttributionParentIndex(objects),
      events: ParentScanTiming[] = [];
    for (const sha of [first, second, third, first]) {
      const expected = await parentMatchingLines(root, sha, paths, wanted);
      const actual = await index.matching(
        root,
        sha,
        await objects.tree(root, sha),
        paths,
        wanted,
        undefined,
        (event) => events.push(event),
      );
      expect(actual).toEqual(expected);
    }
    expect(events.every((event) => event.mode === "objects")).toBe(true);
    expect(events.at(-1)).toMatchObject({ bytes: 0, indexedBlobs: 0 });
    expect(events.at(-1)!.reusedBlobs).toBeGreaterThan(0);
    expect(objects.stats.objectProcesses).toBe(3);
    // A failed object query must not poison the long-lived reader.
    const broken = new Map(await objects.tree(root, first));
    broken.set("a.ts", { mode: "100644", size: 128, oid: "f".repeat(40) });
    await expect(index.matching(root, first, broken, paths, wanted)).rejects.toThrow(
      /missing|unreadable/,
    );
    expect(objects.db.inTransaction).toBe(false);
    writeFileSync(join(root, "recovered.ts"), "export const recoveredValue = 8;\n");
    const fourth = commit();
    expect((await objects.tree(root, fourth)).has("recovered.ts")).toBe(true);
    const abort = new AbortController();
    abort.abort();
    await expect(
      index.matching(root, fourth, await objects.tree(root, fourth), paths, wanted, abort.signal),
    ).rejects.toThrow();
  } finally {
    await objects.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

it("uses Git for custom diff drivers instead of guessing binary rules", async () => {
  const root = mkdtempSync(join(tmpdir(), "adit-parent-driver-")),
    objects = new AttributionGitObjects();
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=NUL", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    });
  try {
    git("init");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    writeFileSync(join(root, ".gitattributes"), "*.ts diff=fixture\n");
    writeFileSync(join(root, "code.ts"), "export const driverValue = 123;\n");
    git("config", "diff.fixture.binary", "true");
    git("add", ".");
    git("commit", "-qm", "fixture");
    const sha = git("rev-parse", "HEAD").trim(),
      wanted = new Set(["export const driverValue = 123;"]);
    const index = new AttributionParentIndex(objects);
    expect(await index.matching(root, sha, await objects.tree(root, sha), ["."], wanted)).toEqual(
      await parentMatchingLines(root, sha, ["."], wanted),
    );
    expect(parentSourceFile("dir/dist/code.ts")).toBe(false);
    expect(parentSourceFile("dir/code.min.ts")).toBe(false);
    expect(parentSourceFile("dir/snapshot.lock.json")).toBe(true);
  } finally {
    await objects.close();
    rmSync(root, { recursive: true, force: true });
  }
});
