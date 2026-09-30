/**
 * Shared plumbing for the read-only `adit cloud ...` commands: the Cloud
 * client, calendar-day options with the machine's time zone, and failure
 * output that carries the server's reason, status and code.
 */

import { CloudApiError, CloudAuthError, CloudClient, loadCredentials } from "@varveai/adit-cloud";

export interface ReadCommandOptions { json?: boolean }

/** The server's own reason, status and code for a failed request, falling back to the transport message. */
export function describeFailure(error: unknown): { message: string; status?: number; code?: string } {
  if (error instanceof CloudApiError) {
    const body = error.body && typeof error.body === "object" ? error.body as Record<string, unknown> : {};
    const reason = typeof body.error === "string" && body.error.trim() ? body.error.trim() : undefined;
    return { message: reason ?? error.message, status: error.status, code: typeof body.code === "string" ? body.code : undefined };
  }
  if (error instanceof CloudAuthError) return { message: error.message, status: error.status, code: error.code };
  return { message: error instanceof Error ? error.message : String(error) };
}

/** Extra fields the server attached to a failure (candidates, parameter names). */
export function failureDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof CloudApiError) || !error.body || typeof error.body !== "object") return {};
  const { error: _reason, code: _code, ...rest } = error.body as Record<string, unknown>;
  return rest;
}

export function reportFailure(error: unknown, options: ReadCommandOptions, label: string): void {
  const failure = describeFailure(error);
  if (options.json) console.log(JSON.stringify({ ok: false, error: failure.message, status: failure.status, code: failure.code, ...failureDetails(error) }));
  else console.error(`${label} failed${failure.status ? ` (${failure.status})` : ""}: ${failure.message}`);
  process.exitCode = 1;
}

export function requireCloudClient(maxRetries = 2): CloudClient {
  const credentials = loadCredentials();
  if (!credentials) throw new Error("Not logged in. Run 'adit cloud login' first.");
  return new CloudClient(credentials.serverUrl, credentials, { maxRetries });
}

export function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

export function calendarDay(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`${name} must be a calendar date (YYYY-MM-DD)`);
  return value;
}

/** Calendar days plus the machine's time zone, so the server cuts the days where the user lives. */
export function periodOptions(options: { from?: string; to?: string; tz?: string }) {
  return { from: calendarDay(options.from, "--from"), to: calendarDay(options.to, "--to"), timeZone: options.tz?.trim() || localTimeZone() };
}

export function pageOptions(options: { offset?: string; limit?: string }, maxLimit: number) {
  const parse = (value: string | undefined, name: string, fallback: number, max: number) => {
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new Error(`${name} must be an integer between 0 and ${max}`);
    return Number(value);
  };
  const limit = parse(options.limit, "--limit", Math.min(50, maxLimit), maxLimit);
  if (limit === 0) throw new Error("--limit must be at least 1");
  return { offset: parse(options.offset, "--offset", 0, Number.MAX_SAFE_INTEGER), limit };
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function shortTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 16).replace("T", " ");
}

export function oneLine(value: string | null | undefined, max = 80): string {
  if (!value) return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
