import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AttributionDiffReader } from "./attribution-diff.js";

it.each(["normal", "shallow", "replacement"])("matches individual Git reads for roots, merges and filtered commits (%s)", async mode => {
  const root = mkdtempSync(join(tmpdir(), "adit-diff-batch-"));
  const command = (...args: string[]) => execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.hooksPath=NUL", ...args],
    { cwd: root, encoding: "utf8", stdio: "pipe", windowsHide: true });
  const commit = () => { command("add", "."); command("commit", "--allow-empty", "-qm", "fixture"); return command("rev-parse", "HEAD").trim(); };
  try {
    command("init", "-b", "fixture");
    command("config", "user.name", "Fixture"); command("config", "user.email", "fixture@example.invalid");
    writeFileSync(join(root, "[draft] 文件.ts"), "export const first = true;\n");
    const first = commit();
    writeFileSync(join(root, "[draft] 文件.ts"), "export const first = false;\n");
    writeFileSync(join(root, "a".repeat(40)), "export const hashName = true;\n");
    const second = commit(), empty = commit();
    mkdirSync(join(root, "dist")); writeFileSync(join(root, "dist/ignored.js"), "generated\n");
    const excluded = commit();
    command("checkout", "-qb", "side", first);
    writeFileSync(join(root, "side.ts"), "export const side = true;\n");
    const side = commit();
    command("checkout", "-q", "fixture"); command("merge", "--no-ff", "-qm", "merge", "side");
    const merge = command("rev-parse", "HEAD").trim();
    if (mode === "shallow") writeFileSync(join(root, ".git/shallow"), second + "\n");
    if (mode === "replacement") command("replace", second, first);
    const query = vi.fn(async (_repository: string, args: string[]) => command(...args));
    const individual = new AttributionDiffReader(query), batched = new AttributionDiffReader(query);
    const shas = [second, first, merge, excluded, empty, side];
    const paths = [".", ":(exclude,glob)**/dist/**"];
    const expected = [];
    for (const sha of shas) expected.push(await individual.read(root, sha, paths));
    query.mockClear();
    for (const [index, sha] of shas.entries())
      expect(await batched.read(root, sha, paths, undefined, [], shas.slice(index + 1))).toEqual(expected[index]);
    expect(query.mock.calls.filter(([, args]) => args.includes("--raw")).length).toBeLessThan(shas.length);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20000);

it("isolates batch failures and propagates cancellation without retrying", async () => {
  const first = "a".repeat(40), second = "b".repeat(40), bad = "c".repeat(40);
  const query = vi.fn(async (_repository: string, args: string[]) => {
    if (args.includes(bad)) throw new Error("missing object");
    return "\0\0";
  });
  const reader = new AttributionDiffReader(query);
  await expect(reader.read("repo", first, ["."], undefined, [], [bad, second])).resolves.toMatchObject({ patch: "", parents: [] });
  await expect(reader.read("repo", bad, ["."], undefined, [], [second])).rejects.toThrow("missing object");
  await expect(reader.read("repo", second, ["."])).resolves.toMatchObject({ patch: "" });
  expect(query.mock.calls.filter(([, args]) => args.includes("--no-walk=unsorted"))).toHaveLength(1);
  const abort = new AbortController();
  const cancelled = vi.fn(async () => { abort.abort(); throw new Error("batch aborted"); });
  await expect(new AttributionDiffReader(cancelled).read("repo", first, ["."], abort.signal, [], [second])).rejects.toThrow();
  expect(cancelled).toHaveBeenCalledTimes(1);
});

it("frames unusual filenames and scopes prefetched metadata to the repository and path filters", async () => {
  const first = "a".repeat(40), second = "b".repeat(40);
  const paths = [second, "\n:100644 100644 marker M", "  ", "src/[draft] 文件.ts"];
  const change = (path: string) => `:000000 100644 ${"0".repeat(40)} ${first} A\0${path}\0`;
  const query = vi.fn(async (repository: string, args: string[]) => {
    if (args.includes("--no-walk=unsorted")) return `${first}\0\0\0\n${paths.map(change).join("")}${second}\0${first}\0\0\n${change("second.ts")}`;
    if (args.includes("--raw")) return `\0\0\n${change(repository + ".ts")}`;
    if (args[0] === "ls-tree") return "";
    return args.slice(args.indexOf("--") + 1).join("|");
  });
  const reader = new AttributionDiffReader(query);
  const result = await reader.read("repo", first, ["."], undefined, [], [second]);
  expect(result.patch).toBe(paths.map(path => `:(top,literal)${path}`).join("|"));
  expect((await reader.read("repo", second, ["."])).patch).toBe(":(top,literal)second.ts");
  const otherRepository = new AttributionDiffReader(query);
  await otherRepository.read("repo", first, ["."], undefined, [], [second]);
  expect((await otherRepository.read("other", second, ["."])).patch).toBe(":(top,literal)other.ts");
  const otherPaths = new AttributionDiffReader(query);
  await otherPaths.read("repo", first, ["."], undefined, [], [second]);
  expect((await otherPaths.read("repo", second, ["src"])).patch).toBe(":(top,literal)repo.ts");
});

it.each(["size-limit", "malformed"])("falls back without changing results after a %s batch response", async mode => {
  const first = "a".repeat(64), second = "b".repeat(64);
  const query = vi.fn(async (_repository: string, args: string[]) => {
    if (args.includes("--no-walk=unsorted")) {
      if (mode === "size-limit") throw Object.assign(new Error("large output"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
      return `${first}\0\0\0\ninvalid raw metadata\0`;
    }
    return "\0\0";
  });
  const reader = new AttributionDiffReader(query);
  for (const sha of [first, second])
    expect(await reader.read("repo", sha, ["."], undefined, [], [second])).toMatchObject({ patch: "", parents: [] });
  expect(query.mock.calls.filter(([, args]) => args.includes("--no-walk=unsorted"))).toHaveLength(1);
  expect(query).toHaveBeenCalledTimes(3);
});
