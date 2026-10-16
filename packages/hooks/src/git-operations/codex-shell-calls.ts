import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TranscriptShellCall } from "./types.js";

interface CodexEntry {
  payload?: unknown;
}

interface LocatedCall {
  call: TranscriptShellCall;
  index: number;
}

interface PendingCall {
  id: string;
  input: Record<string, unknown>;
  start: number;
  end: number;
  output: string[];
  exitCode: number | null;
}

export function codexShellCalls(entries: CodexEntry[], entryOffset: number): TranscriptShellCall[] {
  const executions: LocatedCall[] = [];
  const pending = new Map<string, PendingCall>();
  const polls = new Map<string, string>();
  const processes = new Map<string, string>();
  const legacyStarts = new Map<string, Record<string, unknown>>();

  entries.forEach((entry, entryIndex) => {
    const payload = asRecord(entry.payload);
    if (!payload) return;
    const item = completedItem(payload);
    if (item?.type === "CommandExecution") {
      const command = commandText(item.command);
      if (command) executions.push({ index: entryIndex, call: {
        id: stringValue(item.id) ?? "codex-shell-" + (entryOffset + entryIndex),
        command,
        cwd: workingDirectory(item.cwd),
        output: joinedOutput(item),
        success: isSuccessful(item),
      } });
      return;
    }
    const id = stringValue(payload.call_id);
    if (!id) return;
    if (payload.type === "exec_command_begin") legacyStarts.set(id, payload);
    if (payload.type === "exec_command_end") {
      const start = legacyStarts.get(id);
      const command = commandText(payload.command ?? start?.command);
      if (command) executions.push({ index: entryIndex, call: {
        id, command,
        cwd: workingDirectory(payload.cwd ?? start?.cwd),
        output: joinedOutput(payload),
        success: exitCodeOf(payload.exit_code) === 0,
      } });
    }
    if (payload.type === "function_call") {
      const name = stringValue(payload.name)?.split(".").at(-1);
      const input = parseObject(payload.arguments);
      if (!input) return;
      if (["exec_command", "shell_command", "run_shell_command"].includes(name ?? "")) {
        pending.set(id, { id, input, start: entryIndex, end: entryIndex, output: [], exitCode: null });
      } else if (name === "write_stdin" && input.session_id !== undefined) {
        polls.set(id, String(input.session_id));
      }
    }
    if (payload.type !== "function_call_output") return;
    const owner = processes.get(polls.get(id) ?? "");
    const call = pending.get(id) ?? (owner ? pending.get(owner) : undefined);
    if (!call) return;
    const result = functionResult(payload.output);
    call.end = entryIndex;
    if (result.output) call.output.push(result.output);
    if (result.exitCode !== null) call.exitCode = result.exitCode;
    if (result.sessionId) processes.set(result.sessionId, call.id);
  });

  const calls = executions.filter((execution, index) =>
    !executions.slice(index + 1).some((other) => other.call.id === execution.call.id));
  for (const pendingCall of pending.values()) {
    const command = commandText(pendingCall.input.cmd ?? pendingCall.input.command);
    if (!command || pendingCall.exitCode === null) continue;
    const cwd = workingDirectory(pendingCall.input.workdir ?? pendingCall.input.cwd);
    const matched = calls.some(({ call, index }) => call.id === pendingCall.id || (
      index > pendingCall.start && index <= pendingCall.end && call.command.trim() === command.trim()
      && (!cwd || !call.cwd || resolve(cwd) === resolve(call.cwd))
    ));
    if (!matched) calls.push({ index: pendingCall.start, call: {
      id: pendingCall.id, command, cwd,
      output: pendingCall.output.join("\n") || null,
      success: pendingCall.exitCode === 0,
    } });
  }
  return calls.sort((left, right) => left.index - right.index).map(({ call }) => call);
}

export function completedItem(payload: unknown): Record<string, unknown> | null {
  const record = asRecord(payload);
  if (record?.type !== "item_completed") return null;
  return asRecord(record.item);
}

function functionResult(value: unknown): { output: string | null; exitCode: number | null; sessionId?: string } {
  const text = typeof value === "string" ? value : Array.isArray(value)
    ? value.map((part) => stringValue(asRecord(part)?.text) ?? "").join("\n") : null;
  const object = parseObject(value);
  if (object) return {
    output: joinedOutput(object) ?? stringValue(object.output),
    exitCode: exitCodeOf(object.exit_code),
    sessionId: object.session_id === undefined ? undefined : String(object.session_id),
  };
  const outputIndex = text?.search(/^Output:\r?$/mu) ?? -1;
  const metadata = outputIndex >= 0 ? text!.slice(0, outputIndex) : text ?? "";
  const exit = metadata.match(/^(?:Process exited with code|Exit code:)\s*(-?\d+)\s*$/mu);
  const session = metadata.match(/^Process running with session ID\s+(\S+)/mu);
  return {
    output: outputIndex >= 0 ? text!.slice(outputIndex).replace(/^Output:\r?\n?/u, "") : text,
    exitCode: exit ? Number(exit[1]) : null,
    sessionId: session?.[1],
  };
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return asRecord(value);
  try { return asRecord(JSON.parse(value)); } catch { return null; }
}

function isSuccessful(item: Record<string, unknown>): boolean {
  const exitCode = exitCodeOf(item.exit_code);
  if (exitCode !== null) return exitCode === 0;
  return item.status === "completed";
}

function exitCodeOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) return Number(value.trim());
  return null;
}

function workingDirectory(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  if (!raw.startsWith("file:")) return raw;
  try { return fileURLToPath(raw); } catch { return undefined; }
}

function commandText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.at(-1) ?? null;
}

function joinedOutput(item: Record<string, unknown>): string | null {
  const aggregated = stringValue(item.aggregated_output);
  if (aggregated) return aggregated;
  const parts = [item.stdout, item.stderr]
    .filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.length > 0 ? parts.join("\n") : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
