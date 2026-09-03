import { randomUUID } from "node:crypto";
import { projectNameFromRoot } from "@varveai/adit-core";
import {
  CloudClient,
  DEFAULT_SERVER_URL,
  loadCloudConfig,
  loadCredentials,
} from "@varveai/adit-cloud";
import { CodexCliProvider } from "./cli-agent/codex/provider.js";
import {
  codexBinaryMismatchDebugLines,
  selectCodexExecutable,
} from "./cli-agent/codex/codex-binary-resolver.js";
import { CodexRelayEventDeduper, CodexTranscriptSync } from "./cli-agent/codex/codex-transcript-sync.js";
import {
  ensurePersistentCodexHooksInstalled,
  installCodexHooks,
  type InstalledHooks,
} from "./cli-agent/codex/hooks-bootstrap.js";
import { ensureConnectedPlatformsRecorded } from "./connected-platforms.js";
import { startCliAgentHookServer, type HookServer } from "./cli-agent/hook-server.js";
import { CodexLocalSessionLister, LocalSessionsReporter } from "./cli-agent/local-sessions.js";
import {
  CLI_AGENT_COLLABORATION_CAPABILITIES,
  CliAgentRelayWebSocket,
} from "./cli-agent/relay-client.js";
import {
  isCollaborationLifecycleEvent,
  processCollaborationCommand,
  removeQueuedCollaborationPrompts,
} from "./cli-agent/collaboration-commands.js";
import {
  createRelayNotices,
  createRelayStatusReporter,
  type RelayNotices,
} from "./cli-agent/relay-console.js";
import {
  reliableEventsForRetry,
  trimRelayEventQueue,
  type InFlightReliableEventBatch,
} from "./cli-agent/reliable-event-queue.js";
import { loadInitializedGitOrWorkspaceProjectConfig } from "./project-initialization.js";
import type {
  CliAgentRelayEvent,
  PromptImageAttachment,
  RelayCommand,
} from "./cli-agent/types.js";

interface CloudCodexOptions {
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
  return readModelValue(body.model) ?? readString(body.activeModelId);
}

function withHooksEnabled(args: string[]): string[] {
  const hasHooksFlag = args.some((arg, index) =>
    (arg === "--enable" && args[index + 1] === "hooks") ||
    arg === "--enable=hooks" ||
    arg === "-cfeatures.hooks=true" ||
    arg === "-c" && args[index + 1] === "features.hooks=true" ||
    arg === "--config=features.hooks=true" ||
    arg === "--config" && args[index + 1] === "features.hooks=true"
  );
  return hasHooksFlag ? args : ["--enable", "hooks", ...args];
}

const CODEX_CLOUD_HOOK_MARKER = "from=adit-cloud-codex-env";

function writeCodexDebugLines(notices: RelayNotices, lines: string[]): void {
  for (const line of lines) notices.debug(line);
}

async function processCommand(
  provider: CodexCliProvider,
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

  if (await processCollaborationCommand({ provider, providerName: "Codex", command })) return;

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
    await provider.sendPrompt(text ?? "", {
      mode,
      pendingSessionId,
      localMessageId,
      attachments,
      sessionId,
    });
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
      // Downgrade to a regular prompt only when it still targets the session
      // the user typed into — otherwise late input from a switched-away
      // session would silently start a turn in the newly active one.
      const targetsActiveSession =
        !sessionId || provider.state.activeSessionId === sessionId;
      if (/not currently accepting steering input/i.test(message) && targetsActiveSession) {
        await provider.sendPrompt(text ?? "", { mode, localMessageId, attachments, sessionId });
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
}): boolean {
  if (input.seen.has(input.command.id)) return false;
  input.seen.add(input.command.id);
  input.queue.push(input.command);
  if (input.seen.size > 500) {
    const keep = new Set(input.queue.map((command) => command.id));
    for (const id of input.seen) {
      if (!keep.has(id) && input.seen.size > 250) input.seen.delete(id);
    }
  }
  return true;
}

