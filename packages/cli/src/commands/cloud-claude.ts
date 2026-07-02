import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, findGitRoot, projectNameFromRoot } from "@varveai/adit-core";
import {
  CloudApiError,
  CloudAuthError,
  CloudClient,
  CloudNetworkError,
  DEFAULT_SERVER_URL,
  loadCloudConfig,
  loadCredentials,
} from "@varveai/adit-cloud";
import { ClaudeCodeProvider } from "./cli-agent/claude/provider.js";
import { resolveExecutable } from "./cli-agent/cli-process.js";
import { ClaudeTranscriptSync } from "./cli-agent/claude/claude-transcript-sync.js";
import {
  cleanupStaleClaudeCloudSettings,
  ensurePersistentClaudeHooksInstalled,
  installClaudeHooks,
  type InstalledHooks,
} from "./cli-agent/claude/hooks-bootstrap.js";
import { startCliAgentHookServer, type HookServer } from "./cli-agent/hook-server.js";
import { CliAgentRelayWebSocket } from "./cli-agent/relay-client.js";
import { requireAditProjectInitialized } from "./project-initialization.js";
import type {
  CliAgentRelayEvent,
  PromptImageAttachment,
  RelayCommand,
} from "./cli-agent/types.js";

interface CloudClaudeOptions {
  bin?: string;
  arg?: string[];
}

