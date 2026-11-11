import { expect, it } from "vitest";
import { resolve } from "node:path";
import { AttributionEvidenceStore, type AttributionEvidence } from "./attribution-evidence-store.js";

it("scopes temporary evidence by commit repository, file and time while retaining unlocated scripts", () => {
  const store = new AttributionEvidenceStore();
  const repository = resolve("fixture");
  const base: AttributionEvidence = {
    id: "target", provider: "claude", sessionId: "session", turnId: null, toolId: "tool",
    kind: "native_write", sourcePath: null, filePath: resolve(repository, "code.ts"),
    at: 10, text: "export const target = true;", group: "session", repository,
  };
  try {
    for (const evidence of [
      base,
      { ...base, text: "duplicate identity must not replace the first record" },
      { ...base, id: "other-file", filePath: resolve(repository, "other.ts") },
      { ...base, id: "future", at: 21 },
      { ...base, id: "other-repository", repository: resolve("other-repository") },
      { ...base, id: "script", kind: "script", filePath: null },
    ]) store.add(evidence);
    const first = [...store.forCommit(repository, [base.filePath!], 20)];
    expect(first.map(evidence => evidence.id)).toEqual(["target", "script"]);
    expect(first[0]).toMatchObject(base);
    expect([...store.forCommit(repository, [resolve(repository, "other.ts")], 20)].map(evidence => evidence.id))
      .toEqual(["other-file", "script"]);
    expect([...store.forCommit(repository, [base.filePath!], 21)].map(evidence => evidence.id))
      .toEqual(["target", "future", "script"]);
  } finally {
    store.close();
  }
  expect(() => [...store.forCommit(repository, [base.filePath!], 20)]).toThrow();
});

it("preserves platform path matching, including non-ASCII case on Windows", () => {
  const store = new AttributionEvidenceStore();
  const repository = resolve("fixture");
  try {
    store.add({
      id: "case", provider: "codex", sessionId: "session", turnId: null, toolId: "tool",
      kind: "native_write", sourcePath: null, filePath: resolve(repository, "ÄCode.ts"),
      at: 10, text: "export const target = true;", group: "session", repository,
    });
    expect([...store.forCommit(repository, [resolve(repository, "äcode.ts")], 10)])
      .toHaveLength(process.platform === "win32" ? 1 : 0);
  } finally {
    store.close();
  }
});

it("queries only explicit file writes for large-file association, never unlocated code", () => {
  const store = new AttributionEvidenceStore(), repository = resolve("file-only-fixture");
  const base: AttributionEvidence = { id: "write", provider: "codex", sessionId: "session", turnId: null,
    toolId: "tool", kind: "file_write", sourcePath: null, filePath: resolve(repository, "large.pen"),
    at: 10, text: "", group: "session", repository };
  try {
    for (const row of [base, { ...base, id: "content", kind: "native_write", text: "recorded contents" },
      { ...base, id: "unlocated", kind: "script", filePath: null },
      { ...base, id: "future", at: 11 },
      { ...base, id: "other", filePath: resolve(repository, "other/large.pen") }]) store.add(row);
    expect([...store.forFileWrites(repository, [base.filePath!], 10)].map(row => row.id)).toEqual(["write"]);
    expect([...store.forFileWrites(repository, [], 10)]).toEqual([]);
  } finally { store.close(); }
});

