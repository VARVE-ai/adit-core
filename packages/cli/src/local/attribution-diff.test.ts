import { expect, it, vi } from "vitest";
import { AttributionDiffReader, ATTRIBUTION_FILE_LIMIT } from "./attribution-diff.js";
const changed = (path: string) => `:000000 100644 ${"0".repeat(40)} ${"a".repeat(40)} A\0${path}\0`;

it("never requests giant file patches and uses literal full paths for regular changes", async () => {
  const regular = "src/[draft] 文件.ts", giant = "design.pen";
  const git = vi.fn(async (_repository: string, args: string[]) => {
    if (args.includes("--raw")) return `parent\0\0\n${changed(regular)}${changed(giant)}`;
    if (args[0] === "ls-tree") return `100644 blob ${"a".repeat(40)} 100\t${regular}\0` +
      `100644 blob ${"b".repeat(40)} ${ATTRIBUTION_FILE_LIMIT + 1}\t${giant}\0`;
    expect(args).toContain(`:(top,literal)${regular}`);
    expect(args.some(arg => arg.includes(giant))).toBe(false);
    return "small patch";
  });
  const result = await new AttributionDiffReader(git).read("repo", "sha", ["."], undefined, [{ path: giant, additions: 100, deletions: 0 }]);
  expect(result.patch).toBe("small patch");
  expect(result.fileOnly).toEqual([{ path: giant, additions: 100, deletions: 0, reason: "file_size" }]);
  expect(result.parentPaths).toContain(`:(top,exclude,literal)${giant}`);
});

it("isolates oversized patches without suppressing regular files or ordinary Git errors", async () => {
  const git = vi.fn(async (_repository: string, args: string[]) => {
    if (args.includes("--raw")) return `\0\0\n${changed("a.ts")}${changed("b.ts")}`;
    if (args[0] === "ls-tree") return "";
    if (args.includes("bad")) throw Object.assign(new Error("Git failed"), { code: 128 });
    if (args.includes(":(top,literal)b.ts")) throw Object.assign(new Error("large"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    return "regular patch";
  });
  const reader = new AttributionDiffReader(git);
  expect(await reader.read("repo", "sha", ["."])).toMatchObject({ patch: "regular patch",
    fileOnly: [{ path: "b.ts", reason: "patch_size" }] });
  await expect(reader.read("repo", "bad", ["."])).rejects.toThrow("Git failed");
});
