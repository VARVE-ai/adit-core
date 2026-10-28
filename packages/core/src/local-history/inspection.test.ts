import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createHistorySchema } from "./schema.js";
import { StructuredHistory } from "./structured-store.js";
import { LocalInspection } from "./inspection.js";
import { parseCodex } from "./parsers.js";
import { SECRET_RULES_VERSION } from "./secret-detector.js";
import type { LocalWorkspace } from "../local-state.js";
import type { HistorySession } from "./types.js";
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const secret =
  "sk-ant-" +
  createHash("sha256").update("inspection-flow-synthetic").digest("hex");
const workspace: LocalWorkspace = {
  id: "w",
  name: "fixture",
  path: process.cwd(),
  version: 1,
  started: true,
  providers: ["claude"],
  repositories: [],
  cloud: { enabled: false, mode: "manual", interval: 5 },
  updatedAt: new Date().toISOString(),
};
function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  createHistorySchema(db);
  return {
    db,
    history: new StructuredHistory(db),
    inspection: new LocalInspection(db),
  };
}
function session(id = "main", prefix = ""): HistorySession {
  return {
    provider: "claude",
    id,
    cwd: workspace.path,
    messages: [
      {
        key: "prompt",
        role: "user",
        content: "Inspect configuration",
        raw: {},
        timestamp: "2026-10-20T10:00:00Z",
      },
      {
        key: "call",
        role: "assistant",
        model: "fixture-model",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: {
              command: "cat .env",
              description: "Inspect local configuration",
            },
          },
        ],
        raw: {},
        timestamp: "2026-10-20T10:00:01Z",
      },
      {
        key: "result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: prefix + "ANTHROPIC_API_KEY=" + secret,
          },
        ],
        raw: {},
        timestamp: "2026-10-20T10:00:02Z",
      },
    ],
  };
}
it("paginates session summaries and cards without changing occurrence totals or merging native sessions", () => {
  const { history, inspection } = fixture();
  const scope = { ...workspace, providers: ["claude", "codex"] };
  history.write({
    ...session(),
    messages: Array.from({ length: 52 }, (_, i) => ({
      key: `message-${i}`,
      role: "user",
      content: secret,
      raw: {},
    })),
  });
  history.write(session("other"));
  history.write({ ...session("main"), provider: "codex" });
  history.write({ ...session("outside"), cwd: "/outside-inspection-scope" });
  for (const [provider, id] of [
    ["claude", "main"],
    ["claude", "other"],
    ["codex", "main"],
    ["claude", "outside"],
  ])
    inspection.scanSession(provider, id);
  const original = inspection.read(scope);
  const grouped = inspection.read(scope, "pending", 0, undefined, {
    kind: "sessions",
  });
  expect(grouped.counts).toEqual(original.counts);
  expect(grouped.pendingDefinite).toBe(54);
  expect(grouped.items).toEqual([]);
  expect(grouped.sessions).toHaveLength(3);
  expect(
    grouped.sessions!.find(
      (s) => s.provider === "claude" && s.sessionId === "main",
    )?.count,
  ).toBe(52);
  const view = {
    kind: "session",
    provider: "claude",
    sessionId: "main",
  } as const;
  const first = inspection.read(scope, "pending", 0, undefined, view);
  const last = inspection.read(scope, "pending", 50, undefined, view);
  expect(first.items).toHaveLength(50);
  expect(first.nextOffset).toBe(50);
  expect(last.items).toHaveLength(2);
  expect(last.nextOffset).toBeNull();
  expect(first.counts).toEqual(original.counts);
  expect(
    inspection.setSessionStatus(scope, "claude", "main", "pending", "handled"),
  ).toBe(52);
  expect(inspection.read(scope).counts).toEqual({
    pending: 2,
    handled: 52,
    ignored: 0,
  });
  expect(
    inspection.setSessionStatus(scope, "claude", "main", "handled", "pending"),
  ).toBe(52);
  expect(inspection.read(scope).counts).toEqual(original.counts);
  expect(
    inspection.setSessionStatus(
      scope,
      "claude",
      "outside",
      "pending",
      "ignored",
    ),
  ).toBe(0);
  expect(JSON.stringify(grouped)).not.toContain(secret);
});

