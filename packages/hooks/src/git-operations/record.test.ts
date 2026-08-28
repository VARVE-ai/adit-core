import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDatabase,
  hasGitOperationEvent,
  insertSession,
  openDatabase,
  queryEvents,
  type AditConfig,
} from "@varveai/adit-core";
import { createTimelineManager } from "@varveai/adit-engine";

const mocks = vi.hoisted(() => ({ debugLog: vi.fn() }));
vi.mock("../common/debug-log.js", () => ({ debugLog: mocks.debugLog }));

import { recordGitOperations } from "./record.js";
import { extractGitOperations } from "./extract.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("recordGitOperations", () => {
  it("records a real command once and resolves only the SHA printed by that command", async () => {
    const root = mkdtempSync(join(tmpdir(), "adit-git-operation-record-"));
    tempDirs.push(root);
    execFileSync("git", ["init", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    writeFileSync(join(root, "a.txt"), "a\n");
    execFileSync("git", ["add", "a.txt"], { cwd: root });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: root });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

    const transcriptPath = join(root, "turn.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({ payload: { type: "message", role: "user", content: "commit" } }),
      JSON.stringify({
        payload: {
          type: "exec_command_end",
          call_id: "call-1",
          command: "git commit -m initial",
          cwd: root,
          status: "completed",
          exit_code: 0,
          aggregated_output: `[main ${sha.slice(0, 7)}] initial`,
        },
      }),
    ].join("\n"));

    const db = openDatabase(join(root, ".adit", "adit.sqlite"));
    const config: AditConfig = {
      projectRoot: root,
      dataDir: join(root, ".adit"),
      dbPath: join(root, ".adit", "adit.sqlite"),
      clientId: "client-1",
      projectId: "project-1",
      projectType: "repo",
      repositories: [{
        localRepositoryId: "repo-1",
        relativePath: ".",
        displayName: "repo",
        repositoryUrl: null,
        canonicalRepoKey: null,
        path: root,
      }],
      initialization: "initialized",
      captureEnv: false,
    };
    insertSession(db, {
      id: "session-1",
      projectId: config.projectId,
      clientId: config.clientId,
      sessionType: "interactive",
      platform: "codex",
      startedAt: new Date().toISOString(),
      vclockJson: "{}",
      platformSessionId: "platform-1",
    });
    const ctx = {
      db,
      config,
      session: {
        id: "session-1",
        projectId: config.projectId,
        clientId: config.clientId,
        sessionType: "interactive" as const,
        platform: "codex" as const,
        startedAt: new Date().toISOString(),
        metadataJson: null,
        vclockJson: "{}",
        platformSessionId: "platform-1",
        deletedAt: null,
      },
    };
    const input = {
      cwd: root,
      hookType: "stop" as const,
      platformCli: "codex" as const,
      platformSessionId: "platform-1",
      transcriptPath,
    };

    expect(extractGitOperations({
      platform: "codex",
      transcriptPath,
      expectedSessionId: "platform-1",
      defaultCwd: root,
    })).toHaveLength(1);
    expect(hasGitOperationEvent(db, "session-1", "codex", "call-1", 0)).toBe(false);

    await recordGitOperations(ctx, input, createTimelineManager(db, config));
    await recordGitOperations(ctx, input, createTimelineManager(db, config));

    const events = queryEvents(db, { eventType: "git_operation", limit: 10 });
    expect(mocks.debugLog).not.toHaveBeenCalled();
    expect(queryEvents(db, { limit: 10 }).map((event) => event.eventType)).toEqual(["git_operation"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: "assistant",
      responseText: "initial",
      toolName: "commit",
      status: "success",
      gitBranch: "main",
      gitHeadSha: sha,
    });
    expect(events[0].toolInputJson).not.toContain("git commit");
    expect(JSON.parse(events[0].toolInputJson ?? "{}")).toMatchObject({
      provider: "codex",
      toolCallId: "call-1",
      operationIndex: 0,
      localRepositoryId: "repo-1",
      relativePath: ".",
      workingDirectory: ".",
      commitMessage: "initial",
    });
    closeDatabase(db);
  });
});
