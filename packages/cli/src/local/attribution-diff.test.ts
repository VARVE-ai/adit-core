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
    fileOnly: [{ path: "b.ts", reason: "file_patch_size" }] });
  await expect(reader.read("repo", "bad", ["."])).rejects.toThrow("Git failed");
});

it("does not read deleted file patches or associate their paths when indexed counts are unavailable", async () => {
  const git = vi.fn(async (_repository: string, args: string[]) => {
    expect(args).toContain("--raw");
    return `parent\0\0\n:100644 000000 ${"a".repeat(40)} ${"0".repeat(40)} D\0large.pen\0`;
  });
  const result = await new AttributionDiffReader(git).read("repo", "sha", ["."]);
  expect(result).toMatchObject({ patch: "", fileOnly: [] });
  expect(git).toHaveBeenCalledOnce();
});

it("skips deletion-only edits before applying size limits while retaining added content", async () => {
  const git = vi.fn(async (_repository: string, args: string[]) => {
    if (args.includes("--raw")) return `parent\0\0\n:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0large.pen\0${changed("new.ts")}`;
    if (args[0] === "ls-tree") return `100644 blob ${"a".repeat(40)} ${ATTRIBUTION_FILE_LIMIT + 1}\tlarge.pen\0`;
    expect(args).toContain(":(top,literal)new.ts");
    expect(args).not.toContain(":(top,literal)large.pen");
    return "new code patch";
  });
  const result = await new AttributionDiffReader(git).read("repo", "sha", ["."], undefined, [
    { path: "large.pen", additions: 0, deletions: 1000 },
    { path: "new.ts", additions: 1, deletions: 0 },
  ]);
  expect(result).toMatchObject({ patch: "new code patch", fileOnly: [] });
});

it("consumes every small-file batch even when their combined patches exceed the limit", async () => {
  const bodies = new Map([["a.ts", "a".repeat(5 * 1024 * 1024)], ["b.ts", "b".repeat(5 * 1024 * 1024)], ["tail.ts", "small tail"]]);
  let consumed = 0;
  const git = vi.fn(async (_repository: string, args: string[]) => {
    if (args.includes("--raw")) return `\0\0\n${[...bodies.keys()].map(changed).join("")}`;
    if (args[0] === "ls-tree") return "";
    const paths = args.slice(args.indexOf("--") + 1).map(path => path.slice(":(top,literal)".length));
    const output = paths.map(path => bodies.get(path)).join("\n");
    if (output.length > ATTRIBUTION_FILE_LIMIT)
      throw Object.assign(new Error("batch too large"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    if (paths.includes("b.ts")) expect(consumed).toBe(1);
    return output;
  });
  const chunks: string[] = [];
  const result = await new AttributionDiffReader(git).read("repo", "sha", ["."], undefined, [], [], async patch => {
    await Promise.resolve();
    chunks.push(patch); consumed++;
  });
  expect(result).toMatchObject({ patch: "", fileOnly: [] });
  expect(chunks.join("\n")).toBe([...bodies.values()].join("\n"));
  expect(chunks.every(patch => Buffer.byteLength(patch) <= ATTRIBUTION_FILE_LIMIT)).toBe(true);
});

it("isolates a single oversized patch and still consumes small files after it", async () => {
  const git = vi.fn(async (_repository: string, args: string[]) => {
    if (args.includes("--raw")) return `\0\0\n${changed("large.ts")}${changed("small.ts")}`;
    if (args[0] === "ls-tree") return "";
    return args.includes(":(top,literal)large.ts") ? "x".repeat(ATTRIBUTION_FILE_LIMIT + 1) : "small patch";
  });
  const consume = vi.fn(async (_patch: string) => {});
  const result = await new AttributionDiffReader(git).read("repo", "sha", ["."], undefined, [], [], consume);
  expect(result.fileOnly).toEqual([{ path: "large.ts", additions: null, deletions: null, reason: "file_patch_size" }]);
  expect(consume).toHaveBeenCalledOnce();
  expect(consume.mock.calls[0][0]).toBe("small patch");
});

it("propagates consumer errors instead of treating them as oversized file patches", async () => {
  const git = vi.fn(async (_repository: string, args: string[]) => args.includes("--raw")
    ? `\0\0\n${changed("a.ts")}` : args[0] === "ls-tree" ? "" : "patch");
  const error = Object.assign(new Error("consumer failed"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  await expect(new AttributionDiffReader(git).read("repo", "sha", ["."], undefined, [], [], async () => { throw error; }))
    .rejects.toBe(error);
  expect(git.mock.calls.filter(([, args]) => args.includes("--unified=0"))).toHaveLength(1);
});

it("stops before reading later batches when analysis is cancelled by the consumer", async () => {
  const controller = new AbortController();
  const git = vi.fn(async (_repository: string, args: string[]) => {
    if (args.includes("--raw")) return `\0\0\n${changed("a.ts")}${changed("b.ts")}`;
    if (args[0] === "ls-tree") return "";
    if (args.includes(":(top,literal)a.ts") && args.includes(":(top,literal)b.ts"))
      throw Object.assign(new Error("batch too large"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    return "first patch";
  });
  await expect(new AttributionDiffReader(git).read("repo", "sha", ["."], controller.signal, [], [], async () => controller.abort()))
    .rejects.toThrow();
  expect(git.mock.calls.filter(([, args]) => args.includes("--unified=0")))
    .toHaveLength(2); // Combined request and first batch; the second is never read.
});
