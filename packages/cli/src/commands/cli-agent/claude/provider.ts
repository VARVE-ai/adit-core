import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  AbortError,
  query,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKAPIRetryMessage,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import { getCurrentBranch } from "@varveai/adit-engine";
import type {
  CliAgentContextUsage,
  CliAgentProvider,
  CliAgentRelayEvent,
  CliQuestionResponse,
  CliAgentState,
  CliPermissionRequest,
  PromptImageAttachment,
  CliSlashCommand,
  CliSlashCommandInfo,
  CliRewindResponse,
} from "../types.js";
import { spawnCliProcess } from "../cli-process.js";
import { spawnClaudeCliProcess } from "./cli-process.js";
import {
  ASK_USER_QUESTION_TOOL,
  CLAUDE_CLOUD_WEB_SYSTEM_PROMPT,
  EXIT_PLAN_MODE_TOOL,
  buildClaudeCloudRelayEnv,
  claudeToolScope,
  commandInfoFromClaudeSlashCommand,
  commandInfoFromClaudeSlashName,
  formatClaudeMcpServers,
  formatClaudeSkills,
  pendingSessionIdFromSlashCommand,
  withClaudeCloudNativeSlashCommands,
  type CliPromptMode,
} from "./capabilities.js";
import {
  PushableSdkPromptStream,
  toUserMessage,
} from "./prompt-stream.js";
import {
  asRecord,
  buildQuestionAnswerMap,
  extractSessionId,
  isSameContextUsage,
  isUuid,
  normalizeClaudeContextUsage,
  normalizeQuestionInput,
  readString,
  stableStateEventKey,
} from "./sdk-messages.js";
import {
  ClaudeThinkingPartTracker,
  emitClaudeApiRetry,
  emitClaudeAssistantMessage,
  emitClaudeCompactBoundary,
  emitClaudeCompactStatus,
  emitClaudePartialAssistantMessage,
  emitClaudeResultError,
  emitClaudeResultUsage,
  emitClaudeToolResults,
  type ClaudeSdkEventContext,
  type ClaudeToolUseState,
  type PartialAssistantStreamState,
} from "./sdk-event-emitters.js";
import {
  findLastClaudeSession,
  formatRewindResult,
  isValidClaudeSession,
  mergeClaudeSessionTranscript,
  normalizeClaudeSdkTranscriptEntrypoints,
  readClaudeRewindCheckpoints,
} from "./transcripts.js";
import type { ClaudeRewindCheckpoint } from "./transcripts.js";
export { CLAUDE_CLOUD_RELAY_ADIT_ENV, buildClaudeCloudRelayEnv } from "./capabilities.js";
export { normalizeClaudeTodoWriteInput } from "./todos.js";
export type { ClaudeTodoItem, ClaudeTodoPriority, ClaudeTodoStatus } from "./todos.js";
export { normalizeClaudeSdkTranscriptEntrypoints } from "./transcripts.js";

interface PendingPrompt {
  message: string;
  attachments: PromptImageAttachment[];
  mode: CliPromptMode;
  pendingSessionId: string | null;
  localMessageId: string | null;
  promptEvent: PendingPromptEvent;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface QueuedSdkPrompt {
  message: string;
  attachments: PromptImageAttachment[];
  mode: CliPromptMode;
  pendingSessionId: string | null;
  localMessageId: string | null;
  promptEvent: PendingPromptEvent;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface ActiveClaudePromptInput {
  generation: number;
  displaySessionId: string | null;
  acceptedSessionIds: Set<string>;
  stream: PushableSdkPromptStream;
  submittedTurnCount: number;
  completedResultCount: number;
}

interface PendingPromptEvent {
  text: string;
  attachments: PromptImageAttachment[];
  messageId?: string;
  mode: CliPromptMode;
  createdAt: number;
}

interface ClaudeCodeProviderOptions {
  bin: string;
  args: string[];
  cwd: string;
  hookSettingsPath?: string;
  onEvent?: (event: CliAgentRelayEvent) => void;
}

type CapabilityHydrateTarget =
  | { owner: "local"; child: ChildProcess }
  | { owner: "web"; generation: number };

const RECLAIM_COMMAND = "/local";
const BRANCH_REFRESH_INTERVAL_MS = 5_000;
const CONTEXT_USAGE_REFRESH_INTERVAL_MS = 10_000;
// The capability probe spawns a full Claude CLI process; without a deadline a
// hung spawn (proxy issues, MCP init stalls) leaves the web command list
// waiting forever.
const CAPABILITY_PROBE_TIMEOUT_MS = 20_000;

function stripClaudeModelArgs(args: string[]): string[] {
  const next: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--model") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--model=")) continue;
    next.push(arg);
  }
  return next;
}

interface CliQuestionRequest {
  id: string;
  input: Record<string, unknown>;
  createdAt: number;
}

interface PendingRewindRequest {
  id: string;
  sessionId: string;
  checkpoints: ClaudeRewindCheckpoint[];
}

export class ClaudeCodeProvider extends EventEmitter implements CliAgentProvider {
  readonly provider = "claude-code" as const;
  private local: ChildProcess | null = null;
  private remoteQuery: Query | null = null;
  private capabilityProbeQuery: Query | null = null;
  private capabilityProbeAbortController: AbortController | null = null;
  private remoteAbortController: AbortController | null = null;
  private remoteLoopGeneration = 0;
  private ownerValue: CliAgentState["owner"] = "stopped";
  private busyValue = false;
  private thinkingValue = false;
  private activeSessionId: string | null = null;
  private resumeSessionId: string | null = null;
  private sdkSessionId: string | null = null;
  private remoteSdkSessionId: string | null = null;
  private remoteSdkSessionIdsByActiveSession = new Map<string, Set<string>>();
  private activeModelId: string | null = null;
  private currentBranch: string | null = null;
  private branchRefreshAt = 0;
  private branchRefreshPromise: Promise<void> | null = null;
  private contextUsage: CliAgentContextUsage | null = null;
  private contextUsageBySession = new Map<string, CliAgentContextUsage>();
  private contextUsageRefreshAt = 0;
  private contextUsageRefreshPromise: Promise<void> | null = null;
  private contextCompactionToolBySession = new Map<string, {
    id: string;
    completed: boolean;
    completedAt?: number;
  }>();
  private localResumeSessionId: string | null = null;
  private lastStateEventKey: string | null = null;
  private promptQueue: PendingPrompt[] = [];
  private promptResolvers: Array<(value: QueuedSdkPrompt | null) => void> = [];
  private startingPrompt: QueuedSdkPrompt | null = null;
  private activePromptInput: ActiveClaudePromptInput | null = null;
  private activePromptEvent: PendingPromptEvent | null = null;
  private activePromptMode: CliPromptMode | null = null;
  private pendingPermissions = new Map<string, {
    request: CliPermissionRequest;
    resolve: (result: PermissionResult) => void;
    reject: (error: Error) => void;
  }>();
  private pendingQuestions = new Map<string, {
    request: CliQuestionRequest;
    resolve: (result: PermissionResult) => void;
    reject: (error: Error) => void;
  }>();
  private pendingRewinds = new Map<string, PendingRewindRequest>();
  private boundPendingSessionIds = new Set<string>();
  private lastAssistantMessageBySession = new Map<string, string>();
  private toolUseById = new Map<string, ClaudeToolUseState>();
  private lastAssistantTailKind: "thinking" | "other" | null = null;
  private partialAssistantStreams = new Map<string, PartialAssistantStreamState>();
  private streamedTextMessageIds = new Set<string>();
  private thinkingPartTracker = new ClaudeThinkingPartTracker();
  private slashCommandsByName = new Map<string, CliSlashCommandInfo>();
  private mcpServers: Array<{ name: string; status: string }> = [];
  private skills: string[] = [];
  private capabilityHydrateGeneration = 0;
  // True while a requested capability hydrate has not yet produced a snapshot
  // (probe still running, aborted by a prompt run, or failed). runRemoteLoop
  // re-hydrates after each run while this is set.
  private capabilityHydratePending = false;
  private reclaimingToLocal = false;
  private pendingLocalReclaimSessionId: string | null = null;
  private localSessionAliases = new Map<string, string>();
  private reclaimBuffer = "";
  private reclaimAttached = false;
  private suppressNextLocalExit = false;

  constructor(private readonly opts: ClaudeCodeProviderOptions) {
    super();
    this.startLocal();
  }

  get state(): CliAgentState {
    this.scheduleBranchRefresh();
    return {
      owner: this.ownerValue,
      busy: this.busyValue,
      thinking: this.thinkingValue,
      activeSessionId: this.activeSessionId,
      resumeSessionId: this.resumeSessionId,
      sdkSessionId: this.sdkSessionId,
      activeModelId: this.activeModelId,
      currentBranch: this.currentBranch,
      contextUsage: this.contextUsage,
      lastTokenUsage: null,
    };
  }

