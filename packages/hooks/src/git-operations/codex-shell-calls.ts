import { decodeExecProgram } from "./codex-exec-program.js";
import type { TranscriptShellCall } from "./types.js";

interface CodexEntry {
  payload?: unknown;
}

export function codexShellCalls(
  entries: CodexEntry[],
  entryOffset: number,
): TranscriptShellCall[] {
  const customOutputs = collectCustomOutputs(entries);
  const calls: TranscriptShellCall[] = [];

  entries.forEach((entry, entryIndex) => {
    const payload = asRecord(entry.payload);
    if (payload?.type === "exec_command_end") {
      const command = commandText(payload.command);
      if (!command) return;
      calls.push({
        id: stringValue(payload.call_id) ?? `codex-shell-${entryOffset + entryIndex}`,
        command,
        cwd: stringValue(payload.cwd) ?? undefined,
        output: joinedOutput(payload),
        success: typeof payload.exit_code === "number"
          ? payload.exit_code === 0 : payload.status === "completed",
      });
      return;
    }

    if (payload?.type !== "custom_tool_call" || payload.name !== "exec") return;
    const callId = stringValue(payload.call_id);
    const input = stringValue(payload.input);
    if (!callId || !input) return;

    const runnerOutput = customOutputs.get(callId);
    if (!runnerOutput) return;
    const decoded = decodeExecProgram(input, runnerOutput.parts);
    for (const call of decoded) {
      calls.push({
        id: callId,
        executionIndex: call.executionIndex,
        command: call.command,
        cwd: call.cwd,
        output: call.output.trim(),
        success: call.exitCode !== undefined ? call.exitCode === 0
          : (runnerOutput.completed || call.running) && hasCommitSummary(call.output),
      });
    }
  });

  return calls;
}

function collectCustomOutputs(entries: CodexEntry[]): Map<string, { parts: string[]; completed: boolean }> {
  const outputs = new Map<string, { parts: string[]; completed: boolean }>();
  for (const entry of entries) {
    const payload = asRecord(entry.payload);
    if (payload?.type !== "custom_tool_call_output") continue;
    const callId = stringValue(payload.call_id);
    if (!callId) continue;
    const blocks = Array.isArray(payload.output) ? payload.output : [payload.output];
    const parts = blocks.map((block) => typeof block === "string" ? block : stringValue(asRecord(block)?.text) ?? "");
    const first = parts[0] ?? "";
    const marker = "\nOutput:\n";
    const markerIndex = first.indexOf(marker);
    if (markerIndex < 0) continue;
    parts[0] = first.slice(markerIndex + marker.length);
    // Drop the runner's header, but preserve empty shell outputs after it.
    if (!parts[0]) parts.shift();
    outputs.set(callId, { parts,
      completed: first.startsWith("Script completed\n") });
  }
  return outputs;
}

function hasCommitSummary(output: string): boolean {
  return /^\[[^\]\r\n]+\s[0-9a-f]{7,64}\]\s+\S/mu.test(output);
}

function commandText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.at(-1) ?? null;
}

function joinedOutput(value: Record<string, unknown>): string | null {
  const parts = [value.stdout, value.stderr, value.aggregated_output]
    .filter((item): item is string => typeof item === "string" && item.length > 0);
  return parts.length > 0 ? parts.join("\n") : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
