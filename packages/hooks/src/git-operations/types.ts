import type { Platform } from "@varveai/adit-core";

/** Provider adapters normalize their transcript format before shared Git parsing. */
export interface TranscriptShellCall {
  id: string;
  /** Stable ordinal for multiple executions inside a single provider call. */
  executionIndex?: number;
  command: string;
  cwd?: string;
  output?: string | null;
  success: boolean;
}

export interface AgentGitOperation {
  provider: Platform;
  toolCallId: string;
  operationIndex: number;
  operation: string;
  status: "success" | "error";
  cwd: string;
  output: string | null;
  commitMessage: string | null;
}

export interface ExtractGitOperationsInput {
  platform: Platform;
  transcriptPath: string;
  expectedSessionId?: string;
  defaultCwd: string;
}

export interface ParsedGitCommand {
  operation: string;
  cwd: string;
  commitMessage?: string | null;
}
