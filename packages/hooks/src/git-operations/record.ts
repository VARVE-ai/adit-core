import { isAbsolute, relative, resolve } from "node:path";
import {
  hasGitCommitEvent,
  type LocalRepository,
} from "@varveai/adit-core";
import { runGit, type TimelineManager } from "@varveai/adit-engine";
import type { NormalizedHookInput } from "../adapters/types.js";
import type { HookContext } from "../common/context.js";
import { debugLog } from "../common/debug-log.js";
import { extractGitOperations } from "./extract.js";
import type { AgentGitOperation } from "./types.js";

interface GitOperationDetails {
  repository: LocalRepository | null;
  branch: string | null;
  sha: string | null;
  commitMessage: string | null;
}

/** Record successful git commit commands the agent actually executed in the completed turn. */
export async function recordGitCommits(
  ctx: HookContext,
  input: NormalizedHookInput,
  timeline: TimelineManager,
): Promise<void> {
  if (!input.transcriptPath || !input.platformCli) return;

  let operations: AgentGitOperation[];
  try {
    operations = extractGitOperations({
      platform: input.platformCli,
      transcriptPath: input.transcriptPath,
      expectedSessionId: input.platformSessionId,
      defaultCwd: input.cwd,
    });
  } catch (error) {
    debugLog({ phase: "git-operation-extraction-failed", error: String(error) });
    return;
  }

  for (const operation of operations) {
    if (operation.operation !== "commit" || operation.status !== "success") continue;

    try {
      if (hasGitCommitEvent(
        ctx.db,
        ctx.session.id,
        operation.provider,
        operation.toolCallId,
        operation.operationIndex,
      )) continue;

      const details = await resolveOperationDetails(ctx, operation);
      const toolInputJson = JSON.stringify({
        schemaVersion: 1,
        provider: operation.provider,
        toolCallId: operation.toolCallId,
        operationIndex: operation.operationIndex,
        localRepositoryId: details.repository?.localRepositoryId ?? null,
        relativePath: details.repository?.relativePath ?? null,
        workingDirectory: relativeWorkingDirectory(details.repository, operation.cwd),
        commitMessage: details.commitMessage,
      });

      await timeline.recordEvent({
        sessionId: ctx.session.id,
        eventType: "git_commit",
        actor: "assistant",
        responseText: commitSubject(details.commitMessage) ?? "Git commit",
        toolName: "commit",
        toolInputJson,
        gitBranch: details.branch,
        gitHeadSha: details.sha,
        status: operation.status,
      });
    } catch (error) {
      if (!isUniqueConstraint(error)) {
        debugLog({
          phase: "git-operation-record-failed",
          operation: operation.operation,
          error: String(error),
        });
      }
    }
  }
}

async function resolveOperationDetails(
  ctx: HookContext,
  operation: AgentGitOperation,
): Promise<GitOperationDetails> {
  const repository = findRepository(ctx.config.repositories, operation.cwd);
  if (!operation.output) {
    return { repository, branch: null, sha: null, commitMessage: null };
  }

  const candidate = explicitShaCandidate(operation.operation, operation.output);
  const sha = repository && candidate
    ? await validateCommitSha(repository.path, candidate)
    : null;
  const commitMessage = repository && sha
    ? await readCommitMessage(repository.path, sha)
    : explicitCommitSubject(operation.operation, operation.output);

  return {
    repository,
    branch: explicitBranch(operation.output),
    sha,
    commitMessage,
  };
}

function commitSubject(message: string | null): string | null {
  return message?.split(/\r?\n/u, 1)[0]?.trim() || null;
}

function explicitCommitSubject(operation: string, output: string): string | null {
  if (operation !== "commit") return null;
  const match = output.match(/^\[[^\]\r\n]+\]\s+([^\r\n]+)$/mu);
  return match?.[1]?.trim() || null;
}

function findRepository(repositories: LocalRepository[], cwd: string): LocalRepository | null {
  const absoluteCwd = resolve(cwd);
  return repositories
    .filter((repository) => isInsideOrEqual(absoluteCwd, resolve(repository.path)))
    .sort((a, b) => resolve(b.path).length - resolve(a.path).length)[0] ?? null;
}

function isInsideOrEqual(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function relativeWorkingDirectory(repository: LocalRepository | null, cwd: string): string | null {
  if (!repository) return null;
  const rel = relative(resolve(repository.path), resolve(cwd)).replace(/\\/gu, "/");
  return rel || ".";
}

function explicitShaCandidate(operation: string, output: string): string | null {
  const trimmed = output.trim();
  if (/^[0-9a-f]{7,64}$/iu.test(trimmed)) return trimmed;

  if (operation === "commit") {
    const bracket = output.match(/^\[[^\]\n]+\s([0-9a-f]{7,64})\](?:\s|$)/imu);
    if (bracket?.[1]) return bracket[1];
  }

  return null;
}

function explicitBranch(output: string): string | null {
  const switched = output.match(/(?:Switched to branch|Already on) ['"]([^'"]+)['"]/iu);
  if (switched?.[1]) return switched[1];

  const bracket = output.match(/^\[([^\]\n]+?)\s(?:\(root-commit\)\s)?[0-9a-f]{7,64}\](?:\s|$)/imu);
  return bracket?.[1]?.trim() || null;
}

async function validateCommitSha(repositoryPath: string, candidate: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", `${candidate}^{commit}`], {
    cwd: repositoryPath,
    timeout: 5_000,
  });
  const sha = result.stdout.trim();
  return result.exitCode === 0 && /^[0-9a-f]{40,64}$/iu.test(sha) ? sha : null;
}

async function readCommitMessage(repositoryPath: string, sha: string): Promise<string | null> {
  const result = await runGit(["show", "-s", "--format=%B", sha], {
    cwd: repositoryPath,
    timeout: 5_000,
  });
  const message = result.stdout.trim();
  return result.exitCode === 0 && message ? message : null;
}

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && String((error as { code?: unknown }).code) === "SQLITE_CONSTRAINT_UNIQUE";
}
