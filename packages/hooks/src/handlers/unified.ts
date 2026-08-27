/**
 * Unified hook dispatcher.
 *
 * Platform-agnostic handler that processes normalized hook input
 * and delegates to the appropriate ADIT handler.
 */

import {
  mergeSessionMetadata,
  withPerf,
  insertDiff,
  generateId,
  type LocalRepository,
} from "@varveai/adit-core";
import {
  createTimelineManager,
  captureEnvironment,
  getCurrentBranch,
  getHeadSha,
  type FileChange,
} from "@varveai/adit-engine";
import { initHookContext, type HookContext } from "../common/context.js";
import {
  assistantTextFromTranscriptEntry,
  type TranscriptEntryLike,
} from "../common/transcript-entry.js";
import {
  detectAndRecordCommits,
  initializeSessionRepoBaselines,
} from "../common/commit-attribution.js";
import { debugLog } from "../common/debug-log.js";
import {
  classifyPromptSubmit,
  type PromptSubmitClassification,
} from "../common/system-prompt.js";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { NormalizedHookInput } from "../adapters/types.js";
import {
  extractClaudeMutationsFromTranscript,
  extractCodexMutationsFromTranscript,
  extractGeminiMutationsFromTranscript,
  extractCursorMutationsFromTranscript,
  buildDiffStat,
  buildBoundedDiffText,
  normalizeMutationPaths,
  type AgentFileMutation,
} from "../mutations/index.js";

/**
 * Dispatch a normalized hook input to the appropriate handler.
 * This is the single entry point for all platform hook events.
 */
export interface DispatchHookOptions {
  projectRoot?: string | null;
}

export async function dispatchHook(
  input: NormalizedHookInput,
  options: DispatchHookOptions = {},
): Promise<void> {
  // Older installs can still invoke retired hook commands. Reject them before
  // context initialization so a stale SessionEnd command cannot create an
  // otherwise empty local session.
  if (!isHandledHookType(input.hookType)) return;

  const ctx = await initHookContext(
    input.cwd,
    input.platformCli ?? "other",
    input.platformSessionId,
    { projectRoot: options.projectRoot },
  );
  if (!ctx) return;

  const dataDir = ctx.config.dataDir;

  try {
    if (isIgnoredSystemSession(ctx)) return;

    const classification =
      input.hookType === "prompt-submit"
        ? classifyPromptSubmit(input.prompt, { agentId: input.agentId })
        : null;
    if (classification && classification.kind !== "user") {
      await withPerf(dataDir, "hook", `system-${classification.kind}`, () =>
        handleClassifiedPromptSubmit(ctx, input, classification),
      );
      return;
    }

    await withPerf(dataDir, "hook", input.hookType, async () => {
      switch (input.hookType) {
        case "prompt-submit":
          await handlePromptSubmitUnified(ctx, input);
          break;
        case "stop":
          await handleStopUnified(ctx, input);
          break;
        case "session-start":
          await handleSessionStart(ctx, input);
          break;
        case "subagent-start":
          await handleSubagentStart(ctx, input);
          break;
        case "subagent-stop":
          await handleSubagentStop(ctx, input);
          break;
      }
    });

    // Auto-sync to cloud on stable hook boundaries (fail-open).
    // Uses dynamic import so @varveai/adit-cloud is not a build-time dependency.
    // The module name is constructed to prevent TypeScript from resolving it.
    // Stable hook boundaries use the count/time thresholds in triggerAutoSync.
    // prompt-submit is deliberately skipped so cloud does not receive half a turn
    // containing a user prompt without its assistant response.
    if (shouldTriggerCloudAutoSync(input.hookType)) {
      try {
        await withPerf(dataDir, "network", "cloud-auto-sync", async () => {
          const cloudModuleName = ["@varveai", "adit-cloud"].join("/");
          const cloudModule = await import(cloudModuleName) as {
            triggerAutoSync: (
              db: unknown,
              projectId: string,
              options?: { projectRoot?: string },
            ) => Promise<void>;
          };
          // Awaited so db stays open until triggerAutoSync finishes querying and pushing.
          await cloudModule.triggerAutoSync(ctx.db, ctx.config.projectId, {
            projectRoot: ctx.config.projectRoot,
          });
        });
      } catch {
        // @varveai/adit-cloud not installed — silently skip
      }
    }
  } finally {
    ctx.db.close();
  }
}

function isHandledHookType(hookType: string): boolean {
  return hookType === "prompt-submit"
    || hookType === "stop"
    || hookType === "session-start"
    || hookType === "subagent-start"
    || hookType === "subagent-stop";
}

