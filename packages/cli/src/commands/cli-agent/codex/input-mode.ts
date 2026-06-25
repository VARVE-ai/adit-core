import type { PromptImageAttachment } from "../types.js";
import { CODEX_DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE } from "./codex-app-server-client.js";

export type CodexPromptMode = "build" | "plan";

export const CODEX_PLAN_MODE_INSTRUCTION = [
  "ADIT Plan mode is active.",
  "Do not modify files, create files, apply patches, install packages, start services, commit changes, or otherwise change the working tree.",
  "Use read-only inspection only. If implementation is needed, return a concrete plan with files, steps, risks, and questions instead of editing.",
  "Do not announce that you are about to edit files; stop at the plan.",
].join("\n");

export const CODEX_ADIT_THREAD_CONFIG = {
  [`features.${CODEX_DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE}`]: true,
};

export function promptInputForCodexMode(
  prompt: string,
  mode: CodexPromptMode,
): string {
  if (mode !== "plan") return prompt;
  return `${CODEX_PLAN_MODE_INSTRUCTION}\n\nUser request:\n${prompt}`;
}

export async function codexInputItems(
  prompt: string,
  mode: CodexPromptMode,
  attachments: PromptImageAttachment[] = [],
): Promise<Array<Record<string, unknown>>> {
  const imageItems = await Promise.all(attachments.map(codexImageInputItem));
  return [
    ...(prompt || mode === "plan"
      ? [{
          type: "text",
          text: promptInputForCodexMode(prompt, mode),
          text_elements: [],
        }]
      : []),
    ...imageItems,
  ];
}

export async function codexImageInputItem(
  attachment: PromptImageAttachment,
): Promise<Record<string, unknown>> {
  return {
    type: "image",
    url: await imageAttachmentDataUrl(attachment),
    detail: "high",
  };
}

export async function imageAttachmentDataUrl(attachment: PromptImageAttachment): Promise<string> {
  if (attachment.url.startsWith("data:image/")) return attachment.url;
  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`Failed to load image attachment ${attachment.fileName ?? attachment.id} (${response.status})`);
  }
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || attachment.mimeType;
  const data = Buffer.from(await response.arrayBuffer()).toString("base64");
  return `data:${contentType};base64,${data}`;
}

export function codexThreadModeOverrides(
  mode: CodexPromptMode,
): Record<string, unknown> {
  return {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: mode === "plan" ? "read-only" : "danger-full-access",
    config: { ...CODEX_ADIT_THREAD_CONFIG },
  };
}

export function codexTurnModeOverrides(
  mode: CodexPromptMode,
): Record<string, unknown> {
  if (mode === "plan") {
    return {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: false,
      },
    };
  }

  return {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandboxPolicy: {
      type: "dangerFullAccess",
    },
  };
}
