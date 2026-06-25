import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PromptImageAttachment } from "../types.js";

export const CLAUDE_SYNTHETIC_DELTA_MIN_CHARS = 24;

export const CLAUDE_SYNTHETIC_DELTA_MAX_CHUNKS = 80;

export const CLAUDE_SYNTHETIC_DELTA_INTERVAL_MS = 16;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunkTextForSyntheticDeltas(text: string): string[] {
  const codePoints = Array.from(text);
  if (codePoints.length <= CLAUDE_SYNTHETIC_DELTA_MIN_CHARS) return [text];
  const chunkSize = Math.max(
    CLAUDE_SYNTHETIC_DELTA_MIN_CHARS,
    Math.ceil(codePoints.length / CLAUDE_SYNTHETIC_DELTA_MAX_CHUNKS),
  );
  const chunks: string[] = [];
  for (let index = 0; index < codePoints.length; index += chunkSize) {
    chunks.push(codePoints.slice(index, index + chunkSize).join(""));
  }
  return chunks;
}

export class PushableSdkPromptStream implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[];
  private waiter: {
    resolve: (result: IteratorResult<SDKUserMessage>) => void;
    reject: (error: Error) => void;
  } | null = null;
  private closed = false;
  private error: Error | null = null;

  constructor(first: SDKUserMessage) {
    this.queue = [first];
  }

  push(message: SDKUserMessage): void {
    if (this.error) throw this.error;
    if (this.closed) throw new Error("Claude prompt stream is closed");
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.resolve({ value: message, done: false });
      return;
    }
    this.queue.push(message);
  }

  isClosed(): boolean {
    return this.closed || this.error !== null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.resolve({ value: undefined as never, done: true });
    }
  }

  fail(error: Error): void {
    if (this.error) return;
    this.error = error;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<SDKUserMessage>> {
    const nextMessage = this.queue.shift();
    if (nextMessage) return Promise.resolve({ value: nextMessage, done: false });
    if (this.error) return Promise.reject(this.error);
    if (this.closed) {
      return Promise.resolve({ value: undefined as never, done: true });
    }
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
}

export function toUserMessage(
  message: string,
  attachments: PromptImageAttachment[] = [],
  sessionId?: string,
  opts: { priority?: SDKUserMessage["priority"]; shouldQuery?: boolean } = {},
): SDKUserMessage {
  const content: SDKUserMessage["message"]["content"] = attachments.length === 0
    ? message
    : [
        ...(message ? [{ type: "text" as const, text: message }] : []),
        ...attachments.map((attachment) => ({
          type: "image" as const,
          source: {
            type: "url" as const,
            url: attachment.url,
          },
        })),
      ];
  return {
    type: "user",
    ...(sessionId ? { session_id: sessionId } : {}),
    parent_tool_use_id: null,
    ...(opts.priority ? { priority: opts.priority } : {}),
    ...(typeof opts.shouldQuery === "boolean" ? { shouldQuery: opts.shouldQuery } : {}),
    message: {
      role: "user",
      content,
    },
  };
}
