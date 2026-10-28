import { record, string } from "./types.js";
import { cursorUserQuery } from "./cursor-prompt.js";

const codexProviders = new Set(["codex", "traex", "augure-code"]);
const instructionsHeader =
  /^# AGENTS\.md instructions(?: for [^\r\n]+)?\s+(?=<INSTRUCTIONS>)/;

export const PROMPT_IMAGE_KINDS = ["input_image", "image", "image_url"] as const;
export function promptImageCount(content: unknown): number {
  const blocks=Array.isArray(content)?content:[content];
  return blocks.filter(block=>PROMPT_IMAGE_KINDS.some(kind=>record(block).type===kind)).length;
}

/** An image-only user message is a real prompt. Never serialize image bytes as prose. */
export function submittedPromptText(provider:string,content:unknown,imageCount=promptImageCount(content)):string|null {
  const text=promptText(provider,content);
  return text || (imageCount>0 ? imageCount===1 ? "[Image]" : `[Images: ${imageCount}]` : null);
}

export function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(textContent).filter(Boolean).join("\n");
  const block = record(value);
  // Tool results and attachments are evidence, never a fallback session title.
  if (
    block.type &&
    !["text", "input_text", "output_text"].includes(string(block.type))
  )
    return "";
  return string(block.text) || string(block.content);
}

export function hasCodexPromptContext(provider: string, text: string): boolean {
  return (
    codexProviders.has(provider) &&
    (instructionsHeader.test(text.trimStart()) ||
      text.trimStart().startsWith("<environment_context>") ||
      text.trimStart().startsWith("<turn_aborted>"))
  );
}

/** Only the display summary is cleaned; the collected message stays verbatim. */
export function promptSummary(
  provider: string,
  content: unknown,
): string | null {
  return promptText(provider, content)?.slice(0, 240) || null;
}

/** Untruncated display text; native context remains available in the original message. */
export function promptText(provider: string, content: unknown): string | null {
  let text = textContent(content).trim();
  if (provider === "cursor") text = cursorUserQuery(text)?.text ?? text;
  if (codexProviders.has(provider)) {
    while (hasCodexPromptContext(provider, text)) {
      const isInstructions = instructionsHeader.test(text);
      const closing = isInstructions
        ? "</INSTRUCTIONS>"
        : text.startsWith("<turn_aborted>") ? "</turn_aborted>" : "</environment_context>";
      const end = text.indexOf(closing);
      // An incomplete context block is not a user request either.
      if (end === -1) return null;
      text = text.slice(end + closing.length).trim();
    }
  }
  return text || null;
}
