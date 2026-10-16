function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toSingleLine(value: string): string {
  return value.replace(/\s+/gu, " ");
}

export function formatCliAgentErrorForTerminal(
  tag: string,
  payload: Record<string, unknown>,
): string {
  const title = toSingleLine(readString(payload.title) ?? "error");
  const status = readNumber(payload.errorStatus);
  const message = toSingleLine(readString(payload.message) ?? "unknown error");

  return `\n[${tag}] ${title}${status !== null ? ` (status ${status})` : ""}: ${message}\n`;
}

export function writeCliAgentErrorToTerminal(
  tag: string,
  payload: Record<string, unknown>,
  debug?: (message: string) => void,
): void {
  process.stderr.write(formatCliAgentErrorForTerminal(tag, payload));
  const sessionId = readString(payload.sessionId);
  if (sessionId) debug?.(`error session: ${sessionId}`);
}
