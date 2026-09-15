/**
 * Unified hook dispatcher.
 *
 * Platform-agnostic handler that processes normalized hook input
 * and delegates to the appropriate ADIT handler.
 */

import {
  withPerf,
  insertDiff,
  generateId,
} from "@varveai/adit-core";
import {
  createTimelineManager,
  captureEnvironment,
  type FileChange,
} from "@varveai/adit-engine";
import { initHookContext, type HookContext } from "../common/context.js";
import {
  assistantTextFromTranscriptEntry,
  type TranscriptEntryLike,
} from "../common/transcript-entry.js";
import { recordGitCommits } from "../git-operations/index.js";
import { debugLog } from "../common/debug-log.js";
import {
  classifyPromptSubmit,
  type PromptSubmitClassification,
} from "../common/system-prompt.js";
import { existsSync, readFileSync } from "node:fs";
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
import {
  appendPendingInferred,
  captureWorkingTree,
  diffWorkingTreesWithPatch,
  mergeInferredFiles,
  pendingToMutations,
  takePendingInferred,
  takeToolSnapshot,
  toProjectRelativeChanges,
  writeToolSnapshot,
  inferredSourceFor,
  type InferredFileChange,
  type RepositoryTreeSnapshot,
  type SnapshotProvider,
} from "../bash-snapshot/index.js";

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
    { projectRoot: options.projectRoot, transcriptPath: input.transcriptPath ?? null },
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
        case "pre-tool-use":
          await handlePreToolUse(ctx, input);
          break;
        case "post-tool-use":
          await handlePostToolUse(ctx, input);
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
    || hookType === "pre-tool-use"
    || hookType === "post-tool-use";
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
  return hookType === "stop";
}

