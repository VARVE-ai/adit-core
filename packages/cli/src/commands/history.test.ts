import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "@varveai/adit-core";
import { StructuredHistory } from "../../../core/src/local-history/structured-store.js";
import { createHistorySchema } from "../../../core/src/local-history/schema.js";
import type { HistoryMessage } from "../../../core/src/local-history/types.js";
import { LocalHistoryReader } from "../local/history-reader.js";
import { registerHistoryCommands } from "./history.js";

let root: string, store: LocalStore, reader: LocalHistoryReader;
const message = (key: string, role: string, content: unknown, extra: Partial<HistoryMessage> = {}): HistoryMessage =>
  ({ key, role, content, raw: {}, timestamp: "2026-10-20T10:00:00Z", ...extra });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "adit-history-cli-")); });
afterEach(() => {
  reader?.close(); store?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); process.exitCode = 0;
  rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const state = join(root, "state"), project = join(root, "project"), other = join(root, "other");
  mkdirSync(project); mkdirSync(other); mkdirSync(join(project, "nested"));
  store = new LocalStore(state); createHistorySchema(store.db);
  const w = store.saveWorkspace({ path: project, providers: ["claude", "codex", "cursor"], repositories: [] });
  const outside = store.saveWorkspace({ path: other, providers: ["claude", "codex"], repositories: [] });
  const history = new StructuredHistory(store.db);
  history.write({ provider: "claude", id: "claude-session", cwd: project, messages: [message("p", "user", "repair team model settings"), message("a", "assistant", "Changed the model selector", { finalReply: true })] });
  history.write({ provider: "codex", id: "codex-session", cwd: project, messages: [message("p", "user", "team model token limits"), message("a", "assistant", "Separate input and output limits", { finalReply: true })] });
  history.write({ provider: "codex", id: "outside", cwd: other, messages: [message("p", "user", "team model PRIVATE_OTHER_PROJECT")] });
  reader = new LocalHistoryReader(state);
  vi.stubEnv("ADIT_LOCAL_DATA_DIR", state); vi.stubEnv("ADIT_CLOUD_URL", "http://127.0.0.1:1");
  return { state, project, other, w, outside, history };
}
async function cli(args: string[]) {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const program = new Command(); registerHistoryCommands(program);
  await program.parseAsync(["node", "adit", "history", ...args]);
  const result = JSON.parse(String(output.mock.calls.at(-1)?.[0])); output.mockRestore(); return result;
}
it("searches both Agents in the registered project without login, network, daemon or writes", async () => {
  const { w, project, state } = fixture();
  const network = vi.fn(() => { throw new Error("Network forbidden"); }); vi.stubGlobal("fetch", network);
  expect(reader.workspace({ cwd: join(project, "nested") }).id).toBe(w.id);
  expect(existsSync(join(project, "nested", ".adit"))).toBe(false);
  expect(reader.db.readonly).toBe(true);
  const changes = reader.db.prepare("SELECT total_changes() n").get();
  const before = reader.db.prepare("SELECT * FROM adit_history_sessions ORDER BY provider,id").all();
  const result = await cli(["search", "team model", "--workspace", w.id, "--json"]);
  expect(result).toMatchObject({ ok: true, source: "local", total: 2, nextOffset: null, workspace: { id: w.id } });
  expect(result.items.map((s: any) => s.provider).sort()).toEqual(["claude", "codex"]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_OTHER_PROJECT");
  expect(reader.db.prepare("SELECT * FROM adit_history_sessions ORDER BY provider,id").all()).toEqual(before);
  expect(reader.db.prepare("SELECT total_changes() n").get()).toEqual(changes);
  expect(existsSync(join(state, "daemon.json"))).toBe(false); expect(network).not.toHaveBeenCalled();
});
it("requires a workspace outside registered projects, supports explicit IDs there, and prevents cross-project reads", () => {
  const { w, outside } = fixture();
  expect(() => reader.workspace({ cwd: root })).toThrow(/--workspace/);
  expect(reader.workspace({ cwd: root, workspace: w.id }).id).toBe(w.id);
  expect(() => reader.show(w, "outside", { maxChars: 2000 })).toThrow(/not in the selected/);
  expect(reader.show(outside, "outside", { maxChars: 2000 }).session.id).toBe("outside");
  expect(() => reader.workspace({ workspace: "does-not-exist" })).toThrow(/registered/);
});
it("does not create a missing data directory or local database", () => {
  const directory = join(root, "not-collected");
  expect(() => new LocalHistoryReader(directory)).toThrow(/No collected local history/);
  expect(existsSync(directory)).toBe(false);
});
it("paginates filtered search and rejects invalid date/offset arguments", async () => {
  const { w } = fixture();
  const page = await cli(["search", "team model", "--workspace", w.id, "--limit", "1", "--from", "2026-10-20", "--to", "2026-10-20"]);
  expect(page).toMatchObject({ total: 2, nextOffset: 1 });
  const next = await cli(["search", "team model", "--workspace", w.id, "--limit", "1", "--offset", "1"]);
  expect(next.nextOffset).toBeNull(); expect(next.items[0].id).not.toBe(page.items[0].id);
  expect((await cli(["search", "team model", "--workspace", w.id, "--provider", "claude"])).total).toBe(1);
  expect((await cli(["list", "--workspace", w.id, "--from", "2026-10-21"])).total).toBe(0);
  expect((await cli(["list", "--workspace", w.id, "--from", "2026-02-30"])).code).toBe("INVALID_DATE");
  expect((await cli(["list", "--workspace", w.id, "--offset", "-1"])).code).toBe("INVALID_ARGUMENT");
});
it("reads actual replies, marks compaction as context, and retrieves truncated prompts/replies", async () => {
  const { w, project, history } = fixture();
  const long = "original evidence ".repeat(2100);
  history.write({ provider: "codex", id: "long", cwd: project, messages: [message("p", "user", long), message("a", "assistant", "real closing reply", { finalReply: true }),
    message("compact", "assistant", "native compaction", { raw: { metadata: { compaction_output: true } } })] });
  const result = await cli(["show", "long", "--workspace", w.id, "--max-chars", "100"]);
  expect(result.turns[0].events.map((e: any) => e.text)).toEqual(["real closing reply"]);
  expect(result.turns[0].promptTruncated).toBe(true);
  const turn = await cli(["turn", "long", result.turns[0].id, "--workspace", w.id]);
  expect(turn.turn.events.find((e: any) => e.text === "native compaction").kind).toBe("system");
  const part = await cli(["content", "long", result.turns[0].promptBlockId, "--workspace", w.id]);
  expect(part.nextOffset).toBe(32000);
  const rest = await cli(["content", "long", result.turns[0].promptBlockId, "--workspace", w.id, "--offset", String(part.nextOffset)]);
  expect(part.text + rest.text).toBe(long); expect(rest.nextOffset).toBeNull();
});
it("provides every original text block when a long prompt spans multiple blocks", async () => {
  const { w, project, history } = fixture();
  history.write({ provider: "codex", id: "blocks", cwd: project, messages: [message("p", "user", [
    { type: "input_text", text: "<environment_context>setup</environment_context>" },
    { type: "input_text", text: "actual question ".repeat(2000) },
  ])] });
  const result = await cli(["show", "blocks", "--workspace", w.id]);
  expect(result.turns[0].promptBlockIds).toHaveLength(2);
  const ids = result.turns[0].promptBlockIds;
  const part = await cli(["content", "blocks", ids[1], "--workspace", w.id]);
  expect(part.text).toBe("actual question ".repeat(2000));
  expect(part.nextOffset).toBeNull();
});
it("keeps image-only turns and reflects edits/deletions without changing physical session identities", () => {
  const { w, project, history } = fixture();
  history.write({ provider: "codex", id: "continuation", cwd: project, parentId: "codex-session", relationship: "continuation", messages: [
    message("p", "user", [{ type: "input_image", image_url: "data:PRIVATE_IMAGE" }]), message("a", "assistant", "image reply", { finalReply: true }),
    message("p2", "user", "delete this evidence"), message("a2", "assistant", "deletable reply", { finalReply: true })] });
  history.write({ provider: "codex", id: "fork", cwd: project, parentId: "codex-session", relationship: "fork", messages: [message("p", "user", "independent fork")] });
  const detail = reader.show(w, "codex-session", { maxChars: 2000 });
  expect(detail.totalTurns).toBe(3); expect(detail.turns[1].imageCount).toBe(1);
  expect(JSON.stringify(detail)).not.toContain("PRIVATE_IMAGE");
  // Writes use the page's normal editor on a separate, write-enabled connection.
  const Editor = reader.browser.constructor as typeof import("@varveai/adit-core").LocalSessionBrowser;
  const editor = new Editor(store.db);
  const edit = editor.editTurn(w, "codex", "codex-session", detail.turns[0].id);
  editor.updateTurn(w, "codex", "codex-session", edit.turnId, edit.revision, [{ id: edit.blocks[0].id, text: "revised user request" }]);
  const deletion = editor.editTurn(w, "codex", "codex-session", detail.turns[2].id);
  editor.deleteTurn(w, "codex", "codex-session", deletion.turnId, deletion.revision);
  expect(reader.show(w, "codex-session", { maxChars: 2000 }).turns.map(t => t.prompt)).toEqual(["revised user request", ""]);
  expect(reader.browser.list(w, { query: "delete this evidence" }).total).toBe(0);
  expect(reader.browser.list(w).items.map(s => s.id).sort()).toEqual(["claude-session", "codex-session", "fork"]);
  expect((store.db.prepare("SELECT count(*) n FROM adit_history_sessions").get() as any).n).toBe(5);
});
it("returns saved submitter and writer separately, preserves unmatched commits and disambiguates short SHAs", async () => {
  const { w, project } = fixture();
  const sha = "a".repeat(40), unmatched = "b".repeat(40), shared = "aaaaaaa" + "c".repeat(33);
  // Repository identity is already resolved by the caller; no Git process is needed to read saved commits.
  w.repositories = [project];
  store.db.prepare("INSERT INTO adit_local_repositories VALUES (?,?)").run(project, 100);
  for (const hash of [sha, unmatched, shared]) store.db.prepare("INSERT INTO adit_local_commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(project, hash, "tree", 100, "User", "fixture@example.com", 100, "User", "fixture@example.com", "saved commit", "", 100);
  store.db.prepare("INSERT INTO adit_attribution_runs(id,workspace_id,algorithm_version,input_fingerprint,status,started_at,finished_at) VALUES ('run',?,1,'fixture','done',100,200)").run(w.id);
  store.db.prepare("INSERT INTO adit_attribution_commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("run", project, sha, "codex", "codex-session", null, null, "hash", sha, 3, 0, 1, 0, 0, 1, 1);
  store.db.prepare("INSERT INTO adit_attribution_writers VALUES (?,?,?,?,?,?,?,?,?)")
    .run("run", project, sha, "claude", "claude-session", "code.ts", 1, 0, 0);
  const all = reader.commits(w, { limit: 1, offset: 0 }); expect(all.total).toBe(3); expect(all.nextOffset).toBe(1);
  expect(reader.commits(w, { session: "claude-session", limit: 20, offset: 0 }).commits.map(c => c.sha)).toEqual([sha]);
  expect(reader.commits(w, { session: "codex-session", limit: 20, offset: 0 }).commits.map(c => c.sha)).toEqual([sha]);
  const result = await reader.commit(w, sha);
  expect(result.commit.record).toMatchObject({ provider: "codex", sessionId: "codex-session", method: "hash" });
  expect(result.authorship.sources[0]).toMatchObject({ provider: "claude", sessionId: "claude-session", certain: 1 });
  expect(result.authorship).toMatchObject({ moved: 1, unknown: 1 });
  expect((await reader.commit(w, unmatched)).commit).toMatchObject({ record: null, analyzed: false });
  await expect(reader.commit(w, "aaaaaaa")).rejects.toMatchObject({ code: "COMMIT_AMBIGUOUS" });
  await expect(reader.commit(w, sha, join(root, "unregistered"))).rejects.toMatchObject({ code: "REPOSITORY_NOT_FOUND" });
});
