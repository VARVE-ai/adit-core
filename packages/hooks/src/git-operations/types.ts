import type { Platform } from "@varveai/adit-core";

export interface AgentGitOperation {
  provider: Platform;
  toolCallId: string;
  operationIndex: number;
  operation: string;
  status: "success" | "error";
  cwd: string;
  output: string | null;
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
}
