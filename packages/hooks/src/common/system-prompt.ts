import { createHash } from "node:crypto";

export type PromptSubmitKind =
  | "user"
  | "task-notification"
  | "claude-mem-observer"
  | "subagent-prompt";

export interface PromptSubmitClassification {
  kind: PromptSubmitKind;
  originalLength: number;
  originalHash: string;
  observedUserRequest?: string;
}

const CLAUDE_SUMMARY_PREFIX =
  "Context: This summary will be shown in a list to help users and Claude choose which conversations are relevant.";

const CLAUDE_MEM_OBSERVER_MARKERS = [
  "<observed_from_primary_session>",
  "<user_request>",
  "Hello memory agent",
  "Claude-Mem",
  "Tool executions include the working directory",
  "OUTPUT FORMAT",
  "<observation>",
];

const CLAUDE_MEM_SUMMARY_MARKERS = [
  "Claude will see this summary when searching previous conversations for useful memories and information.",
  "Part summaries:",
];

export function classifyPromptSubmit(
  prompt: string | undefined,
  opts: { agentId?: string } = {},
): PromptSubmitClassification | null {
  if (!prompt) return null;

  const trimmed = prompt.trimStart();
  const base = {
    originalLength: prompt.length,
    originalHash: sha256Text(prompt),
  };

  if (trimmed.startsWith("<task-notification>")) {
    return { ...base, kind: "task-notification" };
  }

  if (isClaudeMemObserverPrompt(trimmed)) {
    return {
      ...base,
      kind: "claude-mem-observer",
      observedUserRequest: extractObservedUserRequest(prompt),
    };
  }

  if (opts.agentId) {
    return { ...base, kind: "subagent-prompt" };
  }

  return { ...base, kind: "user" };
}

export function isClaudeMemObserverPrompt(prompt: string): boolean {
  if (!prompt.startsWith(CLAUDE_SUMMARY_PREFIX)) return false;
  if (CLAUDE_MEM_OBSERVER_MARKERS.some((marker) => prompt.includes(marker))) {
    return true;
  }
  return CLAUDE_MEM_SUMMARY_MARKERS.every((marker) => prompt.includes(marker));
}

export function extractObservedUserRequest(prompt: string): string | undefined {
  const open = "<user_request>";
  const close = "</user_request>";
  const start = prompt.indexOf(open);
  if (start < 0) return undefined;
  const contentStart = start + open.length;
  const end = prompt.indexOf(close, contentStart);
  if (end < 0) return undefined;
  const value = prompt.slice(contentStart, end).trim();
  return value ? value : undefined;
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
