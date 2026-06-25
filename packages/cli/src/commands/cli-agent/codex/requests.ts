import { CODEX_UPDATE_PLAN_TOOL } from "./codex-plan-normalizer.js";
import type { CodexPromptMode } from "./input-mode.js";
import { asRecord, readString } from "./helpers.js";

export type CliToolScope =
  | "approval"
  | "internal"
  | "internal_plan"
  | "shell"
  | "workspace_read"
  | "workspace_write";

export function codexToolScope(toolName: string, mode: CodexPromptMode | null): CliToolScope {
  const normalized = toolName.trim().toLowerCase();
  if (normalized === CODEX_UPDATE_PLAN_TOOL.toLowerCase() || normalized === "update_plan") {
    return mode === "plan" ? "internal_plan" : "internal";
  }
  if (
    normalized === "bash" ||
    normalized === "commandexecution" ||
    normalized === "exec_command"
  ) {
    return "shell";
  }
  if (
    normalized === "read" ||
    normalized === "grep" ||
    normalized === "glob" ||
    normalized === "ls"
  ) {
    return "workspace_read";
  }
  if (normalized === "apply_patch" || normalized === "filechange") {
    return mode === "plan" ? "internal_plan" : "workspace_write";
  }
  return "internal";
}

export function approvalToolName(method: string, params: Record<string, unknown>): string {
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    return "Bash";
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    return "apply_patch";
  }
  if (method === "item/permissions/requestApproval") {
    return "CodexPermissions";
  }
  return readString(params.toolName) ?? "Codex";
}

export function isCodexToolItemType(type: string): boolean {
  return type === "mcpToolCall" ||
    type === "dynamicToolCall" ||
    type === "webSearch" ||
    type === "functionCall" ||
    type === "function_call" ||
    type === "customToolCall" ||
    type === "custom_tool_call";
}

export function buildApprovalResponse(
  method: string,
  params: Record<string, unknown>,
  approved: boolean,
): unknown {
  if (method === "item/commandExecution/requestApproval") {
    return { decision: approved ? "accept" : "decline" };
  }
  if (method === "item/fileChange/requestApproval") {
    return { decision: approved ? "accept" : "decline" };
  }
  if (method === "item/permissions/requestApproval") {
    return {
      permissions: approved ? asRecord(params.permissions) ?? {} : {},
      scope: "turn",
    };
  }
  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    return { decision: approved ? "approved" : "denied" };
  }
  return { decision: approved ? "accept" : "decline" };
}

export function normalizeCodexQuestions(method: string, params: Record<string, unknown>): Array<{
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiple: boolean;
  custom: boolean;
}> {
  if (method === "mcpServer/elicitation/request") {
    return [{
      question: readString(params.message) ?? readString(params.title) ?? "Codex needs input.",
      header: readString(params.title) ?? "Question",
      options: [],
      multiple: false,
      custom: true,
    }];
  }

  const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
  return rawQuestions.map((item) => {
    const question = asRecord(item) ?? {};
    const options = Array.isArray(question.options)
      ? question.options.map((option) => {
          const record = asRecord(option) ?? {};
          const label = readString(record.label) ?? readString(record.value) ?? "";
          return {
            label,
            description: readString(record.description) ?? "",
          };
        }).filter((option) => option.label)
      : [];
    return {
      question: readString(question.question) ?? "Codex needs input.",
      header: readString(question.header) ?? "Question",
      options,
      multiple: false,
      custom: question.isOther !== false,
    };
  });
}

export function buildQuestionResponse(
  method: string,
  params: Record<string, unknown>,
  answers: string[][],
): unknown {
  if (method === "mcpServer/elicitation/request") {
    return {
      action: answers.length > 0 ? "accept" : "decline",
      content: answers.length > 0 ? { answer: answers.flat().join("\n") } : null,
      _meta: null,
    };
  }

  const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
  const mapped: Record<string, { answers: string[] }> = {};
  rawQuestions.forEach((item, index) => {
    const question = asRecord(item) ?? {};
    const id = readString(question.id) ?? `question-${index}`;
    mapped[id] = { answers: answers[index] ?? [] };
  });
  return { answers: mapped };
}
