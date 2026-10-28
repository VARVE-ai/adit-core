export function isRetryableCollectionIssue(error: unknown): boolean {
  const code = (error as {code?: string} | null)?.code;
  if (["ENOENT", "ENOTDIR", "EBUSY", "EAGAIN", "ETXTBSY", "SQLITE_BUSY", "SQLITE_LOCKED"].includes(code || "")) return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /\b(?:ENOENT|ENOTDIR|EBUSY|EAGAIN|ETXTBSY|SQLITE_BUSY|SQLITE_LOCKED)\b|retry on the next collection|Settings changed; retry with the saved selection|Source settings changed; retry with the saved selection|Source was truncated while reading|Cursor IDE transcript has missing bubbles; previous archive retained|database is locked|database table is locked/.test(message);
}
