import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { getCurrentBranch } from "@varveai/adit-engine";
import type {
  CliAgentProvider,
  CliAgentRelayEvent,
  CliAgentState,
  CliPermissionRequest,
  CliQuestionResponse,
  CliSlashCommand,
  CliSlashCommandInfo,
  CliAgentContextUsage,
  CliAgentTokenUsage,
  PromptImageAttachment,
} from "../types.js";
import {
  CodexAppServerClient,
  type CodexJsonRpcMessage,
} from "./codex-app-server-client.js";
import {
  handleCodexAppServerRequest,
  type CodexPendingPermission,
  type CodexPendingQuestion,
} from "./app-requests.js";
import {
  CODEX_CAPABILITY_DISCOVERY_METHOD,
  CODEX_CLOUD_SLASH_COMMAND_SPECS,
  CODEX_MCP_SLASH_COMMAND_PREFIX,
  CODEX_SYSTEM_SKILLS_RETRY_DELAYS_MS,
  CODEX_THREAD_SETTINGS_UPDATE_METHOD,
  extractCodexMcpServers,
  extractCodexSkills,
  extractCodexSupportedMethodsFromError,
  formatCodexMcpServers,
  formatCodexModels,
  formatCodexSkillPrompt,
  formatCodexSkills,
  normalizeSlashCommandName,
  pendingSessionIdFromSlashCommand,
  type CodexSlashCommandSpec,
} from "./capabilities.js";
import { asRecord, delay, isMissingCodexRolloutError, pluralize, readDeltaString, readNumber, readString } from "./helpers.js";
import { writeCliAgentErrorToTerminal } from "../terminal-error.js";
import {
  codexInputItems,
  codexThreadModeOverrides,
  codexTurnModeOverrides,
  type CodexPromptMode,
} from "./input-mode.js";
import {
  buildApprovalResponse,
  buildQuestionResponse,
} from "./requests.js";
import {
  applyReclaimText,
  normalizeCodexReclaimInput,
  restoreTerminalForCodexReclaim,
  stopLocalCodexProcess,
  writeCodexTerminalNotice,
} from "./terminal.js";
import {
  buildCodexContextUsage,
  isSameContextUsage,
  isSameTokenUsage,
  normalizeCodexContextWindow,
  normalizeCodexTokenUsage,
  normalizeCodexUsage,
} from "./usage.js";
import { emitCodexThreadItem } from "./thread-items.js";
export { promptInputForCodexMode, codexThreadModeOverrides, codexTurnModeOverrides } from "./input-mode.js";
export type { CodexPromptMode } from "./input-mode.js";
export { formatCodexTerminalNotice, normalizeCodexReclaimInput } from "./terminal.js";
import { spawnCliProcess } from "../cli-process.js";
import {
  isCodexThreadSavedForCwd,
  startCodexResumeLogWatcher,
  type CodexResumeLogWatcher,
} from "./codex-resume-log-watcher.js";
import {
  startCodexModelConfigWatcher,
  type CodexModelConfigWatcher,
} from "./codex-model-config-watcher.js";

interface PendingPrompt {
  message: string;
  attachments: PromptImageAttachment[];
  mode: CodexPromptMode;
  pendingSessionId: string | null;
  localMessageId: string | null;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface CodexCliProviderOptions {
  bin: string;
  args: string[];
  cwd: string;
  hookEndpoint?: string;
  hookMarker?: string;
  onEvent?: (event: CliAgentRelayEvent) => void;
}

const RECLAIM_COMMAND = "/local";
const BRANCH_REFRESH_INTERVAL_MS = 5_000;

export class CodexCliProvider extends EventEmitter implements CliAgentProvider {
  readonly provider = "codex" as const;
  private local: ChildProcess | null = null;
  private appServer: CodexAppServerClient | null = null;
  private ownerValue: CliAgentState["owner"] = "stopped";
  private busyValue = false;
  private thinkingValue = false;
  private activeSessionId: string | null = null;
  private resumeSessionId: string | null = null;
  private sdkSessionId: string | null = null;
  private activeModelId: string | null = null;
  private currentBranch: string | null = null;
  private branchRefreshAt = 0;
  private branchRefreshPromise: Promise<void> | null = null;
  private contextUsage: CliAgentContextUsage | null = null;
  private lastTokenUsage: CliAgentTokenUsage | null = null;
  private contextWindow: number | null = null;
  private contextUsageBySession = new Map<string, CliAgentContextUsage>();
  private lastTokenUsageBySession = new Map<string, CliAgentTokenUsage>();
  private contextWindowBySession = new Map<string, number>();
  private threadModelBySession = new Map<string, string>();
  private promptQueue: PendingPrompt[] = [];
  private promptActive = false;
  private activeTurnId: string | null = null;
  private activePromptMode: CodexPromptMode | null = null;
  private loadedThreadIds = new Set<string>();
  private emptyThreadIds = new Set<string>();
  private boundPendingSessionIds = new Set<string>();
  private pendingPermissions = new Map<string, CodexPendingPermission>();
  private pendingQuestions = new Map<string, CodexPendingQuestion>();
  private lastAssistantMessageBySession = new Map<string, string>();
  private reclaimAttached = false;
  private reclaimBuffer = "";
  private suppressNextLocalExit = false;
  private supportedAppServerMethods = new Set<string>();
  private slashCommandsByName = new Map<string, CliSlashCommandInfo>();
  private skillSlashCommandsByName = new Map<string, Record<string, unknown>>();
  private mcpSlashCommandsByName = new Map<string, Record<string, unknown>>();
  private codexSkills: Array<Record<string, unknown>> = [];
  private codexMcpServers: Array<Record<string, unknown>> = [];
  private localResumeLogWatcher: CodexResumeLogWatcher | null = null;
  private localModelConfigWatcher: CodexModelConfigWatcher | null = null;

  constructor(private readonly opts: CodexCliProviderOptions) {
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
      lastTokenUsage: this.lastTokenUsage,
      metadata: {
        codex: {
          bin: this.opts.bin,
          defaultModeRequestUserInput: true,
          systemSkillsRetry: true,
        },
      },
    };
  }

  get permissions(): CliPermissionRequest[] {
    return [...this.pendingPermissions.values()].map((item) => item.request);
  }

  noteModel(modelId: string | null | undefined): void {
    if (!modelId) return;
    if (modelId === this.activeModelId) {
      const previous = this.contextUsage;
      this.refreshContextUsage();
      if (!isSameContextUsage(previous, this.contextUsage)) {
        this.emitState();
      }
      return;
    }
    this.activeModelId = modelId;
    this.refreshContextUsage();
    this.emitState();
  }

