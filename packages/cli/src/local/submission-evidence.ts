import { literals, decodeEscapes } from "./attribution-evidence.js";
type Row = Record<string, any>;

export function commandOf(call: Row): string {
  if (call.command_text) return call.command_text;
  try {
    const input = JSON.parse(call.input_json || "null");
    return typeof input === "string"
      ? input
      : (input?.code ?? input?.script ?? input?.command ?? input?.cmd ?? "");
  } catch {
    return "";
  }
}
function submissionCommands(command: string, depth = 0): string[] {
  if (depth > 3) return [command];
  // Codex exec wraps shell bodies in JS string literals; some native records
  // also escape that entire script. Decode only the wrapper and command fields,
  // never execute scripts or treat arbitrary strings (e.g. search terms) as commands.
  const source = /\b(?:cmd|command|script|code)(?:\\["'])?\s*:\s*\\["']/.test(command)
    ? decodeEscapes(command)
    : command;
  const embedded = literals(source).flatMap((literal) =>
    /\b(?:cmd|command|script|code)["']?\s*:\s*$/.test(source.slice(0, literal.start))
      ? submissionCommands(literal.text, depth + 1)
      : [],
  );
  return embedded.length ? embedded : [source];
}
function commitCommand(command: string): boolean {
  return submissionCommands(command).some((body) =>
    !/^\s*(?:rg|grep|cat|Get-Content)\b/i.test(body) &&
    /\bgit(?:[\s'",\[\]-]|\\["'])[^\n]{0,200}?\bcommit\b/.test(body),
  );
}
function subjects(command: string, output: string): string[] {
  command = submissionCommands(command).join("\n");
  const values: string[] = [];
  for (const m of output.matchAll(/^\[[^\]\r\n]+ [a-f0-9]{7,64}\]\s+(.+)$/gm))
    values.push(m[1].trim());
  for (const m of command.matchAll(
    /\bgit\b[^\n]*?\bcommit\b[^\n]*?(?:-m|--message)(?:[=\s]+)("(?:\\.|[^"\\])*"|'[^']*')/g,
  )) {
    const lit = literals(m[1])[0];
    if (lit) values.push(lit.text.split("\n")[0]);
  }
  if (/\bcommit\b[^\n]*-F\s+-/.test(command)) {
    const m = /<<\s*['"]?(\w+)['"]?\s*\n([^\n]+)/.exec(command);
    if (m) values.push(m[2].trim());
  }
  // Native script APIs frequently execute ['git', 'commit', '-m', subject].
  const tokens = literals(command).map((s) => s.text);
  for (let i = 0; i < tokens.length - 3; i++)
    if (
      tokens[i] === "git" &&
      tokens[i + 1] === "commit" &&
      ["-m", "--message"].includes(tokens[i + 2])
    )
      values.push(tokens[i + 3].split("\n")[0]);
  return [...new Set(values.filter(Boolean))];
}

export function nativeOutput(text: string): string {
  const unpack = (value: any): string =>
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.map(unpack).join("\n")
        : value && typeof value === "object"
          ? ["output", "stdout", "text", "content"]
              .filter((k) => k in value)
              .map((k) => unpack(value[k]))
              .join("\n")
          : "";
  try {
    return unpack(JSON.parse(text)) || text;
  } catch {}
  return text
    .split("\n")
    .map((line) => {
      try {
        return unpack(JSON.parse(line)) || line;
      } catch {
        return line.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
      }
    })
    .join("\n");
}


// Only decode literal arguments. Recorded scripts are data and are never executed.
function invocation(call: Row) {
  let input: any;
  try { input = JSON.parse(call.input_json || "null"); } catch { input = null; }
  let source = commandOf(call);
  const name = (call.tool_name || "").replace(/^(?:tools|functions)\./, "");
  const wrapper = /^(exec|js)$/.test(name);
  if (wrapper && /\b(?:cmd|session_id|cell_id)(?:\\?["'])?\s*:\s*\\"/.test(source)) source = decodeEscapes(source);
  const names = wrapper ? [...source.matchAll(/\btools\.(exec_command|write_stdin|wait)\s*\(/g)].map(m => m[1]) : [name];
  const single = names.length === 1;
  const field = (key: string): any => {
    if (!wrapper) return input?.[key];
    const match = new RegExp('(?:\\b' + key + '|["\']' + key + '["\'])\\s*:\\s*').exec(source);
    if (!match) return undefined;
    const rest = source.slice(match.index + match[0].length);
    const literal = literals(rest)[0];
    if (literal?.start === 0) return literal.text;
    return /^(\d+)(?=\s*[,}])/.exec(rest)?.[1];
  };
  const command = wrapper && single && names[0] === "exec_command" ? field("cmd") ?? field("command") : source;
  const kind = single && names[0] === "write_stdin" ? "shell" : single && names[0] === "wait" ? "cell" : null;
  const id = kind ? field(kind === "shell" ? "session_id" : "cell_id") : null;
  return { command: typeof command === "string" ? command : "", source,
    cwd: single ? field("workdir") ?? field("cwd") : undefined, single,
    poll: kind && id != null ? { kind, id: String(id) } : null };
}

export const submissionCommand = (call: Row) => invocation(call).command;

/** Split only fully recorded, sequential text(await tools.*(...)) calls. Output
 * order is not a command identity for parallel or arbitrary scripts. Keep the
 * original call/turn IDs for persisted links; these steps exist only in memory.
 * This normalization is shared by all providers and never executes log text.
 */
function sequentialSteps(call: Row, outputs: Row[]) {
  const parsed = invocation(call);
  if (parsed.single || !/^(exec|js)$/.test((call.tool_name || "").replace(/^(?:tools|functions)\./, ""))) return null;
  const source = parsed.source;
  let masked = source;
  for (const literal of literals(source).reverse()) {
    if (source[literal.start] === "`" && literal.text.includes("${")) return null;
    masked = masked.slice(0, literal.start) + "0" + " ".repeat(literal.end - literal.start - 1) + masked.slice(literal.end);
  }
  const pattern = /\s*text\s*\(\s*await\s+tools\.(exec_command|write_stdin|wait)\s*\(\s*\{([^{}()]*)\}\s*\)\s*\)\s*;?/gy;
  // Quoted keys/values are masked as zero. Reject spreads, variables, computed
  // keys and expressions: they could change the command or printed result count.
  const fields = /^\s*(?:(?:[a-zA-Z_$][\w$]*|0)\s*:\s*(?:-?\d+(?:\.\d+)?|true|false|null)\s*(?:,\s*|$))*$/;
  const steps: ReturnType<typeof invocation>[] = [];
  let end = 0, match: RegExpExecArray | null;
  while ((match = pattern.exec(masked))) {
    if (!fields.test(match[2])) return null;
    const script = source.slice(match.index, pattern.lastIndex);
    steps.push(invocation({ ...call, command_text: script, input_json: JSON.stringify(script) }));
    end = pattern.lastIndex;
  }
  if (steps.length < 2 || masked.slice(end).trim()) return null;

  const records: Row[] = [];
  for (const output of outputs) {
    if (["error", "failed"].includes(output.status) || (output.exit_code != null && output.exit_code !== 0)) return null;
    const body = (output.content_text || "").replace(/^Script completed\r?\n(?:Wall time[^\n]*\r?\n)?Output:\s*/, "").trim();
    let values: any[];
    try {
      const value = JSON.parse(body);
      values = Array.isArray(value) ? value : [value];
    } catch {
      try { values = body.split(/\r?\n/).filter(Boolean).map((line: string) => JSON.parse(line)); }
      catch { return null; }
    }
    for (const value of values) {
      // Only tool envelopes delimit results. Never split JSON printed inside stdout.
      if (!value || typeof value !== "object" || typeof value.output !== "string" ||
        !(typeof value.exit_code === "number" || value.session_id != null || value.cell_id != null)) return null;
      records.push({ ...output, content_text: JSON.stringify(value), exit_code: value.exit_code, status: "unknown" });
    }
  }
  if (records.length !== steps.length) return null;
  return steps.map((parsed, index) => ({ parsed, outputs: [records[index]], index }));
}

function resultState(result: Row) {
  const text = result.content_text || "";
  const refs: {kind: string; id: string}[] = [];
  let failed = ["error", "failed"].includes(result.status) || (result.exit_code != null && result.exit_code !== 0);
  const visit = (value: any, depth = 0) => {
    if (depth > 8) return;
    if (typeof value === "string") {
      try { visit(JSON.parse(value), depth + 1); } catch {
        for (const line of value.split("\n")) { try { visit(JSON.parse(line), depth + 1); } catch {} }
      }
    } else if (Array.isArray(value)) value.forEach(v => visit(v, depth + 1));
    else if (value && typeof value === "object") {
      if (value.exit_code != null && value.exit_code !== 0) failed = true;
      for (const [field, kind] of [["session_id", "shell"], ["cell_id", "cell"]])
        if (typeof value[field] === "number" || typeof value[field] === "string") refs.push({kind, id: String(value[field])});
      for (const key of ["output", "stdout", "text", "content"]) if (key in value) visit(value[key], depth + 1);
    }
  };
  visit(text);
  for (const m of text.matchAll(/(?:Process running with session ID|Script running with cell ID)\s+([\w-]+)/g))
    refs.push({ kind: m[0].startsWith("Process") ? "shell" : "cell", id: m[1] });
  if (/Process exited with code [1-9]\d*/.test(text)) failed = true;
  return { refs: [...new Map(refs.map(r => [r.kind + ":" + r.id, r])).values()], failed, text: nativeOutput(text) };
}

/** Follow native execution handles within one provider/session, retaining the initiating turn. */
export function submissionExecutions(calls: Row[], results: Row[]) {
  const byCall = new Map<string, Row[]>();
  for (const result of results) {
    const outputs = byCall.get(result.tool_call_id) || [];
    outputs.push(result);
    byCall.set(result.tool_call_id, outputs);
  }
  const ordered = [...calls].sort((first, second) => (first.occurred_at ?? Infinity) - (second.occurred_at ?? Infinity)
    || (first.message_ordinal ?? 0) - (second.message_ordinal ?? 0) || (first.call_index ?? 0) - (second.call_index ?? 0) || first.id.localeCompare(second.id));
  return executionRecords(ordered.map(call => ({ call, outputs: byCall.get(call.id) || [] })));
}

function executionRecords(records: Iterable<{ call: Row; outputs: Row[] }>, submissionsOnly = false) {
  type Execution = { call: Row; command: string; cwd?: string; output: string; pending: boolean; failed: boolean; ambiguous: boolean; batch: boolean; lastAt: number; resultCount: number };
  const executions = new Map<string, Execution>();
  const active = new Map<string, Execution>();
  for (const {call, outputs} of records) {
    outputs.sort((first, second) => (first.occurred_at ?? Infinity) - (second.occurred_at ?? Infinity));
    const split = sequentialSteps(call, outputs);
    for (const { parsed, outputs: stepOutputs, index } of split || [{ parsed: invocation(call), outputs, index: 0 }]) {
      const scoped = (kind: string, id: string) => JSON.stringify([call.provider, call.session_id, kind, id]);
      const at = split && call.occurred_at != null ? Math.max(call.occurred_at, stepOutputs[0].occurred_at ?? call.occurred_at) : call.occurred_at;
      let execution: Execution | undefined;
      if (parsed.poll) {
        execution = active.get(scoped(parsed.poll.kind, parsed.poll.id));
        if (!execution || at == null || execution.lastAt > at) continue;
      } else {
        const retain = !submissionsOnly || commitCommand(parsed.command);
        const savedCall = submissionsOnly ? {
          id: call.id, provider: call.provider, session_id: call.session_id, turn_id: call.turn_id,
          occurred_at: call.occurred_at, working_directory: call.working_directory,
        } : call;
        execution = { call: savedCall, command: retain ? parsed.command : "", cwd: parsed.cwd, output: "", pending: false, failed: false, ambiguous: false, batch: !parsed.single && /\btools\.exec_command\s*\(/.test(parsed.source), lastAt: call.occurred_at ?? Infinity, resultCount: 0 };
        if (retain) executions.set(index ? JSON.stringify([call.id, index]) : call.id, execution);
      }
      for (const result of stepOutputs) {
        const state = resultState(result);
        if (!submissionsOnly) execution.output += "\n" + state.text;
        else if (execution.command)
          execution.output += "\n" + state.text.split(/\r?\n/).filter(line => /^\[[^\]\r\n]+ [a-f0-9]{7,64}\]/.test(line)).join("\n");
        execution.failed ||= state.failed;
        execution.resultCount++;
        execution.lastAt = result.occurred_at ?? Infinity;
        execution.pending = state.refs.length > 0;
        // A completed poll closes its handle; a later process may safely reuse the number.
        if (parsed.poll) active.delete(scoped(parsed.poll.kind, parsed.poll.id));
        for (const ref of state.refs) {
          if (result.occurred_at == null || execution.ambiguous || execution.batch) continue;
          const key = scoped(ref.kind, ref.id), existing = active.get(key);
          if (existing && existing !== execution) { existing.ambiguous = execution.ambiguous = true; }
          active.set(key, execution);
        }
      }
    }
  }
  return executions;
}

export function submissionCandidates(calls: Row[], results: Row[]) {
  return candidates(submissionExecutions(calls, results));
}

export function streamedSubmissionCandidates(records: Iterable<{ call: Row; outputs: Row[] }>) {
  return candidates(executionRecords(records, true));
}

function candidates(executions: ReturnType<typeof executionRecords>) {
  return [...executions.values()]
    .filter(e => e.resultCount && !e.failed && !e.ambiguous && commitCommand(e.command))
    .map(e => ({ ...e, hashes: [...e.output.matchAll(/^\[[^\]\r\n]+ ([a-f0-9]{7,64})\]/gm)].map(m => m[1]),
      // A running shell is not evidence that a quiet commit has succeeded.
      subjects: e.pending || e.batch ? [] : subjects(e.command, e.output) }))
    .filter(e => !e.batch || e.hashes.length > 0);
}