it("applies a session action only to its current rule and status, retaining candidates and other sessions", () => {
  const { history, inspection } = fixture();
  const github =
    "ghp_" +
    createHash("sha256").update("group-test").digest("hex").slice(0, 36);
  history.write({
    ...session(),
    messages: [
      {
        key: "test",
        role: "user",
        raw: {},
        content: `${secret}\n${github}\nhttps://example-user:example-password@example.com`,
      },
    ],
  });
  history.write(session("other"));
  inspection.scanSession("claude", "main");
  inspection.scanSession("claude", "other");
  const candidates = inspection.read(workspace).pendingCandidate;
  expect(candidates).toBeGreaterThan(0);
  expect(
    inspection.setSessionStatus(
      workspace,
      "claude",
      "main",
      "pending",
      "handled",
      "github-pat",
    ),
  ).toBe(1);
  expect(inspection.read(workspace).counts).toEqual({
    pending: 2,
    handled: 1,
    ignored: 0,
  });
  expect(
    inspection.setSessionStatus(
      workspace,
      "claude",
      "main",
      "pending",
      "ignored",
    ),
  ).toBe(1);
  expect(inspection.read(workspace).counts).toEqual({
    pending: 1,
    handled: 1,
    ignored: 1,
  });
  expect(inspection.read(workspace).pendingCandidate).toBe(candidates);
  expect(
    inspection.setSessionStatus(
      workspace,
      "claude",
      "main",
      "ignored",
      "pending",
    ),
  ).toBe(1);
  expect(() =>
    inspection.setSessionStatus(
      workspace,
      "claude",
      "main",
      "pending",
      "handled",
      "missing-rule",
    ),
  ).toThrow();
  expect(() =>
    inspection.setSessionStatus(
      workspace,
      "claude",
      "main",
      "pending",
      "invalid" as any,
    ),
  ).toThrow();
});

it("rolls back the whole session action if any disposition write fails", () => {
  const { db, history, inspection } = fixture();
  history.write({
    ...session(),
    messages: [
      { key: "a", role: "user", content: secret, raw: {} },
      { key: "b", role: "assistant", content: secret, raw: {} },
    ],
  });
  inspection.scanSession("claude", "main");
  db.exec(`CREATE TRIGGER fail_second_disposition BEFORE INSERT ON adit_history_secret_dispositions
    WHEN (SELECT count(*) FROM adit_history_secret_dispositions)>0
    BEGIN SELECT RAISE(ABORT,'test failure'); END`);
  expect(() =>
    inspection.setSessionStatus(
      workspace,
      "claude",
      "main",
      "pending",
      "handled",
    ),
  ).toThrow();
  expect(inspection.read(workspace).counts).toEqual({
    pending: 2,
    handled: 0,
    ignored: 0,
  });
});