it("selects matching file records and only the scripts from those write calls before falling back", () => {
  const store = new AttributionEvidenceStore(), repository = resolve("path-first-fixture");
  const base: AttributionEvidence = { id: "target", provider: "codex", sessionId: "writer", turnId: null,
    toolId: "target-call", kind: "file_write", sourcePath: null, filePath: resolve(repository, "src/code.ts"),
    at: 10, text: "", group: "writer", repository };
  try {
    for (const row of [base,
      { ...base, id: "target-code", kind: "script_literal", filePath: null, text: "export const target = true;" },
      { ...base, id: "native", toolId: "native-call", kind: "native_write", text: "export const native = true;" },
      { ...base, id: "other-file", filePath: resolve(repository, "other/code.ts"), toolId: "other-call" },
      { ...base, id: "unlocated", toolId: "unknown-call", kind: "script_literal", filePath: null, text: "unlocated content" },
      { ...base, id: "different-provider", provider: "claude", kind: "script_literal", filePath: null, text: "different provider" },
      { ...base, id: "different-session", sessionId: "other-session", kind: "script_literal", filePath: null, text: "different session" },
      { ...base, id: "future", at: 11, kind: "script_literal", filePath: null, text: "future content" },
    ]) store.add(row);
    const target = store.forFile(repository, base.filePath!, 10);
    expect(target.mode).toBe("path");
    expect([...target.evidence].map(row => row.id)).toEqual(["target", "target-code", "native"]);
    expect(store.forFile(repository, base.filePath!, 9).mode).toBe("fallback");
    const fallback = store.forFile(repository, resolve(repository, "missing.ts"), 10);
    expect(fallback.mode).toBe("fallback");
    expect([...fallback.evidence].every(row => row.filePath === null && row.at <= 10)).toBe(true);
  } finally { store.close(); }
});

it("keeps insertion order and time boundaries across indexed file and unlocated evidence", () => {
  const store = new AttributionEvidenceStore();
  const repository = resolve("large-fixture");
  const rows: AttributionEvidence[] = Array.from({ length: 3000 }, (_, index) => ({
    id: String(index), provider: "codex", sessionId: "session", turnId: null, toolId: null,
    kind: "script", sourcePath: null,
    filePath: index % 17 === 0 ? null : resolve(repository, `file-${index % 100}.ts`),
    at: index % 50, text: `export const value${index} = true;`, group: "session",
    repository: index % 19 === 0 ? null : index % 23 === 0 ? resolve("other-repository") : repository,
  }));
  try {
    rows.forEach(row => store.add(row));
    for (const names of [[], ["file-1.ts"], ["file-9.ts", "file-1.ts", "file-9.ts"]]) {
      const paths = names.map(name => resolve(repository, name));
      const expected = rows.filter(row => row.repository === repository && row.at <= 25 &&
        (row.filePath === null || paths.includes(row.filePath)));
      expect([...store.forCommit(repository, paths, 25)].map(row => row.id))
        .toEqual(expected.map(row => row.id));
    }
  } finally {
    store.close();
  }
});

it("keeps batch writes identical to individual writes and rolls back interrupted batches", () => {
  const individual = new AttributionEvidenceStore(), batched = new AttributionEvidenceStore();
  const repository = resolve("batch-fixture");
  const base: AttributionEvidence = { id: "first", provider: "codex", sessionId: "session", turnId: null,
    toolId: "call", kind: "native_write", sourcePath: null, filePath: resolve(repository, "src/code.ts"),
    at: 10, text: "export const first = true;", group: "session", repository };
  const rows = [base, { ...base, text: "a duplicate must not replace the original" },
    { ...base, id: "unlocated", filePath: null }, { ...base, id: "future", at: 20 },
    { ...base, id: "other", filePath: resolve(repository, "other.ts") },
    { ...base, id: "last" }];
  try {
    rows.forEach(row => individual.add(row));
    batched.addAll(rows);
    expect([...batched.forRepository(repository, 30)]).toEqual([...individual.forRepository(repository, 30)]);
    expect([...batched.forFile(repository, base.filePath!, 10).evidence])
      .toEqual([...individual.forFile(repository, base.filePath!, 10).evidence]);
    function* interrupted() {
      // Spill beyond the 4 MiB page cache: rollback must also restore disk pages.
      for (let index = 0; index < 1500; index++)
        yield { ...base, id: "interrupted-" + index, text: "x".repeat(4096) };
      throw new Error("cancelled while producing evidence");
    }
    expect(() => batched.addAll(interrupted())).toThrow("cancelled");
    expect([...batched.forRepository(repository, 30)]).toEqual([...individual.forRepository(repository, 30)]);
    batched.addAll([{ ...base, id: "recovered" }]);
    expect([...batched.forRepository(repository, 30)].at(-1)?.id).toBe("recovered");
  } finally { individual.close(); batched.close(); }
});
