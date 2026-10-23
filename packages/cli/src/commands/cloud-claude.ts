import { cleanupLegacyHooks } from "./legacy-hook-cleanup.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { projectNameFromRoot } from "@varveai/adit-core";
import {
  CloudClient,
  DEFAULT_SERVER_URL,
  loadCloudConfig,
  loadCredentials,
} from "@varveai/adit-cloud";
import { ClaudeCodeProvider } from "./cli-agent/claude/provider.js";
import { resolveExecutable } from "./cli-agent/cli-process.js";
import { ClaudeTranscriptSync } from "./cli-agent/claude/claude-transcript-sync.js";
import {
  cleanupStaleClaudeCloudSettings,
  installClaudeHooks,
  type InstalledHooks,
} from "./cli-agent/claude/hooks-bootstrap.js";
import { startCliAgentHookServer, type HookServer } from "./cli-agent/hook-server.js";
import { ClaudeLocalSessionLister, LocalSessionsReporter } from "./cli-agent/local-sessions.js";
import {
  CLI_AGENT_COLLABORATION_CAPABILITIES,
  CliAgentRelayWebSocket,
} from "./cli-agent/relay-client.js";
import {
  isCollaborationLifecycleEvent,
  processCollaborationCommand,
  removeQueuedCollaborationPrompts,
} from "./cli-agent/collaboration-commands.js";
import { createRelayNotices, createRelayStatusReporter } from "./cli-agent/relay-console.js";
import {
  reliableEventsForRetry,
  trimRelayEventQueue,
  type InFlightReliableEventBatch,
} from "./cli-agent/reliable-event-queue.js";
import { loadProjectContext } from "./project-context.js";
import type {
  CliAgentRelayEvent,
  PromptImageAttachment,
  RelayCommand,
} from "./cli-agent/types.js";

interface CloudClaudeOptions {
  bin?: string;
  arg?: string[];
}
/**
 * Upper bound for events buffered while the relay is disconnected.
 * Long offline periods with an active local session would otherwise
 * grow the queue without limit. Oldest events are dropped first so
 * the panel converges to recent state after reconnect.
 */
const MAX_EVENT_QUEUE = 10_000;