/** Handle prompt submission (kept lightweight — no git operations) */
async function handlePromptSubmitUnified(ctx: HookContext, input: NormalizedHookInput): Promise<void> {
  // Bash snapshots queued since the last Stop are deliberately kept: a prompt
  // appended while the agent is still working joins the running turn (no Stop
  // fires in between), so clearing here would drop the files it changed so
  // far. They all land on the next assistant_response.
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

  // Files changed by Bash commands during this turn (working-tree snapshot
  // diffs). They join the editing-tool mutations — same diff_stat/diff_text
  // pipeline, tagged source "claude-bash-snapshot" — and additionally land
  // as a complete path-only list in inferred_files_json for commit matching
  // (diff bodies can be omitted for size; the path list never is).
  let inferredFilesJson: string | null = null;
  const snapshotProvider = bashSnapshotProvider(input.platformCli);
  if (snapshotProvider) {
    try {
      const pending = takePendingInferred(ctx.config.dataDir, ctx.session.id);
      const inferred = mergeInferredFiles(pending, {
        exclude: mutations.map((m) => m.path),
        source: inferredSourceFor(snapshotProvider),
      });
      if (inferred.length > 0) inferredFilesJson = JSON.stringify(inferred);
      const bashMutations = pendingToMutations(pending, snapshotProvider);
      if (bashMutations.length > 0) {
        mutations = [...mutations, ...bashMutations];
        mutationStatJson = JSON.stringify(buildDiffStat(mutations));
      }
    } catch (err) {
      debugLog({ phase: "inferred-files-merge-failed", error: String(err) });
    }
  }

  const changedFiles = changesFromMutations(mutations);

  const event = await timeline.recordEvent({
    sessionId: ctx.session.id,
    eventType: "assistant_response",
    actor: "assistant",
    responseText,
    diffStatJson: mutationStatJson,
    inferredFilesJson,
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

  // Record only successful git commit commands actually executed in this turn.
  await withPerf(ctx.config.dataDir, "git", "gitCommits", () =>
    recordGitCommits(ctx, input, timeline),
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

/** Platforms whose shell tool calls are snapshotted (hook tool_name "Bash"). */
function bashSnapshotProvider(platformCli: NormalizedHookInput["platformCli"]): SnapshotProvider | null {
  if (platformCli === "claude-code" || platformCli === "claude-vscode" || platformCli === "codex" || platformCli === "cursor") {
    return platformCli;
  }
  return null;
}

/**
 * Only the shell tool is snapshotted. Background commands (Claude) are
 * skipped: their PostToolUse fires when the command is dispatched, not when
 * it finishes, so there is no window to diff.
 */
function isBashSnapshotCandidate(input: NormalizedHookInput): boolean {
  if (!bashSnapshotProvider(input.platformCli)) return false;
  if (input.toolName !== "Bash" || !input.toolUseId) return false;
  return input.toolInput?.run_in_background !== true;
}

/** PreToolUse(Bash): record the working tree of every project repository. */
async function handlePreToolUse(ctx: HookContext, input: NormalizedHookInput): Promise<void> {
  if (!isBashSnapshotCandidate(input) || !input.toolUseId) return;
  const repositories = ctx.config.repositories;
  if (repositories.length === 0) return;
  const startedAt = new Date().toISOString();

  const captured = await Promise.all(
    repositories.map(async (repository): Promise<RepositoryTreeSnapshot | null> => {
      try {
        const capture = await captureWorkingTree(repository.path);
        if (!capture) return null;
        return {
          localRepositoryId: repository.localRepositoryId,
          relativePath: repository.relativePath,
          path: repository.path,
          tree: capture.tree,
          head: capture.head,
        };
      } catch (err) {
        debugLog({ phase: "bash-snapshot-capture-failed", error: String(err) });
        return null;
      }
    }),
  );
  const snapshots = captured.filter((s): s is RepositoryTreeSnapshot => s !== null);
  if (snapshots.length === 0) return;

  try {
    writeToolSnapshot(ctx.config.dataDir, ctx.session.id, {
      toolUseId: input.toolUseId,
      promptId: input.promptId ?? input.turnId ?? null,
      startedAt,
      repositories: snapshots,
    });
  } catch (err) {
    debugLog({ phase: "bash-snapshot-write-failed", error: String(err) });
  }
}

/** PostToolUse(Bash): diff against the PreToolUse snapshot and queue the changed files. */
async function handlePostToolUse(ctx: HookContext, input: NormalizedHookInput): Promise<void> {
  if (!isBashSnapshotCandidate(input) || !input.toolUseId) return;
  const snapshot = takeToolSnapshot(ctx.config.dataDir, ctx.session.id, input.toolUseId);
  if (!snapshot) return;

  const files: InferredFileChange[] = [];
  await Promise.all(
    snapshot.repositories.map(async (repository) => {
      try {
        const after = await captureWorkingTree(repository.path);
        if (!after || after.tree === repository.tree) return;
        // HEAD moved: the command was a checkout/pull/reset, and the files it
        // touched are history moving, not the agent's edits.
        if (after.head !== repository.head) {
          debugLog({ phase: "bash-snapshot-head-moved", toolUseId: input.toolUseId });
          return;
        }
        const changes = await diffWorkingTreesWithPatch(repository.path, repository.tree, after.tree);
        files.push(...toProjectRelativeChanges(changes, {
          repositoryRelativePath: repository.relativePath,
          projectRoot: ctx.config.projectRoot,
          dataDir: ctx.config.dataDir,
        }));
      } catch (err) {
        debugLog({ phase: "bash-snapshot-diff-failed", error: String(err) });
      }
    }),
  );
  if (files.length === 0) return;

  try {
    appendPendingInferred(ctx.config.dataDir, ctx.session.id, {
      toolUseId: input.toolUseId,
      promptId: input.promptId ?? input.turnId ?? snapshot.promptId,
      recordedAt: new Date().toISOString(),
      files,
    });
  } catch (err) {
    debugLog({ phase: "bash-snapshot-append-failed", error: String(err) });
  }
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

