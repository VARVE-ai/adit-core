interface CodexEntry {
  payload?: unknown;
}

export interface TranscriptShellCall {
  id: string;
  command: string;
  cwd?: string;
  output?: string | null;
  success: boolean;
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
        success: payload.status === "completed" || payload.exit_code === 0,
      });
      return;
    }

    if (payload?.type !== "custom_tool_call" || payload.name !== "exec") return;
    const callId = stringValue(payload.call_id);
    const input = stringValue(payload.input);
    if (!callId || !input) return;

    const execInput = parseSingleExecCommand(input);
    const runnerOutput = customOutputs.get(callId);
    if (!execInput || !runnerOutput) return;

    calls.push({
      id: callId,
      command: execInput.command,
      cwd: execInput.cwd ?? undefined,
      output: stripRunnerEnvelope(runnerOutput),
      success:
        payload.status === "completed" && runnerOutput.startsWith("Script completed\n"),
    });
  });

  return calls;
}

function collectCustomOutputs(entries: CodexEntry[]): Map<string, string> {
  const outputs = new Map<string, string>();
  for (const entry of entries) {
    const payload = asRecord(entry.payload);
    if (payload?.type !== "custom_tool_call_output") continue;
    const callId = stringValue(payload.call_id);
    const output = textContent(payload.output);
    if (callId && output) outputs.set(callId, output);
  }
  return outputs;
}

function parseSingleExecCommand(
  source: string,
): { command: string; cwd: string | null } | null {
  const marker = "tools.exec_command";
  const callStart = source.indexOf(marker);
  if (callStart < 0 || source.indexOf(marker, callStart + marker.length) >= 0) {
    return null;
  }

  const objectStart = source.indexOf("{", callStart + marker.length);
  if (objectStart < 0) return null;
  const objectEnd = matchingBrace(source, objectStart);
  if (objectEnd < 0) return null;

  const objectSource = source.slice(objectStart + 1, objectEnd);
  const command = jsonStringProperty(objectSource, "cmd");
  if (!command) return null;
  return {
    command,
    cwd: jsonStringProperty(objectSource, "workdir"),
  };
}

function matchingBrace(source: string, start: number): number {
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function jsonStringProperty(source: string, property: "cmd" | "workdir"): string | null {
  const pattern = new RegExp(
    `(?:^|,)\\s*(?:"${property}"|${property})\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`,
    "su",
  );
  const literal = source.match(pattern)?.[1];
  if (!literal) return null;
  try {
    const parsed = JSON.parse(literal) as unknown;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function stripRunnerEnvelope(output: string): string | null {
  const marker = "\nOutput:\n";
  const markerIndex = output.indexOf(marker);
  if (markerIndex < 0) return output.trim() || null;
  return output.slice(markerIndex + marker.length).trim() || null;
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

function textContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts = value.map((item) => {
    if (typeof item === "string") return item;
    return stringValue(asRecord(item)?.text) ?? "";
  }).filter(Boolean);
  return parts.length > 0 ? parts.join("") : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
