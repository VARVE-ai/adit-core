import { EventEmitter } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockAbortError extends Error {}
  return {
    AbortError: MockAbortError,
    spawn: vi.fn(),
    spawnSync: vi.fn(),
    query: vi.fn(),
    remoteInterrupt: vi.fn(),
    remoteClose: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mocks.spawn(...args),
  spawnSync: (...args: unknown[]) => mocks.spawnSync(...args),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  AbortError: mocks.AbortError,
  query: (...args: unknown[]) => mocks.query(...args),
}));

vi.mock("@varveai/adit-engine", () => ({
  getCurrentBranch: vi.fn(async () => "main"),
}));

import {
  ClaudeCodeProvider,
  buildClaudeCloudRelayEnv,
  normalizeClaudeSdkTranscriptEntrypoints,
  normalizeClaudeTodoWriteInput,
} from "./provider.js";

function mockChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    child.emit("exit", 0, null);
    return true;
  });
  return child;
}

function createCapabilityQuery() {
  return {
    supportedCommands: vi.fn(async () => []),
    mcpServerStatus: vi.fn(async () => []),
    close: vi.fn(),
    interrupt: vi.fn(),
    async *[Symbol.asyncIterator]() {},
  };
}

function createRemoteQuery(abortController?: AbortController) {
  return {
    supportedCommands: vi.fn(async () => []),
    mcpServerStatus: vi.fn(async () => []),
    getContextUsage: vi.fn(async () => ({
      totalTokens: 100,
      maxTokens: 200,
      percentage: 50,
      model: "claude-test",
    })),
    close: mocks.remoteClose,
    interrupt: mocks.remoteInterrupt.mockImplementation(async () => {
      abortController?.abort();
    }),
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve, reject) => {
        const signal = abortController?.signal;
        if (!signal) return resolve();
        if (signal.aborted) {
          reject(new mocks.AbortError("aborted"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(new mocks.AbortError("aborted")),
          { once: true },
        );
      });
    },
  };
}

function findRemoteQueryCall(): {
  options?: Record<string, unknown>;
  prompt?: AsyncIterable<Record<string, unknown>>;
} {
  const call = mocks.query.mock.calls.find(([input]) =>
    (input as { options?: { includePartialMessages?: boolean } }).options?.includePartialMessages === true
  );
  expect(call).toBeTruthy();
  return call?.[0] as {
    options?: Record<string, unknown>;
    prompt?: AsyncIterable<Record<string, unknown>>;
  };
}