  get permissions(): CliPermissionRequest[] {
    return [...this.pendingPermissions.values()].map((item) => item.request);
  }

  noteModel(modelId: string | null | undefined): void {
    this.setActiveModel(modelId, { emit: true });
  }

  noteLocalSession(id: string): string | null {
    if (!id) return null;
    let canonicalId = this.localSessionAliases.get(id) ?? id;
    if (this.pendingLocalReclaimSessionId) {
      canonicalId = this.pendingLocalReclaimSessionId;
      if (id !== canonicalId) this.localSessionAliases.set(id, canonicalId);
      this.pendingLocalReclaimSessionId = null;
    }
    const changed = this.activeSessionId !== canonicalId || this.resumeSessionId !== canonicalId;
    this.localResumeSessionId = canonicalId;
    this.activeSessionId = canonicalId;
    this.resumeSessionId = canonicalId;
    this.sdkSessionId = null;
    this.remoteSdkSessionId = null;
    this.applyStoredContextUsageForSession(canonicalId);
    if (!changed) return canonicalId;
    this.emitState();
    return canonicalId;
  }

  markLocalBusy(): void {
    this.setBusy(true);
    this.setThinking(true);
  }

  markLocalIdle(): void {
    this.setThinking(false);
    this.setBusy(false);
  }

  async takeover(): Promise<void> {
    if (this.ownerValue === "web") {
      this.emitSlashCommands();
      void this.hydrateCapabilities({
        owner: "web",
        generation: this.remoteLoopGeneration,
      });
      return;
    }
    if (this.ownerValue !== "local") {
      throw Object.assign(new Error("local Claude owner is not available"), {
        statusCode: 409,
      });
    }
    if (this.busyValue || this.thinkingValue) {
      throw Object.assign(new Error("local Claude is busy"), {
        statusCode: 409,
      });
    }

    this.suppressNextLocalExit = true;
    const oldLocal = this.local;
    this.local = null;
    try {
      oldLocal?.kill("SIGTERM");
    } catch {}

    this.ownerValue = "web";
    this.reclaimingToLocal = false;
    this.pendingLocalReclaimSessionId = null;
    this.localSessionAliases.clear();
    this.emitState();
    process.stderr.write(
      `\n[adit cloud claude] Web has taken over Claude Code. Type ${RECLAIM_COMMAND} here to reclaim local control.\n`,
    );
    this.attachReclaimInput();
    const generation = ++this.remoteLoopGeneration;
    void this.runRemoteLoop(generation);
    // Publish whatever we already know right away so the web slash-command
    // popup is usable while the probe spawns; the probe result replaces it.
    if (this.slashCommandsByName.size === 0) {
      this.applyClaudeCapabilitySnapshot({ commands: [] });
    } else {
      this.emitSlashCommands();
    }
    void this.hydrateCapabilities({ owner: "web", generation });
  }

  async releaseToLocal(): Promise<void> {
    if (this.ownerValue !== "web") return;
    if (this.reclaimingToLocal) return;
    this.reclaimingToLocal = true;
    this.detachReclaimInput();
    this.stopCapabilityProbe();
    process.stderr.write("\n[adit cloud claude] releasing Web control back to local Claude CLI...\n");
    this.remoteLoopGeneration++;
    await this.finishActiveRunAsAborted({
      errorMessage: "Web control released to local CLI",
      eventMessage: "Web control released to local CLI.",
      interruptRemote: true,
    });
    this.mergeRemoteTranscriptsIntoActive();
    const resumeId = this.pickLocalResumeSessionId();
    this.pendingLocalReclaimSessionId = resumeId;
    if (resumeId) {
      this.localResumeSessionId = resumeId;
      this.activeSessionId = resumeId;
      this.resumeSessionId = resumeId;
      this.sdkSessionId = null;
      this.remoteSdkSessionId = null;
      this.applyStoredContextUsageForSession(resumeId);
    } else {
      this.localResumeSessionId = null;
      this.activeSessionId = null;
      this.resumeSessionId = null;
      this.sdkSessionId = null;
      this.remoteSdkSessionId = null;
      this.applyStoredContextUsageForSession(null);
    }
    this.startLocal(resumeId ? ["--resume", resumeId] : []);
  }

  async startNewSession(pendingSessionId?: string | null): Promise<void> {
    if (this.ownerValue !== "web") {
      throw Object.assign(new Error("Web has not taken over this Claude session"), {
        statusCode: 409,
      });
    }
    const generation = ++this.remoteLoopGeneration;
    await this.finishActiveRunAsAborted({
      errorMessage: "Claude session switched",
      eventMessage: "Claude session switched.",
      interruptRemote: true,
    });
    const pendingId = readString(pendingSessionId);
    this.pendingLocalReclaimSessionId = null;
    this.localSessionAliases.clear();
    this.localResumeSessionId = null;
    this.activeSessionId = pendingId;
    this.resumeSessionId = null;
    this.sdkSessionId = null;
    this.remoteSdkSessionId = null;
    this.applyStoredContextUsageForSession(null);
    this.emitState();
    void this.runRemoteLoop(generation);
  }

  async switchSession(sessionId: string): Promise<void> {
    if (!isUuid(sessionId)) {
      throw Object.assign(new Error("Claude session not found for this project"), {
        statusCode: 404,
      });
    }

    const hasLocalTranscript = isValidClaudeSession(sessionId, this.opts.cwd);
    if (hasLocalTranscript) this.localResumeSessionId = sessionId;
    if (!hasLocalTranscript && this.ownerValue !== "web") {
      throw Object.assign(new Error("Claude session not found for this project"), {
        statusCode: 404,
      });
    }

    if (this.ownerValue === "web") {
      const generation = ++this.remoteLoopGeneration;
      await this.finishActiveRunAsAborted({
        errorMessage: "Claude session switched",
        eventMessage: "Claude session switched.",
        interruptRemote: true,
      });
      this.activeSessionId = sessionId;
      this.resumeSessionId = sessionId;
      this.sdkSessionId = null;
      this.remoteSdkSessionId = null;
      this.applyStoredContextUsageForSession(sessionId);
      this.emitState();
      void this.runRemoteLoop(generation);
      return;
    }

    this.activeSessionId = sessionId;
    this.resumeSessionId = sessionId;
    this.sdkSessionId = null;
    this.remoteSdkSessionId = null;
    this.applyStoredContextUsageForSession(sessionId);
    this.emitState();

    if (this.ownerValue === "local") {
      this.suppressNextLocalExit = true;
      const oldLocal = this.local;
      this.local = null;
      try {
        oldLocal?.kill("SIGTERM");
      } catch {}
      this.startLocal(["--resume", sessionId]);
      return;
    }
  }

  async sendPrompt(
    prompt: string,
    opts: {
      mode?: CliPromptMode;
      pendingSessionId?: string | null;
      localMessageId?: string | null;
      attachments?: PromptImageAttachment[];
    } = {},
  ): Promise<void> {
    if (this.ownerValue !== "web") {
      throw Object.assign(new Error("Web has not taken over this Claude session"), {
        statusCode: 409,
      });
    }
    const trimmed = prompt.trim();
    const attachments = opts.attachments ?? [];
    if (!trimmed && attachments.length === 0) return;
    await new Promise<void>((resolve, reject) => {
      this.promptQueue.push({
        message: trimmed,
        attachments,
        mode: opts.mode === "plan" ? "plan" : "build",
        pendingSessionId: opts.pendingSessionId ?? null,
        localMessageId: opts.localMessageId ?? null,
        promptEvent: {
          text: trimmed,
          attachments,
          ...(opts.localMessageId ? { messageId: opts.localMessageId } : {}),
          mode: opts.mode === "plan" ? "plan" : "build",
          createdAt: Date.now(),
        },
        resolve,
        reject,
      });
      this.drainPromptResolvers();
    });
  }

  async steerPrompt(
    prompt: string,
    opts: {
      sessionId?: string | null;
      localMessageId?: string | null;
      mode?: CliPromptMode;
      attachments?: PromptImageAttachment[];
    } = {},
  ): Promise<void> {
    if (this.ownerValue !== "web") {
      throw Object.assign(new Error("Web has not taken over this Claude session"), {
        statusCode: 409,
      });
    }
    const trimmed = prompt.trim();
    const attachments = opts.attachments ?? [];
    if (!trimmed && attachments.length === 0) return;
    const input = this.activePromptInput;
    if (
      !input ||
      input.generation !== this.remoteLoopGeneration ||
      !this.remoteQuery ||
      input.stream.isClosed() ||
      (!this.busyValue && !this.thinkingValue)
    ) {
      throw Object.assign(new Error("Claude Code is not currently accepting steering input"), {
        statusCode: 409,
      });
    }
    if (opts.sessionId && !this.acceptsSteerSessionId(opts.sessionId, input)) {
      throw Object.assign(new Error("Claude Code is running a different session"), {
        statusCode: 409,
      });
    }

    const sessionId =
      (opts.sessionId && !opts.sessionId.startsWith("pending_") ? opts.sessionId : null) ??
      this.activeSessionId ??
      this.resumeSessionId ??
      input.displaySessionId ??
      this.sdkSessionId ??
      this.remoteSdkSessionId ??
      "pending";
    const sdkSessionId = this.remoteSdkSessionId ??
      this.sdkSessionId ??
      Array.from(input.acceptedSessionIds).find(isUuid);
    input.stream.push(toUserMessage(trimmed, attachments, sdkSessionId ?? undefined, {
      priority: "now",
      shouldQuery: true,
    }));
    input.submittedTurnCount += 1;
    this.pushEvent("message", {
      role: "user",
      sessionId,
      ...(opts.localMessageId ? { messageId: opts.localMessageId } : {}),
      text: trimmed,
      attachments,
      inputKind: "steer",
      mode: opts.mode ?? this.activePromptMode ?? "build",
      createdAt: Date.now(),
    });
  }