function createRelayLoopWake() {
  let wakeCurrent: (() => void) | null = null;
  return {
    wake(): void {
      const wake = wakeCurrent;
      wakeCurrent = null;
      wake?.();
    },
    wait(ms: number): Promise<void> {
      return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = () => {
          if (wakeCurrent === finish) wakeCurrent = null;
          clearTimeout(timer);
          resolve();
        };
        timer = setTimeout(finish, ms);
        wakeCurrent = finish;
      });
    },
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readModelValue(value: unknown): string | null {
  if (typeof value === "string") return readString(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const model = value as Record<string, unknown>;
  return readString(model.display_name) ?? readString(model.id);
}

function readStringMatrix(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value.map((item) =>
    Array.isArray(item)
      ? item.filter((answer): answer is string => typeof answer === "string")
      : [],
  );
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function readImageAttachments(value: unknown): PromptImageAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: PromptImageAttachment[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const id = readString(item.id);
    const url = readString(item.url);
    const mimeType = readString(item.mimeType);
    if (!id || !url || !mimeType?.startsWith("image/")) continue;
    attachments.push({
      id,
      kind: "image",
      url,
      mimeType,
      fileName: readString(item.fileName),
      sizeBytes: typeof item.sizeBytes === "number" && Number.isFinite(item.sizeBytes)
        ? item.sizeBytes
        : 0,
    });
  }
  return attachments;
}

function isPendingSessionId(value: string | null | undefined): boolean {
  return value?.startsWith("pending_") ?? false;
}

function readHookModel(body: Record<string, unknown>): string | null {
  return (
    readModelValue(body.model) ??
    readString(body.activeModelId)
  );
}

export function isLocalIdleHook(eventType: string, body: Record<string, unknown>): boolean {
  if (
    eventType === "Stop" ||
    eventType === "StopFailure" ||
    eventType === "SubagentStop" ||
    eventType === "SessionEnd"
  ) {
    return true;
  }
  if (eventType !== "Notification") return false;
  const text = [
    readString(body.message),
    readString(body.title),
    readString(body.notification_type),
  ]
    .filter((item): item is string => Boolean(item))
    .join("\n");
  return /error|failed|failure|blocked|rejected|denied|security|safety|安全|敏感|失败|错误|拒绝/u.test(text);
}

export function isTerminalClaudeErrorEvent(event: CliAgentRelayEvent): boolean {
  if (event.type === "message") {
    const modelId = readString(event.payload.modelId);
    if (modelId && modelId !== "<synthetic>") return false;
    const text = readString(event.payload.text);
    return Boolean(text && isTerminalClaudeErrorText(text));
  }

  if (event.type !== "tool") return false;
  if (readString(event.payload.status) !== "error") return false;
  const text = [
    readString(event.payload.error),
    readString(event.payload.output),
  ]
    .filter((item): item is string => Boolean(item))
    .join("\n");
  return isTerminalClaudeErrorText(text);
}

function isTerminalClaudeErrorText(text: string): boolean {
  if (/Claude Code returned an error result/iu.test(text)) return true;
  return /API Error/iu.test(text) &&
    (
      /safety|security|blocked|rejected|denied|policy|安全|不安全|敏感|拒绝/u.test(text) ||
      /\b(429|500|502|503|504|529)\b|overload|rate.?limit|server-side|temporary|访问量过大|稍后再试|限流|过载|繁忙/iu
        .test(text)
    );
}

function eventWithSessionId(event: CliAgentRelayEvent, sessionId: string | null): CliAgentRelayEvent {
  if (!sessionId) return event;
  if (event.payload.sessionId === sessionId) return event;
  return {
    ...event,
    payload: {
      ...event.payload,
      sessionId,
    },
  };
}

function enqueueTranscriptEvents(
  transcriptEvents: CliAgentRelayEvent[],
  enqueueEvent: (event: CliAgentRelayEvent) => void,
  sessionId: string | null,
  opts: { idleOnRunAborted?: boolean } = {},
): boolean {
  let shouldMarkIdle = false;
  for (const transcriptEvent of transcriptEvents) {
    const event = eventWithSessionId(transcriptEvent, sessionId);
    enqueueEvent(event);
    if (isTerminalClaudeErrorEvent(event)) shouldMarkIdle = true;
    if (opts.idleOnRunAborted && event.type === "run.aborted") shouldMarkIdle = true;
  }
  return shouldMarkIdle;
}

function printCloudError(prefix: string, error: unknown): void {
  if (error instanceof CloudAuthError) {
    console.error(`${prefix}: authentication failed. Run 'adit cloud login' again.`);
    console.error(error.message);
  } else if (error instanceof CloudNetworkError) {
    console.error(`${prefix}: cannot reach adit-cloud.`);
    console.error(error.message);
  } else if (error instanceof CloudApiError) {
    console.error(`${prefix}: cloud API error (${error.status}).`);
    console.error(error.message);
  } else {
    console.error(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function processCommand(
  provider: ClaudeCodeProvider,
  command: RelayCommand,
): Promise<void> {
  if (command.type === "takeover") {
    await provider.takeover();
    return;
  }

  if (command.type === "new-session") {
    await provider.startNewSession?.(
      readString(command.payload.pendingSessionId) ?? readString(command.payload.sessionId),
    );
    return;
  }

  if (command.type === "switch-session") {
    const sessionId = readString(command.payload.sessionId);
    if (!sessionId) return;
    await provider.switchSession(sessionId);
    return;
  }

  if (command.type === "prompt") {
    const text = readString(command.payload.text);
    const attachments = readImageAttachments(command.payload.attachments);
    if (!text && attachments.length === 0) return;
    const sessionId = readString(command.payload.sessionId);
    const pendingSessionId = readString(command.payload.pendingSessionId);
    const localMessageId = readString(command.payload.localMessageId);
    const mode = readString(command.payload.mode) === "plan" ? "plan" : "build";
    if (!pendingSessionId && sessionId && provider.state.activeSessionId !== sessionId) {
      await provider.switchSession(sessionId);
    }
    await provider.sendPrompt(text ?? "", { mode, pendingSessionId, localMessageId, attachments });
    return;
  }

  if (command.type === "steer") {
    const text = readString(command.payload.text);
    const attachments = readImageAttachments(command.payload.attachments);
    if (!text && attachments.length === 0) return;
    const sessionId = readString(command.payload.sessionId);
    const localMessageId = readString(command.payload.localMessageId);
    const mode = readString(command.payload.mode) === "plan" ? "plan" : "build";
    try {
      await provider.steerPrompt(text ?? "", { sessionId, localMessageId, mode, attachments });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not currently accepting steering input|prompt stream is closed/i.test(message)) {
        await provider.sendPrompt(text ?? "", { mode, localMessageId, attachments });
        return;
      }
      throw error;
    }
    return;
  }

  if (command.type === "slash-command") {
    const name = readString(command.payload.command) ?? readString(command.payload.name);
    if (!name) return;
    const sessionId = readString(command.payload.sessionId);
    const pendingSessionId =
      readString(command.payload.pendingSessionId) ??
      (isPendingSessionId(sessionId) ? sessionId : null);
    if (!pendingSessionId && sessionId && provider.state.activeSessionId !== sessionId) {
      await provider.switchSession(sessionId);
    }
    await provider.handleSlashCommand({
      name,
      args: readStringArray(command.payload.args),
      raw: readString(command.payload.raw) ?? `/${name}`,
      sessionId,
      pendingSessionId,
      localMessageId: readString(command.payload.localMessageId),
    });
    return;
  }

  if (command.type === "rewind") {
    const id = readString(command.payload.id);
    if (!id) return;
    await provider.answerRewind?.({
      id,
      sessionId: readString(command.payload.sessionId),
      userMessageId: readString(command.payload.userMessageId),
      dryRun: command.payload.dryRun === true,
      rejected: command.payload.rejected === true,
    });
    return;
  }

  if (command.type === "abort") {
    await provider.abort();
    return;
  }

  if (command.type === "permission") {
    const id = readString(command.payload.id);
    const response = readString(command.payload.response);
    if (!id) return;
    await provider.answerPermission(
      id,
      response !== "reject",
      response === "reject" ? "Rejected from adit-cloud." : undefined,
    );
    return;
  }

  if (command.type === "question") {
    const id = readString(command.payload.id);
    if (!id) return;
    await provider.answerQuestion({
      id,
      answers: readStringMatrix(command.payload.answers),
      rejected: command.payload.rejected === true,
    });
  }
}

function enqueueCommand(input: {
  queue: RelayCommand[];
  seen: Set<string>;
  command: RelayCommand;
}): void {
  if (input.seen.has(input.command.id)) return;
  input.seen.add(input.command.id);
  input.queue.push(input.command);
  if (input.seen.size > 500) {
    const keep = new Set(input.queue.map((command) => command.id));
    for (const id of input.seen) {
      if (!keep.has(id) && input.seen.size > 250) input.seen.delete(id);
    }
  }
}

async function drainCommandQueue(input: {
  provider: ClaudeCodeProvider;
  commands: RelayCommand[];
  enqueueEvent: (event: CliAgentRelayEvent) => void;
  ws: CliAgentRelayWebSocket | null;
}): Promise<void> {
  while (input.commands.length > 0) {
    const command = input.commands.shift();
    if (!command) return;
    try {
      await processCommand(input.provider, command);
      input.ws?.ack(command.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.ws?.commandError(command.id, message);
      input.enqueueEvent({
        type: "error",
        payload: {
          message,
          commandId: command.id,
          createdAt: Date.now(),
        },
      });
    }
  }
}

export async function cloudClaudeCommand(opts?: CloudClaudeOptions): Promise<void> {
  const gitRoot = findGitRoot(process.cwd());
  if (!gitRoot) {
    console.error("Not inside a git project. Run this from the project you want to connect.");
    process.exitCode = 1;
    return;
  }
  if (!requireAditProjectInitialized(gitRoot, "adit cloud claude")) {
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(gitRoot);
  const credentials = loadCredentials();
  if (!credentials) {
    console.error("Not logged in. Run 'adit cloud login' first.");
    process.exitCode = 1;
    return;
  }

  const claudeBin = opts?.bin ?? "claude";
  const claudeExecutable = resolveExecutable(claudeBin);
  if (!claudeExecutable) {
    console.error(`Claude Code CLI not found: ${claudeBin}`);
    console.error("Install Claude Code and make sure 'claude' is available on PATH.");
    process.exitCode = 1;
    return;
  }

  const cloudConfig = loadCloudConfig();
  const serverUrl = cloudConfig.serverUrl ?? credentials.serverUrl ?? DEFAULT_SERVER_URL;
  const client = new CloudClient(serverUrl, credentials);
  const terminalId = randomUUID();
  const projectName = projectNameFromRoot(config.projectRoot);
  const panelName = projectName;

  try {
    await client.get("/api/sync/status");
  } catch (error) {
    printCloudError("Unable to verify cloud login", error);
    process.exitCode = 1;
    return;
  }

  let hookServer: HookServer | null = null;
  let installedHooks: InstalledHooks | null = null;
  let provider: ClaudeCodeProvider | null = null;
  const eventQueue: CliAgentRelayEvent[] = [];
  const commandQueue: RelayCommand[] = [];
  const seenCommandIds = new Set<string>();
  const transcriptSync = new ClaudeTranscriptSync();
  const relayLoopWake = createRelayLoopWake();
  const enqueueEvent = (event: CliAgentRelayEvent): void => {
    eventQueue.push(event);
    relayLoopWake.wake();
  };

  try {
    try {
      const installedPersistentHooks = await ensurePersistentClaudeHooksInstalled({
        cwd: config.projectRoot,
      });
      if (installedPersistentHooks) {
        console.log("Installed ADIT Claude Code hooks for local timeline tracking.");
      }
    } catch (error) {
      console.error(
        `[adit cloud claude] warning: failed to install persistent ADIT Claude Code hooks: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await cleanupStaleClaudeCloudSettings({ cwd: config.projectRoot });
    hookServer = await startCliAgentHookServer();
    const hookSettingsPath = join(
      config.projectRoot,
      ".claude",
      `adit-cloud-${terminalId}.settings.local.json`,
    );
    installedHooks = installClaudeHooks({
      cwd: config.projectRoot,
      endpoint: hookServer.endpoint,
      marker: `from=adit-cloud-cli-${hookServer.port}`,
      settingsPath: hookSettingsPath,
    });

    provider = new ClaudeCodeProvider({
      bin: claudeExecutable,
      args: opts?.arg ?? [],
      cwd: config.projectRoot,
      hookSettingsPath: installedHooks.settingsPath,
      onEvent: enqueueEvent,
    });

    const ws = new CliAgentRelayWebSocket({
      serverUrl,
      accessToken: async () => (await client.getFreshCredentials()).accessToken,
      register: {
        provider: "claude-code",
        terminalId,
        projectRoot: config.projectRoot,
        projectId: config.projectId,
        projectName,
        panelName,
      },
      onHello: (info) => {
        console.log(`Connected ${config.projectRoot} to adit-cloud Coding.`);
        console.log(`Terminal: ${terminalId}`);
        console.log(`Connection: ${info.connectionId}`);
        if (info.panelId) console.log(`Panel: ${info.panelName ?? panelName} (${info.panelId})`);
        console.log("Local Claude Code owns the session until the Coding page takes over.");
        console.log("When Web owns the session, type /local in this terminal to reclaim it.");
      },
      onCommand: (command) => {
        enqueueCommand({
          queue: commandQueue,
          seen: seenCommandIds,
          command,
        });
        relayLoopWake.wake();
      },
      onConnectionClosed: () => {
        // Server archived our panel; reconnect will get a fresh one.
      },
      onError: (error) => {
        printCloudError("[adit cloud claude] websocket relay", error);
      },
    });

    hookServer.events.on("hook", (event) => {
      const body = event.body as Record<string, unknown>;
      const hookModel = readHookModel(body);
      const rawSessionId = transcriptSync.noteHook({
        eventType: event.type,
        body,
        sessionId: readString(body.sessionId),
      });
      const isLocalOwner = provider?.state.owner === "local";
      const sessionId = rawSessionId && isLocalOwner
        ? provider?.noteLocalSession(rawSessionId) ?? rawSessionId
        : rawSessionId;
      if (event.type === "StatusLine" || event.type === "SessionStart") {
        transcriptSync.noteModel(rawSessionId, hookModel);
        provider?.noteModel(hookModel);
      }
      if (event.type === "UserPromptSubmit") {
        if (isLocalOwner) {
          provider?.markLocalBusy();
          if (enqueueTranscriptEvents(transcriptSync.drainSession(rawSessionId), enqueueEvent, sessionId)) {
            provider?.markLocalIdle();
          }
          const prompt = readString(body.prompt);
          if (sessionId && prompt) {
            enqueueEvent({
              type: "message",
              payload: {
                role: "user",
                sessionId,
                text: prompt,
                createdAt: Date.now(),
              },
            });
          }
        }
      }
      if (isLocalIdleHook(event.type, body)) {
        if (isLocalOwner) {
          transcriptSync.scheduleDrain(rawSessionId, (transcriptEvent) => {
            const mappedEvent = eventWithSessionId(transcriptEvent, sessionId);
            enqueueEvent(mappedEvent);
            if (isTerminalClaudeErrorEvent(mappedEvent)) provider?.markLocalIdle();
          });
          provider?.markLocalIdle();
        }
      }
    });

    ws.connect();

    let stopping = false;
    let resourcesCleaned = false;
    const cleanupResources = () => {
      if (resourcesCleaned) return;
      resourcesCleaned = true;
      try {
        provider?.stop();
      } catch {}
      try {
        ws.close();
      } catch {}
      try {
        installedHooks?.cleanup();
      } catch {}
      try {
        void hookServer?.close().catch(() => undefined);
      } catch {}
    };
    const cleanup = (signal: string, exitCode = 0) => {
      if (stopping) return;
      stopping = true;
      process.exitCode = exitCode;
      console.log(`\n[adit cloud claude] received ${signal}, shutting down...`);
      cleanupResources();
      setTimeout(() => process.exit(exitCode), 100);
    };

    process.on("SIGINT", () => cleanup("SIGINT"));
    process.on("SIGTERM", () => cleanup("SIGTERM"));
    process.on("SIGHUP", () => cleanup("SIGHUP"));
    process.on("exit", cleanupResources);
    process.on("uncaughtException", (error) => {
      printCloudError("[adit cloud claude] uncaught exception", error);
      cleanup("uncaughtException", 1);
    });
    process.on("unhandledRejection", (error) => {
      printCloudError("[adit cloud claude] unhandled rejection", error);
      cleanup("unhandledRejection", 1);
    });

    provider.on("exit", () => {
      cleanup("Claude CLI exit");
    });

    while (!stopping) {
      try {
        if (ws.isOpen && ws.currentConnectionId) {
          await drainCommandQueue({
            provider,
            commands: commandQueue,
            enqueueEvent,
            ws,
          });
          const state = provider.state;
          if (
            state.owner === "local" &&
            state.busy &&
            enqueueTranscriptEvents(
              transcriptSync.drainSession(state.activeSessionId),
              enqueueEvent,
              state.activeSessionId,
              { idleOnRunAborted: true },
            )
          ) {
            provider.markLocalIdle();
          }
          ws.sendHeartbeat(provider.state);
          if (eventQueue.length > 0) {
            const batch = eventQueue.splice(0, 50);
            const sent = ws.sendEvents(batch);
            if (!sent) eventQueue.unshift(...batch);
          }
        } else {
          ws.connect();
        }
      } catch (error) {
        printCloudError("[adit cloud claude] relay loop", error);
      }

      const relayConnected = ws.isOpen && Boolean(ws.currentConnectionId);
      // Always yield while disconnected: commands cannot drain without a
      // connection, and a zero-await iteration would starve the event loop.
      if (!relayConnected || (commandQueue.length === 0 && eventQueue.length === 0)) {
        await relayLoopWake.wait(1500);
      }
    }
  } catch (error) {
    printCloudError("Failed to start Claude Coding relay", error);
    provider?.stop();
    try {
      installedHooks?.cleanup();
    } catch {}
    await hookServer?.close().catch(() => undefined);
    process.exitCode = 1;
  }
}