function requiresReliableEventDelivery(event: CliAgentRelayEvent): boolean {
  return isCollaborationLifecycleEvent(event);
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

function readHookReasoningEffort(body: Record<string, unknown>): string | null {
  const effort = body.effort && typeof body.effort === "object" && !Array.isArray(body.effort)
    ? body.effort as Record<string, unknown>
    : null;
  return (
    readString(effort?.level) ??
    readString(body.reasoningEffort) ??
    readString(body.reasoning_effort)
  );
}

export function isLocalIdleHook(eventType: string, body: Record<string, unknown>): boolean {
  // SubagentStop is deliberately NOT an idle signal: it fires mid-turn when a
  // Task subagent finishes while the main agent keeps working. Treating it as
  // idle let the web panel take over (killing the CLI) in the middle of a turn.
  if (
    eventType === "Stop" ||
    eventType === "StopFailure"
  ) {
    return true;
  }
  if (eventType !== "Notification") return false;
  // Error-ish notifications stay an idle signal: permission denials and
  // safety blocks stall the turn without ever firing Stop. Tradeoff: a
  // mid-turn tool-failure notification can mark idle early.
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

  if (await processCollaborationCommand({ provider, providerName: "Claude", command })) return;

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

function commandErrorSessionId(
  provider: ClaudeCodeProvider,
  command: RelayCommand,
  previousActiveSessionId: string | null,
): string | null {
  const payloadSessionId = readString(command.payload.sessionId);
  const pendingSessionId =
    readString(command.payload.pendingSessionId) ??
    (isPendingSessionId(payloadSessionId) ? payloadSessionId : null);
  if (pendingSessionId) {
    const activeSessionId = provider.state.activeSessionId;
    if (
      activeSessionId &&
      activeSessionId !== previousActiveSessionId &&
      !isPendingSessionId(activeSessionId)
    ) {
      return activeSessionId;
    }
    return pendingSessionId;
  }
  return payloadSessionId ?? provider.state.activeSessionId ?? provider.state.resumeSessionId;
}

async function drainCommandQueue(input: {
  provider: ClaudeCodeProvider;
  commands: RelayCommand[];
  enqueueEvent: (event: CliAgentRelayEvent) => void;
  ws: CliAgentRelayWebSocket | null;
}): Promise<boolean> {
  let processed = false;
  while (input.commands.length > 0) {
    const command = input.commands.shift();
    if (!command) return processed;
    processed = true;
    const previousActiveSessionId = input.provider.state.activeSessionId;
    try {
      await processCommand(input.provider, command);
      input.ws?.ack(command.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const sessionId = commandErrorSessionId(input.provider, command, previousActiveSessionId);
      input.ws?.commandError(command.id, message, sessionId);
      input.enqueueEvent({
        type: "error",
        payload: {
          message,
          commandId: command.id,
          ...(sessionId ? { sessionId } : {}),
          createdAt: Date.now(),
        },
      });
    }
  }
  return processed;
}

export async function cloudClaudeCommand(opts?: CloudClaudeOptions): Promise<void> {
  const config = loadProjectContext("adit cloud claude");
  if (!config) return;
  for (const error of cleanupLegacyHooks(config.projectRoot).errors) console.error(error);

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
  const notices = createRelayNotices("claude");
  const relayStatus = createRelayStatusReporter({
    notices,
    projectName,
    projectRoot: config.projectRoot,
    terminalId,
    serverUrl,
    suppressInteractiveNotices: Boolean(process.stderr.isTTY),
  });

  try {
    await client.get("/api/sync/status");
  } catch (error) {
    notices.cloudError("unable to verify cloud login", error);
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
  let inFlightEventBatch: InFlightReliableEventBatch | null = null;
  let droppedQueuedEvents = 0;
  const enqueueEvent = (event: CliAgentRelayEvent): void => {
    eventQueue.push({
      ...event,
      ...(requiresReliableEventDelivery(event)
        ? { eventId: event.eventId ?? randomUUID() }
        : {}),
    });
    if (eventQueue.length > MAX_EVENT_QUEUE) {
      const dropped = trimRelayEventQueue({
        queue: eventQueue,
        maxSize: MAX_EVENT_QUEUE,
        isReliable: requiresReliableEventDelivery,
      });
      droppedQueuedEvents += dropped;
      if (dropped > 0 && (droppedQueuedEvents === 1 || droppedQueuedEvents % 1000 === 0)) {
        notices.line(
          `warning: relay event queue exceeded ${MAX_EVENT_QUEUE} while disconnected — dropped ${droppedQueuedEvents} oldest event(s) so far.`,
        );
      }
    }
    relayLoopWake.wake();
  };

  try {
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
      dataDir: config.dataDir,
      hookSettingsPath: installedHooks.settingsPath,
      onEvent: enqueueEvent,
      notices,
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
        capabilities: [...CLI_AGENT_COLLABORATION_CAPABILITIES],
      },
      onHello: (info) => {
        relayStatus.helloOk({ ...info, owner: provider?.state.owner ?? "stopped" });
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
        inFlightEventBatch = null;
        removeQueuedCollaborationPrompts(commandQueue);
        void provider?.abortCollaborationOnRelayDisconnect().catch((error) => {
          relayStatus.relayError(error instanceof Error ? error : new Error(String(error)));
        });
      },
      onEventsAck: (batchId) => {
        if (inFlightEventBatch?.batchId !== batchId) return;
        const acknowledged = new Set(inFlightEventBatch.eventIds);
        for (let index = eventQueue.length - 1; index >= 0; index -= 1) {
          const eventId = eventQueue[index]?.eventId;
          if (eventId && acknowledged.has(eventId)) eventQueue.splice(index, 1);
        }
        inFlightEventBatch = null;
        relayLoopWake.wake();
      },
      onError: (error) => {
        relayStatus.relayError(error);
      },
      onReconnectScheduled: (attempt, delayMs) => {
        relayStatus.retryScheduled(attempt, delayMs);
      },
    });
    const localSessionLister = new ClaudeLocalSessionLister(config.projectRoot);
    const localSessionsReporter = new LocalSessionsReporter(
      ws,
      () => localSessionLister.list(),
    );

    hookServer.events.on("hook", (event) => {
      const body = event.body as Record<string, unknown>;
      const hookModel = readHookModel(body);
      const hookReasoningEffort = readHookReasoningEffort(body);
      const rawSessionId = transcriptSync.noteHook({
        eventType: event.type,
        body,
        sessionId: readString(body.sessionId),
      });
      const isLocalOwner = provider?.state.owner === "local";
      const sessionId = rawSessionId && isLocalOwner
        ? provider?.noteLocalSession(rawSessionId) ?? rawSessionId
        : rawSessionId;
      if (event.type === "StatusLine") {
        transcriptSync.noteModel(rawSessionId, hookModel);
        provider?.noteModel(hookModel);
      }
      if (
        !readString(body.agent_id) &&
        (hookReasoningEffort || event.type === "StatusLine")
      ) {
        provider?.noteReasoningEffort(hookReasoningEffort);
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
      // SubagentStop is a transcript-freshness signal (drain), not a turn
      // boundary — the main agent is usually still working.
      const isIdleHook = isLocalIdleHook(event.type, body);
      if ((isIdleHook || event.type === "SubagentStop") && isLocalOwner) {
        transcriptSync.scheduleDrain(rawSessionId, (transcriptEvent) => {
          const mappedEvent = eventWithSessionId(transcriptEvent, sessionId);
          enqueueEvent(mappedEvent);
          if (isTerminalClaudeErrorEvent(mappedEvent)) provider?.markLocalIdle();
        });
        if (isIdleHook) provider?.markLocalIdle();
      }
    });

    ws.connect();

    let stopping = false;
    let resourcesCleaned = false;
    const cleanupResources = () => {
      if (resourcesCleaned) return;
      resourcesCleaned = true;
      try {
        // Deliberate shutdown: tell the relay now so the final offline feed
        // record is written immediately instead of after the grace delay.
        if (provider) ws.sendHeartbeat(provider.state, "offline");
      } catch {}
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
      notices.shutdown(signal);
      cleanupResources();
      setTimeout(() => process.exit(exitCode), 100);
    };

    process.on("SIGINT", () => cleanup("SIGINT"));
    process.on("SIGTERM", () => cleanup("SIGTERM"));
    process.on("SIGHUP", () => cleanup("SIGHUP"));
    process.on("exit", cleanupResources);
    process.on("uncaughtException", (error) => {
      notices.cloudError("uncaught exception", error);
      cleanup("uncaughtException", 1);
    });
    process.on("unhandledRejection", (error) => {
      notices.cloudError("unhandled rejection", error);
      cleanup("unhandledRejection", 1);
    });

    provider.on("exit", () => {
      cleanup("Claude CLI exit");
    });

    while (!stopping) {
      try {
        if (ws.isOpen && ws.currentConnectionId) {
          const flushEvents = () => {
            if (eventQueue.length === 0) return;
            if (inFlightEventBatch) {
              const retryBatch = reliableEventsForRetry({
                queue: eventQueue,
                batch: inFlightEventBatch,
              });
              if (
                retryBatch.length === inFlightEventBatch.eventIds.length
                && ws.sendEvents(retryBatch, inFlightEventBatch.batchId)
              ) {
                inFlightEventBatch.sentAt = Date.now();
              }
              return;
            }
            if (requiresReliableEventDelivery(eventQueue[0]!)) {
              const reliableBatch: CliAgentRelayEvent[] = [];
              for (const event of eventQueue.slice(0, 50)) {
                if (!requiresReliableEventDelivery(event)) break;
                reliableBatch.push(event);
              }
              const eventIds = reliableBatch.flatMap((event) => event.eventId ? [event.eventId] : []);
              if (eventIds.length !== reliableBatch.length) return;
              const batchId = randomUUID();
              if (ws.sendEvents(reliableBatch, batchId)) {
                inFlightEventBatch = { batchId, eventIds, sentAt: Date.now() };
              }
              return;
            }
            let batchSize = 0;
            while (
              batchSize < Math.min(50, eventQueue.length)
              && !requiresReliableEventDelivery(eventQueue[batchSize]!)
            ) batchSize += 1;
            const batch = eventQueue.splice(0, batchSize);
            if (!ws.sendEvents(batch)) eventQueue.unshift(...batch);
          };
          const processedCommands = await drainCommandQueue({
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
          localSessionsReporter.maybeReport(processedCommands);
          flushEvents();
        } else {
          ws.connect();
        }
      } catch (error) {
        notices.cloudError("relay loop", error);
      }

      const relayConnected = ws.isOpen && Boolean(ws.currentConnectionId);
      // Always yield while disconnected: commands cannot drain without a
      // connection, and a zero-await iteration would starve the event loop.
      const hasDispatchableEvents = eventQueue.length > 0 && !inFlightEventBatch;
      if (!relayConnected || (commandQueue.length === 0 && !hasDispatchableEvents)) {
        await relayLoopWake.wait(1500);
      }
    }
  } catch (error) {
    notices.cloudError("failed to start Claude Coding relay", error);
    provider?.stop();
    try {
      installedHooks?.cleanup();
    } catch {}
    await hookServer?.close().catch(() => undefined);
    process.exitCode = 1;
  }
}
