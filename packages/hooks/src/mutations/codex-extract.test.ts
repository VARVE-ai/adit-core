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

describe("extractCodexMutationsFromTranscript", () => {
  it("extracts successful patch_apply_end updates from the latest Codex turn", () => {
    const dir = tempDir();
    try {
      const transcriptPath = join(dir, "019efde3-72c7-7f82-9f7c-5f3d63cee24f.jsonl");
      writeJsonl(transcriptPath, [
        userMessage("old turn"),
        patchApplyEnd("old_call", {
          "/project/old.ts": {
            type: "update",
            unified_diff: "@@ -1,1 +1,1 @@\n-old\n+old-new\n",
            move_path: null,
          },
        }),
        userMessage("current turn"),
        patchApplyEnd("call_patch", {
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
        toolUseId: "call_patch",
        toolName: "apply_patch",
        path: "/project/src/app.ts",
        kind: "update",
        status: "completed",
        source: "codex-patch-apply-end",
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
        patchApplyEnd("call_add", {
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
        userMessage("try risky patch"),
        {
          timestamp: "2026-06-25T08:28:21.484Z",
          type: "event_msg",
          payload: {
            type: "patch_apply_end",
            call_id: "call_failed",
            success: false,
            status: "failed",
            changes: {
              "/project/src/risky.ts": {
                type: "update",
                unified_diff: "@@ -1,1 +1,1 @@\n-old\n+new\n",
              },
            },
          },
        },
      ]);

      const result = extractCodexMutationsFromTranscript(transcriptPath);

      expect(result?.mutations).toHaveLength(1);
      expect(result?.mutations[0]).toMatchObject({
        toolUseId: "call_failed",
        path: "/project/src/risky.ts",
        kind: "update",
        status: "failed",
        omitted: { reason: "failed" },
      });
      expect(result?.mutations[0]?.diff).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts concrete Bash write targets from the latest Codex turn", () => {
    const dir = tempDir();
    try {
      const transcriptPath = join(dir, "019efde3-72c7-7f82-9f7c-5f3d63cee24f.jsonl");
      writeJsonl(transcriptPath, [
        userMessage("old turn"),
        execCommandEnd("old_call", "printf old > packages/old.txt"),
        userMessage("write files"),
        execCommandEnd(
          "call_shell",
          "printf hi > packages/core/src/generated.ts\nsips input.png -o packages/cloud/out.png",
        ),
      ]);

      const result = extractCodexMutationsFromTranscript(transcriptPath);

      expect(result?.mutations).toMatchObject([
        {
          provider: "codex",
          toolUseId: "call_shell",
          toolName: "Bash",
          path: "/project/packages/core/src/generated.ts",
          kind: "update",
          status: "completed",
          source: "codex-bash-output",
          omitted: { reason: "unavailable" },
        },
        {
          path: "/project/packages/cloud/out.png",
          source: "codex-bash-output",
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records rm/unlink targets as deletions", () => {
    const dir = tempDir();
    try {
      const transcriptPath = join(dir, "019efde3-72c7-7f82-9f7c-5f3d63cee24f.jsonl");
      writeJsonl(transcriptPath, [
        userMessage("clean up"),
        execCommandEnd("call_rm", "rm packages/core/src/tmp.ts\ntouch packages/core/src/kept.ts"),
      ]);

      const result = extractCodexMutationsFromTranscript(transcriptPath);

      expect(result?.mutations).toMatchObject([
        {
          path: "/project/packages/core/src/tmp.ts",
          kind: "delete",
          source: "codex-bash-output",
        },
        {
          path: "/project/packages/core/src/kept.ts",
          kind: "update",
          source: "codex-bash-output",
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function userMessage(text: string): unknown {
  return {
    timestamp: "2026-06-25T08:28:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  };
}

function patchApplyEnd(callId: string, changes: Record<string, unknown>): unknown {
  return {
    timestamp: "2026-06-25T08:28:21.484Z",
    type: "event_msg",
    payload: {
      type: "patch_apply_end",
      call_id: callId,
      turn_id: "019efde3-72c7-7f82-9f7c-5f3d63cee24f",
      stdout: "Success. Updated the following files:\n",
      stderr: "",
      success: true,
      changes,
      status: "completed",
    },
  };
}

function execCommandEnd(callId: string, command: string): unknown {
  return {
    timestamp: "2026-06-25T08:28:21.484Z",
    type: "event_msg",
    payload: {
      type: "exec_command_end",
      call_id: callId,
      command: ["/bin/zsh", "-lc", command],
      cwd: "/project",
      parsed_cmd: [{ type: "unknown", cmd: command }],
      exit_code: 0,
      status: "completed",
    },
  };
}
