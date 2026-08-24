export type CliAgentProviderName = "claude-code" | "codex";

export type CliAgentOwner = "local" | "web" | "stopped";

export interface CliAgentContextUsage {
  percentage: number;
  totalTokens: number;
  maxTokens: number;
  modelId?: string | null;
  updatedAt: number;
  source: "claude-sdk" | "codex-app-server";
}

export interface CliAgentTokenUsage {
  totalTokens?: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  updatedAt: number;
  source: "codex-app-server";
}

export interface CliAgentState {
  owner: CliAgentOwner;
  busy: boolean;
  thinking: boolean;
  activeSessionId: string | null;
  resumeSessionId: string | null;
  sdkSessionId: string | null;
  activeModelId: string | null;
  reasoningEffort?: string | null;
  currentBranch: string | null;
  contextUsage: CliAgentContextUsage | null;
  lastTokenUsage: CliAgentTokenUsage | null;
  metadata?: Record<string, unknown>;
}

export interface CliPermissionRequest {
  id: string;
  toolName: string;
  input: unknown;
  createdAt: number;
}

export interface CliQuestionResponse {
  id: string;
  answers: string[][];
  rejected?: boolean;
}

export interface CliSlashCommand {
  name: string;
  args: string[];
  raw: string;
  sessionId?: string | null;
  pendingSessionId?: string | null;
  localMessageId?: string | null;
}

export interface CliRewindResponse {
  id: string;
  sessionId?: string | null;
  userMessageId?: string | null;
  dryRun?: boolean;
  rejected?: boolean;
}

export interface CliSlashCommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
}

export interface PromptImageAttachment {
  id: string;
  kind: "image";
  url: string;
  mimeType: string;
  fileName?: string | null;
  sizeBytes: number;
}

export type CliSessionContextKind =
  | "collaboration_request"
  | "collaboration_result";

export interface AppendSessionContextInput {
  sessionId: string;
  contextEntryId: string;
  requestId: string;
  kind: CliSessionContextKind;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface AppendSessionContextResult {
  provider: CliAgentProviderName;
  sessionId: string;
  contextEntryId: string;
  persisted: true;
  appended: boolean;
  alreadyApplied?: boolean;
}

export interface StartCollaborationConsultationInput {
  requestId: string;
  attemptId: string;
  runId: string;
  protocolVersion: "v1";
  mode: "consultation";
  targetSessionId: string;
  question: string;
}

export interface StartCollaborationConsultationResult {
  sessionId: string;
  providerRunId: string;
}

export interface AbortCollaborationConsultationInput {
  requestId: string;
  attemptId: string;
  runId: string;
  code: "RUN_TIMEOUT" | "EXECUTION_ABORTED";
  message: string;
}

export interface CliAgentProvider {
  readonly provider: CliAgentProviderName;
  readonly state: CliAgentState;
  readonly permissions: CliPermissionRequest[];
  takeover(): Promise<void>;
  releaseToLocal(): Promise<void>;
  startNewSession?(pendingSessionId?: string | null): Promise<void>;
  switchSession(sessionId: string): Promise<void>;
  appendSessionContext?(
    input: AppendSessionContextInput,
  ): Promise<AppendSessionContextResult>;
  startCollaborationConsultation?(
    input: StartCollaborationConsultationInput,
  ): Promise<StartCollaborationConsultationResult>;
  abortCollaborationConsultation?(
    input: AbortCollaborationConsultationInput,
  ): Promise<void>;
  abortCollaborationOnRelayDisconnect?(): Promise<void>;
  sendPrompt(prompt: string, opts?: {
    mode?: "build" | "plan";
    pendingSessionId?: string | null;
    localMessageId?: string | null;
    attachments?: PromptImageAttachment[];
  }): Promise<void>;
  steerPrompt?(prompt: string, opts?: {
    sessionId?: string | null;
    localMessageId?: string | null;
    mode?: "build" | "plan";
    attachments?: PromptImageAttachment[];
  }): Promise<void>;
  handleSlashCommand(command: CliSlashCommand): Promise<void>;
  answerRewind?(response: CliRewindResponse): Promise<void>;
  answerPermission(
    id: string,
    approved: boolean,
    reason?: string,
  ): Promise<void>;
  answerQuestion(response: CliQuestionResponse): Promise<void>;
  abort(): Promise<void>;
  stop(): void;
}

export interface CliAgentRelayEvent {
  eventId?: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface RelayCommand {
  id: string;
  type:
    | "prompt"
    | "steer"
    | "abort"
    | "permission"
    | "question"
    | "takeover"
    | "new-session"
    | "switch-session"
    | "slash-command"
    | "rewind"
    | "append-session-context"
    | "collaboration-prompt";
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface CliAgentConnectionState {
  owner: string;
  busy: boolean;
  thinking: boolean;
  activeSessionId: string | null;
  resumeSessionId: string | null;
  sdkSessionId: string | null;
  activeModelId: string | null;
  reasoningEffort?: string | null;
  currentBranch: string | null;
  contextUsage: CliAgentContextUsage | null;
  lastTokenUsage: CliAgentTokenUsage | null;
  metadata?: Record<string, unknown>;
}