function findRemotePromptStream(): AsyncIterable<Record<string, unknown>> {
  const prompt = findRemoteQueryCall().prompt;
  expect(prompt).toBeTruthy();
  return prompt as AsyncIterable<Record<string, unknown>>;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function writeClaudeTranscript(input: {
  configDir: string;
  cwd: string;
  sessionId: string;
  text?: string;
}): void {
  const projectId = path.resolve(input.cwd).replace(/[^a-zA-Z0-9-]/g, "-");
  const projectDir = path.join(input.configDir, "projects", projectId);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${input.sessionId}.jsonl`),
    JSON.stringify({
      type: "user",
      uuid: `user-${input.sessionId}`,
      sessionId: input.sessionId,
      message: {
        role: "user",
        content: input.text ?? "hello",
      },
    }) + "\n",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.spawn.mockImplementation(() => mockChildProcess());
  mocks.query.mockImplementation((
    input: {
      options?: {
        abortController?: AbortController;
        includePartialMessages?: boolean;
      };
    },
  ) => {
    if (input.options?.includePartialMessages) {
      return createRemoteQuery(input.options.abortController);
    }
    return createCapabilityQuery();
  });
});

describe("normalizeClaudeTodoWriteInput", () => {
  it("normalizes Claude TodoWrite input", () => {
    expect(
      normalizeClaudeTodoWriteInput({
        todos: [
          {
            id: "a",
            content: "Inspect auth flow",
            status: "in_progress",
            priority: "high",
            activeForm: "Inspecting auth flow",
          },
          {
            content: "Add regression test",
            status: "completed",
          },
        ],
      }),
    ).toEqual([
      {
        id: "a",
        content: "Inspect auth flow",
        status: "in_progress",
        priority: "high",
        activeForm: "Inspecting auth flow",
      },
      {
        id: "todo-1",
        content: "Add regression test",
        status: "completed",
      },
    ]);
  });

  it("distinguishes empty lists from malformed input", () => {
    expect(normalizeClaudeTodoWriteInput({ todos: [] })).toEqual([]);
    expect(normalizeClaudeTodoWriteInput({ todos: [{ status: "pending" }] })).toBeNull();
    expect(normalizeClaudeTodoWriteInput({})).toBeNull();
  });
});

describe("normalizeClaudeSdkTranscriptEntrypoints", () => {
  it("rewrites TypeScript SDK transcript entrypoints for Claude resume picker compatibility", () => {
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const configDir = fs.mkdtempSync(path.join(tmpdir(), "adit-claude-config-"));
    const cwd = "/tmp/adit-entrypoint-project";
    const sessionId = "11111111-2222-4333-8444-555555555555";
    const projectId = path.resolve(cwd).replace(/[^a-zA-Z0-9-]/g, "-");
    const projectDir = path.join(configDir, "projects", projectId);
    const transcriptFile = path.join(projectDir, `${sessionId}.jsonl`);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      transcriptFile,
      [
        JSON.stringify({
          type: "user",
          entrypoint: "sdk-ts",
          sessionId,
          message: { role: "user", content: "hello" },
        }),
        JSON.stringify({
          type: "assistant",
          entrypoint: "sdk-cli",
          sessionId,
          message: { role: "assistant", content: [] },
        }),
        "{not-json",
        "",
      ].join("\n"),
    );

    try {
      process.env.CLAUDE_CONFIG_DIR = configDir;

      normalizeClaudeSdkTranscriptEntrypoints({ cwd, sessionId });

      const lines = fs.readFileSync(transcriptFile, "utf8").split("\n");
      expect(JSON.parse(lines[0] ?? "{}").entrypoint).toBe("cli");
      expect(JSON.parse(lines[1] ?? "{}").entrypoint).toBe("sdk-cli");
      expect(lines[2]).toBe("{not-json");
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      }
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("ClaudeCodeProvider abort", () => {
  it("does not acknowledge a prompt until the remote query can be interrupted", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    await provider.sendPrompt("hello");
    await provider.abort();

    expect(mocks.remoteInterrupt).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "run.aborted")).toBe(true);
    expect(events.some((event) =>
      event.type === "error" &&
      String(event.payload.message ?? "").includes("aborted")
    )).toBe(false);

    provider.stop();
  });

  it("marks a pending tool permission as errored when the run is aborted", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sessionId = "11111111-1111-1111-1111-111111111111";
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      provider.noteLocalSession(sessionId);
      await provider.takeover();
      await provider.sendPrompt("edit aaa.md", { mode: "plan" });

      const remoteCall = mocks.query.mock.calls.find(([input]) =>
        (input as { options?: { includePartialMessages?: boolean } }).options?.includePartialMessages === true
      );
      const canUseTool = (remoteCall?.[0] as {
        options?: {
          canUseTool?: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string; signal: AbortSignal },
          ) => Promise<unknown>;
        };
      }).options?.canUseTool;
      expect(canUseTool).toBeTypeOf("function");
      expect(findRemoteQueryCall().options?.disallowedTools).toBeUndefined();

      const toolSignal = new AbortController();
      const permission = canUseTool?.("Edit", { file_path: "aaa.md" }, {
        toolUseID: "tool-1",
        signal: toolSignal.signal,
      });
      await tick();
      expect(provider.permissions).toHaveLength(1);

      await provider.abort();
      await expect(permission).rejects.toThrow("Claude run aborted");

      expect(events).toContainEqual(expect.objectContaining({
        type: "tool",
        payload: expect.objectContaining({
          sessionId,
          toolUseId: "tool-1",
          toolName: "Edit",
          input: { file_path: "aaa.md" },
          error: "Claude run aborted",
          status: "error",
        }),
      }));
    } finally {
      provider.stop();
    }
  });

  it("interrupts the active run and emits run.aborted before switching sessions", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const oldSessionId = "11111111-1111-1111-1111-111111111111";
    const newSessionId = "22222222-2222-2222-2222-222222222222";
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      provider.noteLocalSession(oldSessionId);
      await provider.takeover();
      await provider.sendPrompt("hello");
      mocks.remoteInterrupt.mockClear();

      await provider.switchSession(newSessionId);

      expect(mocks.remoteInterrupt).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual(expect.objectContaining({
        type: "run.aborted",
        payload: expect.objectContaining({
          message: "Claude session switched.",
          sessionId: oldSessionId,
        }),
      }));
      expect(provider.state.activeSessionId).toBe(newSessionId);
    } finally {
      provider.stop();
    }
  });

  it("emits run.aborted when releasing Web control during an active run", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sessionId = "11111111-1111-1111-1111-111111111111";
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      provider.noteLocalSession(sessionId);
      await provider.takeover();
      await provider.sendPrompt("hello");
      mocks.remoteInterrupt.mockClear();

      await provider.releaseToLocal();

      expect(mocks.remoteInterrupt).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual(expect.objectContaining({
        type: "run.aborted",
        payload: expect.objectContaining({
          message: "Web control released to local CLI.",
          sessionId,
        }),
      }));
      expect(provider.state.owner).toBe("local");
    } finally {
      provider.stop();
    }
  });

  it("resumes a Claude transcript without UUID markers when releasing Web control", async () => {
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const configDir = fs.mkdtempSync(path.join(tmpdir(), "adit-claude-config-"));
    const cwd = "/tmp/project";
    const sessionId = "11111111-1111-1111-1111-111111111111";
    const latestSessionId = "22222222-2222-2222-2222-222222222222";
    const projectId = path.resolve(cwd).replace(/[^a-zA-Z0-9-]/g, "-");
    const projectDir = path.join(configDir, "projects", projectId);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        sessionId,
        type: "user",
        message: { role: "user", content: "hello" },
      })}\n`,
    );
    fs.writeFileSync(
      path.join(projectDir, `${latestSessionId}.jsonl`),
      `${JSON.stringify({ sessionId: latestSessionId, uuid: "latest-message" })}\n`,
    );
    fs.utimesSync(
      path.join(projectDir, `${latestSessionId}.jsonl`),
      new Date(Date.now() + 10_000),
      new Date(Date.now() + 10_000),
    );
    process.env.CLAUDE_CONFIG_DIR = configDir;

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd,
    });

    try {
      provider.noteLocalSession(sessionId);
      await provider.takeover();
      await provider.releaseToLocal();

      expect(mocks.spawn.mock.calls.at(-1)?.[1]).toEqual(["--resume", sessionId]);
      expect(provider.state.activeSessionId).toBe(sessionId);
    } finally {
      provider.stop();
      if (originalConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      }
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("keeps the reclaimed session active when local Claude reports a new runtime session", async () => {
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const configDir = fs.mkdtempSync(path.join(tmpdir(), "adit-claude-config-"));
    const cwd = "/tmp/project";
    const sessionId = "11111111-1111-1111-1111-111111111111";
    const runtimeSessionId = "33333333-3333-3333-3333-333333333333";
    const laterSessionId = "44444444-4444-4444-4444-444444444444";
    const projectId = path.resolve(cwd).replace(/[^a-zA-Z0-9-]/g, "-");
    const projectDir = path.join(configDir, "projects", projectId);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        sessionId,
        type: "assistant",
        message: { role: "assistant", content: [] },
      })}\n`,
    );
    process.env.CLAUDE_CONFIG_DIR = configDir;

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd,
    });

    try {
      provider.noteLocalSession(sessionId);
      await provider.takeover();
      await provider.releaseToLocal();

      expect(mocks.spawn.mock.calls.at(-1)?.[1]).toEqual(["--resume", sessionId]);
      expect(provider.noteLocalSession(runtimeSessionId)).toBe(sessionId);
      expect(provider.noteLocalSession(runtimeSessionId)).toBe(sessionId);
      expect(provider.state.activeSessionId).toBe(sessionId);
      expect(provider.state.resumeSessionId).toBe(sessionId);
      expect(provider.noteLocalSession(laterSessionId)).toBe(laterSessionId);
      expect(provider.state.activeSessionId).toBe(laterSessionId);
    } finally {
      provider.stop();
      if (originalConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      }
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("does not switch to an unrelated latest Claude session when reclaiming local control", async () => {
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const configDir = fs.mkdtempSync(path.join(tmpdir(), "adit-claude-config-"));
    const cwd = "/tmp/project";
    const sessionId = "11111111-1111-1111-1111-111111111111";
    const latestSessionId = "22222222-2222-2222-2222-222222222222";
    const projectId = path.resolve(cwd).replace(/[^a-zA-Z0-9-]/g, "-");
    const projectDir = path.join(configDir, "projects", projectId);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, `${latestSessionId}.jsonl`),
      `${JSON.stringify({ sessionId: latestSessionId, uuid: "latest-message" })}\n`,
    );
    process.env.CLAUDE_CONFIG_DIR = configDir;

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd,
    });

    try {
      provider.noteLocalSession(sessionId);
      await provider.takeover();
      await provider.releaseToLocal();

      expect(mocks.spawn.mock.calls.at(-1)?.[1]).toEqual([]);
      expect(provider.state.activeSessionId).toBeNull();
      expect(provider.state.resumeSessionId).toBeNull();
    } finally {
      provider.stop();
      if (originalConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      }
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("emits run.aborted when the provider stops during an active run", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sessionId = "11111111-1111-1111-1111-111111111111";
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    provider.noteLocalSession(sessionId);
    await provider.takeover();
    await provider.sendPrompt("hello");
    mocks.remoteInterrupt.mockClear();

    provider.stop();

    expect(mocks.remoteInterrupt).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: "run.aborted",
      payload: expect.objectContaining({
        message: "Claude provider stopped.",
        sessionId,
      }),
    }));
    expect(provider.state.owner).toBe("stopped");
  });
});

describe("ClaudeCodeProvider takeover", () => {
  it("does not emit fallback slash commands on construction", () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      expect(events.some((event) => event.type === "slash-commands")).toBe(false);
    } finally {
      provider.stop();
    }
  });

  it("hydrates slash commands and MCP status from the SDK while local owns Claude", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const capabilityQuery = {
      supportedCommands: vi.fn(async () => [
        { name: "debug", description: "Enable debug logging" },
        { name: "lark-mail", description: "Use Lark mail" },
        { name: "custom-command" },
      ]),
      mcpServerStatus: vi.fn(async () => [
        { name: "lark", status: "connected" },
      ]),
      close: vi.fn(),
      interrupt: vi.fn(),
      async *[Symbol.asyncIterator]() {},
    };
    mocks.query.mockImplementation(() => capabilityQuery);

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await tick();
      await tick();

      expect(capabilityQuery.supportedCommands).toHaveBeenCalledTimes(1);
      expect(capabilityQuery.mcpServerStatus).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual(expect.objectContaining({
        type: "slash-commands",
        payload: expect.objectContaining({
          commands: [
            {
              name: "debug",
              description: "Enable debug logging",
              argumentHint: undefined,
              aliases: undefined,
            },
            {
              name: "lark-mail",
              description: "Use Lark mail",
              argumentHint: undefined,
              aliases: undefined,
            },
            {
              name: "custom-command",
              argumentHint: undefined,
              aliases: undefined,
            },
            {
              name: "rewind",
              description: "Rewind Claude Code files when checkpointing is available",
            },
          ],
        }),
      }));

      await provider.handleSlashCommand({ name: "mcp", args: [], raw: "/mcp" });
      expect(events).toContainEqual(expect.objectContaining({
        type: "notice",
        payload: expect.objectContaining({
          title: "/mcp",
          text: "- lark: connected",
        }),
      }));
    } finally {
      provider.stop();
    }
  });

  it("keeps Claude native rewind when the SDK command snapshot is empty", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await tick();
      await tick();

      const slashEvents = events.filter((event) => event.type === "slash-commands");
      expect(slashEvents.length).toBeGreaterThan(0);
      expect(slashEvents.at(-1)?.payload.commands).toEqual([
        {
          name: "rewind",
          description: "Rewind Claude Code files when checkpointing is available",
        },
      ]);
    } finally {
      provider.stop();
    }
  });

  it("rejects unreported slash commands before hydrate while keeping internal notices available", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await expect(
        provider.handleSlashCommand({ name: "compact", args: [], raw: "/compact" }),
      ).rejects.toMatchObject({
        message: "Claude Code did not expose /compact for this Cloud session.",
        statusCode: 400,
      });

      await provider.handleSlashCommand({ name: "rewind", args: [], raw: "/rewind" });

      await provider.handleSlashCommand({ name: "mcp", args: [], raw: "/mcp" });
      await provider.handleSlashCommand({ name: "skills", args: [], raw: "/skills" });

      expect(events).toContainEqual(expect.objectContaining({
        type: "notice",
        payload: expect.objectContaining({ title: "/mcp" }),
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "notice",
        payload: expect.objectContaining({ title: "/rewind" }),
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "notice",
        payload: expect.objectContaining({ title: "/skills" }),
      }));
    } finally {
      provider.stop();
    }
  });

  it("binds a pending Web session when the first native slash command starts a Claude session", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sessionId = "11111111-1111-1111-1111-111111111111";
    mocks.query.mockImplementation((
      input: {
        options?: {
          abortController?: AbortController;
          includePartialMessages?: boolean;
        };
      },
    ) => {
      if (!input.options?.includePartialMessages) {
        return {
          supportedCommands: vi.fn(async () => [
            { name: "compact", description: "Compact conversation" },
          ]),
          mcpServerStatus: vi.fn(async () => []),
          close: vi.fn(),
          interrupt: vi.fn(),
          async *[Symbol.asyncIterator]() {},
        };
      }

      return {
        supportedCommands: vi.fn(async () => []),
        mcpServerStatus: vi.fn(async () => []),
        getContextUsage: vi.fn(async () => ({
          totalTokens: 100,
          maxTokens: 200,
          percentage: 50,
          model: "claude-test",
        })),
        close: mocks.remoteClose,
        interrupt: mocks.remoteInterrupt,
        async *[Symbol.asyncIterator]() {
          yield {
            type: "system",
            subtype: "init",
            session_id: sessionId,
            slash_commands: ["compact"],
          };
          yield {
            type: "result",
            session_id: sessionId,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      };
    });
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await tick();
      await tick();
      await provider.takeover();

      await provider.handleSlashCommand({
        name: "compact",
        args: [],
        raw: "/compact",
        sessionId: "pending_web_session",
        pendingSessionId: "pending_web_session",
        localMessageId: "local-user-1",
      });
      await tick();
      await tick();

      expect(events).toContainEqual(expect.objectContaining({
        type: "session-bound",
        payload: {
          pendingSessionId: "pending_web_session",
          sessionId,
          createdAt: expect.any(Number),
        },
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "message",
        payload: expect.objectContaining({
          role: "user",
          sessionId,
          messageId: "local-user-1",
          text: "/compact",
        }),
      }));
    } finally {
      provider.stop();
    }
  });

  it("emits Claude context compaction status and boundary as internal tool events", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sessionId = "11111111-1111-1111-1111-111111111111";
    mocks.query.mockImplementation((
      input: {
        options?: {
          abortController?: AbortController;
          includePartialMessages?: boolean;
        };
      },
    ) => {
      if (!input.options?.includePartialMessages) return createCapabilityQuery();
      return {
        supportedCommands: vi.fn(async () => []),
        mcpServerStatus: vi.fn(async () => []),
        getContextUsage: vi.fn(async () => ({
          totalTokens: 100,
          maxTokens: 200,
          percentage: 50,
          model: "claude-test",
        })),
        close: mocks.remoteClose,
        interrupt: mocks.remoteInterrupt,
        async *[Symbol.asyncIterator]() {
          yield {
            type: "system",
            subtype: "init",
            session_id: sessionId,
            slash_commands: [],
          };
          yield {
            type: "system",
            subtype: "status",
            status: "compacting",
            uuid: "compact-status-1",
            session_id: sessionId,
          };
          yield {
            type: "system",
            subtype: "compact_boundary",
            uuid: "compact-boundary-1",
            session_id: sessionId,
            compact_metadata: {
              trigger: "auto",
              pre_tokens: 1000,
              post_tokens: 250,
              duration_ms: 1500,
            },
          };
          yield {
            type: "result",
            session_id: sessionId,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      };
    });
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await provider.takeover();
      await provider.sendPrompt("hello");
      await tick();
      await tick();

      expect(events).toContainEqual(expect.objectContaining({
        type: "tool",
        payload: expect.objectContaining({
          sessionId,
          messageId: `claude-tools-${sessionId}`,
          toolUseId: "compact-status-1",
          toolName: "Context compaction",
          input: { source: "claude" },
          tool_scope: "internal",
          status: "running",
        }),
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "tool",
        payload: expect.objectContaining({
          sessionId,
          messageId: `claude-tools-${sessionId}`,
          toolUseId: "compact-status-1",
          toolName: "Context compaction",
          input: {
            source: "claude",
            trigger: "auto",
            preTokens: 1000,
            postTokens: 250,
            durationMs: 1500,
          },
          tool_scope: "internal",
          output: "Claude context compaction completed (trigger=auto, tokens 1000 -> 250, duration=1.5s).",
          status: "completed",
        }),
      }));
    } finally {
      provider.stop();
    }
  });

  it("rejects Web takeover after the local Claude CLI exits", async () => {
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
    });
    const child = mocks.spawn.mock.results[0]?.value as EventEmitter;

    child.emit("exit", 0, null);

    expect(provider.state.owner).toBe("stopped");

    await expect(provider.takeover()).rejects.toMatchObject({
      message: "local Claude owner is not available",
      statusCode: 409,
    });

    provider.stop();
  });

  it("resumes the bound Web Claude session when releasing Web control", async () => {
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const configDir = fs.mkdtempSync(path.join(tmpdir(), "adit-claude-config-"));
    const cwd = "/tmp/project";
    const localSessionId = "11111111-1111-4111-8111-111111111111";
    const webSessionId = "22222222-2222-4222-8222-222222222222";
    writeClaudeTranscript({ configDir, cwd, sessionId: localSessionId });
    writeClaudeTranscript({ configDir, cwd, sessionId: webSessionId });

    try {
      process.env.CLAUDE_CONFIG_DIR = configDir;
      const provider = new ClaudeCodeProvider({
        bin: "claude",
        args: [],
        cwd,
      });
      provider.noteLocalSession(localSessionId);

      await provider.takeover();
      (provider as unknown as { bindPendingSession(pendingSessionId: string, sessionId: string): void })
        .bindPendingSession("pending_web_session", webSessionId);
      mocks.spawn.mockClear();

      await provider.releaseToLocal();

      expect(mocks.spawn).toHaveBeenCalledWith(
        "claude",
        ["--resume", webSessionId],
        expect.objectContaining({ cwd }),
      );
      expect(provider.state.owner).toBe("local");
      expect(provider.state.activeSessionId).toBe(webSessionId);
      expect(provider.state.resumeSessionId).toBe(webSessionId);

      provider.stop();
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      }
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("does not resume the old local Claude session after an empty Web session request", async () => {
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const configDir = fs.mkdtempSync(path.join(tmpdir(), "adit-claude-config-"));
    const cwd = "/tmp/project";
    const localSessionId = "11111111-1111-4111-8111-111111111111";
    writeClaudeTranscript({ configDir, cwd, sessionId: localSessionId });

    try {
      process.env.CLAUDE_CONFIG_DIR = configDir;
      const provider = new ClaudeCodeProvider({
        bin: "claude",
        args: [],
        cwd,
      });
      provider.noteLocalSession(localSessionId);

      await provider.takeover();
      await provider.startNewSession("pending_web_session");
      mocks.spawn.mockClear();

      await provider.releaseToLocal();

      expect(mocks.spawn).toHaveBeenCalledWith(
        "claude",
        [],
        expect.objectContaining({ cwd }),
      );
      expect(provider.state.owner).toBe("local");
      expect(provider.state.activeSessionId).toBeNull();
      expect(provider.state.resumeSessionId).toBeNull();

      provider.stop();
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      }
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("keeps Claude listening for the first prompt after an empty Web session request", async () => {
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
    });

    try {
      await provider.takeover();
      await provider.startNewSession("pending_web_session");

      const promptResult = provider
        .sendPrompt("hello", { pendingSessionId: "pending_web_session" })
        .then(() => "sent" as const)
        .catch(() => "rejected" as const);
      const result = await Promise.race([
        promptResult,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
      ]);

      expect(result).toBe("sent");
      expect(findRemoteQueryCall().options?.includePartialMessages).toBe(true);
    } finally {
      provider.stop();
    }
  });

  it("preserves the latest runtime model when releasing Web control to local Claude", async () => {
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const configDir = fs.mkdtempSync(path.join(tmpdir(), "adit-claude-config-"));
    const cwd = "/tmp/project";
    const sessionId = "11111111-1111-4111-8111-111111111111";
    writeClaudeTranscript({ configDir, cwd, sessionId });

    try {
      process.env.CLAUDE_CONFIG_DIR = configDir;
      const provider = new ClaudeCodeProvider({
        bin: "claude",
        args: ["--model=claude-default", "--debug"],
        cwd,
      });
      provider.noteLocalSession(sessionId);
      provider.noteModel("glm-5.2[1M][1m]");

      await provider.takeover();
      mocks.spawn.mockClear();

      await provider.releaseToLocal();

      expect(mocks.spawn).toHaveBeenCalledWith(
        "claude",
        ["--resume", sessionId, "--debug", "--model", "glm-5.2[1M][1m]"],
        expect.objectContaining({ cwd }),
      );
      expect(provider.state.activeModelId).toBe("glm-5.2[1M][1m]");

      provider.stop();
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      }
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("reports current branch and context usage while Web controls Claude", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    await provider.sendPrompt("hello");
    await tick();

    expect(provider.state.currentBranch).toBe("main");
    expect(events).toContainEqual(expect.objectContaining({
      type: "state",
      payload: expect.objectContaining({
        currentBranch: "main",
        contextUsage: expect.objectContaining({
          percentage: 50,
          totalTokens: 100,
          maxTokens: 200,
          modelId: null,
          source: "claude-sdk",
        }),
      }),
    }));

    await provider.abort();
    provider.stop();
  });

  it("disables AskUserQuestion for Build mode while keeping bypass permissions", async () => {
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
    });

    try {
      await provider.takeover();
      await provider.sendPrompt("start", { mode: "build" });

      const options = findRemoteQueryCall().options;
      expect(options?.permissionMode).toBe("bypassPermissions");
      expect(options?.systemPrompt).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
      expect(options?.allowDangerouslySkipPermissions).toBe(true);
      expect(options?.disallowedTools).toEqual(["AskUserQuestion"]);
      expect(options?.canUseTool).toBeUndefined();
    } finally {
      await provider.abort().catch(() => undefined);
      provider.stop();
    }
  });

  it("passes the latest local runtime model to the Web-owned Claude SDK run", async () => {
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
    });

    try {
      provider.noteModel("glm-5.2[1M][1m]");
      await provider.takeover();
      await provider.sendPrompt("start", { mode: "build" });

      expect(findRemoteQueryCall().options?.model).toBe("glm-5.2[1M][1m]");
    } finally {
      await provider.abort().catch(() => undefined);
      provider.stop();
    }
  });

  it("keeps the runtime model when Claude SDK reports a provider-normalized base model", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sessionId = "11111111-1111-1111-1111-111111111111";
    mocks.query.mockImplementation((
      input: {
        options?: {
          includePartialMessages?: boolean;
        };
      },
    ) => {
      if (!input.options?.includePartialMessages) return createCapabilityQuery();
      return {
        supportedCommands: vi.fn(async () => []),
        mcpServerStatus: vi.fn(async () => []),
        getContextUsage: vi.fn(async () => ({
          totalTokens: 100,
          maxTokens: 200,
          percentage: 50,
          model: "glm-5.2",
        })),
        close: mocks.remoteClose,
        interrupt: mocks.remoteInterrupt,
        async *[Symbol.asyncIterator]() {
          yield {
            type: "assistant",
            session_id: sessionId,
            message: {
              id: "message-1",
              role: "assistant",
              model: "glm-5.2",
              content: [{ type: "text", text: "OK" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "result",
            session_id: sessionId,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      };
    });
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      provider.noteModel("glm-5.2[1M][1m]");
      await provider.takeover();
      await provider.sendPrompt("start", { mode: "build" });
      await tick();
      await tick();

      expect(findRemoteQueryCall().options?.model).toBe("glm-5.2[1M][1m]");
      expect(provider.state.activeModelId).toBe("glm-5.2[1M][1m]");
      expect(events).not.toContainEqual(expect.objectContaining({
        type: "state",
        payload: expect.objectContaining({ activeModelId: "glm-5.2" }),
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "message",
        payload: expect.objectContaining({
          sessionId,
          messageId: "message-1",
          modelId: "glm-5.2[1M][1m]",
          text: "OK",
        }),
      }));
    } finally {
      provider.stop();
    }
  });

  it("ignores zero-token Claude context usage placeholders", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const contextUsages = [
      {
        totalTokens: 100,
        maxTokens: 200,
        percentage: 50,
        model: "claude-test",
      },
      {
        totalTokens: 0,
        maxTokens: 200,
        percentage: 0,
        model: "claude-test",
      },
    ];
    mocks.query.mockImplementation((
      input: {
        options?: {
          abortController?: AbortController;
          includePartialMessages?: boolean;
        };
      },
    ) => {
      if (!input.options?.includePartialMessages) return createCapabilityQuery();
      const query = createRemoteQuery(input.options.abortController);
      return {
        ...query,
        getContextUsage: vi.fn(async () => contextUsages.shift()),
      };
    });
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    await provider.sendPrompt("hello");
    await tick();
    expect(provider.state.contextUsage?.totalTokens).toBe(100);

    (provider as unknown as { scheduleContextUsageRefresh(force?: boolean): void })
      .scheduleContextUsageRefresh(true);
    await tick();

    expect(provider.state.contextUsage?.totalTokens).toBe(100);
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "state",
      payload: expect.objectContaining({
        contextUsage: expect.objectContaining({ totalTokens: 0 }),
      }),
    }));

    await provider.abort();
    provider.stop();
  });

  it("does not persist duplicate state events when state is unchanged", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    const stateEvents = () => events.filter((event) => event.type === "state").length;
    const count = stateEvents();

    (provider as unknown as { emitState(): void }).emitState();
    (provider as unknown as { emitState(): void }).emitState();

    expect(stateEvents()).toBe(count);

    provider.stop();
  });

  it("accepts a new prompt after the SDK reports a completed result", async () => {
    const remotePrompts: string[] = [];
    mocks.query.mockImplementation((
      input: {
        prompt?: AsyncIterable<Record<string, unknown>>;
        options?: {
          abortController?: AbortController;
          includePartialMessages?: boolean;
        };
      },
    ) => {
      if (!input.options?.includePartialMessages || !input.prompt) {
        return createCapabilityQuery();
      }

      return {
        supportedCommands: vi.fn(async () => []),
        mcpServerStatus: vi.fn(async () => []),
        getContextUsage: vi.fn(async () => ({
          totalTokens: 100,
          maxTokens: 200,
          percentage: 50,
          model: "claude-test",
        })),
        close: mocks.remoteClose,
        interrupt: mocks.remoteInterrupt,
        async *[Symbol.asyncIterator]() {
          const iterator = input.prompt![Symbol.asyncIterator]();
          const first = await iterator.next();
          const content = (first.value?.message as { content?: unknown } | undefined)?.content;
          if (typeof content === "string") remotePrompts.push(content);
          yield {
            type: "result",
            session_id: "11111111-1111-1111-1111-111111111111",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          await iterator.next();
        },
      };
    });

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
    });

    try {
      await provider.takeover();
      await provider.sendPrompt("first");
      await tick();

      const secondPrompt = provider.sendPrompt("second");
      const result = await Promise.race([
        secondPrompt.then(() => "resolved"),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
      ]);

      expect(result).toBe("resolved");
      expect(remotePrompts).toEqual(["first", "second"]);
    } finally {
      provider.stop();
    }
  });

  it("does not emit whitespace-only thinking parts as reasoning", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sessionId = "11111111-1111-1111-1111-111111111111";
    mocks.query.mockImplementation((
      input: {
        options?: {
          includePartialMessages?: boolean;
        };
      },
    ) => {
      if (!input.options?.includePartialMessages) {
        return createCapabilityQuery();
      }

      return {
        supportedCommands: vi.fn(async () => []),
        mcpServerStatus: vi.fn(async () => []),
        getContextUsage: vi.fn(async () => ({
          totalTokens: 100,
          maxTokens: 200,
          percentage: 50,
          model: "claude-test",
        })),
        close: mocks.remoteClose,
        interrupt: mocks.remoteInterrupt,
        async *[Symbol.asyncIterator]() {
          yield {
            type: "assistant",
            session_id: sessionId,
            message: {
              id: "message-1",
              role: "assistant",
              model: "glm-4.5-flash",
              content: [
                { type: "thinking", thinking: "\n\t " },
                { type: "thinking", thinking: "\nactual reasoning\n" },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "result",
            session_id: sessionId,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      };
    });

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await provider.takeover();
      await provider.sendPrompt("hello");
      await tick();
      await tick();

      const reasoningEvents = events.filter((event) => event.type === "reasoning");
      expect(reasoningEvents).toHaveLength(1);
      expect(reasoningEvents[0]?.payload).toEqual(expect.objectContaining({
        sessionId,
        messageId: "message-1",
        text: "\nactual reasoning\n",
      }));
    } finally {
      provider.stop();
    }
  });

  it("emits Claude SDK text deltas without trimming leading spaces", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sessionId = "11111111-1111-1111-1111-111111111111";
    mocks.query.mockImplementation((
      input: {
        options?: {
          includePartialMessages?: boolean;
        };
      },
    ) => {
      if (!input.options?.includePartialMessages) {
        return createCapabilityQuery();
      }

      return {
        supportedCommands: vi.fn(async () => []),
        mcpServerStatus: vi.fn(async () => []),
        getContextUsage: vi.fn(async () => ({
          totalTokens: 100,
          maxTokens: 200,
          percentage: 50,
          model: "claude-test",
        })),
        close: mocks.remoteClose,
        interrupt: mocks.remoteInterrupt,
        async *[Symbol.asyncIterator]() {
          yield {
            type: "stream_event",
            session_id: sessionId,
            uuid: "partial-1",
            parent_tool_use_id: null,
            event: {
              type: "message_start",
              message: {
                id: "message-1",
                model: "glm-4.5-flash",
              },
            },
          };
          yield {
            type: "stream_event",
            session_id: sessionId,
            uuid: "partial-1",
            parent_tool_use_id: null,
            event: {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "text_delta",
                text: "Hello",
              },
            },
          };
          yield {
            type: "stream_event",
            session_id: sessionId,
            uuid: "partial-1",
            parent_tool_use_id: null,
            event: {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "text_delta",
                text: " world",
              },
            },
          };
          yield {
            type: "stream_event",
            session_id: sessionId,
            uuid: "partial-1",
            parent_tool_use_id: null,
            event: {
              type: "message_stop",
            },
          };
          yield {
            type: "result",
            session_id: sessionId,
            usage: { input_tokens: 1, output_tokens: 2 },
          };
        },
      };
    });

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await provider.takeover();
      await provider.sendPrompt("hello");
      await tick();
      await tick();

      const deltaEvents = events.filter((event) => event.type === "assistant-delta");
      expect(deltaEvents.map((event) => event.payload.text)).toEqual(["Hello", " world"]);
      expect(deltaEvents).toHaveLength(2);
      for (const event of deltaEvents) {
        expect(event.payload).toEqual(expect.objectContaining({
          sessionId,
          messageId: "message-1",
          modelId: undefined,
        }));
      }
      expect(events).toContainEqual(expect.objectContaining({
        type: "usage",
        payload: expect.objectContaining({
          sessionId,
          messageId: "message-1",
        }),
      }));
    } finally {
      provider.stop();
    }
  });

  it("links Claude SDK tool results to the assistant message that created the tool use", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sessionId = "11111111-1111-1111-1111-111111111111";
    mocks.query.mockImplementation((
      input: {
        options?: {
          includePartialMessages?: boolean;
        };
      },
    ) => {
      if (!input.options?.includePartialMessages) {
        return createCapabilityQuery();
      }

      return {
        supportedCommands: vi.fn(async () => []),
        mcpServerStatus: vi.fn(async () => []),
        getContextUsage: vi.fn(async () => null),
        close: mocks.remoteClose,
        interrupt: mocks.remoteInterrupt,
        async *[Symbol.asyncIterator]() {
          yield {
            type: "assistant",
            session_id: sessionId,
            uuid: "assistant-1",
            parent_tool_use_id: null,
            message: {
              id: "assistant-message-1",
              role: "assistant",
              model: "glm-5.2",
              content: [
                {
                  type: "tool_use",
                  id: "toolu_1",
                  name: "Read",
                  input: { file_path: "README.md" },
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "user",
            session_id: sessionId,
            uuid: "tool-result-1",
            message: {
              id: "tool-result-message-1",
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_1",
                  content: "file contents",
                },
              ],
            },
          };
          yield {
            type: "result",
            session_id: sessionId,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      };
    });

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await provider.takeover();
      await provider.sendPrompt("read README");
      await tick();

      const toolEvents = events.filter((event) => event.type === "tool");
      const completed = toolEvents.find((event) => event.payload.status === "completed");
      expect(completed?.payload).toEqual(expect.objectContaining({
        sessionId,
        messageId: "assistant-message-1",
        toolUseId: "toolu_1",
        toolName: "Read",
        input: { file_path: "README.md" },
      }));
    } finally {
      provider.stop();
    }
  });

  it("synthesizes assistant deltas when Claude SDK only returns final text", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sessionId = "11111111-1111-1111-1111-111111111111";
    const text = "This final-only Claude response should still reach the panel as assistant deltas.";
    mocks.query.mockImplementation((
      input: {
        options?: {
          includePartialMessages?: boolean;
        };
      },
    ) => {
      if (!input.options?.includePartialMessages) {
        return createCapabilityQuery();
      }

      return {
        supportedCommands: vi.fn(async () => []),
        mcpServerStatus: vi.fn(async () => []),
        getContextUsage: vi.fn(async () => ({
          totalTokens: 100,
          maxTokens: 200,
          percentage: 50,
          model: "claude-test",
        })),
        close: mocks.remoteClose,
        interrupt: mocks.remoteInterrupt,
        async *[Symbol.asyncIterator]() {
          yield {
            type: "assistant",
            session_id: sessionId,
            uuid: "assistant-1",
            parent_tool_use_id: null,
            message: {
              id: "message-final-only",
              role: "assistant",
              model: "glm-5.2",
              content: [{ type: "text", text }],
            },
          };
          yield {
            type: "result",
            session_id: sessionId,
            usage: { input_tokens: 1, output_tokens: 2 },
          };
        },
      };
    });

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await provider.takeover();
      await provider.sendPrompt("hello");
      await new Promise((resolve) => setTimeout(resolve, 120));

      const deltaEvents = events.filter((event) => event.type === "assistant-delta");
      expect(deltaEvents.length).toBeGreaterThan(1);
      expect(deltaEvents.map((event) => event.payload.text).join("")).toBe(text);

      const lastDeltaIndex = events.reduce(
        (last, event, index) => event.type === "assistant-delta" ? index : last,
        -1,
      );
      const finalMessageIndex = events.findIndex((event) =>
        event.type === "message" &&
        event.payload.role === "assistant" &&
        event.payload.messageId === "message-final-only"
      );
      expect(finalMessageIndex).toBeGreaterThan(lastDeltaIndex);
    } finally {
      provider.stop();
    }
  });

  it("emits Claude SDK thinking deltas as reasoning updates", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sessionId = "11111111-1111-1111-1111-111111111111";
    mocks.query.mockImplementation((
      input: {
        options?: {
          includePartialMessages?: boolean;
        };
      },
    ) => {
      if (!input.options?.includePartialMessages) {
        return createCapabilityQuery();
      }

      return {
        supportedCommands: vi.fn(async () => []),
        mcpServerStatus: vi.fn(async () => []),
        getContextUsage: vi.fn(async () => null),
        close: mocks.remoteClose,
        interrupt: mocks.remoteInterrupt,
        async *[Symbol.asyncIterator]() {
          yield {
            type: "stream_event",
            session_id: sessionId,
            uuid: "partial-1",
            parent_tool_use_id: null,
            event: {
              type: "message_start",
              message: {
                id: "message-1",
                model: "glm-4.5-flash",
              },
            },
          };
          yield {
            type: "stream_event",
            session_id: sessionId,
            uuid: "partial-1",
            parent_tool_use_id: null,
            event: {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "thinking_delta",
                thinking: "First",
              },
            },
          };
          yield {
            type: "stream_event",
            session_id: sessionId,
            uuid: "partial-1",
            parent_tool_use_id: null,
            event: {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "thinking_delta",
                thinking: " thought",
              },
            },
          };
          yield {
            type: "assistant",
            session_id: sessionId,
            message: {
              id: "message-1",
              role: "assistant",
              model: "glm-4.5-flash",
              content: [
                { type: "thinking", thinking: "First thought" },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "result",
            session_id: sessionId,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      };
    });

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await provider.takeover();
      await provider.sendPrompt("hello");
      await tick();
      await tick();

      const reasoningEvents = events.filter((event) => event.type === "reasoning");
      expect(reasoningEvents.map((event) => event.payload.text)).toEqual([
        "First",
        " thought",
        "First thought",
      ]);
      expect(reasoningEvents[0]?.payload).toEqual(expect.objectContaining({
        sessionId,
        messageId: "message-1",
        partId: "message-1-reasoning-0",
        contentBlockIndex: 0,
        delta: true,
      }));
      expect(reasoningEvents[1]?.payload).toEqual(expect.objectContaining({
        sessionId,
        messageId: "message-1",
        partId: "message-1-reasoning-0",
        contentBlockIndex: 0,
        delta: true,
      }));
      expect(reasoningEvents[2]?.payload).toEqual(expect.objectContaining({
        sessionId,
        messageId: "message-1",
        partId: "message-1-reasoning-0",
        contentBlockIndex: 0,
        replace: true,
      }));
    } finally {
      provider.stop();
    }
  });

  it("emits Claude SDK API retry status and final result errors", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sessionId = "session-retry";
    mocks.query.mockImplementation((
      input: {
        prompt?: AsyncIterable<Record<string, unknown>>;
        options?: {
          includePartialMessages?: boolean;
        };
      },
    ) => {
      if (!input.options?.includePartialMessages || !input.prompt) {
        return createCapabilityQuery();
      }

      return {
        supportedCommands: vi.fn(async () => []),
        mcpServerStatus: vi.fn(async () => []),
        getContextUsage: vi.fn(async () => null),
        close: mocks.remoteClose,
        interrupt: mocks.remoteInterrupt,
        async *[Symbol.asyncIterator]() {
          yield {
            type: "system",
            subtype: "api_retry",
            attempt: 1,
            max_retries: 10,
            retry_delay_ms: 1000,
            error_status: 529,
            error: "overloaded",
            uuid: "retry-1",
            session_id: sessionId,
          };
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            session_id: sessionId,
            errors: ["API Error: 529 [1305][该模型当前访问量过大，请您稍后再试]"],
            usage: { input_tokens: 1, output_tokens: 0 },
            total_cost_usd: 0,
          };
        },
      };
    });

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await provider.takeover();
      await provider.sendPrompt("hello");
      await tick();
      await tick();

      expect(events).toContainEqual(expect.objectContaining({
        type: "run.retry",
        payload: expect.objectContaining({
          sessionId,
          attempt: 1,
          maxRetries: 10,
          retryDelayMs: 1000,
          retryDelaySeconds: 1,
          errorStatus: 529,
          error: "overloaded",
          message: "API overloaded, retrying 1/10 in 1s...",
        }),
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "error",
        payload: expect.objectContaining({
          title: "Claude request failed",
          message: "API Error: 529 [1305][该模型当前访问量过大，请您稍后再试]",
          sessionId,
        }),
      }));
    } finally {
      provider.stop();
    }
  });

  it("keeps the run busy until the SDK iterator finishes after result usage", async () => {
    let finishSdkOutput: () => void = () => {};
    const sdkOutputFinished = new Promise<void>((resolve) => {
      finishSdkOutput = resolve;
    });

    mocks.query.mockImplementation((
      input: {
        prompt?: AsyncIterable<Record<string, unknown>>;
        options?: {
          includePartialMessages?: boolean;
        };
      },
    ) => {
      if (!input.options?.includePartialMessages || !input.prompt) {
        return createCapabilityQuery();
      }

      return {
        supportedCommands: vi.fn(async () => []),
        mcpServerStatus: vi.fn(async () => []),
        getContextUsage: vi.fn(async () => ({
          totalTokens: 100,
          maxTokens: 200,
          percentage: 50,
          model: "claude-test",
        })),
        close: mocks.remoteClose,
        interrupt: mocks.remoteInterrupt,
        async *[Symbol.asyncIterator]() {
          yield {
            type: "result",
            session_id: "11111111-1111-1111-1111-111111111111",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          await sdkOutputFinished;
        },
      };
    });

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
    });

    try {
      await provider.takeover();
      await provider.sendPrompt("hello");
      await tick();

      expect(provider.state.busy).toBe(true);
      expect(provider.state.thinking).toBe(true);

      finishSdkOutput();
      await tick();
      await tick();

      expect(provider.state.busy).toBe(false);
      expect(provider.state.thinking).toBe(false);
    } finally {
      finishSdkOutput();
      provider.stop();
    }
  });
});

describe("ClaudeCodeProvider steerPrompt", () => {
  it("does not force the first web prompt as an immediate assistant turn", async () => {
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
    });

    try {
      await provider.takeover();
      await provider.sendPrompt("hello");

      const iterator = findRemotePromptStream()[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect((first.value.message as { content?: unknown }).content).toBe("hello");
      expect(first.value.priority).toBeUndefined();
      expect(first.value.shouldQuery).toBeUndefined();
    } finally {
      await provider.abort();
      provider.stop();
    }
  });

  it("sends image attachments as Claude content blocks", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    const attachment = {
      id: "att-1",
      kind: "image" as const,
      url: "https://storage.example.invalid/coding-attachments/u/2026/05/a.png",
      mimeType: "image/png",
      fileName: "a.png",
      sizeBytes: 1234,
    };

    await provider.takeover();
    await provider.sendPrompt("describe this", {
      localMessageId: "local-image-1",
      attachments: [attachment],
    });

    const iterator = findRemotePromptStream()[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect((first.value.message as { content?: unknown }).content).toEqual([
      { type: "text", text: "describe this" },
      { type: "image", source: { type: "url", url: attachment.url } },
    ]);
    await provider.abort();
    provider.stop();
  });

  it("pushes steering input into the active SDK prompt stream", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    await provider.sendPrompt("hello");

    const iterator = findRemotePromptStream()[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect((first.value.message as { content?: unknown }).content).toBe("hello");

    await provider.steerPrompt("focus on tests", {
      localMessageId: "local-steer-1",
    });

    const second = await iterator.next();
    expect((second.value.message as { content?: unknown }).content).toBe("focus on tests");
    expect(second.value.priority).toBe("now");
    expect(second.value.shouldQuery).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: "message",
      payload: expect.objectContaining({
        role: "user",
        messageId: "local-steer-1",
        text: "focus on tests",
        inputKind: "steer",
      }),
    }));

    await provider.abort();
    provider.stop();
  });

  it("does not surface Claude SDK user diagnostic result errors while steering", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const remotePrompts: string[] = [];
    const sessionId = "11111111-1111-1111-1111-111111111111";
    let markFirstPromptRead: () => void = () => {};
    const firstPromptRead = new Promise<void>((resolve) => {
      markFirstPromptRead = resolve;
    });

    mocks.query.mockImplementation((
      input: {
        prompt?: AsyncIterable<Record<string, unknown>>;
        options?: {
          includePartialMessages?: boolean;
        };
      },
    ) => {
      if (!input.options?.includePartialMessages || !input.prompt) {
        return createCapabilityQuery();
      }

      return {
        supportedCommands: vi.fn(async () => []),
        mcpServerStatus: vi.fn(async () => []),
        getContextUsage: vi.fn(async () => null),
        close: mocks.remoteClose,
        interrupt: mocks.remoteInterrupt,
        async *[Symbol.asyncIterator]() {
          const iterator = input.prompt![Symbol.asyncIterator]();
          const first = await iterator.next();
          remotePrompts.push(String((first.value?.message as { content?: unknown } | undefined)?.content));
          markFirstPromptRead();

          const second = await iterator.next();
          remotePrompts.push(String((second.value?.message as { content?: unknown } | undefined)?.content));
          yield {
            type: "result",
            session_id: sessionId,
            result_type: "user",
            subtype: "error_diagnostic",
            is_error: true,
            errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
            usage: { input_tokens: 1, output_tokens: 0 },
            total_cost_usd: 0,
          };
          yield {
            type: "result",
            session_id: sessionId,
            usage: { input_tokens: 1, output_tokens: 1 },
            total_cost_usd: 0,
          };
        },
      };
    });

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await provider.takeover();
      await provider.sendPrompt("hello");
      await firstPromptRead;
      await provider.steerPrompt("today?");
      await tick();
      await tick();

      expect(remotePrompts).toEqual(["hello", "today?"]);
      expect(events).not.toContainEqual(expect.objectContaining({
        type: "error",
        payload: expect.objectContaining({
          title: "Claude request failed",
          message: "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
        }),
      }));
    } finally {
      provider.stop();
    }
  });

  it("keeps the SDK prompt stream open until steered turns also complete", async () => {
    const remotePrompts: string[] = [];
    let releaseFirstResult: () => void = () => {};
    const firstResultAllowed = new Promise<void>((resolve) => {
      releaseFirstResult = resolve;
    });
    let markFirstPromptRead: () => void = () => {};
    const firstPromptRead = new Promise<void>((resolve) => {
      markFirstPromptRead = resolve;
    });
    let recordThirdRead: (value: "done" | "pending" | "value") => void = () => {};
    const thirdReadObserved = new Promise<"done" | "pending" | "value">((resolve) => {
      recordThirdRead = resolve;
    });
    let finishSdkOutput: () => void = () => {};
    const sdkOutputFinished = new Promise<void>((resolve) => {
      finishSdkOutput = resolve;
    });

    mocks.query.mockImplementation((
      input: {
        prompt?: AsyncIterable<Record<string, unknown>>;
        options?: {
          includePartialMessages?: boolean;
        };
      },
    ) => {
      if (!input.options?.includePartialMessages || !input.prompt) {
        return createCapabilityQuery();
      }

      return {
        supportedCommands: vi.fn(async () => []),
        mcpServerStatus: vi.fn(async () => []),
        getContextUsage: vi.fn(async () => ({
          totalTokens: 100,
          maxTokens: 200,
          percentage: 50,
          model: "claude-test",
        })),
        close: mocks.remoteClose,
        interrupt: mocks.remoteInterrupt,
        async *[Symbol.asyncIterator]() {
          const iterator = input.prompt![Symbol.asyncIterator]();
          const first = await iterator.next();
          remotePrompts.push(String((first.value?.message as { content?: unknown } | undefined)?.content));
          markFirstPromptRead();

          await firstResultAllowed;
          yield {
            type: "result",
            session_id: "11111111-1111-1111-1111-111111111111",
            usage: { input_tokens: 1, output_tokens: 1 },
          };

          const second = await iterator.next();
          remotePrompts.push(String((second.value?.message as { content?: unknown } | undefined)?.content));
          const thirdRead = iterator.next();
          const thirdState = await Promise.race([
            thirdRead.then((result) => result.done ? "done" as const : "value" as const),
            new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20)),
          ]);
          recordThirdRead(thirdState);

          yield {
            type: "result",
            session_id: "11111111-1111-1111-1111-111111111111",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          await thirdRead;
          await sdkOutputFinished;
        },
      };
    });

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
    });

    try {
      await provider.takeover();
      await provider.sendPrompt("hello");
      await firstPromptRead;
      await provider.steerPrompt("focus on tests");

      releaseFirstResult();

      expect(await thirdReadObserved).toBe("pending");
      expect(remotePrompts).toEqual(["hello", "focus on tests"]);
    } finally {
      finishSdkOutput();
      await tick();
      provider.stop();
    }
  });

  it("rejects steering when no SDK prompt stream is active", async () => {
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
    });

    await provider.takeover();

    await expect(provider.steerPrompt("too early")).rejects.toThrow(
      "Claude Code is not currently accepting steering input",
    );

    provider.stop();
  });
});

describe("ClaudeCodeProvider stream anomalies", () => {
  function mockRemoteQueryYielding(messages: Array<Record<string, unknown>>): void {
    mocks.query.mockImplementation((
      input: {
        options?: {
          includePartialMessages?: boolean;
        };
      },
    ) => {
      if (!input.options?.includePartialMessages) {
        return createCapabilityQuery();
      }
      return {
        supportedCommands: vi.fn(async () => []),
        mcpServerStatus: vi.fn(async () => []),
        getContextUsage: vi.fn(async () => null),
        close: mocks.remoteClose,
        interrupt: mocks.remoteInterrupt,
        async *[Symbol.asyncIterator]() {
          for (const message of messages) yield message;
        },
      };
    });
  }

  it("completes server tools whose results arrive inside assistant messages", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sessionId = "11111111-1111-1111-1111-111111111111";
    mockRemoteQueryYielding([
      {
        type: "assistant",
        session_id: sessionId,
        uuid: "assistant-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-1",
          role: "assistant",
          model: "glm-5.2",
          content: [
            { type: "server_tool_use", id: "call_web_reader", name: "webReader", input: {} },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        type: "assistant",
        session_id: sessionId,
        uuid: "assistant-2",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-2",
          role: "assistant",
          model: "glm-5.2",
          content: [
            { type: "tool_result", tool_use_id: "call_web_reader", content: "page contents" },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        type: "result",
        session_id: sessionId,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await provider.takeover();
      await provider.sendPrompt("read the page");
      await tick();
      await tick();

      const toolEvents = events.filter((event) =>
        event.type === "tool" && event.payload.toolUseId === "call_web_reader"
      );
      expect(toolEvents.map((event) => event.payload.status)).toEqual(["running", "completed"]);
      expect(toolEvents[1]?.payload).toEqual(expect.objectContaining({
        sessionId,
        messageId: "assistant-message-1",
        toolName: "webReader",
        output: "page contents",
      }));
      expect(events.filter((event) => event.type === "error")).toHaveLength(0);
    } finally {
      provider.stop();
    }
  });

  it("pairs streamed thinking blocks with their final events by stream order", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sessionId = "11111111-1111-1111-1111-111111111111";
    const streamEvent = (event: Record<string, unknown>) => ({
      type: "stream_event",
      session_id: sessionId,
      parent_tool_use_id: null,
      event,
    });
    const finalThinking = (thinking: string) => ({
      type: "assistant",
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        id: "message-1",
        role: "assistant",
        model: "glm-5.2",
        content: [{ type: "thinking", thinking }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    mockRemoteQueryYielding([
      streamEvent({
        type: "message_start",
        message: { id: "message-1" },
      }),
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "segment one " },
      }),
      finalThinking("segment one full"),
      streamEvent({
        type: "content_block_delta",
        index: 4,
        delta: { type: "thinking_delta", thinking: "segment two " },
      }),
      finalThinking("segment two full"),
      {
        type: "assistant",
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          id: "message-1",
          role: "assistant",
          model: "glm-5.2",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        type: "result",
        session_id: sessionId,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await provider.takeover();
      await provider.sendPrompt("do the thing");
      await tick();
      await tick();

      const reasoning = events.filter((event) => event.type === "reasoning");
      const deltas = reasoning.filter((event) => event.payload.delta === true);
      const finals = reasoning.filter((event) => event.payload.delta !== true);

      expect(deltas.map((event) => event.payload.partId)).toEqual([
        "message-1-reasoning-0",
        "message-1-reasoning-4",
      ]);
      expect(finals.map((event) => ({
        partId: event.payload.partId,
        replace: event.payload.replace,
        text: event.payload.text,
      }))).toEqual([
        { partId: "message-1-reasoning-0", replace: true, text: "segment one full" },
        { partId: "message-1-reasoning-4", replace: true, text: "segment two full" },
      ]);
    } finally {
      provider.stop();
    }
  });

  it("warns when a successful result follows a bare thinking tail", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sessionId = "11111111-1111-1111-1111-111111111111";
    mockRemoteQueryYielding([
      {
        type: "assistant",
        session_id: sessionId,
        uuid: "assistant-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-1",
          role: "assistant",
          model: "glm-5.2",
          content: [
            { type: "thinking", thinking: "analyzing the brand palette" },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        type: "result",
        session_id: sessionId,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await provider.takeover();
      await provider.sendPrompt("build the page");
      await tick();
      await tick();

      const errors = events.filter((event) => event.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.payload).toEqual(expect.objectContaining({
        title: "Claude reply may be truncated",
        sessionId,
      }));
    } finally {
      provider.stop();
    }
  });

  it("does not warn when the turn ends with reply text after thinking", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sessionId = "11111111-1111-1111-1111-111111111111";
    mockRemoteQueryYielding([
      {
        type: "assistant",
        session_id: sessionId,
        uuid: "assistant-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-1",
          role: "assistant",
          model: "glm-5.2",
          content: [
            { type: "thinking", thinking: "analyzing" },
            { type: "text", text: "done" },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        type: "result",
        session_id: sessionId,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await provider.takeover();
      await provider.sendPrompt("build the page");
      await tick();
      await tick();

      expect(events.filter((event) => event.type === "error")).toHaveLength(0);
    } finally {
      provider.stop();
    }
  });

  it("emits an error when the stream ends without a result", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sessionId = "11111111-1111-1111-1111-111111111111";
    mockRemoteQueryYielding([
      {
        type: "assistant",
        session_id: sessionId,
        uuid: "assistant-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-1",
          role: "assistant",
          model: "glm-5.2",
          content: [
            { type: "text", text: "ok" },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]);

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await provider.takeover();
      await provider.sendPrompt("hello");
      await tick();
      await tick();

      const errors = events.filter((event) => event.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.payload).toEqual(expect.objectContaining({
        title: "Claude run ended unexpectedly",
        sessionId,
      }));
    } finally {
      provider.stop();
    }
  });
});

describe("buildClaudeCloudRelayEnv", () => {
  it("disables inherited ADIT cloud side effects for relay-managed Claude hooks", () => {
    const env = buildClaudeCloudRelayEnv({
      TERM: "screen-256color",
      ADIT_CLOUD_AUTO_SYNC: "true",
      ADIT_PROJECT_LINK_AUTO_SYNC: "true",
      ADIT_TRANSCRIPT_UPLOAD: "true",
    });

    expect(env.TERM).toBe("screen-256color");
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(env.ADIT_CLOUD_AUTO_SYNC).toBe("false");
    expect(env.ADIT_PROJECT_LINK_AUTO_SYNC).toBe("false");
    expect(env.ADIT_TRANSCRIPT_UPLOAD).toBe("false");
  });

  it("keeps color defaults for Claude child processes", () => {
    const env = buildClaudeCloudRelayEnv({});

    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.FORCE_COLOR).toBe("3");
  });
});