  async handleSlashCommand(command: CliSlashCommand): Promise<void> {
    const name = command.name.trim().replace(/^\//, "");
    if (!name) return;
    const normalized = name.toLowerCase();

    if (normalized === "mcp") {
      this.pushNotice({
        title: "/mcp",
        text: formatClaudeMcpServers(this.mcpServers),
        sessionId: command.sessionId,
      });
      return;
    }

    if (normalized === "skills") {
      this.pushNotice({
        title: "/skills",
        text: formatClaudeSkills(this.skills, this.slashCommandsByName),
        sessionId: command.sessionId,
        data: {
          noticeKind: "skills",
          provider: this.provider,
          skills: this.skills.map((name) => ({
            name,
            enabled: true,
          })),
        },
      });
      return;
    }

    if (normalized === "rewind") {
      this.requestRewind(command.sessionId);
      return;
    }

    if (!this.slashCommandsByName.has(normalized)) {
      throw Object.assign(
        new Error(`Claude Code did not expose /${name} for this Cloud session.`),
        { statusCode: 400 },
      );
    }

    await this.sendPrompt(command.raw.startsWith("/") ? command.raw : `/${command.raw}`, {
      mode: "build",
      pendingSessionId: command.pendingSessionId ?? pendingSessionIdFromSlashCommand(command),
      localMessageId: command.localMessageId ?? null,
    });
  }

  private requestRewind(sessionIdInput?: string | null): void {
    const sessionId = sessionIdInput ?? this.activeSessionId ?? this.resumeSessionId ?? this.sdkSessionId;
    if (!sessionId || !isValidClaudeSession(sessionId, this.opts.cwd)) {
      this.pushNotice({
        title: "/rewind",
        text: "Claude Code does not have an active session that can be rewound.",
        sessionId,
      });
      return;
    }

    const checkpoints = readClaudeRewindCheckpoints(this.opts.cwd, sessionId, 30);
    if (checkpoints.length === 0) {
      this.pushNotice({
        title: "/rewind",
        text: "No Claude Code user messages were found for this session.",
        sessionId,
      });
      return;
    }

    const id = `rewind-${randomUUID()}`;
    this.pendingRewinds.set(id, { id, sessionId, checkpoints });
    this.pushEvent("rewind.requested", {
      id,
      sessionId,
      checkpoints,
      createdAt: Date.now(),
    });
  }

  async answerRewind(response: CliRewindResponse): Promise<void> {
    const pending = this.pendingRewinds.get(response.id);
    if (response.rejected) {
      if (pending) this.pendingRewinds.delete(response.id);
      this.pushEvent("rewind.rejected", {
        id: response.id,
        sessionId: pending?.sessionId ?? response.sessionId,
        createdAt: Date.now(),
      });
      return;
    }

    const sessionId = response.sessionId ?? pending?.sessionId;
    const userMessageId = response.userMessageId;
    if (!sessionId || !userMessageId) {
      throw Object.assign(new Error("rewind sessionId and userMessageId are required"), {
        statusCode: 400,
      });
    }
    if (this.busyValue) {
      throw Object.assign(new Error("Claude Code is busy; wait for the current run before rewinding."), {
        statusCode: 409,
      });
    }

    const result = await this.runRewindFiles(sessionId, userMessageId, response.dryRun === true);
    const checkpoint = pending?.checkpoints.find((item) => item.messageId === userMessageId);
    if (response.dryRun !== true) {
      this.pendingRewinds.delete(response.id);
    }
    this.pushEvent("rewind.completed", {
      id: response.id,
      sessionId,
      userMessageId,
      dryRun: response.dryRun === true,
      checkpoint,
      result,
      createdAt: Date.now(),
    });
    this.pushNotice({
      title: response.dryRun === true ? "Rewind preview" : "Rewind files",
      text: formatRewindResult(result, response.dryRun === true, checkpoint?.files),
      sessionId,
    });
  }

  private async runRewindFiles(
    sessionId: string,
    userMessageId: string,
    dryRun: boolean,
  ): Promise<{
    canRewind: boolean;
    error?: string;
    filesChanged?: string[];
    insertions?: number;
    deletions?: number;
  }> {
    const abortController = new AbortController();
    const rewindQuery = query({
      prompt: this.createCapabilityProbeStream(abortController.signal),
      options: {
        cwd: this.opts.cwd,
        pathToClaudeCodeExecutable: this.opts.bin,
        spawnClaudeCodeProcess: spawnClaudeCliProcess,
        env: this.buildEnv(),
        settings: this.opts.hookSettingsPath,
        resume: sessionId,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        forkSession: false,
        enableFileCheckpointing: true,
        abortController,
        includePartialMessages: false,
        forwardSubagentText: false,
      },
    });

    try {
      await rewindQuery.supportedCommands().catch(() => [] as SlashCommand[]);
      return await rewindQuery.rewindFiles(userMessageId, { dryRun });
    } finally {
      abortController.abort();
      try {
        rewindQuery.close?.();
      } catch {}
    }
  }

  async answerPermission(
    id: string,
    approved: boolean,
    reason?: string,
  ): Promise<void> {
    const pending = this.pendingPermissions.get(id);
    if (!pending) {
      throw Object.assign(new Error("permission request not found"), {
        statusCode: 404,
      });
    }
    this.pendingPermissions.delete(id);
    this.pushEvent("permission-resolved", { id, approved });
    const result: PermissionResult = approved
      ? {
          behavior: "allow",
          updatedInput: asRecord(pending.request.input),
          toolUseID: id,
        }
      : {
          behavior: "deny",
          message: reason || "The user rejected this tool use from adit-cloud.",
          toolUseID: id,
        };
    if (pending.request.toolName === EXIT_PLAN_MODE_TOOL) {
      this.pushEvent("plan.approval.resolved", {
        id,
        requestID: id,
        approved,
        sessionId: this.activeSessionId ?? this.resumeSessionId,
      });
    }
    pending.resolve(result);
  }

  async answerQuestion(response: CliQuestionResponse): Promise<void> {
    const pending = this.pendingQuestions.get(response.id);
    if (!pending) {
      const pendingPermission = this.pendingPermissions.get(response.id);
      if (pendingPermission?.request.toolName === ASK_USER_QUESTION_TOOL) {
        this.pendingPermissions.delete(response.id);
        this.resolveAskUserQuestionPermission(response, pendingPermission.request, pendingPermission.resolve);
        return;
      }
      throw Object.assign(new Error("question request not found"), {
        statusCode: 404,
      });
    }
    this.pendingQuestions.delete(response.id);

    this.resolveAskUserQuestionPermission(response, pending.request, pending.resolve);
  }

  private resolveAskUserQuestionPermission(
    response: CliQuestionResponse,
    request: { id: string; input: unknown },
    resolve: (result: PermissionResult) => void,
  ): void {
    if (response.rejected) {
      this.pushEvent("question.rejected", {
        id: response.id,
        requestID: response.id,
      });
      resolve({
        behavior: "deny",
        message: "The user ignored this question from adit-cloud.",
        toolUseID: response.id,
      });
      return;
    }

    const inputRecord = asRecord(request.input);
    const questions = normalizeQuestionInput(inputRecord);
    const answers = buildQuestionAnswerMap(questions, response.answers);
    this.pushEvent("question.replied", {
      id: response.id,
      requestID: response.id,
    });
    resolve({
      behavior: "allow",
      updatedInput: {
        ...inputRecord,
        answers,
      },
      toolUseID: response.id,
    });
  }

  async abort(): Promise<void> {
    if (this.ownerValue !== "web") return;
    await this.finishActiveRunAsAborted({
      errorMessage: "Claude run aborted",
      eventMessage: "Claude run aborted.",
      interruptRemote: true,
    });
  }

  stop(): void {
    this.finishActiveRunAsAborted({
      errorMessage: "Claude provider stopped",
      eventMessage: "Claude provider stopped.",
      interruptRemote: false,
    });
    this.stopCapabilityProbe();
    this.pendingRewinds.clear();
    this.detachReclaimInput();
    this.pendingLocalReclaimSessionId = null;
    this.localSessionAliases.clear();
    try {
      this.local?.kill("SIGTERM");
    } catch {}
    this.local = null;
    this.ownerValue = "stopped";
    this.setThinking(false);
    this.setBusy(false);
    this.emitState();
  }

  private startLocal(extraArgs: string[] = []): void {
    this.detachReclaimInput();
    this.stopCapabilityProbe();
    this.reclaimingToLocal = false;
    this.finishWebPrompts(new Error("local mode active"));
    this.remoteQuery = null;
    this.remoteAbortController = null;
    const configuredArgs = this.activeModelId
      ? stripClaudeModelArgs(this.opts.args)
      : this.opts.args;
    const args = [
      ...extraArgs,
      ...configuredArgs,
      ...(this.activeModelId ? ["--model", this.activeModelId] : []),
      ...(this.opts.hookSettingsPath ? ["--settings", this.opts.hookSettingsPath] : []),
    ];
    const child = spawnCliProcess(this.opts.bin, args, {
      cwd: this.opts.cwd,
      env: this.buildEnv(),
      stdio: "inherit",
    });
    this.local = child;
    this.ownerValue = "local";
    this.emitState();
    void this.hydrateCapabilities({ owner: "local", child });

    child.on("error", (error) => {
      this.pushEvent("error", { message: error.message });
      process.stderr.write(`\n[adit cloud claude] failed to start Claude CLI: ${error.message}\n`);
      if (this.local === child) {
        this.local = null;
        this.ownerValue = "stopped";
        this.emitState();
        this.emit("exit", { code: null, signal: null });
      }
    });
    child.on("exit", (code, signal) => {
      this.setThinking(false);
      this.setBusy(false);
      if (this.suppressNextLocalExit) {
        this.suppressNextLocalExit = false;
        return;
      }
      if (this.local === child) {
        this.local = null;
        this.ownerValue = "stopped";
        this.emitState();
        this.emit("exit", { code, signal });
      }
    });
  }

  private async hydrateCapabilities(target: CapabilityHydrateTarget): Promise<void> {
    if (!this.isCapabilityHydrateTargetCurrent(target)) return;
    this.stopCapabilityProbe();
    if (!this.isCapabilityHydrateTargetCurrent(target)) return;
    const hydrateGeneration = ++this.capabilityHydrateGeneration;
    this.capabilityHydratePending = true;
    const abortController = new AbortController();
    this.capabilityProbeAbortController = abortController;
    const probe = query({
      prompt: this.createCapabilityProbeStream(abortController.signal),
      options: {
        cwd: this.opts.cwd,
        pathToClaudeCodeExecutable: this.opts.bin,
        spawnClaudeCodeProcess: spawnClaudeCliProcess,
        env: this.buildEnv(),
        settings: this.opts.hookSettingsPath,
        permissionMode: "plan",
        forkSession: false,
        abortController,
        includePartialMessages: false,
        forwardSubagentText: false,
      },
    });
    this.capabilityProbeQuery = probe;

    try {
      const probeTimeout = setTimeout(() => abortController.abort(), CAPABILITY_PROBE_TIMEOUT_MS);
      let commands: SlashCommand[];
      let mcpServers: unknown[];
      try {
        [commands, mcpServers] = await Promise.all([
          probe.supportedCommands().catch(() => [] as SlashCommand[]),
          probe.mcpServerStatus().catch(() => [] as unknown[]),
        ]);
      } finally {
        clearTimeout(probeTimeout);
      }
      if (
        !this.isCapabilityHydrateTargetCurrent(target) ||
        this.capabilityHydrateGeneration !== hydrateGeneration ||
        this.capabilityProbeQuery !== probe
      ) {
        return;
      }
      const nextCommands = commands.map(commandInfoFromClaudeSlashCommand);
      this.applyClaudeCapabilitySnapshot({
        // A timed-out or failed probe yields no commands; keep a previously
        // hydrated table instead of downgrading it to the native fallback.
        ...(nextCommands.length > 0 || this.slashCommandsByName.size === 0
          ? { commands: nextCommands }
          : {}),
        mcpServers: mcpServers.map((server) => ({
          name: readString(asRecord(server).name) ?? "",
          status: readString(asRecord(server).status) ?? "unknown",
        })).filter((server) => server.name.length > 0),
      });
    } catch (error) {
      if (!abortController.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`\n[adit cloud claude] capability hydrate failed: ${message}\n`);
      }
    } finally {
      if (this.capabilityProbeQuery === probe) {
        this.capabilityProbeQuery = null;
      }
      if (this.capabilityProbeAbortController === abortController) {
        this.capabilityProbeAbortController = null;
      }
      abortController.abort();
      try {
        probe.close();
      } catch {}
    }
  }

