/**
 * Agent file mutation types.
 *
 * A mutation is a single file change explicitly performed by the agent via a
 * file-editing tool (Write/Edit/MultiEdit/NotebookEdit for Claude; fileChange
 * for Codex). Shell-driven indirect changes are NOT mutations.
 */

export type MutationKind = "add" | "update" | "delete" | "rename";

export type MutationStatus = "running" | "completed" | "failed";

export type MutationSource =
  | "claude-write-tool"
  | "claude-edit-tool"
  | "claude-multiedit-tool"
  | "claude-notebookedit-tool"
  | "codex-filechange"
  | "codex-patch-apply-end"
  | "gemini-write-file"
  | "gemini-replace"
  | "gemini-edit"
  | "gemini-insert"
  | "cursor-write"
  | "cursor-strreplace";

export interface MutationOmitted {
  reason: "diff_too_large" | "file_too_large" | "failed" | "unavailable";
  bytes?: number;
  limitBytes?: number;
}

export interface AgentFileMutation {
  provider: "claude-code" | "claude-vscode" | "codex" | "gemini" | "cursor" | "cursor-vscode";
  toolUseId: string;
  toolName: string;
  path: string;
  kind: MutationKind;
  status: MutationStatus;
  source: MutationSource;
  additions?: number;
  deletions?: number;
  diff?: string;
  omitted?: MutationOmitted;
}
