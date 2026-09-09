import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDatabase,
  hasGitCommitEvent,
  insertSession,
  openDatabase,
  queryEvents,
  type AditConfig,
} from "@varveai/adit-core";
import { createTimelineManager } from "@varveai/adit-engine";

const mocks = vi.hoisted(() => ({ debugLog: vi.fn() }));
vi.mock("../common/debug-log.js", () => ({ debugLog: mocks.debugLog }));

import { recordGitCommits } from "./record.js";
import { extractGitOperations } from "./extract.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("recordGitCommits", () => {
  it("records desktop loop commits in three repositories once, excluding a failed execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "adit-desktop-loop-"));
    tempDirs.push(root);
    const names = ["cloud", "core", "docker"];
    const results: Array<Record<string, unknown>> = [];
    const shas: string[] = [];
    const repositories = names.map((repo) => {
      const path = join(root, repo);
      mkdirSync(path);
      const git = (args: string[]) => execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
      git(["init", "-b", "main"]);
      git(["config", "user.name", "Test"]);
      git(["config", "user.email", "test@example.com"]);
      const output = git(["commit", "--allow-empty", "-m", `fix: ${repo}`]);
      shas.push(git(["rev-parse", "HEAD"]));
      results.push({ repo, chunk_id: repo, wall_time_seconds: 0.01, exit_code: 0, output });
      return { localRepositoryId: repo, relativePath: repo, displayName: repo,
        repositoryUrl: null, canonicalRepoKey: null, path };
    });
    const transcriptPath = join(root, "turn.jsonl");
    const source = `
      const repos = ["cloud", "core", "docker", "cloud"];
      for (const repo of repos) {
        const r = await tools.exec_command({cmd:"git commit -m 'fix: " + repo + "'",workdir:${JSON.stringify(root + "/")} + repo});
        text({repo,...r});
        if (r.exit_code !== 0) break;
      }`;
    writeFileSync(transcriptPath, [
      { payload: { type: "message", role: "user", content: "commit all" } },
      { payload: { type: "custom_tool_call", call_id: "batch", name: "exec", status: "completed", input: source } },
      { payload: { type: "custom_tool_call_output", call_id: "batch", output: [
        { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
        ...[...results, {repo: "cloud", wall_time_seconds: 0, exit_code: 1, output: "nothing to commit"}]
          .map((result) => ({type: "input_text", text: JSON.stringify(result)})),
      ] } },
    ].map((entry) => JSON.stringify(entry)).join("\n"));
    const dbPath = join(root, ".adit", "adit.sqlite");
    const db = openDatabase(dbPath);
    try {
      const config: AditConfig = { projectRoot: root, dataDir: join(root, ".adit"), dbPath,
        clientId: "client", projectId: "project", projectType: "workspace", repositories,
        initialization: "initialized", captureEnv: false };
      const session = { id: "session", projectId: "project", clientId: "client",
        sessionType: "interactive" as const, platform: "codex" as const,
        startedAt: new Date().toISOString(), vclockJson: "{}", platformSessionId: "desktop",
        metadataJson: null, deletedAt: null };
      insertSession(db, session);
      const input = { cwd: root, hookType: "stop" as const, platformCli: "codex" as const,
        platformSessionId: "desktop", transcriptPath };
      const timeline = createTimelineManager(db, config);
      for (let attempt = 0; attempt < 2; attempt++) await recordGitCommits({ db, config, session }, input, timeline);
      const events = queryEvents(db, { eventType: "git_commit", limit: 10 });
      expect(events).toHaveLength(3);
      names.forEach((repo, index) => {
        const event = events.find((event) => event.gitHeadSha === shas[index]);
        expect(event?.responseText).toBe(`fix: ${repo}`);
        expect(JSON.parse(event?.toolInputJson ?? "{}")).toMatchObject({
          toolCallId: `batch:exec:${index}`, operationIndex: 0, localRepositoryId: repo, relativePath: repo,
        });
      });
    } finally { closeDatabase(db); }
  });

  it("records only a successful git commit once and resolves its printed SHA", async () => {
    const root = mkdtempSync(join(tmpdir(), "adit-git-commit-record-"));
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
          command: "git status && git commit -m initial",
          cwd: root,
          status: "completed",
          exit_code: 0,
          aggregated_output: `[main ${sha.slice(0, 7)}] initial`,
        },
      }),
      JSON.stringify({
        payload: {
          type: "exec_command_end",
          call_id: "call-2",
          command: "git commit -m failed",
          cwd: root,
          status: "failed",
          exit_code: 1,
          aggregated_output: "nothing to commit",
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
    })).toHaveLength(3);
    expect(hasGitCommitEvent(db, "session-1", "codex", "call-1", 1)).toBe(false);

    await recordGitCommits(ctx, input, createTimelineManager(db, config));
    await recordGitCommits(ctx, input, createTimelineManager(db, config));

    const events = queryEvents(db, { eventType: "git_commit", limit: 10 });
    expect(mocks.debugLog).not.toHaveBeenCalled();
    expect(queryEvents(db, { limit: 10 }).map((event) => event.eventType)).toEqual(["git_commit"]);
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
      operationIndex: 1,
      localRepositoryId: "repo-1",
      relativePath: ".",
      workingDirectory: ".",
      commitMessage: "initial",
    });
    closeDatabase(db);
  });

  it("records two commits from one tool call with their own SHAs and messages", async () => {
    const root = mkdtempSync(join(tmpdir(), "adit-git-commit-multi-"));
    tempDirs.push(root);
    execFileSync("git", ["init", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    writeFileSync(join(root, "a.txt"), "a\n");
    execFileSync("git", ["add", "a.txt"], { cwd: root });
    execFileSync("git", ["commit", "-m", "first"], { cwd: root });
    const firstSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    writeFileSync(join(root, "b.txt"), "b\n");
    execFileSync("git", ["add", "b.txt"], { cwd: root });
    execFileSync("git", ["commit", "-m", "second"], { cwd: root });
    const secondSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

    const transcriptPath = join(root, "turn.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({
        type: "user",
        sessionId: "claude-1",
        message: { content: "commit twice" },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId: "claude-1",
        message: {
          content: [{
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: {
              command: "git add a.txt && git commit -m first && git add b.txt && git commit -m second",
            },
          }],
        },
      }),
      JSON.stringify({
        type: "user",
        sessionId: "claude-1",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "ok",
          }],
        },
        toolUseResult: {
          stdout: `[main ${firstSha.slice(0, 7)}] first\n[main ${secondSha.slice(0, 7)}] second`,
          interrupted: false,
        },
      }),
    ].join("\n"));

    const dbPath = join(root, ".adit", "adit.sqlite");
    const db = openDatabase(dbPath);
    const config: AditConfig = {
      projectRoot: root,
      dataDir: join(root, ".adit"),
      dbPath,
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
      platform: "claude-code",
      startedAt: new Date().toISOString(),
      vclockJson: "{}",
      platformSessionId: "claude-1",
    });
    const ctx = {
      db,
      config,
      session: {
        id: "session-1",
        projectId: config.projectId,
        clientId: config.clientId,
        sessionType: "interactive" as const,
        platform: "claude-code" as const,
        startedAt: new Date().toISOString(),
        metadataJson: null,
        vclockJson: "{}",
        platformSessionId: "claude-1",
        deletedAt: null,
      },
    };

    await recordGitCommits(ctx, {
      cwd: root,
      hookType: "stop",
      platformCli: "claude-code",
      platformSessionId: "claude-1",
      transcriptPath,
    }, createTimelineManager(db, config));

    const events = queryEvents(db, { eventType: "git_commit", limit: 10 });
    expect(events).toHaveLength(2);

    const first = events.find((event) => event.responseText === "first");
    const second = events.find((event) => event.responseText === "second");
    expect(first?.gitHeadSha).toBe(firstSha);
    expect(second?.gitHeadSha).toBe(secondSha);
    expect(JSON.parse(first?.toolInputJson ?? "{}")).toMatchObject({
      operationIndex: 1,
      commitMessage: "first",
    });
    expect(JSON.parse(second?.toolInputJson ?? "{}")).toMatchObject({
      operationIndex: 3,
      commitMessage: "second",
    });
    closeDatabase(db);
  });

  it("keeps Claude's printed commit subject when the command ran outside a configured repository", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "adit-git-commit-project-"));
    const commandRoot = mkdtempSync(join(tmpdir(), "adit-git-commit-external-"));
    tempDirs.push(projectRoot, commandRoot);

    const transcriptPath = join(projectRoot, "turn.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({
        type: "user",
        sessionId: "claude-1",
        message: { content: "commit it" },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId: "claude-1",
        message: {
          content: [{
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: `cd ${commandRoot} && git commit -m fix` },
          }],
        },
      }),
      JSON.stringify({
        type: "user",
        sessionId: "claude-1",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "[main (root-commit) abc1234] Add test.md with sample content",
          }],
        },
        toolUseResult: {
          stdout: "[main (root-commit) abc1234] Add test.md with sample content",
          stderr: "Shell cwd was reset to the project root",
          interrupted: false,
        },
      }),
    ].join("\n"));

    const dbPath = join(projectRoot, ".adit", "adit.sqlite");
    const db = openDatabase(dbPath);
    const config: AditConfig = {
      projectRoot,
      dataDir: join(projectRoot, ".adit"),
      dbPath,
      clientId: "client-1",
      projectId: "project-1",
      projectType: "repo",
      repositories: [{
        localRepositoryId: "repo-1",
        relativePath: ".",
        displayName: "repo",
        repositoryUrl: null,
        canonicalRepoKey: null,
        path: projectRoot,
      }],
      initialization: "initialized",
      captureEnv: false,
    };
    insertSession(db, {
      id: "session-1",
      projectId: config.projectId,
      clientId: config.clientId,
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: new Date().toISOString(),
      vclockJson: "{}",
      platformSessionId: "claude-1",
    });
    const ctx = {
      db,
      config,
      session: {
        id: "session-1",
        projectId: config.projectId,
        clientId: config.clientId,
        sessionType: "interactive" as const,
        platform: "claude-code" as const,
        startedAt: new Date().toISOString(),
        metadataJson: null,
        vclockJson: "{}",
        platformSessionId: "claude-1",
        deletedAt: null,
      },
    };

    await recordGitCommits(ctx, {
      cwd: projectRoot,
      hookType: "stop",
      platformCli: "claude-code",
      platformSessionId: "claude-1",
      transcriptPath,
    }, createTimelineManager(db, config));

    const events = queryEvents(db, { eventType: "git_commit", limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      responseText: "Add test.md with sample content",
      gitBranch: "main",
      gitHeadSha: null,
    });
    expect(JSON.parse(events[0].toolInputJson ?? "{}")).toMatchObject({
      localRepositoryId: null,
      relativePath: null,
      workingDirectory: null,
      commitMessage: "Add test.md with sample content",
    });
    closeDatabase(db);
  });
});