  private stopCapabilityProbe(): void {
    this.capabilityHydrateGeneration += 1;
    this.capabilityProbeAbortController?.abort();
    try {
      this.capabilityProbeQuery?.close?.();
    } catch {}
    this.capabilityProbeQuery = null;
    this.capabilityProbeAbortController = null;
  }

  private async runRemoteLoop(generation: number): Promise<void> {
    while (this.ownerValue === "web" && this.remoteLoopGeneration === generation) {
      let first: QueuedSdkPrompt | null;
      try {
        first = await this.nextPrompt();
      } catch {
        return;
      }
      if (!first || this.ownerValue !== "web" || this.remoteLoopGeneration !== generation) return;

      this.stopCapabilityProbe();
      const pendingSessionId = first.pendingSessionId;
      const pendingClaudeSessionId = pendingSessionId ? randomUUID() : null;
      const canonicalSessionId = pendingSessionId
        ? pendingClaudeSessionId
        : this.activeSessionId ?? this.resumeSessionId;
      const resumeId = pendingSessionId
        ? null
        : this.pickResumeSessionId({ fallbackToLatest: false });
      const abortController = new AbortController();
      this.remoteAbortController = abortController;
      this.startingPrompt = first;
      this.activePromptEvent = first.promptEvent;
      this.activePromptMode = first.mode;
      this.toolUseById.clear();
      this.lastAssistantTailKind = null;
      this.partialAssistantStreams.clear();
      this.streamedTextMessageIds.clear();
      this.thinkingPartTracker.clear();
      const permissionMode: PermissionMode = first.mode === "plan" ? "plan" : "bypassPermissions";
      const disallowedTools = first.mode === "build" ? [ASK_USER_QUESTION_TOOL] : undefined;
      const explicitSessionId = !resumeId && canonicalSessionId && isUuid(canonicalSessionId)
        ? canonicalSessionId
        : undefined;
      const promptInput = new PushableSdkPromptStream(
        toUserMessage(first.message, first.attachments, pendingClaudeSessionId ?? undefined),
      );
      this.activePromptInput = {
        generation,
        displaySessionId: pendingSessionId ?? canonicalSessionId ?? resumeId,
        acceptedSessionIds: new Set(
          [
            pendingSessionId,
            pendingClaudeSessionId,
            canonicalSessionId,
            resumeId,
            this.activeSessionId,
            this.resumeSessionId,
            this.sdkSessionId,
            this.remoteSdkSessionId,
          ].filter((id): id is string => Boolean(id)),
        ),
        stream: promptInput,
        submittedTurnCount: 1,
        completedResultCount: 0,
      };
      const options: Options = {
        cwd: this.opts.cwd,
        pathToClaudeCodeExecutable: this.opts.bin,
        spawnClaudeCodeProcess: spawnClaudeCliProcess,
        env: this.buildEnv(),
        ...(this.activeModelId ? { model: this.activeModelId } : {}),
        resume: resumeId ?? undefined,
        sessionId: explicitSessionId,
        settings: this.opts.hookSettingsPath,
        systemPrompt: CLAUDE_CLOUD_WEB_SYSTEM_PROMPT,
        permissionMode,
        ...(disallowedTools ? { disallowedTools } : {}),
        ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
        forkSession: false,
        enableFileCheckpointing: true,
        abortController,
        includePartialMessages: true,
        forwardSubagentText: true,
        ...(permissionMode === "bypassPermissions"
          ? {}
          : {
              canUseTool: (toolName, input, requestOptions) =>
                this.handleToolPermission(
                  toolName,
                  input,
                  requestOptions.toolUseID,
                  requestOptions.signal,
                ),
            }),
      };

      try {
        this.remoteQuery = query({
          prompt: promptInput,
          options,
        });
        this.setBusy(true);
        this.setThinking(true);
        this.emitState();
        this.scheduleContextUsageRefresh(true);
        this.resolveStartingPrompt(first);
      } catch (error) {
        promptInput.fail(error instanceof Error ? error : new Error(String(error)));
        if (this.activePromptInput?.stream === promptInput) {
          this.activePromptInput = null;
        }
        this.rejectStartingPrompt(first, error instanceof Error ? error : new Error(String(error)));
        if (!(error instanceof AbortError)) {
          const messageText = error instanceof Error ? error.message : String(error);
          this.pushEvent("error", { message: messageText });
          process.stderr.write(`\n[adit cloud claude] SDK error: ${messageText}\n`);
        }
        this.setThinking(false);
        this.setBusy(false);
        this.remoteQuery = null;
        this.remoteAbortController = null;
        continue;
      }

      let observedSdkSessionId: string | null = null;
      let sawResult = false;
      let sawStreamError = false;
      try {
        for await (const message of this.remoteQuery) {
          if (this.remoteLoopGeneration !== generation) break;
          const sdkSessionId = await this.handleSdkMessage(message, canonicalSessionId ?? resumeId, {
            suppressActiveFallback: Boolean(pendingSessionId),
          });
          this.scheduleContextUsageRefresh(message.type === "result");
          if (message.type === "result") {
            sawResult = true;
            const activeInput = this.activePromptInput?.stream === promptInput
              ? this.activePromptInput
              : null;
            if (activeInput) {
              activeInput.completedResultCount += 1;
              if (activeInput.completedResultCount >= activeInput.submittedTurnCount) {
                promptInput.close();
              }
            } else {
              promptInput.close();
            }
          }
          const boundSessionId = sdkSessionId ?? pendingClaudeSessionId;
          if (pendingSessionId && boundSessionId) {
            this.bindPendingSession(pendingSessionId, boundSessionId);
          }
          if (
            sdkSessionId &&
            canonicalSessionId &&
            sdkSessionId !== canonicalSessionId
          ) {
            observedSdkSessionId = sdkSessionId;
          }
        }
      } catch (error) {
        sawStreamError = true;
        if (this.startingPrompt === first) {
          this.rejectStartingPrompt(first, error instanceof Error ? error : new Error(String(error)));
        }
        if (!(error instanceof AbortError)) {
          const messageText = error instanceof Error ? error.message : String(error);
          this.pushEvent("error", { message: messageText });
          process.stderr.write(`\n[adit cloud claude] SDK error: ${messageText}\n`);
        }
      } finally {
        if (
          !sawResult &&
          !sawStreamError &&
          this.ownerValue === "web" &&
          this.remoteLoopGeneration === generation &&
          !abortController.signal.aborted
        ) {
          this.pushEvent("error", {
            title: "Claude run ended unexpectedly",
            message: "The Claude Code process ended before reporting a result. The run was likely cut off — send a new prompt to continue.",
            sessionId: this.currentRunSessionId() ?? canonicalSessionId ?? resumeId ?? undefined,
            ...(this.activeModelId ? { modelId: this.activeModelId } : {}),
            mode: this.activePromptMode ?? first.mode,
            createdAt: Date.now(),
          });
        }
        const normalizeRelatedTranscripts = () => {
          const sessionIds = new Set(
            [
              pendingClaudeSessionId,
              canonicalSessionId,
              resumeId,
              observedSdkSessionId,
              this.activeSessionId,
              this.resumeSessionId,
              this.sdkSessionId,
              this.remoteSdkSessionId,
            ].filter((id): id is string => Boolean(id)),
          );
          for (const sessionId of sessionIds) {
            normalizeClaudeSdkTranscriptEntrypoints({
              cwd: this.opts.cwd,
              sessionId,
            });
          }
        };
        normalizeRelatedTranscripts();
        if (!pendingSessionId) {
          this.mergeRemoteTranscriptsIntoActive(canonicalSessionId, observedSdkSessionId);
          normalizeRelatedTranscripts();
        }
        if (this.activePromptEvent === first.promptEvent) {
          this.activePromptEvent = null;
        }
        if (this.activePromptMode === first.mode) {
          this.activePromptMode = null;
        }
        if (this.startingPrompt === first) {
          this.rejectStartingPrompt(first, new Error("Claude run ended before it started"));
        }
        promptInput.close();
        if (this.activePromptInput?.stream === promptInput) {
          this.activePromptInput = null;
        }
        this.setThinking(false);
        this.setBusy(false);
        this.remoteQuery = null;
        this.remoteAbortController = null;
        // Starting this run may have aborted the capability probe before it
        // delivered a snapshot (and a failed run never sends the SDK init
        // message that would replace it) — settle the debt now.
        if (
          this.capabilityHydratePending &&
          this.ownerValue === "web" &&
          this.remoteLoopGeneration === generation
        ) {
          void this.hydrateCapabilities({ owner: "web", generation });
        }
      }
    }
  }

