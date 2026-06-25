import type { CodexJsonRpcMessage } from "./codex-app-server-client.js";
import type { CliPermissionRequest } from "../types.js";
import { asRecord, readString } from "./helpers.js";
import type { CodexPromptMode } from "./input-mode.js";
import { approvalToolName, codexToolScope, normalizeCodexQuestions } from "./requests.js";

export interface CodexPendingPermission {
  request: CliPermissionRequest;
  method: string;
  params: Record<string, unknown>;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export interface CodexPendingQuestion {
  id: string;
  method: string;
  params: Record<string, unknown>;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface CodexAppRequestContext {
  activeSessionId: string | null;
  resumeSessionId: string | null;
  activePromptMode: CodexPromptMode | null;
  pendingPermissions: Map<string, CodexPendingPermission>;
  pendingQuestions: Map<string, CodexPendingQuestion>;
  pushEvent: (type: string, payload: Record<string, unknown>) => void;
  emitState: () => void;
}

export function handleCodexAppServerRequest(
  message: CodexJsonRpcMessage,
  ctx: CodexAppRequestContext,
): Promise<unknown> {
  if (message.id === undefined || !message.method) {
    return Promise.resolve(null);
  }
  const id = String(message.id);
  const params = asRecord(message.params) ?? {};
  const sessionId = readString(params.threadId) ?? ctx.activeSessionId ?? ctx.resumeSessionId;

  if (
    message.method === "item/tool/requestUserInput" ||
    message.method === "mcpServer/elicitation/request"
  ) {
    return new Promise((resolve, reject) => {
      ctx.pendingQuestions.set(id, {
        id,
        method: message.method ?? "",
        params,
        resolve,
        reject,
      });
      ctx.pushEvent("question.asked", {
        id,
        sessionId,
        questions: normalizeCodexQuestions(message.method ?? "", params),
        createdAt: Date.now(),
      });
      ctx.emitState();
    });
  }

  if (
    message.method === "item/commandExecution/requestApproval" ||
    message.method === "item/fileChange/requestApproval" ||
    message.method === "item/permissions/requestApproval" ||
    message.method === "applyPatchApproval" ||
    message.method === "execCommandApproval"
  ) {
    return new Promise((resolve, reject) => {
      const toolName = approvalToolName(message.method ?? "", params);
      const request: CliPermissionRequest = {
        id,
        toolName,
        input: params,
        createdAt: Date.now(),
      };
      ctx.pendingPermissions.set(id, {
        request,
        method: message.method ?? "",
        params,
        resolve,
        reject,
      });
      ctx.pushEvent("permission", {
        id,
        toolName,
        input: params,
        tool_scope: codexToolScope(toolName, ctx.activePromptMode),
        mode: ctx.activePromptMode ?? undefined,
        inputKind: "prompt",
        createdAt: request.createdAt,
        sessionId,
      });
      ctx.emitState();
    });
  }

  return Promise.reject(new Error(`Unsupported Codex app-server request: ${message.method}`));
}