it("paginates more than 50 matching sessions without downloading their contents", () => {
  const { history, inspection } = fixture();
  for (let i = 0; i < 52; i++) {
    history.write(session(`session-${i}`));
    inspection.scanSession("claude", `session-${i}`);
  }
  const first = inspection.read(workspace, "pending", 0, undefined, {
    kind: "sessions",
  });
  const second = inspection.read(workspace, "pending", 50, undefined, {
    kind: "sessions",
  });
  expect(first.sessions).toHaveLength(50);
  expect(first.items).toEqual([]);
  expect(first.nextOffset).toBe(50);
  expect(second.sessions).toHaveLength(2);
  expect(second.nextOffset).toBeNull();
  expect(
    new Set([...first.sessions!, ...second.sessions!].map((s) => s.sessionId))
      .size,
  ).toBe(52);
  expect(first.counts.pending).toBe(52);
});
it("scans tools only once, includes children, persists dispositions across source replacement and restart", async () => {
  const { db, history, inspection } = fixture();
  history.write(session());
  history.write({
    ...session("child"),
    cwd: "",
    parentId: "main",
    relationship: "subagent",
  });
  history.write({ ...session("outside"), cwd: "/outside-inspection-scope" });
  const run = inspection.start(workspace);
  await inspection.run(workspace, run);
  let data = inspection.read(workspace);
  expect(data).toMatchObject({
    total: 2,
    main: 1,
    children: 1,
    checked: 2,
    pendingDefinite: 2,
    maskReady: true,
  });
  expect(data.items).toHaveLength(2);
  const finding = data.items.find((i) => i.sessionId === "main")!;
  const occurrence = finding;
  expect(inspection.detail(workspace, occurrence.id)).toMatchObject({
    location: "tool_output",
    turn: 1,
    command: "cat .env",
    model: "fixture-model",
    input: null,
    envRead: true,
  });
  expect(JSON.stringify(data)).not.toContain(secret);
  inspection.setStatus(workspace, finding.id, "handled");
  history.write(session("main", "中文😀\n\n"));
  expect(inspection.read(workspace).checked).toBe(1);
  expect(() => inspection.detail(workspace, occurrence.id)).toThrow();
  inspection.scanSession("claude", "main");
  const restarted = new LocalInspection(db);
  expect(restarted.read(workspace, "handled").items[0].id).toBe(finding.id);
  expect(restarted.detail(workspace, occurrence.id).line).toBe(3);
  expect(
    JSON.stringify(
      db.prepare("SELECT * FROM adit_history_secret_findings").all(),
    ),
  ).not.toContain(secret);
  expect(
    JSON.stringify(db.prepare("SELECT adit_history_redact(text_content) FROM adit_history_blocks").all()),
  ).not.toContain(secret);
  expect(JSON.stringify(history.read("claude", "main"))).toContain(secret);
  expect(() =>
    inspection.detail(
      { ...workspace, path: "/outside-inspection-scope" },
      occurrence.id,
    ),
  ).toThrow();
});
it("counts native Codex tool inputs once while keeping real repeated prompts, replies and output", async () => {
  const { history, inspection } = fixture();
  const command = `echo ${secret}`;
  const value = parseCodex(
    [
      {
        type: "session_meta",
        payload: { id: "native-calls", cwd: workspace.path },
      },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: secret },
      },
      // Identical text in a genuine reply is a different occurrence.
      {
        type: "response_item",
        payload: { type: "message", role: "assistant", content: command },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "custom",
          name: "exec",
          input: command,
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "function",
          name: "shell",
          arguments: JSON.stringify({ command }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "custom",
          output: secret,
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  history.write(value);
  await inspection.run(workspace, inspection.start(workspace));
  const data = inspection.read(workspace);
  expect(data.pendingDefinite).toBe(5);
  expect(data.items).toHaveLength(5);
  expect(data.items.map((item) => item.location).sort()).toEqual([
    "prompt",
    "response",
    "tool_input",
    "tool_input",
    "tool_output",
  ]);
  for (const item of data.items.filter(
    (item) => item.location === "tool_input",
  ))
    expect(inspection.detail(workspace, item.id).field).toMatch(/^call\//);
});
it("rescans old field projections without rebuilding masking or losing canonical dispositions", async () => {
  const { db, history, inspection } = fixture();
  history.write(session());
  await inspection.run(workspace, inspection.start(workspace));
  const original = inspection.read(workspace).items[0];
  const occurrence = original;
  inspection.setStatus(workspace, original.id, "handled");
  db.prepare("UPDATE adit_history_secret_findings SET rules_version=?").run(
    SECRET_RULES_VERSION,
  );
  db.prepare("UPDATE adit_history_secret_scan_states SET rules_version=?").run(
    SECRET_RULES_VERSION,
  );
  // Old duplicate remains evidence only; the corrected scan deactivates it.
  const columns = (
    db.prepare("PRAGMA table_info(adit_history_secret_findings)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  db.prepare(
    `INSERT INTO adit_history_secret_findings SELECT ${columns.map((column) => (column === "id" ? "'obsolete-projection'" : column)).join(",")} FROM adit_history_secret_findings WHERE id=?`,
  ).run(occurrence.id);
  expect(inspection.read(workspace).checked).toBe(0);
  expect(inspection.maskReady()).toBe(true);
  await inspection.run(workspace, inspection.start(workspace, "collection"));
  expect(inspection.read(workspace).run).toMatchObject({
    total: 1,
    completed: 1,
    status: "done",
  });
  expect(inspection.read(workspace).counts).toEqual({
    pending: 0,
    handled: 1,
    ignored: 0,
  });
  expect(inspection.read(workspace, "handled").items[0].id).toBe(original.id);
  expect(
    db
      .prepare(
        "SELECT active FROM adit_history_secret_findings WHERE id='obsolete-projection'",
      )
      .get(),
  ).toEqual({ active: 0 });
  expect(inspection.maskReady()).toBe(true);
});
it("reuses full scans, backfills definite-only scans, retains results on cancellation and distinguishes new locations", async () => {
  const { history, inspection } = fixture();
  history.write(session());
  inspection.scanSession("claude", "main", true);
  expect(inspection.read(workspace).checked).toBe(0);
  await inspection.run(workspace, inspection.start(workspace, "collection"));
  const first = inspection.read(workspace).items[0];
  inspection.setStatus(workspace, first.id, "ignored");
  await inspection.run(workspace, inspection.start(workspace, "collection"));
  expect(inspection.read(workspace).run?.total).toBe(0);
  const updated = session();
  updated.messages.push({
    key: "new-output",
    role: "assistant",
    content: secret,
    raw: {},
  });
  history.write(updated);
  await inspection.run(workspace, inspection.start(workspace, "collection"));
  expect(inspection.read(workspace).counts).toEqual({
    pending: 1,
    handled: 0,
    ignored: 1,
  });
  expect(inspection.detail(workspace, first.id).status).toBe("ignored");
  const cancelled = inspection.start(workspace);
  inspection.cancel(workspace);
  await inspection.run(workspace, cancelled, true);
  expect(inspection.read(workspace).run?.status).toBe("cancelled");
  expect(inspection.read(workspace).counts.pending).toBe(1);
});
it("keeps display masking ready without storing a search copy or changing original evidence", async () => {
  const { db, history, inspection } = fixture();
  history.write(session());
  await inspection.run(workspace, inspection.start(workspace));
  expect(
    JSON.stringify(db.prepare("SELECT adit_history_redact(text_content) FROM adit_history_blocks").all()),
  ).not.toContain(secret);
  expect(JSON.stringify(history.read("claude", "main"))).toContain(secret);
  expect(inspection.maskReady()).toBe(true);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'adit_history_text_fts%'").all()).toEqual([]);
});
it("lists repeated occurrences independently, filters candidates and paginates findings", async () => {
  const { history, inspection } = fixture();
  const value = session();
  value.messages = [
    {
      key: "many",
      role: "user",
      content:
        Array(60).fill(secret).join("\n") +
        "\nAPI_TOKEN=" +
        createHash("sha256").update("candidate-only-fixture").digest("hex"),
      raw: {},
    },
  ];
  history.write(value);
  await inspection.run(workspace, inspection.start(workspace));
  const first = inspection.read(workspace),
    rest = inspection.read(workspace, "pending", 50);
  expect(first).toMatchObject({
    pendingDefinite: 60,
    pendingCandidate: 1,
    nextOffset: 50,
  });
  expect(first.items).toHaveLength(50);
  expect(rest.items).toHaveLength(10);
  expect(rest.nextOffset).toBeNull();
  expect(new Set([...first.items, ...rest.items].map((f) => f.id)).size).toBe(
    60,
  );
  const candidates = inspection.read(
    workspace,
    "pending",
    0,
    "high-entropy-assignment",
  );
  expect(candidates.items).toHaveLength(1);
  expect(candidates.counts.pending).toBe(1);
  inspection.setStatus(workspace, candidates.items[0].id, "handled");
  expect(inspection.pendingCount(workspace)).toBe(60);
  inspection.setStatus(workspace, first.items[0].id, "handled");
  expect(inspection.pendingCount(workspace)).toBe(59);
  expect(inspection.read(workspace).counts).toEqual({
    pending: 59,
    handled: 1,
    ignored: 0,
  });
  expect(
    inspection.read(workspace, "handled", 0, "high-entropy-assignment").counts
      .handled,
  ).toBe(1);
  expect(JSON.stringify(first)).not.toContain(secret);
  expect(() => inspection.read(workspace, "pending", 0, "invalid")).toThrow(
    "Invalid inspection rule",
  );
});

it("keeps prompt metadata for findings across sessions and orphan messages", async () => {
  const { history, inspection } = fixture();
  const value = session();
  value.messages = Array.from({ length: 52 }, (_, i) => ({
    key: `prompt-${i}`,
    role: "user" as const,
    content: secret,
    raw: {},
  }));
  history.write(value);
  history.write(session("other"));
  history.write({
    ...session("orphans"),
    messages: [
      { key: "orphan-1", role: "assistant", content: secret, raw: {} },
      { key: "orphan-2", role: "assistant", content: secret, raw: {} },
    ],
  });
  await inspection.run(workspace, inspection.start(workspace));
  const data = inspection.read(workspace);
  expect(data.pendingDefinite).toBe(55);
  expect(data.items).toHaveLength(50);
  expect(data.nextOffset).toBe(50);
  const all = [
    ...data.items,
    ...inspection.read(workspace, "pending", 50).items,
  ];
  expect(new Set(all.map((item) => item.id)).size).toBe(55);
  expect(
    all
      .filter((item) => item.sessionId === "main")
      .map((item) => item.turn)
      .sort((a, b) => a! - b!),
  ).toEqual(Array.from({ length: 52 }, (_, i) => i + 1));
  expect(
    all
      .filter((item) => item.sessionId === "orphans")
      .every((item) => item.turn === null),
  ).toBe(true);
});

it("changes only the selected finding in the same turn and retains decisions across rescans", async () => {
  const { db, history, inspection } = fixture();
  const value = session();
  value.messages.push({
    key: "reply",
    role: "assistant",
    content: secret,
    raw: {},
  });
  history.write(value);
  await inspection.run(workspace, inspection.start(workspace));
  const [first, second] = inspection.read(workspace).items;
  expect(first.turn).toBe(second.turn);
  inspection.setStatus(workspace, first.id, "handled");
  expect(inspection.detail(workspace, second.id).status).toBe("pending");
  inspection.setStatus(workspace, second.id, "ignored");
  await inspection.run(workspace, inspection.start(workspace), true);
  expect(new LocalInspection(db).read(workspace).counts).toEqual({
    pending: 0,
    handled: 1,
    ignored: 1,
  });
  value.messages.push({
    key: "new-output",
    role: "assistant",
    content: secret,
    raw: {},
  });
  history.write(value);
  await inspection.run(workspace, inspection.start(workspace));
  expect(inspection.read(workspace).counts).toEqual({
    pending: 1,
    handled: 1,
    ignored: 1,
  });
  const outside = { ...workspace, path: "/outside-inspection-scope" };
  expect(() => inspection.setStatus(outside, first.id, "ignored")).toThrow();
  expect(() =>
    inspection.setStatus(workspace, "turn_" + first.id, "ignored"),
  ).toThrow();
  inspection.setStatus(workspace, first.id, "pending");
  expect(inspection.read(workspace).counts).toEqual({
    pending: 2,
    handled: 0,
    ignored: 1,
  });
  history.write({ ...value, messages: [] });
  expect(() => inspection.setStatus(workspace, first.id, "handled")).toThrow();
});