  noteLocalSession(id: string): void {
    if (!id) return;
    const changed = this.activeSessionId !== id || this.resumeSessionId !== id;
    this.activeSessionId = id;
    this.resumeSessionId = id;
    this.sdkSessionId = id;
    this.applyStoredUsageForSession(id);
    if (!changed) return;
    this.emitState();
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
      await this.hydrateAppServerCapabilities();
      return;
    }
    if (this.ownerValue !== "local") {
      throw Object.assign(new Error("local Codex owner is not available"), {
        statusCode: 409,
      });
    }
    if (this.busyValue || this.thinkingValue) {
      throw Object.assign(new Error("local Codex is busy"), {
        statusCode: 409,
      });
    }

    await this.ensureAppServer();
    await this.hydrateAppServerCapabilities();
    const resumeId = this.activeSessionId ?? this.resumeSessionId;
    if (resumeId) {
      await this.resumeThread(resumeId);
    } else {
      await this.startThread("build");
    }

    const oldLocal = this.local;
    this.suppressNextLocalExit = Boolean(oldLocal);
    this.local = null;
    this.stopLocalResumeLogWatcher();
    this.stopLocalModelConfigWatcher();
    await stopLocalCodexProcess(oldLocal);

    this.ownerValue = "web";
    this.emitState();
    restoreTerminalForCodexReclaim();
    writeCodexTerminalNotice(
      `[adit cloud codex] Web has taken over Codex CLI. Type ${RECLAIM_COMMAND} here to reclaim local control.`,
    );
    this.attachReclaimInput();
  }

  async releaseToLocal(): Promise<void> {
    if (this.ownerValue !== "web") return;
    this.detachReclaimInput();
    process.stderr.write("\n[adit cloud codex] releasing Web control back to local Codex CLI...\n");
    await this.finishActiveRunAsAborted({
      errorMessage: "Web control released to local CLI",
      eventMessage: "Web control released to local CLI.",
      interruptTurn: true,
    });
    this.appServer?.stop();
    this.appServer = null;
    this.loadedThreadIds = new Set<string>();
    this.emptyThreadIds = new Set<string>();
    const resumeId = this.pickLocalResumeSessionId();
    if (resumeId) {
      this.activeSessionId = resumeId;
      this.resumeSessionId = resumeId;
      this.sdkSessionId = resumeId;
      this.applyStoredUsageForSession(resumeId);
    } else {
      this.activeSessionId = null;
      this.resumeSessionId = null;
      this.sdkSessionId = null;
      this.applyStoredUsageForSession(null);
    }
    this.startLocal(resumeId ? ["resume", resumeId] : []);
  }

  async startNewSession(pendingSessionId?: string | null): Promise<void> {
    if (this.ownerValue !== "web") {
      throw Object.assign(new Error("Web has not taken over this Codex session"), {
        statusCode: 409,
      });
    }
    await this.finishActiveRunAsAborted({
      errorMessage: "Codex session switched",
      eventMessage: "Codex session switched.",
      interruptTurn: true,
    });
    const threadId = await this.startThread("build");
    if (pendingSessionId) {
      this.bindPendingSession(pendingSessionId, threadId);
    } else {
      this.resumeSessionId = threadId;
      this.sdkSessionId = threadId;
      this.applyStoredUsageForSession(threadId);
      this.emitState();
    }
  }

  async switchSession(sessionId: string): Promise<void> {
    if (!sessionId.trim()) {
      throw Object.assign(new Error("Codex session not found for this project"), {
        statusCode: 404,
      });
    }

    if (this.ownerValue === "local") {
      this.suppressNextLocalExit = true;
      const oldLocal = this.local;
      this.local = null;
      this.stopLocalResumeLogWatcher();
      this.stopLocalModelConfigWatcher();
      try {
        oldLocal?.kill("SIGTERM");
      } catch {}
      this.activeSessionId = sessionId;
      this.resumeSessionId = sessionId;
      this.sdkSessionId = sessionId;
      this.applyStoredUsageForSession(sessionId);
      this.emitState();
      this.startLocal(["resume", sessionId]);
      return;
    }

    if (this.ownerValue === "web") {
      await this.finishActiveRunAsAborted({
        errorMessage: "Codex session switched",
        eventMessage: "Codex session switched.",
        interruptTurn: true,
      });
      await this.ensureAppServer();
      if (this.loadedThreadIds.has(sessionId)) {
        this.noteThread({ id: sessionId }, null);
      } else {
        await this.resumeThread(sessionId);
      }
      this.setBusy(false);
      this.setThinking(false);
      return;
    }
  }

  async sendPrompt(
    prompt: string,
    opts: {
      mode?: "build" | "plan";
      pendingSessionId?: string | null;
      localMessageId?: string | null;
      attachments?: PromptImageAttachment[];
    } = {},
  ): Promise<void> {
    if (this.ownerValue !== "web") {
      throw Object.assign(new Error("Web has not taken over this Codex session"), {
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
        resolve,
        reject,
      });
      void this.drainPromptQueue();
    });
  }

  async steerPrompt(
    prompt: string,
    opts: {
      sessionId?: string | null;
      localMessageId?: string | null;
      mode?: CodexPromptMode;
      attachments?: PromptImageAttachment[];
    } = {},
  ): Promise<void> {
    if (this.ownerValue !== "web") {
      throw Object.assign(new Error("Web has not taken over this Codex session"), {
        statusCode: 409,
      });
    }
    const trimmed = prompt.trim();
    const attachments = opts.attachments ?? [];
    if (!trimmed && attachments.length === 0) return;
    const threadId = this.activeSessionId ?? this.resumeSessionId;
    const turnId = this.activeTurnId;
    if (!threadId || !turnId || (!this.busyValue && !this.thinkingValue)) {
      throw Object.assign(new Error("Codex is not currently accepting steering input"), {
        statusCode: 409,
      });
    }
    if (opts.sessionId && !this.acceptsSteerSessionId(opts.sessionId, threadId)) {
      throw Object.assign(new Error("Codex is running a different session"), {
        statusCode: 409,
      });
    }

    await this.ensureAppServer();
    await this.appServer?.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: await codexInputItems(trimmed, "build", attachments),
    });
    this.pushEvent("message", {
      role: "user",
      sessionId: threadId,
      ...(opts.localMessageId ? { messageId: opts.localMessageId } : {}),
      text: trimmed,
      attachments,
      inputKind: "steer",
      mode: opts.mode ?? this.activePromptMode ?? "build",
      createdAt: Date.now(),
    });
  }

  async handleSlashCommand(command: CliSlashCommand): Promise<void> {
    const name = command.name.trim().replace(/^\//, "").toLowerCase();
    if (!name) return;
    const pendingSessionId =
      command.pendingSessionId ?? pendingSessionIdFromSlashCommand(command);
    if (!this.slashCommandsByName.has(name)) {
      throw Object.assign(
        new Error(`Codex Cloud Coding does not expose /${command.name} as an executable native command.`),
        { statusCode: 400 },
      );
    }
    if (this.ownerValue !== "web") {
      throw Object.assign(new Error("Web has not taken over this Codex session"), {
        statusCode: 409,
      });
    }

    const wasSkillSlashCommand = this.skillSlashCommandsByName.has(name);
    const skillCommand = wasSkillSlashCommand
      ? await this.resolveSkillSlashCommand(name)
      : null;
    if (wasSkillSlashCommand && !skillCommand) {
      throw Object.assign(new Error(`Codex skill command /${name} is no longer available.`), {
        statusCode: 400,
      });
    }
    if (skillCommand) {
      const argsText = command.args.join(" ").trim();
      if (argsText) {
        await this.sendPrompt(formatCodexSkillPrompt(skillCommand, argsText), {
          mode: "build",
          pendingSessionId,
          localMessageId: command.localMessageId ?? null,
        });
      } else {
        this.pushNotice({
          title: `/${name}`,
          text: formatCodexSkills([skillCommand]),
          sessionId: command.sessionId,
          data: {
            noticeKind: "skills",
            provider: this.provider,
            skills: [skillCommand],
          },
        });
      }
      return;
    }

    const wasMcpSlashCommand = this.mcpSlashCommandsByName.has(name);
    const mcpCommand = wasMcpSlashCommand
      ? await this.resolveMcpSlashCommand(name)
      : null;
    if (wasMcpSlashCommand && !mcpCommand) {
      throw Object.assign(new Error(`Codex MCP command /${name} is no longer available.`), {
        statusCode: 400,
      });
    }
    if (mcpCommand) {
      this.pushNotice({
        title: `/${name}`,
        text: formatCodexMcpServers([mcpCommand]),
        sessionId: command.sessionId,
      });
      return;
    }

    if (name === "new" || name === "clear") {
      const threadId = await this.startThread("build");
      if (pendingSessionId) this.bindPendingSession(pendingSessionId, threadId);
      this.pushNotice({
        title: `/${name}`,
        text: `Started a clean Codex thread: ${threadId}`,
        sessionId: threadId,
      });
      return;
    }

    if (name === "mcp") {
      await this.ensureAppServer();
      const result = await this.appServer?.request("mcpServerStatus/list", {
        detail: "toolsAndAuthOnly",
      });
      this.codexMcpServers = extractCodexMcpServers(result);
      this.refreshSlashCommands();
      this.pushNotice({
        title: "/mcp",
        text: formatCodexMcpServers(this.codexMcpServers),
        sessionId: command.sessionId,
      });
      return;
    }

    if (name === "skills") {
      await this.ensureAppServer();
      const skills = await this.fetchCodexSkillsWithRetry();
      this.codexSkills = skills;
      this.refreshSlashCommands();
      this.pushNotice({
        title: "/skills",
        text: formatCodexSkills(skills),
        sessionId: command.sessionId,
        data: {
          noticeKind: "skills",
          provider: this.provider,
          skills,
        },
      });
      return;
    }

    if (name === "model") {
      await this.ensureAppServer();
      const result = await this.appServer?.request("model/list", {
        includeHidden: false,
      });
      this.pushNotice({
        title: "/model",
        text: formatCodexModels(result),
        sessionId: command.sessionId,
      });
      return;
    }

    const threadId = pendingSessionId
      ? await this.startThread("build")
      : command.sessionId ?? this.activeSessionId ?? this.resumeSessionId;
    if (!threadId) {
      throw Object.assign(new Error(`/${name} requires an active Codex thread.`), {
        statusCode: 400,
      });
    }
    if (!pendingSessionId && !this.loadedThreadIds.has(threadId)) {
      await this.resumeThread(threadId);
    }

    if (name === "compact") {
      if (pendingSessionId) this.bindPendingSession(pendingSessionId, threadId);
      if (this.emptyThreadIds.has(threadId)) {
        this.pushEmptyThreadNotice("compact", threadId);
        return;
      }
      try {
        await this.appServer?.request("thread/compact/start", { threadId });
      } catch (error) {
        if (isMissingCodexRolloutError(error)) {
          this.emptyThreadIds.add(threadId);
          this.pushEmptyThreadNotice("compact", threadId);
          return;
        }
        throw error;
      }
      this.pushNotice({
        title: "/compact",
        text: "Started Codex thread compaction.",
        sessionId: threadId,
      });
      return;
    }

    if (name === "fork") {
      if (this.emptyThreadIds.has(threadId)) {
        if (pendingSessionId) this.bindPendingSession(pendingSessionId, threadId);
        this.pushEmptyThreadNotice("fork", threadId);
        return;
      }
      let result: Record<string, unknown>;
      try {
        result = asRecord(await this.appServer?.request("thread/fork", {
          threadId,
          cwd: this.opts.cwd,
          ...codexThreadModeOverrides("build"),
        })) ?? {};
      } catch (error) {
        if (isMissingCodexRolloutError(error)) {
          this.emptyThreadIds.add(threadId);
          if (pendingSessionId) this.bindPendingSession(pendingSessionId, threadId);
          this.pushEmptyThreadNotice("fork", threadId);
          return;
        }
        throw error;
      }
      const thread = asRecord(result.thread) ?? {};
      const forkedThreadId = readString(thread.id);
      if (forkedThreadId) this.noteThread(thread, result);
      if (pendingSessionId) {
        this.bindPendingSession(pendingSessionId, forkedThreadId ?? threadId);
      }
      this.pushNotice({
        title: "/fork",
        text: forkedThreadId
          ? `Forked Codex thread: ${forkedThreadId}`
          : "Forked the current Codex thread.",
        sessionId: forkedThreadId ?? threadId,
      });
    }
  }

  private pushEmptyThreadNotice(command: "compact" | "fork", threadId: string): void {
    this.pushNotice({
      title: `/${command}`,
      text: command === "fork"
        ? "This Codex thread has no conversation to fork yet. Send a prompt first, then run /fork."
        : "This Codex thread has no conversation to compact yet. Send a prompt first, then run /compact.",
      sessionId: threadId,
    });
  }

  async answerPermission(
    id: string,
    approved: boolean,
    _reason?: string,
  ): Promise<void> {
    const pending = this.pendingPermissions.get(id);
    if (!pending) {
      throw Object.assign(new Error("permission request not found"), {
        statusCode: 404,
      });
    }
    this.pendingPermissions.delete(id);
    this.pushEvent("permission-resolved", { id, approved });
    pending.resolve(buildApprovalResponse(pending.method, pending.params, approved));
  }

  async answerQuestion(response: CliQuestionResponse): Promise<void> {
    const pending = this.pendingQuestions.get(response.id);
    if (!pending) {
      throw Object.assign(new Error("question request not found"), {
        statusCode: 404,
      });
    }
    this.pendingQuestions.delete(response.id);
    if (response.rejected) {
      this.pushEvent("question.rejected", {
        id: response.id,
        requestID: response.id,
      });
      pending.resolve(buildQuestionResponse(pending.method, pending.params, []));
      return;
    }
    this.pushEvent("question.replied", {
      id: response.id,
      requestID: response.id,
    });
    pending.resolve(buildQuestionResponse(pending.method, pending.params, response.answers));
  }

  async abort(): Promise<void> {
    if (this.ownerValue !== "web") return;
    await this.finishActiveRunAsAborted({
      errorMessage: "Codex run aborted",
      eventMessage: "Codex run aborted.",
      interruptTurn: true,
    });
  }

  stop(): void {
    this.finishActiveRunAsAborted({
      errorMessage: "Codex provider stopped",
      eventMessage: "Codex provider stopped.",
      interruptTurn: false,
    });
    this.detachReclaimInput();
    this.appServer?.stop();
    this.appServer = null;
    try {
      this.local?.kill("SIGTERM");
    } catch {}
    this.stopLocalResumeLogWatcher();
    this.stopLocalModelConfigWatcher();
    this.local = null;
    this.ownerValue = "stopped";
    this.setThinking(false);
    this.setBusy(false);
    this.emitState();
  }

  private startLocal(extraArgs: string[] = []): void {
    this.stopLocalResumeLogWatcher();
    this.stopLocalModelConfigWatcher();
    this.detachReclaimInput();
    this.finishWebPrompts(new Error("local mode active"));
    this.resetAppServerCapabilities();
    // Deliberately no emitSlashCommands here: broadcasting the now-empty
    // table would be persisted as the latest slash-commands snapshot and
    // replayed to future viewers; the next takeover re-hydrates instead.
    this.appServer?.stop();
    this.appServer = null;
    const child = spawnCliProcess(this.opts.bin, [...extraArgs, ...this.opts.args], {
      cwd: this.opts.cwd,
      env: this.buildEnv(),
      stdio: "inherit",
    });
    this.local = child;
    this.ownerValue = "local";
    this.startLocalResumeLogWatcher(child);
    this.startLocalModelConfigWatcher(child);
    this.emitState();

    child.on("error", (error) => {
      this.pushEvent("error", { message: error.message });
      process.stderr.write(`\n[adit cloud codex] failed to start Codex CLI: ${error.message}\n`);
      if (this.local === child) {
        this.local = null;
        this.stopLocalResumeLogWatcher();
        this.stopLocalModelConfigWatcher();
        this.ownerValue = "stopped";
        this.emitState();
        this.emit("exit", { code: null, signal: null });
      }
    });
    child.on("exit", (code, signal) => {
      this.setThinking(false);
      this.setBusy(false);
      if (this.local === child || this.suppressNextLocalExit) {
        this.stopLocalResumeLogWatcher();
        this.stopLocalModelConfigWatcher();
      }
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

  private startLocalResumeLogWatcher(child: ChildProcess): void {
    this.localResumeLogWatcher = startCodexResumeLogWatcher({
      cwd: this.opts.cwd,
      onResume: (threadId) => {
        if (this.ownerValue !== "local" || this.local !== child) return;
        this.noteLocalSession(threadId);
      },
    });
  }

  private stopLocalResumeLogWatcher(): void {
    try {
      this.localResumeLogWatcher?.stop();
    } catch {}
    this.localResumeLogWatcher = null;
  }

  private startLocalModelConfigWatcher(child: ChildProcess): void {
    this.localModelConfigWatcher = startCodexModelConfigWatcher({
      cwd: this.opts.cwd,
      onModel: (modelId) => {
        if (this.ownerValue !== "local" || this.local !== child) return;
        this.noteModel(modelId);
      },
    });
  }

  private stopLocalModelConfigWatcher(): void {
    try {
      this.localModelConfigWatcher?.stop();
    } catch {}
    this.localModelConfigWatcher = null;
  }

  private async drainPromptQueue(): Promise<void> {
    if (this.promptActive || this.busyValue || this.ownerValue !== "web") return;
    const item = this.promptQueue.shift();
    if (!item) return;
    this.promptActive = true;
    this.activePromptMode = item.mode;
    try {
      await this.ensureAppServer();
      const threadId = await this.ensureThreadForPrompt(item.pendingSessionId, item.mode);
      await this.applyActiveModelToThread(threadId, this.activeModelId);
      this.pushEvent("message", {
        role: "user",
        sessionId: threadId,
        ...(item.localMessageId ? { messageId: item.localMessageId } : {}),
        text: item.message,
        attachments: item.attachments,
        inputKind: "prompt",
        mode: item.mode,
        createdAt: Date.now(),
      });
      const result = asRecord(await this.appServer?.request("turn/start", {
        threadId,
        input: await codexInputItems(item.message, item.mode, item.attachments),
        cwd: this.opts.cwd,
        ...codexTurnModeOverrides(item.mode),
      }));
      const turn = asRecord(result?.turn);
      this.activeTurnId = readString(turn?.id) ?? this.activeTurnId;
      this.emptyThreadIds.delete(threadId);
      this.setBusy(true);
      this.setThinking(true);
      item.resolve();
    } catch (error) {
      this.activePromptMode = null;
      item.reject(error instanceof Error ? error : new Error(String(error)));
      this.pushEvent("error", {
        message: error instanceof Error ? error.message : String(error),
        createdAt: Date.now(),
      });
    } finally {
      this.promptActive = false;
    }
  }

  private async ensureThreadForPrompt(
    pendingSessionId: string | null,
    mode: CodexPromptMode,
  ): Promise<string> {
    if (pendingSessionId) {
      const threadId = await this.startThread(mode);
      this.bindPendingSession(pendingSessionId, threadId);
      return threadId;
    }

    const existing = this.activeSessionId ?? this.resumeSessionId;
    if (existing) {
      if (!this.loadedThreadIds.has(existing)) {
        await this.resumeThread(existing, mode);
      }
      return existing;
    }

    return this.startThread(mode);
  }

  private async ensureAppServer(): Promise<void> {
    if (this.appServer?.isRunning) return;
    const client = new CodexAppServerClient({
      bin: this.opts.bin,
      cwd: this.opts.cwd,
      env: this.buildEnv(),
      onNotification: (message) => this.handleAppNotification(message),
      onServerRequest: (message) => this.handleAppServerRequest(message),
      onError: (error) => {
        this.pushEvent("error", { message: error.message, createdAt: Date.now() });
      },
    });
    this.appServer = client;
    await client.start();
  }

  private async startThread(mode: CodexPromptMode): Promise<string> {
    await this.ensureAppServer();
    const preferredModelId = this.activeModelId;
    const result = asRecord(await this.appServer?.request("thread/start", {
      cwd: this.opts.cwd,
      ...codexThreadModeOverrides(mode),
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    }));
    const thread = asRecord(result?.thread);
    const threadId = readString(thread?.id);
    if (!threadId) throw new Error("Codex app-server did not return a thread id");
    this.noteThread(thread, result, {
      preserveActiveModel: Boolean(preferredModelId),
    });
    await this.applyActiveModelToThread(threadId, preferredModelId);
    this.emptyThreadIds.add(threadId);
    return threadId;
  }

  private async resumeThread(
    threadId: string,
    mode: CodexPromptMode = "build",
  ): Promise<void> {
    await this.ensureAppServer();
    const preferredModelId = this.activeModelId;
    const result = asRecord(await this.appServer?.request("thread/resume", {
      threadId,
      cwd: this.opts.cwd,
      ...codexThreadModeOverrides(mode),
      persistExtendedHistory: true,
    }));
    const thread = asRecord(result?.thread);
    const resumedId = readString(thread?.id) ?? threadId;
    this.noteThread({ ...(thread ?? {}), id: resumedId }, result, {
      markLocalResumable: true,
      preserveActiveModel: Boolean(preferredModelId),
    });
    await this.applyActiveModelToThread(resumedId, preferredModelId);
  }

  private handleAppNotification(message: CodexJsonRpcMessage): void {
    const method = message.method;
    const params = asRecord(message.params) ?? {};
    if (method === "error") {
      this.pushEvent("error", {
        message: readString(params.message) ?? "Codex app-server error",
        createdAt: Date.now(),
      });
      return;
    }

    if (method === "thread/started") {
      this.noteThread(asRecord(params.thread), null);
      return;
    }

    if (method === "thread/status/changed") {
      const status = asRecord(params.status);
      const active = status?.type === "active";
      this.setBusy(active);
      this.setThinking(active);
      return;
    }

    if (method === "thread/settings/updated") {
      const sessionId = readString(params.threadId);
      const settings = asRecord(params.threadSettings);
      const modelId = readString(settings?.model);
      if (sessionId && modelId) {
        this.threadModelBySession.set(sessionId, modelId);
        if (sessionId === this.activeSessionId || sessionId === this.resumeSessionId) {
          this.noteModel(modelId);
        }
      }
      return;
    }

    if (method === "turn/started") {
      const sessionId = readString(params.threadId) ?? this.activeSessionId ?? this.resumeSessionId;
      if (sessionId) this.emptyThreadIds.delete(sessionId);
      this.activeTurnId = readString(asRecord(params.turn)?.id) ?? this.activeTurnId;
      this.setBusy(true);
      this.setThinking(true);
      return;
    }

    if (method === "turn/completed") {
      const turn = asRecord(params.turn);
      const status = readString(turn?.status);
      if (status === "failed") {
        const error = asRecord(turn?.error);
        this.pushEvent("error", {
          message: readString(error?.message) ?? "Codex turn failed",
          createdAt: Date.now(),
        });
      }
      this.activeTurnId = null;
      this.activePromptMode = null;
      this.setThinking(false);
      this.setBusy(false);
      void this.drainPromptQueue();
      return;
    }

    if (method === "item/started") {
      this.emitThreadItem(asRecord(params.item), {
        threadId: readString(params.threadId),
        running: true,
      });
      return;
    }

    if (method === "item/completed") {
      this.emitThreadItem(asRecord(params.item), {
        threadId: readString(params.threadId),
        running: false,
      });
      return;
    }

    if (method === "item/agentMessage/delta" || method === "item/plan/delta") {
      const text = readDeltaString(params.delta);
      const sessionId = readString(params.threadId);
      const messageId = readString(params.itemId);
      if (text && sessionId && messageId) {
        this.lastAssistantMessageBySession.set(sessionId, messageId);
        this.pushEvent("assistant-delta", {
          sessionId,
          messageId,
          text,
          modelId: this.activeModelId ?? undefined,
          createdAt: Date.now(),
        });
      }
      return;
    }

    if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
      const text = readDeltaString(params.delta);
      const sessionId = readString(params.threadId);
      const messageId = readString(params.itemId);
      if (text && sessionId && messageId) {
        this.pushEvent("reasoning", {
          sessionId,
          messageId,
          text,
          createdAt: Date.now(),
        });
      }
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      const sessionId = readString(params.threadId);
      const rawTokenUsage = asRecord(params.tokenUsage) ?? {};
      const runtimeContextWindow = normalizeCodexContextWindow(
        readNumber(rawTokenUsage.modelContextWindow) ??
          readNumber(rawTokenUsage.model_context_window),
      );
      const previousContextWindow = sessionId
        ? this.contextWindowBySession.get(sessionId) ?? null
        : this.contextWindow;
      const contextWindowChanged =
        runtimeContextWindow !== null && runtimeContextWindow !== previousContextWindow;
      if (runtimeContextWindow !== null) {
        if (sessionId) {
          this.contextWindowBySession.set(sessionId, runtimeContextWindow);
        } else {
          this.contextWindow = runtimeContextWindow;
        }
      }
      const rawUsage = asRecord(rawTokenUsage.last);
      const usage = normalizeCodexUsage(rawUsage);
      const tokenUsage = normalizeCodexTokenUsage(rawUsage);
      const previousTokenUsage = sessionId
        ? this.lastTokenUsageBySession.get(sessionId) ?? null
        : this.lastTokenUsage;
      if (tokenUsage && !isSameTokenUsage(previousTokenUsage, tokenUsage)) {
        if (sessionId) {
          this.lastTokenUsageBySession.set(sessionId, tokenUsage);
        }
        if (!sessionId || sessionId === this.currentUsageSessionId()) {
          this.lastTokenUsage = tokenUsage;
          this.refreshContextUsage();
          this.emitState();
        }
      } else if (
        tokenUsage &&
        contextWindowChanged &&
        (!sessionId || sessionId === this.currentUsageSessionId())
      ) {
        this.refreshContextUsage();
        this.emitState();
      }
      if (sessionId && usage) {
        this.pushEvent("usage", {
          sessionId,
          messageId: this.lastAssistantMessageBySession.get(sessionId),
          usage,
          createdAt: Date.now(),
        });
      }
    }
  }
  private handleAppServerRequest(message: CodexJsonRpcMessage): Promise<unknown> {
    return handleCodexAppServerRequest(message, {
      activeSessionId: this.activeSessionId,
      resumeSessionId: this.resumeSessionId,
      activePromptMode: this.activePromptMode,
      pendingPermissions: this.pendingPermissions,
      pendingQuestions: this.pendingQuestions,
      pushEvent: (type, payload) => this.pushEvent(type, payload),
      emitState: () => this.emitState(),
    });
  }


  private noteThread(
    thread: Record<string, unknown> | null,
    result: Record<string, unknown> | null,
    opts: { markLocalResumable?: boolean; preserveActiveModel?: boolean } = {},
  ): void {
    const threadId = readString(thread?.id);
    if (!threadId) return;
    this.activeSessionId = threadId;
    if (opts.markLocalResumable) {
      this.resumeSessionId = threadId;
    }
    this.sdkSessionId = threadId;
    this.loadedThreadIds.add(threadId);
    this.applyStoredUsageForSession(threadId);
    const modelId = readString(result?.model);
    if (modelId) {
      this.threadModelBySession.set(threadId, modelId);
      if (!opts.preserveActiveModel) {
        this.activeModelId = modelId;
        this.refreshContextUsage();
      }
    }
    this.emitState();
  }

  private async applyActiveModelToThread(
    threadId: string,
    modelId: string | null | undefined,
  ): Promise<void> {
    const nextModelId = readString(modelId);
    if (!nextModelId) return;
    if (this.threadModelBySession.get(threadId) === nextModelId) return;
    if (
      this.supportedAppServerMethods.size > 0 &&
      !this.supportedAppServerMethods.has(CODEX_THREAD_SETTINGS_UPDATE_METHOD)
    ) {
      return;
    }
    try {
      await this.appServer?.request(CODEX_THREAD_SETTINGS_UPDATE_METHOD, {
        threadId,
        model: nextModelId,
      });
      this.threadModelBySession.set(threadId, nextModelId);
      this.noteModel(nextModelId);
    } catch {}
  }
  private emitThreadItem(
    item: Record<string, unknown> | null,
    opts: { threadId: string | null; running: boolean },
  ): void {
    emitCodexThreadItem(item, opts, {
      activeSessionId: this.activeSessionId,
      resumeSessionId: this.resumeSessionId,
      activeModelId: this.activeModelId,
      activePromptMode: this.activePromptMode,
      emptyThreadIds: this.emptyThreadIds,
      lastAssistantMessageBySession: this.lastAssistantMessageBySession,
      pushEvent: (type, payload) => this.pushEvent(type, payload),
    });
  }



  private bindPendingSession(pendingSessionId: string, sessionId: string): void {
    if (!pendingSessionId || !sessionId) return;
    const changed =
      this.activeSessionId !== sessionId ||
      this.resumeSessionId !== sessionId ||
      this.sdkSessionId !== sessionId;
    this.activeSessionId = sessionId;
    this.resumeSessionId = sessionId;
    this.sdkSessionId = sessionId;
    this.applyStoredUsageForSession(sessionId);
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

  private finishWebPrompts(error: Error): void {
    for (const item of this.promptQueue.splice(0)) {
      item.reject(error);
    }
    this.promptActive = false;
  }

  private rejectPendingRequests(error: Error): void {
    const hadPendingRequests = this.pendingPermissions.size > 0 || this.pendingQuestions.size > 0;
    for (const pending of this.pendingPermissions.values()) {
      pending.reject(error);
    }
    this.pendingPermissions.clear();
    for (const pending of this.pendingQuestions.values()) {
      pending.reject(error);
    }
    this.pendingQuestions.clear();
    if (!hadPendingRequests) return;
    this.pushEvent("permission-resolved", { id: "all", approved: false });
    this.pushEvent("question.rejected", { id: "all" });
  }

  private hasActiveWebRun(): boolean {
    return this.ownerValue === "web" && (
      this.busyValue ||
      this.thinkingValue ||
      this.promptActive ||
      this.activeTurnId !== null ||
      this.pendingPermissions.size > 0 ||
      this.pendingQuestions.size > 0
    );
  }

  private finishActiveRunAsAborted(input: {
    errorMessage: string;
    eventMessage: string;
    interruptTurn: false;
  }): void;
  private finishActiveRunAsAborted(input: {
    errorMessage: string;
    eventMessage: string;
    interruptTurn: true;
  }): Promise<void>;
  private finishActiveRunAsAborted(input: {
    errorMessage: string;
    eventMessage: string;
    interruptTurn: boolean;
  }): void | Promise<void> {
    const sessionId = this.activeSessionId ?? this.resumeSessionId;
    const turnId = this.activeTurnId;
    const hadActiveRun = this.hasActiveWebRun();
    const error = new Error(input.errorMessage);

    this.finishWebPrompts(error);
    this.rejectPendingRequests(error);
    this.activeTurnId = null;
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

    if (!input.interruptTurn) {
      emitAbortEvent();
      return;
    }

    return (async () => {
      if (sessionId && turnId) {
        try {
          await this.appServer?.request("turn/interrupt", { threadId: sessionId, turnId });
        } catch {}
      }
      emitAbortEvent();
    })();
  }

  private acceptsSteerSessionId(sessionIdInput: string, threadId: string): boolean {
    const sessionId = sessionIdInput.trim();
    if (!sessionId) return true;
    if (sessionId.startsWith("pending_")) return true;
    return [
      threadId,
      this.activeSessionId,
      this.resumeSessionId,
      this.sdkSessionId,
    ].some((id) => id === sessionId);
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

  private emitState(): void {
    this.emit("state", this.state);
    this.pushEvent("state", {
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
      lastTokenUsage: this.lastTokenUsage,
      createdAt: Date.now(),
    });
  }

  private refreshContextUsage(): void {
    const sessionId = this.currentUsageSessionId();
    const tokenUsage = sessionId
      ? this.lastTokenUsageBySession.get(sessionId) ?? null
      : this.lastTokenUsage;
    this.lastTokenUsage = tokenUsage;
    const runtimeContextWindow = sessionId
      ? this.contextWindowBySession.get(sessionId) ?? null
      : this.contextWindow;
    this.contextWindow = runtimeContextWindow;
    const nextUsage = buildCodexContextUsage(
      tokenUsage,
      this.activeModelId,
      runtimeContextWindow,
    );
    if (!nextUsage) {
      this.contextUsage = null;
      if (sessionId) this.contextUsageBySession.delete(sessionId);
      return;
    }
    if (isSameContextUsage(this.contextUsage, nextUsage)) return;
    this.contextUsage = nextUsage;
    if (sessionId) this.contextUsageBySession.set(sessionId, nextUsage);
  }

  private currentUsageSessionId(): string | null {
    return this.activeSessionId ?? this.resumeSessionId ?? this.sdkSessionId;
  }

  private pickLocalResumeSessionId(): string | null {
    const seen = new Set<string>();
    for (const id of [this.resumeSessionId, this.activeSessionId, this.sdkSessionId]) {
      const sessionId = readString(id);
      if (!sessionId || seen.has(sessionId)) continue;
      seen.add(sessionId);
      if (isCodexThreadSavedForCwd({ cwd: this.opts.cwd, threadId: sessionId })) {
        return sessionId;
      }
    }
    return null;
  }

  private applyStoredUsageForSession(sessionId: string | null): void {
    if (!sessionId) {
      this.contextUsage = null;
      this.lastTokenUsage = null;
      this.contextWindow = null;
      return;
    }
    this.lastTokenUsage = this.lastTokenUsageBySession.get(sessionId) ?? null;
    this.contextWindow = this.contextWindowBySession.get(sessionId) ?? null;
    this.contextUsage = this.contextUsageBySession.get(sessionId) ?? null;
  }

  private pushEvent(type: string, payload: Record<string, unknown>): void {
    if (type === "error" && this.ownerValue === "web") {
      writeCliAgentErrorToTerminal("adit cloud codex", payload);
    }
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

  private async hydrateAppServerCapabilities(): Promise<void> {
    await this.ensureAppServer();
    try {
      let methods = await this.discoverAppServerMethods();
      if (methods.size === 0) {
        // Discovery parses the supported-method list out of the app-server's
        // error message; when that format changes we would otherwise filter
        // out every command. Assume the standard method set instead.
        methods = new Set(CODEX_CLOUD_SLASH_COMMAND_SPECS.map((spec) => spec.method));
      }
      this.supportedAppServerMethods = methods;

      const [skills, mcpServers] = await Promise.all([
        methods.has("skills/list")
          ? this.fetchCodexSkillsWithRetry().catch(() => [] as Array<Record<string, unknown>>)
          : Promise.resolve([] as Array<Record<string, unknown>>),
        methods.has("mcpServerStatus/list")
          ? this.fetchCodexMcpServers().catch(() => [] as Array<Record<string, unknown>>)
          : Promise.resolve([] as Array<Record<string, unknown>>),
      ]);
      this.codexSkills = skills;
      this.codexMcpServers = mcpServers;
    } catch {
      this.resetAppServerCapabilities();
    }
    this.refreshSlashCommands();
  }

  private async discoverAppServerMethods(): Promise<Set<string>> {
    if (!this.appServer) return new Set<string>();
    try {
      await this.appServer.request(CODEX_CAPABILITY_DISCOVERY_METHOD, {});
      return new Set<string>();
    } catch (error) {
      return extractCodexSupportedMethodsFromError(error);
    }
  }

  private async fetchCodexSkills(): Promise<Array<Record<string, unknown>>> {
    const result = await this.appServer?.request("skills/list", {
      cwds: [this.opts.cwd],
      forceReload: false,
    });
    return extractCodexSkills(result);
  }

  private async fetchCodexSkillsWithRetry(): Promise<Array<Record<string, unknown>>> {
    let lastSkills: Array<Record<string, unknown>> = [];
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= CODEX_SYSTEM_SKILLS_RETRY_DELAYS_MS.length; attempt += 1) {
      const sawDeferredBeforeRequest = this.appServer?.hasDeferredSystemSkillsStderr?.() ?? false;
      try {
        const skills = await this.fetchCodexSkills();
        const sawDeferredAfterRequest = this.appServer?.hasDeferredSystemSkillsStderr?.() ?? false;
        const sawTransientSystemSkillsError = sawDeferredBeforeRequest || sawDeferredAfterRequest;
        if (!sawTransientSystemSkillsError) return skills;

        lastSkills = skills;
        if (attempt < CODEX_SYSTEM_SKILLS_RETRY_DELAYS_MS.length) {
          this.appServer?.clearDeferredSystemSkillsStderr?.();
          await delay(CODEX_SYSTEM_SKILLS_RETRY_DELAYS_MS[attempt]);
          continue;
        }

        this.appServer?.flushDeferredSystemSkillsStderr?.();
        return skills;
      } catch (error) {
        lastError = error;
        const sawDeferredAfterRequest = this.appServer?.hasDeferredSystemSkillsStderr?.() ?? false;
        const sawTransientSystemSkillsError = sawDeferredBeforeRequest || sawDeferredAfterRequest;
        if (sawTransientSystemSkillsError && attempt < CODEX_SYSTEM_SKILLS_RETRY_DELAYS_MS.length) {
          this.appServer?.clearDeferredSystemSkillsStderr?.();
          await delay(CODEX_SYSTEM_SKILLS_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        this.appServer?.flushDeferredSystemSkillsStderr?.();
        throw error;
      }
    }

    if (lastError) throw lastError;
    return lastSkills;
  }

  private async fetchCodexMcpServers(): Promise<Array<Record<string, unknown>>> {
    const result = await this.appServer?.request("mcpServerStatus/list", {
      detail: "toolsAndAuthOnly",
    });
    return extractCodexMcpServers(result);
  }

  private async resolveSkillSlashCommand(name: string): Promise<Record<string, unknown> | null> {
    if (!this.skillSlashCommandsByName.has(name)) return null;
    await this.ensureAppServer();
    this.codexSkills = await this.fetchCodexSkillsWithRetry();
    this.refreshSlashCommands();
    return this.skillSlashCommandsByName.get(name) ?? null;
  }

  private async resolveMcpSlashCommand(name: string): Promise<Record<string, unknown> | null> {
    if (!this.mcpSlashCommandsByName.has(name)) return null;
    await this.ensureAppServer();
    this.codexMcpServers = await this.fetchCodexMcpServers();
    this.refreshSlashCommands();
    return this.mcpSlashCommandsByName.get(name) ?? null;
  }

  private resetAppServerCapabilities(): void {
    this.supportedAppServerMethods = new Set<string>();
    this.slashCommandsByName = new Map<string, CliSlashCommandInfo>();
    this.skillSlashCommandsByName = new Map<string, Record<string, unknown>>();
    this.mcpSlashCommandsByName = new Map<string, Record<string, unknown>>();
    this.codexSkills = [];
    this.codexMcpServers = [];
  }

  private refreshSlashCommands(): void {
    const commands = CODEX_CLOUD_SLASH_COMMAND_SPECS
      .filter((spec) => this.supportedAppServerMethods.has(spec.method))
      .map((spec) => this.codexSlashCommandInfo(spec));
    this.skillSlashCommandsByName = new Map<string, Record<string, unknown>>();
    this.mcpSlashCommandsByName = new Map<string, Record<string, unknown>>();
    const reservedCommandNames = new Set(commands.map((command) => command.name.toLowerCase()));
    const skillCommands = this.supportedAppServerMethods.has("skills/list")
      ? this.codexSkillSlashCommands(reservedCommandNames)
      : [];
    for (const command of skillCommands) reservedCommandNames.add(command.name.toLowerCase());
    const mcpCommands = this.supportedAppServerMethods.has("mcpServerStatus/list")
      ? this.codexMcpSlashCommands(reservedCommandNames)
      : [];
    commands.push(...skillCommands, ...mcpCommands);
    this.slashCommandsByName = new Map(
      commands.map((command) => [command.name.toLowerCase(), command]),
    );
    this.emitSlashCommands();
  }

  private codexSlashCommandInfo(spec: CodexSlashCommandSpec): CliSlashCommandInfo {
    if (spec.name === "skills") {
      return {
        name: spec.name,
        description: `List ${this.codexSkills.length} Codex ${pluralize("skill", this.codexSkills.length)}`,
      };
    }
    if (spec.name === "mcp") {
      return {
        name: spec.name,
        description: `Show ${this.codexMcpServers.length} Codex MCP ${pluralize("server", this.codexMcpServers.length)}`,
      };
    }
    return { name: spec.name, description: spec.description };
  }

  private codexSkillSlashCommands(reservedNames: Set<string>): CliSlashCommandInfo[] {
    const commands: CliSlashCommandInfo[] = [];
    const skillCommands = new Map<string, Record<string, unknown>>();
    for (const skill of this.codexSkills) {
      if (skill.enabled === false) continue;
      const rawName = readString(skill.name);
      if (!rawName) continue;
      const name = normalizeSlashCommandName(rawName);
      if (!name || reservedNames.has(name) || skillCommands.has(name)) continue;
      skillCommands.set(name, skill);
      commands.push({
        name,
        description: `Use Codex skill: ${
          readString(skill.displayName) ??
          readString(skill.description) ??
          rawName
        }`,
      });
    }
    this.skillSlashCommandsByName = skillCommands;
    return commands;
  }

  private codexMcpSlashCommands(reservedNames: Set<string>): CliSlashCommandInfo[] {
    const commands: CliSlashCommandInfo[] = [];
    const mcpCommands = new Map<string, Record<string, unknown>>();
    for (const server of this.codexMcpServers) {
      const rawName = readString(server.name);
      if (!rawName) continue;
      const slug = normalizeSlashCommandName(rawName);
      if (!slug) continue;
      const name = `${CODEX_MCP_SLASH_COMMAND_PREFIX}${slug}`;
      if (reservedNames.has(name) || mcpCommands.has(name)) continue;
      mcpCommands.set(name, server);
      commands.push({
        name,
        description: `Show Codex MCP server: ${rawName}`,
      });
    }
    this.mcpSlashCommandsByName = mcpCommands;
    return commands;
  }

  private emitSlashCommands(): void {
    this.pushEvent("slash-commands", {
      provider: this.provider,
      commands: Array.from(this.slashCommandsByName.values()),
      createdAt: Date.now(),
    });
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: process.env.TERM || "xterm-256color",
      COLORTERM: process.env.COLORTERM || "truecolor",
      FORCE_COLOR: process.env.FORCE_COLOR || "3",
      DISABLE_AUTOUPDATER: "1",
    };
    if (this.opts.hookEndpoint) {
      env.ADIT_CLOUD_CODEX_HOOK_ENDPOINT = this.opts.hookEndpoint;
    }
    if (this.opts.hookMarker) {
      env.ADIT_CLOUD_CODEX_HOOK_MARKER = this.opts.hookMarker;
    }
    return env;
  }

  private attachReclaimInput(): void {
    if (this.reclaimAttached || !process.stdin.isTTY) return;
    this.reclaimAttached = true;
    this.reclaimBuffer = "";
    try {
      restoreTerminalForCodexReclaim();
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
    const normalized = normalizeCodexReclaimInput(text);
    if (text.includes("\u0003") || normalized.includes("\u0003")) {
      this.stop();
      this.emit("exit", { code: null, signal: "SIGINT" });
      return;
    }
    this.reclaimBuffer = applyReclaimText(this.reclaimBuffer, normalized);
    if (this.reclaimBuffer.length > 200) {
      this.reclaimBuffer = this.reclaimBuffer.slice(-200);
    }
    if (this.reclaimBuffer.includes(RECLAIM_COMMAND)) {
      this.reclaimBuffer = "";
      void this.releaseToLocal();
      return;
    }
    if (text.includes("\n") || text.includes("\r")) {
      writeCodexTerminalNotice(
        `[adit cloud codex] Web owns this session. Type ${RECLAIM_COMMAND} to reclaim.\n`,
      );
    }
  };
}
