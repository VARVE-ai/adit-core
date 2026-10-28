import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { LocalHistory } from "./archive.js";
import { sourceFiles } from "./sources.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), readdir: vi.fn(actual.readdir) };
});

const actualFilesystem = await vi.importActual<typeof filesystem>("node:fs/promises");
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.mocked(filesystem.lstat).mockReset();
  vi.mocked(filesystem.readdir).mockReset();
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "adit-targeted-sources-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(path: string, contents = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function archive() {
  const database = new Database(":memory:");
  cleanup.push(() => database.close());
  return new LocalHistory(database);
}

describe("targeted Warp and Kilo source enumeration", () => {
  it("discovers and collects Warp without listing its protected application directory", async () => {
    const root = fixture(), path = join(root, "warp.sqlite");
    const database = new Database(path);
    database.exec("CREATE TABLE agent_conversations(conversation_id TEXT, conversation_data TEXT); CREATE TABLE ai_queries(conversation_id TEXT, input TEXT, working_directory TEXT)");
    database.prepare("INSERT INTO agent_conversations VALUES (?, ?)").run("warp-session", "{}");
    database.prepare("INSERT INTO ai_queries VALUES (?, ?, ?)").run("warp-session", JSON.stringify({ text: "question" }), root);
    database.close();
    vi.mocked(filesystem.readdir).mockRejectedValue(Object.assign(new Error("EPERM: scandir"), { code: "EPERM" }));

    expect(await Array.fromAsync(sourceFiles("warp", root))).toEqual([path]);
    expect(await Array.fromAsync(sourceFiles("warp", path))).toEqual([path]);
    const history = archive(), sources = [{ id: "warp", paths: [root] }];
    expect(await history.scan(root, sources, { preview: true })).toMatchObject({ counts: { warp: 1 }, errors: [] });
    expect(history.session("warp", "warp-session")).toBeUndefined();
    expect(await history.scan(root, sources)).toMatchObject({ counts: { warp: 1 }, errors: [], updated: 1 });
    expect(history.session("warp", "warp-session")?.messages[0].content).toEqual({ text: "question" });
    expect(filesystem.readdir).not.toHaveBeenCalled();
  });

  it("enumerates Kilo's database and sorted session manifests without traversing caches or message trees", async () => {
    const root = fixture(), database = write(join(root, "kilo.db"));
    const second = write(join(root, "storage/session/project-b/two.json"), "{}");
    const first = write(join(root, "storage/session/project-a/one.json"), "{}");
    write(join(root, "storage/session/project-a/notes.txt"));
    for (const base of [root, join(root, "storage/message"), join(root, "storage/session/project-a")]) {
      write(join(base, ...Array(12).fill("cache"), "ignored.json"), "{}");
    }
    write(join(root, "cache/kilo.db"));

    expect(await Array.fromAsync(sourceFiles("kilo", root))).toEqual([database, first, second]);
    expect(vi.mocked(filesystem.readdir).mock.calls.map(([path]) => path)).toEqual([
      join(root, "storage/session"),
      join(root, "storage/session/project-a"),
      join(root, "storage/session/project-b"),
    ]);
  });

  it("discovers and collects Kilo JSON sessions despite deeply nested unrelated data", async () => {
    const root = fixture();
    write(join(root, ...Array(12).fill("cache"), "ignored.json"), "{}");
    write(join(root, "storage/session/project/session.json"), JSON.stringify({ id: "session", directory: root }));
    write(join(root, "storage/message/session/message.json"), JSON.stringify({ id: "message", sessionID: "session", role: "user" }));
    const part = write(join(root, "storage/part/message/part.json"), JSON.stringify({ id: "part", type: "text", text: "first question" }));
    const history = archive(), sources = [{ id: "kilo", paths: [root] }];

    expect(await history.scan(root, sources, { preview: true })).toMatchObject({ counts: { kilo: 1 }, errors: [] });
    expect(await history.scan(root, sources)).toMatchObject({ counts: { kilo: 1 }, errors: [], updated: 1 });
    expect(await history.scan(root, sources)).toMatchObject({ errors: [], updated: 0 });
    write(part, JSON.stringify({ id: "part", type: "text", text: "updated question" }));
    expect(await history.scan(root, sources)).toMatchObject({ errors: [], updated: 1 });
    expect(history.session("kilo", "session")?.messages[0].content).toEqual([{ id: "part", type: "text", text: "updated question" }]);
  });

  it.each(["warp", "kilo"])("treats missing %s installations and empty data directories as empty", async (provider) => {
    const root = fixture();
    expect(await Array.fromAsync(sourceFiles(provider, join(root, "missing")))).toEqual([]);
    expect(await Array.fromAsync(sourceFiles(provider, root))).toEqual([]);
    expect(await Array.fromAsync(sourceFiles(provider, write(join(root, "unrelated.txt"))))).toEqual([]);
  });

  it.each(["warp", "kilo"])("accepts an explicit %s database path and reports a corrupt database", async (provider) => {
    const root = fixture(), path = write(join(root, provider === "warp" ? "warp.sqlite" : "kilo.db"), "not a database");
    expect(await Array.fromAsync(sourceFiles(provider, path))).toEqual([path]);
    const history = archive(), sources = [{ id: provider, paths: [root] }];
    for (const preview of [true, false]) {
      const result = await history.scan(root, sources, { preview });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain(`${provider}:`);
      expect(result.counts).toEqual({});
    }
  });

  it.each(["warp", "kilo"])("reports actual %s database permission failures without blocking Codex discovery", async (provider) => {
    const root = fixture(), path = join(root, provider === "warp" ? "warp.sqlite" : "kilo.db");
    write(join(root, "rollout-codex.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "codex-session", cwd: root } }) + "\n");
    const failure = Object.assign(new Error("EACCES: source database"), { code: "EACCES" });
    vi.mocked(filesystem.lstat).mockImplementation(async (candidate) => {
      if (candidate === path) throw failure;
      return actualFilesystem.lstat(candidate);
    });

    await expect(Array.fromAsync(sourceFiles(provider, root))).rejects.toBe(failure);
    const result = await archive().scan(root, [{ id: provider, paths: [root] }, { id: "codex", paths: [root] }], { preview: true });
    expect(result.counts).toEqual({ codex: 1 });
    expect(result.errors).toEqual([`${provider}: EACCES: source database`]);
  });

  it("reports inaccessible Kilo session directories rather than silently returning an empty discovery", async () => {
    const root = fixture(), directory = join(root, "storage/session");
    mkdirSync(directory, { recursive: true });
    const failure = Object.assign(new Error("EPERM: session directory"), { code: "EPERM" });
    vi.mocked(filesystem.readdir).mockRejectedValue(failure);
    await expect(Array.fromAsync(sourceFiles("kilo", root))).rejects.toBe(failure);
  });

  it.each([
    ["warp", ""], ["warp", "warp.sqlite"],
    ["kilo", ""], ["kilo", "kilo.db"], ["kilo", "storage"],
    ["kilo", "storage/session"], ["kilo", "storage/session/project"],
  ])("does not follow %s symbolic links at %s", async (provider, relativePath) => {
    const root = fixture(), linkedPath = join(root, relativePath);
    if (provider === "warp") write(join(root, "warp.sqlite"));
    else if (relativePath === "kilo.db") write(join(root, "kilo.db"));
    else write(join(root, "storage/session/project/session.json"), "{}");
    vi.mocked(filesystem.lstat).mockImplementation(async (path) => {
      const info = await actualFilesystem.lstat(path);
      if (path === linkedPath) info.isSymbolicLink = () => true;
      return info;
    });

    expect(await Array.fromAsync(sourceFiles(provider, root))).toEqual([]);
    expect(vi.mocked(filesystem.readdir).mock.calls.map(([path]) => path)).not.toContain(linkedPath);
  });

  it.each(["warp", "kilo"])("honors cancellation during %s source probing", async (provider) => {
    const root = fixture(), controller = new AbortController();
    write(join(root, provider === "warp" ? "warp.sqlite" : "kilo.db"));
    vi.mocked(filesystem.lstat).mockImplementation(async (path) => {
      const info = await actualFilesystem.lstat(path);
      controller.abort();
      return info;
    });
    await expect(Array.fromAsync(sourceFiles(provider, root, controller.signal))).rejects.toMatchObject({ name: "AbortError" });
  });
});