interface IgnoredSessionMetadata {
  aditIgnored?: {
    reason?: string;
    kind?: string;
    originalLength?: number;
    originalHash?: string;
    markedAt?: string;
  };
}

function isIgnoredSystemSession(ctx: HookContext): boolean {
  const metadata = parseSessionMetadata(ctx.session.metadataJson);
  return metadata.aditIgnored?.reason === "claude-mem-observer";
}

async function handleClassifiedPromptSubmit(
  ctx: HookContext,
  _input: NormalizedHookInput,
  classification: PromptSubmitClassification,
): Promise<void> {
  // System-generated prompts are never recorded as events. The only side
  // effect kept is marking claude-mem observer sessions as ignored so their
  // synthetic traffic stays out of the timeline entirely.
  if (classification.kind === "claude-mem-observer") {
    markIgnoredSystemSession(ctx, classification);
  }
}

function markIgnoredSystemSession(
  ctx: HookContext,
  classification: PromptSubmitClassification,
): void {
  const metadata = parseSessionMetadata(ctx.session.metadataJson);
  metadata.aditIgnored = {
    reason: "claude-mem-observer",
    kind: classification.kind,
    originalLength: classification.originalLength,
    originalHash: classification.originalHash,
    markedAt: new Date().toISOString(),
  };
  const metadataJson = JSON.stringify(metadata);
  ctx.db.prepare("UPDATE sessions SET metadata_json = ? WHERE id = ?").run(metadataJson, ctx.session.id);
  ctx.session.metadataJson = metadataJson;
}

