function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatCliAgentErrorForTerminal(
  tag: string,
  payload: Record<string, unknown>,
): string {
  const title = readString(payload.title) ?? "error";
  const status = readNumber(payload.errorStatus);
  const sessionId = readString(payload.sessionId);
  const message = readString(payload.message) ?? "unknown error";

  const lines = [`[${tag}] ${title}${status !== null ? ` (status ${status})` : ""}`];
  if (sessionId) lines.push(`  session: ${sessionId}`);
  for (const line of message.split(/\r?\n/)) {
    lines.push(`  ${line}`);
  }
  return `\n${lines.join("\n")}\n`;
}

export function writeCliAgentErrorToTerminal(
  tag: string,
  payload: Record<string, unknown>,
): void {
  process.stderr.write(formatCliAgentErrorForTerminal(tag, payload));
}