  private isCapabilityHydrateTargetCurrent(target: CapabilityHydrateTarget): boolean {
    if (target.owner === "web") {
      return this.ownerValue === "web" && this.remoteLoopGeneration === target.generation;
    }
    return this.ownerValue === "local" && this.local === target.child;
  }

  private async *createCapabilityProbeStream(
    signal: AbortSignal,
  ): AsyncIterable<SDKUserMessage> {
    if (!signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }

  private nextPrompt(): Promise<QueuedSdkPrompt | null> {
    if (this.promptQueue.length > 0) {
      const item = this.promptQueue.shift();
      if (!item) return Promise.resolve(null);
      return Promise.resolve({
        message: item.message,
        attachments: item.attachments,
        mode: item.mode,
        pendingSessionId: item.pendingSessionId,
        localMessageId: item.localMessageId,
        promptEvent: item.promptEvent,
        resolve: item.resolve,
        reject: item.reject,
      });
    }
    return new Promise((resolve) => {
      this.promptResolvers.push(resolve);
    });
  }

  private drainPromptResolvers(): void {
    while (this.promptResolvers.length > 0 && this.promptQueue.length > 0) {
      const resolve = this.promptResolvers.shift();
      const item = this.promptQueue.shift();
      if (!resolve || !item) return;
      resolve({
        message: item.message,
        attachments: item.attachments,
        mode: item.mode,
        pendingSessionId: item.pendingSessionId,
        localMessageId: item.localMessageId,
        promptEvent: item.promptEvent,
        resolve: item.resolve,
        reject: item.reject,
      });
    }
  }

  private finishWebPrompts(error: Error): void {
    this.activePromptEvent = null;
    this.activePromptMode = null;
    this.activePromptInput?.stream.close();
    this.activePromptInput = null;
    this.toolUseById.clear();
    this.lastAssistantTailKind = null;
    this.partialAssistantStreams.clear();
    this.streamedTextMessageIds.clear();
    this.thinkingPartTracker.clear();
    if (this.startingPrompt) {
      this.startingPrompt.reject(error);
      this.startingPrompt = null;
    }
    for (const item of this.promptQueue.splice(0)) {
      item.reject(error);
    }
    for (const resolve of this.promptResolvers.splice(0)) {
      resolve(null);
    }
    this.pendingRewinds.clear();
  }

  private resolveStartingPrompt(prompt: QueuedSdkPrompt): void {
    if (this.startingPrompt !== prompt) return;
    this.startingPrompt = null;
    prompt.resolve();
  }

  private rejectStartingPrompt(prompt: QueuedSdkPrompt, error: Error): void {
    if (this.startingPrompt !== prompt) return;
    this.startingPrompt = null;
    prompt.reject(error);
  }

  private rejectPendingRequests(error: Error): void {
    const hadPendingRequests = this.pendingPermissions.size > 0 || this.pendingQuestions.size > 0;
    for (const pending of this.pendingPermissions.values()) {
      this.emitPendingToolError(pending.request, error.message);
      pending.reject(error);
    }
    this.pendingPermissions.clear();
    for (const pending of this.pendingQuestions.values()) {
      this.emitPendingToolError({
        id: pending.request.id,
        toolName: ASK_USER_QUESTION_TOOL,
        input: pending.request.input,
        createdAt: pending.request.createdAt,
      }, error.message);
      pending.reject(error);
    }
    this.pendingQuestions.clear();
    if (!hadPendingRequests) return;
    this.pushEvent("permission-resolved", { id: "all", approved: false });
    this.pushEvent("question.rejected", { id: "all" });
  }

  private emitPendingToolError(
    request: CliPermissionRequest & { toolName: string },
    message: string,
  ): void {
    const sessionId = this.activeSessionId ??
      this.resumeSessionId ??
      this.sdkSessionId ??
      this.remoteSdkSessionId;
    const createdAt = Date.now();
    this.pushEvent("tool", {
      ...(sessionId ? { sessionId } : {}),
      messageId: sessionId
        ? this.lastAssistantMessageBySession.get(sessionId) ?? `cli-tool-${request.id}`
        : `cli-tool-${request.id}`,
      toolUseId: request.id,
      toolName: request.toolName,
      input: request.input && typeof request.input === "object" && !Array.isArray(request.input)
        ? request.input
        : {},
      tool_scope: claudeToolScope(request.toolName, this.activePromptMode, request.input),
      mode: this.activePromptMode ?? undefined,
      error: message,
      status: "error",
      createdAt,
    });
  }

  private currentRunSessionId(): string | null {
    return this.activeSessionId ??
      this.resumeSessionId ??
      this.sdkSessionId ??
      this.remoteSdkSessionId ??
      this.activePromptInput?.displaySessionId ??
      null;
  }

  private hasActiveWebRun(): boolean {
    return this.ownerValue === "web" && (
      this.busyValue ||
      this.thinkingValue ||
      this.remoteQuery !== null ||
      this.remoteAbortController !== null ||
      this.activePromptInput !== null ||
      this.activePromptEvent !== null ||
      this.startingPrompt !== null ||
      this.pendingPermissions.size > 0 ||
      this.pendingQuestions.size > 0
    );
  }

  private finishActiveRunAsAborted(input: {
    errorMessage: string;
    eventMessage: string;
    interruptRemote: false;
  }): void;
  private finishActiveRunAsAborted(input: {
    errorMessage: string;
    eventMessage: string;
    interruptRemote: true;
  }): Promise<void>;
  private finishActiveRunAsAborted(input: {
    errorMessage: string;
    eventMessage: string;
    interruptRemote: boolean;
  }): void | Promise<void> {
    const sessionId = this.currentRunSessionId();
    const hadActiveRun = this.hasActiveWebRun();
    const remoteQuery = this.remoteQuery;
    const error = new Error(input.errorMessage);

    this.finishWebPrompts(error);
    this.rejectPendingRequests(error);
    this.remoteAbortController?.abort();
    this.remoteQuery = null;
    this.remoteAbortController = null;
    this.setThinking(false);
    this.setBusy(false);

    const emitAbortEvent = () => {
      if (!hadActiveRun) return;
      this.pushEvent("run.aborted", {
        message: input.eventMessage,
        ...(sessionId ? { sessionId } : {}),
        createdAt: Date.now(),
      });
    };

    if (!input.interruptRemote) {
      try {
        remoteQuery?.close?.();
      } catch {}
      emitAbortEvent();
      return;
    }

    return (async () => {
      try {
        await remoteQuery?.interrupt?.();
      } catch {}
      try {
        remoteQuery?.close?.();
      } catch {}
      emitAbortEvent();
    })();
  }

  private acceptsSteerSessionId(
    sessionIdInput: string,
    input: ActiveClaudePromptInput,
  ): boolean {
    const sessionId = sessionIdInput.trim();
    if (!sessionId) return true;
    if (sessionId.startsWith("pending_")) return true;
    if (input.acceptedSessionIds.has(sessionId)) return true;
    return [
      this.activeSessionId,
      this.resumeSessionId,
      this.sdkSessionId,
      this.remoteSdkSessionId,
    ].some((id) => id === sessionId);
  }

  private sdkEventContext(): ClaudeSdkEventContext {
    return {
      activeModelId: () => this.activeModelId,
      activePromptMode: () => this.activePromptMode,
      ownerValue: () => this.ownerValue,
      remoteLoopGeneration: () => this.remoteLoopGeneration,
      remoteAbortSignalAborted: () => this.remoteAbortController?.signal.aborted === true,
      contextCompactionToolBySession: this.contextCompactionToolBySession,
      lastAssistantMessageBySession: this.lastAssistantMessageBySession,
      toolUseById: this.toolUseById,
      partialAssistantStreams: this.partialAssistantStreams,
      streamedTextMessageIds: this.streamedTextMessageIds,
      thinkingParts: this.thinkingPartTracker,
      pushEvent: (type, payload) => this.pushEvent(type, payload),
    };
  }

  private async handleSdkMessage(
    message: SDKMessage,
    canonicalSessionId: string | null,
    opts: { suppressActiveFallback?: boolean } = {},
  ): Promise<string | null> {
    const sdkSessionId = extractSessionId(message);
    if (sdkSessionId) {
      this.noteSdkSession(sdkSessionId, {
        keepActiveSession: Boolean(canonicalSessionId && sdkSessionId !== canonicalSessionId),
        preserveResumeSession: opts.suppressActiveFallback === true,
      });
    }
    const sessionId =
      (opts.suppressActiveFallback ? sdkSessionId : null) ??
      canonicalSessionId ??
      (opts.suppressActiveFallback ? null : this.activeSessionId) ??
      (opts.suppressActiveFallback ? null : this.resumeSessionId) ??
      sdkSessionId ??
      "pending";
    if (sdkSessionId) this.flushActivePromptEvent(sessionId);
    if (message.type === "system") {
      const subtype = readString((message as { subtype?: unknown }).subtype);
      if (subtype === "api_retry") {
        this.emitApiRetry(message as SDKAPIRetryMessage, sessionId);
        return sdkSessionId;
      }

      if (subtype === "status") {
        this.emitCompactStatus(message, sessionId);
        return sdkSessionId;
      }

      if (subtype === "compact_boundary") {
        this.emitCompactBoundary(message, sessionId);
        return sdkSessionId;
      }

      if ((message as SDKSystemMessage).subtype === "init") {
        const init = message as SDKSystemMessage;
        this.updateClaudeCapabilities(init);
        if (init.session_id) {
          this.noteSdkSession(init.session_id, {
            keepActiveSession: Boolean(canonicalSessionId && init.session_id !== canonicalSessionId),
            preserveResumeSession: opts.suppressActiveFallback === true,
          });
          this.flushActivePromptEvent(sessionId);
        }
        return sdkSessionId;
      }
    }

    if (message.type === "assistant") {
      this.noteAssistantTailKind(message as SDKAssistantMessage);
      await this.emitAssistantMessage(message as SDKAssistantMessage, sessionId);
      return sdkSessionId;
    }

    if (message.type === "stream_event") {
      this.emitPartialAssistantMessage(message as SDKPartialAssistantMessage, sessionId);
      return sdkSessionId;
    }

    if (message.type === "user") {
      this.emitToolResults(message as SDKUserMessage, sessionId);
      return sdkSessionId;
    }

    if (message.type === "result") {
      this.emitResultUsage(message, sessionId);
      this.emitResultError(message, sessionId);
      this.emitTruncatedTurnWarning(message, sessionId);
      this.lastAssistantTailKind = null;
    }
    return sdkSessionId;
  }

  // A turn must end with text or a tool call; ending on a bare thinking block
  // means the model stream was cut off upstream even though the SDK reports a
  // successful result (observed with unstable Anthropic-compatible relays).
  private noteAssistantTailKind(message: SDKAssistantMessage): void {
    if (readString((message as { parent_tool_use_id?: unknown }).parent_tool_use_id)) return;
    const content = message.message?.content;
    if (!Array.isArray(content)) return;
    for (const part of content as unknown as Array<Record<string, unknown>>) {
      if (part.type === "thinking") {
        if (typeof part.thinking === "string" && part.thinking.trim()) {
          this.lastAssistantTailKind = "thinking";
        }
      } else if (part.type === "text") {
        if (typeof part.text === "string" && part.text.trim()) {
          this.lastAssistantTailKind = "other";
        }
      } else if (
        part.type === "tool_use" ||
        part.type === "server_tool_use" ||
        part.type === "tool_result"
      ) {
        this.lastAssistantTailKind = "other";
      }
    }
  }

  private emitTruncatedTurnWarning(message: SDKMessage, sessionId: string): void {
    if (this.lastAssistantTailKind !== "thinking") return;
    const result = message as { subtype?: unknown; is_error?: unknown };
    const subtype = readString(result.subtype);
    if (result.is_error === true || Boolean(subtype?.startsWith("error_"))) return;
    this.pushEvent("error", {
      title: "Claude reply may be truncated",
      message: "The turn ended right after a thinking block, without any reply or tool call — the model stream was likely cut off. Send a follow-up prompt to continue.",
      sessionId,
      ...(this.activeModelId ? { modelId: this.activeModelId } : {}),
      mode: this.activePromptMode ?? undefined,
      createdAt: Date.now(),
    });
  }
  private emitCompactStatus(message: SDKMessage, sessionId: string): void {
    emitClaudeCompactStatus(message, sessionId, this.sdkEventContext());
  }

  private emitCompactBoundary(message: SDKMessage, sessionId: string): void {
    emitClaudeCompactBoundary(message, sessionId, this.sdkEventContext());
  }




  private updateClaudeCapabilities(init: SDKSystemMessage): void {
    const commands = Array.isArray(init.slash_commands)
      ? init.slash_commands
          .filter((command): command is string => typeof command === "string" && command.trim().length > 0)
          .map((command) => commandInfoFromClaudeSlashName(command.trim().replace(/^\//, "")))
      : [];
    this.applyClaudeCapabilitySnapshot({
      commands,
      mcpServers: Array.isArray(init.mcp_servers)
        ? init.mcp_servers
            .map((server) => ({
              name: typeof server.name === "string" ? server.name : "",
              status: typeof server.status === "string" ? server.status : "unknown",
            }))
            .filter((server) => server.name.length > 0)
        : [],
      skills: Array.isArray(init.skills)
        ? init.skills.filter((skill): skill is string => typeof skill === "string" && skill.length > 0)
        : [],
    });
  }

  private applyClaudeCapabilitySnapshot(input: {
    commands?: CliSlashCommandInfo[];
    mcpServers?: Array<{ name: string; status: string }>;
    skills?: string[];
  }): void {
    this.capabilityHydratePending = false;
    if (input.mcpServers) this.mcpServers = input.mcpServers;
    if (input.skills) this.skills = input.skills;
    if (input.commands !== undefined) {
      this.slashCommandsByName = new Map(
        withClaudeCloudNativeSlashCommands(input.commands)
          .map((command) => [command.name.toLowerCase(), command]),
      );
    }
    this.emitSlashCommands();
  }

  private emitSlashCommands(): void {
    const commands = Array.from(this.slashCommandsByName.values());
    this.pushEvent("slash-commands", {
      provider: this.provider,
      commands,
      createdAt: Date.now(),
    });
  }

  private noteSdkSession(
    id: string,
    opts: {
      keepActiveSession?: boolean;
      preserveResumeSession?: boolean;
    } = {},
  ): void {
    if (!id) return;
    const nextActiveSessionId = opts.keepActiveSession
      ? this.activeSessionId ?? this.resumeSessionId
      : id;
    let nextResumeSessionId: string | null = id;
    if (opts.preserveResumeSession) {
      nextResumeSessionId = this.resumeSessionId;
    } else if (opts.keepActiveSession) {
      nextResumeSessionId = this.resumeSessionId ?? this.activeSessionId;
    }
    const changed =
      this.sdkSessionId !== id ||
      this.remoteSdkSessionId !== id ||
      this.activeSessionId !== nextActiveSessionId ||
      this.resumeSessionId !== nextResumeSessionId;
    this.sdkSessionId = id;
    this.remoteSdkSessionId = id;
    this.activeSessionId = nextActiveSessionId;
    this.resumeSessionId = nextResumeSessionId;
    this.applyStoredContextUsageForSession(nextActiveSessionId ?? id);
    if (nextActiveSessionId) {
      this.rememberRemoteSdkSession(nextActiveSessionId, id);
    }
    if (changed) this.emitState();
  }

  private bindPendingSession(pendingSessionId: string, sessionId: string): void {
    if (!pendingSessionId || !sessionId) return;
    const changed =
      this.activeSessionId !== sessionId ||
      this.resumeSessionId !== sessionId ||
      this.sdkSessionId !== sessionId ||
      this.remoteSdkSessionId !== sessionId ||
      this.localResumeSessionId !== sessionId;
    this.localResumeSessionId = sessionId;
    this.activeSessionId = sessionId;
    this.resumeSessionId = sessionId;
    this.sdkSessionId = sessionId;
    this.remoteSdkSessionId = sessionId;
    this.applyStoredContextUsageForSession(sessionId);
    if (!this.boundPendingSessionIds.has(pendingSessionId)) {
      this.boundPendingSessionIds.add(pendingSessionId);
      this.pushEvent("session-bound", {
        pendingSessionId,
        sessionId,
        createdAt: Date.now(),
      });
    }
    if (changed) this.emitState();
  }

  private flushActivePromptEvent(sessionId: string): void {
    if (!this.activePromptEvent) return;
    const prompt = this.activePromptEvent;
    this.activePromptEvent = null;
    this.pushEvent("message", {
      role: "user",
      sessionId,
      ...(prompt.messageId ? { messageId: prompt.messageId } : {}),
      text: prompt.text,
      attachments: prompt.attachments,
      inputKind: "prompt",
      mode: prompt.mode,
      createdAt: prompt.createdAt,
    });
  }
  private async emitAssistantMessage(message: SDKAssistantMessage, sessionId: string): Promise<void> {
    await emitClaudeAssistantMessage(message, sessionId, this.sdkEventContext());
  }



  private emitPartialAssistantMessage(message: SDKPartialAssistantMessage, fallbackSessionId: string): void {
    emitClaudePartialAssistantMessage(message, fallbackSessionId, this.sdkEventContext());
  }


  private emitApiRetry(message: SDKAPIRetryMessage, sessionId: string): void {
    emitClaudeApiRetry(message, sessionId, this.sdkEventContext());
  }

  private emitResultError(message: SDKMessage, sessionId: string): void {
    emitClaudeResultError(message, sessionId, this.sdkEventContext());
  }


  private emitResultUsage(message: SDKMessage, fallbackSessionId: string): void {
    emitClaudeResultUsage(message, fallbackSessionId, this.sdkEventContext());
  }

  private emitToolResults(message: SDKUserMessage, sessionId: string): void {
    emitClaudeToolResults(message, sessionId, this.sdkEventContext());
  }


  private handleToolPermission(
    toolName: string,
    input: unknown,
    id: string,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    if (toolName === ASK_USER_QUESTION_TOOL) {
      return this.handleUserQuestion(input, id, signal);
    }
    if (toolName === EXIT_PLAN_MODE_TOOL) {
      return this.handlePlanApproval(input, id, signal);
    }

    return new Promise<PermissionResult>((resolve, reject) => {
      const request: CliPermissionRequest = {
        id,
        toolName,
        input,
        createdAt: Date.now(),
      };
      const abort = () => {
        this.pendingPermissions.delete(id);
        this.pushEvent("permission-resolved", { id, approved: false });
        this.emitPendingToolError(request, "Permission request aborted.");
        reject(new Error("permission request aborted"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pendingPermissions.set(id, {
        request,
        resolve: (result) => {
          signal.removeEventListener("abort", abort);
          resolve(result);
        },
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      this.pushEvent("permission", {
        id,
        toolName,
        input,
        tool_scope: claudeToolScope(toolName, this.activePromptMode, input),
        mode: this.activePromptMode ?? undefined,
        inputKind: "prompt",
        createdAt: request.createdAt,
        sessionId: this.activeSessionId ?? this.resumeSessionId,
      });
      this.emitState();
    });
  }

  private handlePlanApproval(
    input: unknown,
    id: string,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve, reject) => {
      const request: CliPermissionRequest = {
        id,
        toolName: EXIT_PLAN_MODE_TOOL,
        input,
        createdAt: Date.now(),
      };
      const abort = () => {
        this.pendingPermissions.delete(id);
        this.pushEvent("permission-resolved", { id, approved: false });
        this.pushEvent("plan.approval.resolved", {
          id,
          requestID: id,
          approved: false,
          sessionId: this.activeSessionId ?? this.resumeSessionId,
        });
        this.emitPendingToolError(request, "Plan approval request aborted.");
        reject(new Error("plan approval request aborted"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pendingPermissions.set(id, {
        request,
        resolve: (result) => {
          signal.removeEventListener("abort", abort);
          resolve(result);
        },
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      const inputRecord = asRecord(input);
      this.pushEvent("plan.approval.requested", {
        id,
        requestID: id,
        sessionID: this.activeSessionId ?? this.resumeSessionId,
        sessionId: this.activeSessionId ?? this.resumeSessionId,
        input: inputRecord,
        plan: readString(inputRecord.plan),
        mode: "plan",
        inputKind: "prompt",
        tool_scope: "approval",
        allowedPrompts: Array.isArray(inputRecord.allowedPrompts)
          ? inputRecord.allowedPrompts
          : undefined,
        tool: {
          messageID: this.lastAssistantMessageBySession.get(this.activeSessionId ?? this.resumeSessionId ?? "") ?? "",
          callID: id,
        },
        createdAt: request.createdAt,
      });
      this.pushEvent("permission", {
        id,
        toolName: EXIT_PLAN_MODE_TOOL,
        input,
        tool_scope: "approval",
        mode: "plan",
        inputKind: "prompt",
        createdAt: request.createdAt,
        sessionId: this.activeSessionId ?? this.resumeSessionId,
      });
      this.emitState();
    });
  }

  private handleUserQuestion(
    input: unknown,
    id: string,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const inputRecord = asRecord(input);
    const questions = normalizeQuestionInput(inputRecord);
    if (questions.length === 0) {
      return Promise.resolve({
        behavior: "deny",
        message: "AskUserQuestion did not include any valid questions.",
        toolUseID: id,
      });
    }

    return new Promise<PermissionResult>((resolve, reject) => {
      const request: CliQuestionRequest = {
        id,
        input: inputRecord,
        createdAt: Date.now(),
      };
      const abort = () => {
        this.pendingQuestions.delete(id);
        this.pushEvent("question.rejected", {
          id,
          requestID: id,
          sessionId: this.activeSessionId ?? this.resumeSessionId,
        });
        this.emitPendingToolError({
          id,
          toolName: ASK_USER_QUESTION_TOOL,
          input: inputRecord,
          createdAt: request.createdAt,
        }, "Question request aborted.");
        reject(new Error("question request aborted"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pendingQuestions.set(id, {
        request,
        resolve: (result) => {
          signal.removeEventListener("abort", abort);
          resolve(result);
        },
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      this.pushEvent("question.asked", {
        id,
        sessionID: this.activeSessionId ?? this.resumeSessionId,
        sessionId: this.activeSessionId ?? this.resumeSessionId,
        questions,
        tool: {
          messageID: this.lastAssistantMessageBySession.get(this.activeSessionId ?? this.resumeSessionId ?? "") ?? "",
          callID: id,
        },
        createdAt: request.createdAt,
      });
      this.emitState();
    });
  }

  private attachReclaimInput(): void {
    if (this.reclaimAttached || !process.stdin.isTTY) return;
    this.reclaimAttached = true;
    this.reclaimBuffer = "";
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.resume();
      process.stdin.on("data", this.onReclaimInput);
    } catch {
      this.reclaimAttached = false;
    }
  }

  private detachReclaimInput(): void {
    if (!this.reclaimAttached) return;
    this.reclaimAttached = false;
    process.stdin.off("data", this.onReclaimInput);
    this.reclaimBuffer = "";
    try {
      process.stdin.pause();
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
    } catch {}
  }

  private onReclaimInput = (chunk: string | Buffer) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text === "\u0003") {
      this.stop();
      return;
    }
    this.reclaimBuffer += text;
    if (this.reclaimBuffer.length > 200) {
      this.reclaimBuffer = this.reclaimBuffer.slice(-200);
    }
    if (this.reclaimBuffer.includes(RECLAIM_COMMAND)) {
      this.reclaimBuffer = "";
      void this.releaseToLocal();
      return;
    }
    if (text.includes("\n") || text.includes("\r")) {
      process.stderr.write(
        `[adit cloud claude] Web owns this session. Type ${RECLAIM_COMMAND} to reclaim.\n`,
      );
    }
  };

  private pickResumeSessionId(opts: { fallbackToLatest: boolean }): string | null {
    const candidates = [
      this.activeSessionId,
      this.resumeSessionId,
      this.remoteSdkSessionId,
      this.sdkSessionId,
    ];
    for (const id of candidates) {
      if (id && isValidClaudeSession(id, this.opts.cwd)) {
        this.resumeSessionId = id;
        this.activeSessionId = id;
        return id;
      }
    }
    if (!opts.fallbackToLatest) return null;
    const latest = findLastClaudeSession(this.opts.cwd);
    if (latest) {
      this.resumeSessionId = latest;
      this.activeSessionId = latest;
      this.emitState();
      return latest;
    }
    this.resumeSessionId = null;
    return null;
  }

  private pickLocalResumeSessionId(): string | null {
    const seen = new Set<string>();
    const candidates = [
      this.localResumeSessionId,
      this.resumeSessionId,
      this.activeSessionId,
      this.remoteSdkSessionId,
      this.sdkSessionId,
    ];
    for (const id of candidates) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (isValidClaudeSession(id, this.opts.cwd)) return id;
    }
    return null;
  }

  private setBusy(value: boolean): void {
    if (this.busyValue === value) return;
    this.busyValue = value;
    this.emitState();
  }

  private setThinking(value: boolean): void {
    if (this.thinkingValue === value) return;
    this.thinkingValue = value;
    this.emitState();
  }

  private scheduleBranchRefresh(force = false): void {
    const now = Date.now();
    if (this.branchRefreshPromise) return;
    if (!force && now - this.branchRefreshAt < BRANCH_REFRESH_INTERVAL_MS) return;
    this.branchRefreshAt = now;
    this.branchRefreshPromise = getCurrentBranch(this.opts.cwd)
      .then((branch) => {
        const nextBranch = readString(branch);
        if (this.currentBranch === nextBranch) return;
        this.currentBranch = nextBranch;
        this.emitState();
      })
      .catch(() => undefined)
      .finally(() => {
        this.branchRefreshPromise = null;
      });
  }

  private scheduleContextUsageRefresh(force = false): void {
    if (this.ownerValue !== "web" || !this.remoteQuery) return;
    const queryWithUsage = this.remoteQuery as Query & {
      getContextUsage?: () => Promise<unknown>;
    };
    if (typeof queryWithUsage.getContextUsage !== "function") return;

    const now = Date.now();
    if (this.contextUsageRefreshPromise) return;
    if (!force && now - this.contextUsageRefreshAt < CONTEXT_USAGE_REFRESH_INTERVAL_MS) return;
    this.contextUsageRefreshAt = now;
    const sessionId = this.currentContextUsageSessionId();
    this.contextUsageRefreshPromise = queryWithUsage.getContextUsage()
      .then((rawUsage) => {
        const usage = normalizeClaudeContextUsage(rawUsage, this.activeModelId);
        if (!usage) return;
        const previousUsage = sessionId
          ? this.contextUsageBySession.get(sessionId) ?? null
          : this.contextUsage;
        if (isSameContextUsage(previousUsage, usage)) return;
        if (sessionId) this.contextUsageBySession.set(sessionId, usage);
        if (!sessionId || sessionId === this.currentContextUsageSessionId()) {
          this.contextUsage = usage;
          this.emitState();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.contextUsageRefreshPromise = null;
      });
  }

  private emitState(): void {
    this.emit("state", this.state);
    const payload = {
      sessionId: this.activeSessionId ?? this.resumeSessionId,
      owner: this.ownerValue,
      busy: this.busyValue,
      thinking: this.thinkingValue,
      activeSessionId: this.activeSessionId,
      resumeSessionId: this.resumeSessionId,
      sdkSessionId: this.sdkSessionId,
      activeModelId: this.activeModelId,
      currentBranch: this.currentBranch,
      contextUsage: this.contextUsage,
      lastTokenUsage: null,
    };
    const key = stableStateEventKey(payload);
    if (key === this.lastStateEventKey) return;
    this.lastStateEventKey = key;
    this.pushEvent("state", {
      ...payload,
      createdAt: Date.now(),
    });
  }

  private pushEvent(type: string, payload: Record<string, unknown>): void {
    this.opts.onEvent?.({ type, payload });
  }

  private pushNotice(input: {
    title: string;
    text: string;
    sessionId?: string | null;
    data?: Record<string, unknown>;
  }): void {
    this.pushEvent("notice", {
      title: input.title,
      text: input.text,
      sessionId: input.sessionId ?? this.activeSessionId ?? this.resumeSessionId,
      ...(input.data ?? {}),
      createdAt: Date.now(),
    });
  }

  private buildEnv(): NodeJS.ProcessEnv {
    return buildClaudeCloudRelayEnv();
  }

  private currentContextUsageSessionId(): string | null {
    return this.activeSessionId ?? this.resumeSessionId ?? this.sdkSessionId ?? this.remoteSdkSessionId;
  }

  private applyStoredContextUsageForSession(sessionId: string | null): void {
    this.contextUsage = sessionId ? this.contextUsageBySession.get(sessionId) ?? null : null;
  }

  private setActiveModel(
    modelId: string | null | undefined,
    opts: { emit: boolean },
  ): boolean {
    const normalized = typeof modelId === "string" && modelId.trim() ? modelId.trim() : null;
    if (!normalized) return false;
    const changed = this.activeModelId !== normalized;
    if (!changed) return false;
    this.activeModelId = normalized;
    if (changed && opts.emit) this.emitState();
    return changed;
  }

  private rememberRemoteSdkSession(
    activeSessionId: string,
    sdkSessionId: string,
  ): void {
    if (!activeSessionId || !sdkSessionId || activeSessionId === sdkSessionId) return;
    let ids = this.remoteSdkSessionIdsByActiveSession.get(activeSessionId);
    if (!ids) {
      ids = new Set<string>();
      this.remoteSdkSessionIdsByActiveSession.set(activeSessionId, ids);
    }
    ids.add(sdkSessionId);
  }

  private mergeRemoteTranscriptsIntoActive(
    activeSessionId: string | null = this.activeSessionId,
    remoteSessionId: string | null = this.remoteSdkSessionId ?? this.sdkSessionId,
  ): void {
    if (!activeSessionId) return;
    const remoteSessionIds = new Set<string>();
    const remembered = this.remoteSdkSessionIdsByActiveSession.get(activeSessionId);
    if (remembered) {
      for (const id of remembered) remoteSessionIds.add(id);
    }
    if (remoteSessionId) remoteSessionIds.add(remoteSessionId);
    if (this.remoteSdkSessionId) remoteSessionIds.add(this.remoteSdkSessionId);
    if (this.sdkSessionId) remoteSessionIds.add(this.sdkSessionId);

    for (const id of remoteSessionIds) {
      if (!id || id === activeSessionId) continue;
      mergeClaudeSessionTranscript({
        cwd: this.opts.cwd,
        sourceSessionId: id,
        targetSessionId: activeSessionId,
      });
    }
  }
}
