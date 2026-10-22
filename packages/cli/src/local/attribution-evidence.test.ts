import { expect, it } from "vitest";
import {
  extractWritten,
  tokenOverlap,
  wordTokens,
  jsonTextValue,
  decodeEscapes,
} from "./attribution-evidence.js";
import { analysisIdentities, parseAddedLines } from "./attribution-analysis.js";
it("collects replacement text, never old text, paths, or search parameters", () => {
  const parts = extractWritten("Edit", {
    file_path: "src/a.ts",
    old_string: "old sensitive expression",
    new_string: "new written expression",
    pattern: "search needle",
  });
  expect(parts.map((p) => p.text)).toEqual(["new written expression"]);
  const script = extractWritten("exec_command", {
    cmd: `p.write_text(p.read_text().replace("old sensitive expression", "new written expression\\nsecond written expression"))`,
  });
  const lines = script.flatMap((p) => p.text.split("\n"));
  expect(lines).toContain("new written expression");
  expect(lines).toContain("second written expression");
  expect(lines.some((l) => l.includes("old sensitive expression"))).toBe(false);
  expect(
    extractWritten("Grep", {
      pattern: "new written expression",
      path: "src/a.ts",
    }),
  ).toEqual([]);
  expect(
    extractWritten("Read", {
      file_path: "src/a.ts",
      content: "output from read",
    }),
  ).toEqual([]);
});
it("accepts only added patch lines, including escaped patches inside script calls", () => {
  const patch =
    "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old written expression\n+new written expression\n context expression\n*** End Patch";
  expect(extractWritten("apply_patch", patch)).toEqual([
    { kind: "patch", path: "src/a.ts", text: "new written expression" },
  ]);
  const nested = extractWritten(
    "exec",
    `await tools.apply_patch(${JSON.stringify(patch)});`,
  );
  expect(nested.some((e) => e.text === "new written expression")).toBe(true);
  expect(nested.some((e) => e.text.includes("old written expression"))).toBe(
    false,
  );
});
it("handles PowerShell here-strings and excludes old multi-line replacement values", () => {
  const script =
    "$old = @'\nold expression first\nold expression second\n'@\n$new = @'\nnew expression first\nnew expression second\n'@\nSet-Content -LiteralPath $path -Value $content.Replace($old,$new)";
  const text = extractWritten("exec_command", { cmd: script })
    .map((e) => e.text)
    .join("\n");
  expect(text).toContain("new expression first");
  expect(text).not.toContain("old expression first");
  expect(text).not.toContain("old expression second");
});
it("does not treat request headers or runtime validation scripts as authored file content", () => {
  expect(
    extractWritten("exec_command", {
      cmd: "$encoded=$packageName.Replace('/','%2f'); Invoke-RestMethod -Uri $uri -Headers @{'Cache-Control'='no-cache'}",
      workdir: "/work",
    }),
  ).toEqual([]);
  const diagnostic =
    "import { rmSync } from 'node:fs';\nwriteProjectManifest(root, { schemaVersion: 1 });\nrmSync(root, { recursive: true, force: true });";
  expect(
    extractWritten(
      "exec",
      `text(await tools.exec_command({cmd:${JSON.stringify(diagnostic)},workdir:'/work'}));`,
    ),
  ).toEqual([]);
  // The same source explicitly saved into a file remains legitimate evidence.
  const saved = extractWritten("exec_command", {
    cmd: `writeFileSync('diagnostic.ts', ${JSON.stringify(diagnostic)})`,
  });
  expect(
    saved.some((part) =>
      part.text.includes("rmSync(root, { recursive: true, force: true });"),
    ),
  ).toBe(true);
});
it("temporarily deduplicates copied calls and credits child work without mutating sessions", () => {
  const sessions = [
    { provider: "claude", id: "a", started_at: 1 },
    { provider: "claude", id: "b", started_at: 2 },
    {
      provider: "claude",
      id: "child",
      parent_id: "a",
      relationship: "subagent",
      started_at: 3,
    },
    {
      provider: "claude",
      id: "fork",
      parent_id: "a",
      relationship: "fork",
      started_at: 4,
    },
  ];
  const before = JSON.stringify(sessions);
  const groups = analysisIdentities(sessions, [
    { provider: "claude", session_id: "a", source_call_id: "same" },
    { provider: "claude", session_id: "b", source_call_id: "same" },
  ]);
  expect(groups.find("claude\0a")).toBe(groups.find("claude\0b"));
  expect(groups.representative("claude\0child").id).toBe("a");
  expect(groups.find("claude\0fork")).not.toBe(groups.find("claude\0a"));
  expect(JSON.stringify(sessions)).toBe(before);
});
it("uses native continuation identity in analysis while preserving actual forks",()=>{
 const sessions=[{provider:"codex",id:"native",started_at:1},
  {provider:"codex",id:"native_page",parent_id:"native",relationship:"continuation",started_at:2},
  {provider:"codex",id:"fork",parent_id:"native",relationship:"fork",started_at:3}];
 const groups=analysisIdentities(sessions,[]);
 expect(groups.representative("codex\0native_page").id).toBe("native");
 expect(groups.representative("codex\0fork").id).toBe("fork");
});
it("requires at least ninety percent token overlap and preserves quoted values", () => {
  expect(
    tokenOverlap(
      wordTokens(
        "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
      ),
      wordTokens(
        "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo",
      ),
    ),
  ).toBeGreaterThanOrEqual(0.9);
  expect(
    tokenOverlap(
      wordTokens("alpha bravo charlie delta"),
      wordTokens("alpha bravo charlie changed"),
    ),
  ).toBeLessThan(0.9);
  expect(jsonTextValue('"welcome": "Welcome to the application",')).toBe(
    "Welcome to the application",
  );
  expect(decodeEscapes('a\\nb\\t\\"c\\"')).toBe('a\nb\t"c"');
});
it("persists short and generated lines as excluded and keeps exact hunk coordinates", () => {
  const lines = parseAddedLines(
    "diff --git a/a.ts b/a.ts\n+++ b/a.ts\n@@ -0,0 +10,2 @@\n+const realValue = 42;\n+}\ndiff --git a/prisma/migrations/a.sql b/prisma/migrations/a.sql\n+++ b/prisma/migrations/a.sql\n@@ -0,0 +1 @@\n+CREATE TABLE values_table;",
  );
  expect(lines.map((l) => [l.number, l.hunk, l.excluded])).toEqual([
    [10, 1, false],
    [11, 1, true],
    [1, 2, true],
  ]);
});
