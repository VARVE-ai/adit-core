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