function commandErrorSessionId(
  provider: CodexCliProvider,
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
  provider: CodexCliProvider;
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

export async function cloudCodexCommand(opts?: CloudCodexOptions): Promise<void> {
  const config = loadInitializedGitOrWorkspaceProjectConfig("adit cloud codex");
  if (!config) return;

  const credentials = loadCredentials();
  if (!credentials) {
    console.error("Not logged in. Run 'adit cloud login' first.");
    process.exitCode = 1;
    return;
  }

  const notices = createRelayNotices("codex");
  const codexSelection = selectCodexExecutable(opts?.bin);
  const codexExecutable = codexSelection.executable;
  if (!codexExecutable) {
    console.error(`Codex CLI not found: ${codexSelection.bin}`);
    console.error("Install Codex CLI and make sure 'codex' is available on PATH.");
    process.exitCode = 1;
    return;
  }
  writeCodexDebugLines(notices, codexSelection.debugLines);
  if (!codexSelection.supportsAppServer) {
    console.error(`Codex CLI does not expose 'app-server': ${codexSelection.bin}`);
    console.error("Upgrade Codex CLI to the latest version and try again.");
    process.exitCode = 1;
    return;
  }
  if (!opts?.bin && codexSelection.source !== "PATH") {
    writeCodexDebugLines(notices, [
      `Using Codex CLI from ${codexExecutable} (${codexSelection.source})`,
    ]);
  }
  writeCodexDebugLines(notices, codexBinaryMismatchDebugLines(codexExecutable));

  const cloudConfig = loadCloudConfig();
  const serverUrl = cloudConfig.serverUrl ?? credentials.serverUrl ?? DEFAULT_SERVER_URL;
  const client = new CloudClient(serverUrl, credentials);
  const terminalId = randomUUID();
  const projectName = projectNameFromRoot(config.projectRoot);
  const panelName = projectName;
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
  let provider: CodexCliProvider | null = null;
  const eventQueue: CliAgentRelayEvent[] = [];
  const commandQueue: RelayCommand[] = [];
  const seenCommandIds = new Set<string>();
  const transcriptSync = new CodexTranscriptSync((sessionId, effort) => {
    provider?.noteReasoningEffort(effort, sessionId);
  });
  const eventDeduper = new CodexRelayEventDeduper();
  const relayLoopWake = createRelayLoopWake();
  let inFlightEventBatch: InFlightReliableEventBatch | null = null;
  let droppedQueuedEvents = 0;
  const enqueueEvent = (event: CliAgentRelayEvent): void => {
    const next = eventDeduper.filter(event);
    if (next) {
      eventQueue.push({
        ...next,
        ...(requiresReliableEventDelivery(next)
          ? { eventId: next.eventId ?? randomUUID() }
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
    }
  };
  const enqueueEvents = (events: CliAgentRelayEvent[]): void => {
    for (const event of events) enqueueEvent(event);
  };

  try {
    // Self-heal only repairs platforms the user connected; a project where
    // Codex was never connected is left untouched.
    const connectedPlatforms = await ensureConnectedPlatformsRecorded(config.projectRoot);
    if (connectedPlatforms.includes("codex")) {
      const installedPersistentHooks = await ensurePersistentCodexHooksInstalled({
        cwd: config.projectRoot,
      });
      if (installedPersistentHooks) {
        notices.line("Reinstalled ADIT Codex hooks for local timeline tracking.");
      }
    }
  } catch (error) {
    notices.line(
      `warning: failed to install persistent ADIT Codex hooks: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    hookServer = await startCliAgentHookServer();
    installedHooks = installCodexHooks({
      cwd: config.projectRoot,
      endpoint: hookServer.endpoint,
      marker: CODEX_CLOUD_HOOK_MARKER,
      persistent: true,
    });

    provider = new CodexCliProvider({
      bin: codexExecutable,
      args: withHooksEnabled(opts?.arg ?? []),
      cwd: config.projectRoot,
      dataDir: config.dataDir,
      hookEndpoint: hookServer.endpoint,
      hookMarker: CODEX_CLOUD_HOOK_MARKER,
      onEvent: enqueueEvent,
      notices,
    });

    const ws = new CliAgentRelayWebSocket({
      serverUrl,
      accessToken: async () => (await client.getFreshCredentials()).accessToken,
      register: {
        provider: "codex",
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
        const enqueued = enqueueCommand({
          queue: commandQueue,
          seen: seenCommandIds,
          command,
        });
        if (enqueued) relayLoopWake.wake();
      },
      onConnectionClosed: () => {
        inFlightEventBatch = null;
        removeQueuedCollaborationPrompts(commandQueue);
        void provider?.abortCollaborationOnRelayDisconnect?.().catch((error) => {
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
    const localSessionLister = new CodexLocalSessionLister(config.projectRoot);
    const localSessionsReporter = new LocalSessionsReporter(
      ws,
      () => localSessionLister.list(),
    );

    hookServer.events.on("hook", (event) => {
      const body = event.body as Record<string, unknown>;
      const sessionId = transcriptSync.noteHook({
        eventType: event.type,
        body,
        sessionId: readString(body.sessionId),
      });
      provider?.noteModel(readHookModel(body));
      const isLocalOwner = provider?.state.owner === "local";
      if (sessionId && isLocalOwner) provider?.noteLocalSession(sessionId);
      if (event.type === "UserPromptSubmit" && isLocalOwner) {
        provider?.markLocalBusy();
        enqueueEvents(transcriptSync.drainSession(sessionId));
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
      if (event.type === "PostToolUse" && isLocalOwner) {
        const transcriptEvents = transcriptSync.drainSession(sessionId);
        if (transcriptEvents.length > 0) {
          enqueueEvents(transcriptEvents);
        } else {
          enqueueEvents(transcriptSync.toolEvents(sessionId, body));
        }
      }
      if (event.type === "Stop") {
        if (isLocalOwner) {
          const transcriptEvents = transcriptSync.drainSession(sessionId);
          if (transcriptEvents.length > 0) {
            enqueueEvents(transcriptEvents);
          } else {
            enqueueEvents(transcriptSync.stopEvents(sessionId, body));
          }
          transcriptSync.scheduleDrain(sessionId, (transcriptEvent) => {
            enqueueEvent(transcriptEvent);
          });
          provider?.markLocalIdle();
        }
      }
    });

    ws.connect();

    let stopping = false;
    let lastTranscriptDrainAt = 0;
    const cleanup = (signal: string) => {
      if (stopping) return;
      stopping = true;
      notices.shutdown(signal);
      try {
        // Deliberate shutdown: tell the relay now so the final offline feed
        // record is written immediately instead of after the grace delay.
        if (provider) ws.sendHeartbeat(provider.state, "offline");
      } catch {}
      provider?.stop();
      ws.close();
      try {
        installedHooks?.cleanup();
      } catch {}
      void hookServer?.close().catch(() => undefined);
      setTimeout(() => process.exit(0), 100);
    };

    process.on("SIGINT", () => cleanup("SIGINT"));
    process.on("SIGTERM", () => cleanup("SIGTERM"));

    provider.on("exit", (info: { signal?: string | null } | undefined) => {
      cleanup(info?.signal ?? "Codex CLI exit");
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
          ws.sendHeartbeat(provider.state);
          localSessionsReporter.maybeReport(processedCommands);
          const state = provider.state;
          const now = Date.now();
          if (state.activeSessionId && now - lastTranscriptDrainAt > 1000) {
            lastTranscriptDrainAt = now;
            enqueueEvents(transcriptSync.drainSession(state.activeSessionId));
          }
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
    notices.cloudError("failed to start Codex Coding relay", error);
    provider?.stop();
    try {
      installedHooks?.cleanup();
    } catch {}
    await hookServer?.close().catch(() => undefined);
    process.exitCode = 1;
  }
}