function parseSessionMetadata(metadataJson: string | null): IgnoredSessionMetadata & Record<string, unknown> {
  if (!metadataJson) return {};
  try {
    const parsed = JSON.parse(metadataJson);
    return parsed && typeof parsed === "object"
      ? parsed as IgnoredSessionMetadata & Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function shouldTriggerCloudAutoSync(hookType: NormalizedHookInput["hookType"]): boolean {
  return hookType === "stop"
    || hookType === "subagent-start"
    || hookType === "subagent-stop";
}

/** Handle prompt submission (kept lightweight — no git operations) */
async function handlePromptSubmitUnified(ctx: HookContext, input: NormalizedHookInput): Promise<void> {
  if (!input.prompt) return;

  const timeline = createTimelineManager(ctx.db, ctx.config);

  // Only record the prompt text. Per-turn file mutation extraction is deferred
  // to handleStopUnified so this blocking UserPromptSubmit hook stays fast.
  await timeline.recordEvent({
    sessionId: ctx.session.id,
    eventType: "prompt_submit",
    actor: "user",
    promptText: input.prompt,
  });
}

/** Handle stop (assistant response complete) */
async function handleStopUnified(ctx: HookContext, input: NormalizedHookInput): Promise<void> {
  const timeline = createTimelineManager(ctx.db, ctx.config);

  // Use last_assistant_message as the response text (what the model actually said).
  // Cursor sometimes fires stop before transcript text is fully flushed, so
  // we retry transcript extraction briefly when message text is missing.
  // When no real message can be recovered, store null — never a synthetic
  // placeholder like stop_reason or "completed" that would pollute analysis.
  const responseText = input.lastAssistantMessage
    ?? await recoverAssistantMessageFromTranscript(input.transcriptPath)
    ?? null;

  // Extract file-edit mutations from the platform transcript.
  // Replaces the old git working-tree scan + auto-checkpoint flow.
  let mutations: AgentFileMutation[] = [];
  let mutationStatJson: string | null = null;
  const isClaudeFamily =
    input.platformCli === "claude-code" || input.platformCli === "claude-vscode";
  if (
    (isClaudeFamily || input.platformCli === "codex" || input.platformCli === "gemini" || input.platformCli === "cursor") &&
    input.transcriptPath
  ) {
    try {
      let extracted;
      if (input.platformCli === "codex") {
        extracted = extractCodexMutationsFromTranscript(input.transcriptPath);
      } else if (input.platformCli === "gemini") {
        extracted = extractGeminiMutationsFromTranscript(input.transcriptPath);
      } else if (input.platformCli === "cursor") {
        extracted = extractCursorMutationsFromTranscript(input.transcriptPath);
      } else {
        extracted = extractClaudeMutationsFromTranscript(input.transcriptPath, {
          provider: input.platformCli === "claude-vscode" ? "claude-vscode" : "claude-code",
        });
      }
      if (extracted) {
        // Normalize every path to project-root-relative before anything is
        // persisted: raw transcript paths are absolute (Claude/Gemini/Cursor)
        // or cwd-relative (Codex shell), which produced illegal
        // `diff --git a//Users/...` headers, leaked the local filesystem
        // layout to the cloud, and split path-keyed aggregations.
        mutations = normalizeMutationPaths(extracted.mutations, {
          projectRoot: ctx.config.projectRoot,
          cwd: input.cwd,
        });
        if (mutations.length > 0) {
          mutationStatJson = JSON.stringify(buildDiffStat(mutations));
        }
      }
    } catch (err) {
      // Best-effort: hook must not fail due to transcript parse errors
      debugLog({
        phase: "mutation-extraction-failed",
        transcriptPath: input.transcriptPath,
        error: String(err),
      });
    }
  }

  const changedFiles = changesFromMutations(mutations);
  // Mutation paths are project-root-relative after normalization, so repo
  // matching must resolve them against the project root, not the event cwd.
  const workspaceGitState = await resolveWorkspaceGitState(
    ctx,
    ctx.config.projectRoot,
    changedFiles,
  );

  const event = await timeline.recordEvent({
    sessionId: ctx.session.id,
    eventType: "assistant_response",
    actor: "assistant",
    responseText,
    diffStatJson: mutationStatJson,
    ...(workspaceGitState ? {
      gitBranch: workspaceGitState.gitBranch,
      gitHeadSha: workspaceGitState.gitHeadSha,
    } : {}),
  });

  // Persist bounded diff_text from mutations (replaces old git checkpoint path)
  if (mutations.length > 0) {
    const diffText = buildBoundedDiffText(mutations);
    if (diffText.length > 0) {
      try {
        insertDiff(ctx.db, {
          id: generateId(),
          eventId: event.id,
          diffText,
        });
      } catch (err) {
        // Best-effort; don't fail the hook over a diff write
        debugLog({
          phase: "mutation-diff-insert-failed",
          error: String(err),
        });
      }
    }
  }

  // Attribute commits made during this turn (fail-open inside).
  await withPerf(ctx.config.dataDir, "git", "commitAttribution", () =>
    detectAndRecordCommits(ctx, timeline),
  );

  // Environment snapshots stay local for the TUI env screen and snapshot
  // commands. They are intentionally excluded from cloud sync; the per-turn
  // env_drift comparison event was also retired because nothing consumed it.
  if (ctx.config.captureEnv) {
    try {
      // Pass per-turn mutation paths when available. Workspace stop hooks must
      // not scan the whole dirty working tree and accidentally attribute stale
      // edits to this turn.
      await withPerf(ctx.config.dataDir, "snapshot", "captureEnvironment", () =>
        captureEnvironment(
          ctx.db,
          ctx.config,
          ctx.session.id,
          ctx.config.projectType === "workspace"
            ? { changedFiles }
            : undefined,
        ),
      );
    } catch {
      // Fail-open
    }
  }
}

interface WorkspaceGitState {
  gitBranch: string | null;
  gitHeadSha: string | null;
}

function changesFromMutations(mutations: AgentFileMutation[]): FileChange[] {
  const changes: FileChange[] = [];
  const seen = new Set<string>();

  for (const mutation of mutations) {
    if (mutation.status !== "completed") continue;
    const path = mutation.path.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    changes.push({
      path,
      status: mutationKindToFileStatus(mutation.kind),
    });
  }

  return changes;
}

function mutationKindToFileStatus(kind: AgentFileMutation["kind"]): FileChange["status"] {
  if (kind === "add") return "A";
  if (kind === "delete") return "D";
  if (kind === "rename") return "R";
  return "M";
}

async function resolveWorkspaceGitState(
  ctx: HookContext,
  cwd: string,
  changedFiles: FileChange[],
): Promise<WorkspaceGitState | null> {
  if (ctx.config.projectType !== "workspace") return null;
  if (changedFiles.length === 0) return { gitBranch: null, gitHeadSha: null };

  const repositories = matchedWorkspaceRepositories(ctx, cwd, changedFiles);
  if (repositories.length === 0) return { gitBranch: null, gitHeadSha: null };

  const states = await Promise.all(
    repositories.map(async (repo) => ({
      branch: await safeGetCurrentBranch(repo.path),
      headSha: await safeGetHeadSha(repo.path),
    })),
  );

  return {
    gitBranch: joinNullable(states.map((state) => state.branch)),
    gitHeadSha: joinNullable(states.map((state) => state.headSha)),
  };
}

function matchedWorkspaceRepositories(
  ctx: HookContext,
  cwd: string,
  changedFiles: FileChange[],
): LocalRepository[] {
  const matched = new Map<string, LocalRepository>();

  for (const change of changedFiles) {
    const absPath = absoluteMutationPath(cwd, change.path);
    const repo = ctx.config.repositories.find((candidate) =>
      isPathInsideOrEqual(absPath, resolve(candidate.path)),
    );
    if (repo) matched.set(repo.path, repo);
  }

  return Array.from(matched.values());
}

function absoluteMutationPath(cwd: string, path: string): string {
  const normalized = path.replace(/\\/gu, "/");
  return resolve(isAbsolute(normalized) ? normalized : join(cwd, normalized));
}

function isPathInsideOrEqual(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function joinNullable(values: Array<string | null>): string | null {
  const filtered = values.filter((value): value is string => !!value);
  return filtered.length > 0 ? filtered.join(",") : null;
}

async function safeGetCurrentBranch(cwd: string): Promise<string | null> {
  try {
    return await getCurrentBranch(cwd);
  } catch {
    return null;
  }
}

async function safeGetHeadSha(cwd: string): Promise<string | null> {
  try {
    return await getHeadSha(cwd);
  } catch {
    return null;
  }
}

function extractLastAssistantTextFromTranscript(transcriptPath: string): string | undefined {
  if (!transcriptPath || !existsSync(transcriptPath)) return undefined;
  try {
    const lines = readFileSync(transcriptPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as TranscriptEntryLike;
        const text = assistantTextFromTranscriptEntry(entry);
        if (text) return text;
      } catch {
        // ignore malformed lines
      }
    }
  } catch {
    // fail-open
  }
  return undefined;
}

async function recoverAssistantMessageFromTranscript(transcriptPath?: string): Promise<string | undefined> {
  if (!transcriptPath) return undefined;
  const delaysMs = [0, 120, 240, 480, 800];
  for (const delayMs of delaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const text = extractLastAssistantTextFromTranscript(transcriptPath);
    if (text) return text;
  }
  return undefined;
}

/** Handle session start — capture initial env snapshot and record metadata */
async function handleSessionStart(ctx: HookContext, input: NormalizedHookInput): Promise<void> {
  // Seed per-repo HEAD baselines so first-turn commits are attributable.
  await initializeSessionRepoBaselines(ctx);

  // Persist launch context (model, source, permission mode) on the session
  // record. Replaces the legacy "checkpoint" marker event.
  const metadata: Record<string, unknown> = {};
  if (input.model) metadata.model = input.model;
  if (input.sessionSource) metadata.source = input.sessionSource;
  if (input.permissionMode) metadata.permissionMode = input.permissionMode;

  if (Object.keys(metadata).length > 0) {
    try {
      mergeSessionMetadata(ctx.db, ctx.session.id, metadata);
    } catch {
      // Fail-open
    }
  }

  if (ctx.config.captureEnv) {
    try {
      await withPerf(ctx.config.dataDir, "snapshot", "captureEnvironment", () =>
        captureEnvironment(ctx.db, ctx.config, ctx.session.id),
      );
    } catch {
      // Fail-open
    }
  }

}

/** Handle subagent start — record when a subagent is spawned */
async function handleSubagentStart(ctx: HookContext, input: NormalizedHookInput): Promise<void> {
  const timeline = createTimelineManager(ctx.db, ctx.config);

  await timeline.recordEvent({
    sessionId: ctx.session.id,
    eventType: "subagent_start",
    actor: "assistant",
    responseText: `Subagent started: ${input.agentType ?? "unknown"}`,
    toolName: input.agentType ?? null,
    toolInputJson: JSON.stringify({
      agentId: input.agentId,
      agentType: input.agentType,
    }),
  });
}

/** Handle subagent stop — record when a subagent finishes */
async function handleSubagentStop(ctx: HookContext, input: NormalizedHookInput): Promise<void> {
  const timeline = createTimelineManager(ctx.db, ctx.config);

  await timeline.recordEvent({
    sessionId: ctx.session.id,
    eventType: "subagent_stop",
    actor: "assistant",
    responseText: input.lastAssistantMessage
      ? `Subagent finished: ${input.agentType ?? "unknown"}`
      : `Subagent stopped: ${input.agentType ?? "unknown"}`,
    toolName: input.agentType ?? null,
    toolInputJson: JSON.stringify({
      agentId: input.agentId,
      agentType: input.agentType,
      agentTranscriptPath: input.agentTranscriptPath,
    }),
    toolOutputJson: input.lastAssistantMessage
      ? JSON.stringify({ lastAssistantMessage: input.lastAssistantMessage })
      : null,
  });
}
