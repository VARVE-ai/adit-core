import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { extractCodexMutationsFromTranscript } from "./codex-extract.js";

function tempDir(): string {
  const dir = join(tmpdir(), `adit-codex-mutations-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJsonl(path: string, entries: unknown[]): void {
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n"));
}

function userMessage(text: string) {
  return {
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  };
}

/** Shape of the record Codex 0.151+ writes when apply_patch finishes. */
function fileChange(id: string, changes: Record<string, unknown>, status = "completed") {
  return {
    type: "event_msg",
    payload: {
      type: "item_completed",
      thread_id: "thread-1",
      turn_id: "turn-1",
      item: { type: "FileChange", id, changes, status, stdout: "", stderr: "" },
    },
  };
}

describe("extractCodexMutationsFromTranscript", () => {
  it("extracts completed FileChange items from the latest Codex turn", () => {
    const dir = tempDir();
    try {
      const transcriptPath = join(dir, "019efde3-72c7-7f82-9f7c-5f3d63cee24f.jsonl");
      writeJsonl(transcriptPath, [
        userMessage("old turn"),
        fileChange("patch-old", {
          "/project/old.ts": {
            type: "update",
            unified_diff: "@@ -1,1 +1,1 @@\n-old\n+old-new\n",
            move_path: null,
          },
        }),
        userMessage("current turn"),
        fileChange("patch-1", {
          "/project/src/app.ts": {
            type: "update",
            unified_diff: "@@ -1,1 +1,1 @@\n-old\n+new\n",
            move_path: null,
          },
        }),
      ]);

      const result = extractCodexMutationsFromTranscript(transcriptPath);

      expect(result?.mutations).toHaveLength(1);
      expect(result?.mutations[0]).toMatchObject({
        provider: "codex",
        toolUseId: "patch-1",
        toolName: "apply_patch",
        path: "/project/src/app.ts",
        kind: "update",
        status: "completed",
        source: "codex-file-change",
        additions: 1,
        deletions: 1,
        diff: "@@ -1,1 +1,1 @@\n-old\n+new\n",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses Codex add content when no unified_diff is present", () => {
    const dir = tempDir();
    try {
      const transcriptPath = join(dir, "019efde3-72c7-7f82-9f7c-5f3d63cee24f.jsonl");
      writeJsonl(transcriptPath, [
        userMessage("add a file"),
        fileChange("patch-add", {
          "/project/src/new.ts": {
            type: "add",
            content: "const value = 1;\nexport { value };\n",
          },
        }),
      ]);

      const result = extractCodexMutationsFromTranscript(transcriptPath);

      expect(result?.mutations).toHaveLength(1);
      expect(result?.mutations[0]).toMatchObject({
        path: "/project/src/new.ts",
        kind: "add",
        status: "completed",
        additions: 2,
        deletions: 0,
        diff: "@@ -0,0 +1,2 @@\n+const value = 1;\n+export { value };",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records failed Codex patch applications without diff evidence", () => {
    const dir = tempDir();
    try {
      const transcriptPath = join(dir, "019efde3-72c7-7f82-9f7c-5f3d63cee24f.jsonl");
      writeJsonl(transcriptPath, [
        userMessage("try a patch"),
        fileChange("patch-failed", {
          "/project/src/broken.ts": {
            type: "update",
            unified_diff: "@@ -1,1 +1,1 @@\n-old\n+new\n",
            move_path: null,
          },
        }, "failed"),
      ]);

      const result = extractCodexMutationsFromTranscript(transcriptPath);

      expect(result?.mutations).toHaveLength(1);
      expect(result?.mutations[0]).toMatchObject({
        path: "/project/src/broken.ts",
        status: "failed",
        omitted: { reason: "failed" },
      });
      expect(result?.mutations[0]?.diff).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores exec scripts, command executions and the retired patch_apply_end records", () => {
    const dir = tempDir();
    try {
      const transcriptPath = join(dir, "019efde3-72c7-7f82-9f7c-5f3d63cee24f.jsonl");
      writeJsonl(transcriptPath, [
        userMessage("edit through a script"),
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            call_id: "call-exec",
            name: "exec",
            status: "completed",
            input: 'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: /project/a.ts\\n@@\\n-1\\n+2\\n*** End Patch"))',
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: {
              type: "CommandExecution",
              id: "exec-1",
              command: ["/bin/zsh", "-lc", "sed -i '' 's/1/2/' /project/a.ts"],
              cwd: "file:///project",
              exit_code: 0,
              status: "completed",
              aggregated_output: "",
            },
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "patch_apply_end",
            call_id: "legacy",
            status: "completed",
            changes: { "/project/a.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-1\n+2" } },
          },
        },
      ]);

      expect(extractCodexMutationsFromTranscript(transcriptPath)?.mutations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
