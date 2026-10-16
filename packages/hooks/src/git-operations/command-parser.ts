import { isAbsolute, resolve } from "node:path";
import type { ParsedGitCommand } from "./types.js";

/**
 * Extract direct `git <operation>` invocations from a shell command.
 * This deliberately handles only explicit commands; aliases and scripts are
 * left alone instead of guessing about work that may have happened inside.
 */
export function parseGitCommands(command: string, initialCwd: string): ParsedGitCommand[] {
  const operations: ParsedGitCommand[] = [];
  let cwd = initialCwd;

  for (const segment of splitShellSegments(command)) {
    const words = tokenizeShellWords(segment.text);
    if (words.length === 0) continue;

    const executableIndex = findExecutableIndex(words);
    const executable = words[executableIndex];
    if (!executable) continue;

    if (basename(executable) === "cd") {
      const target = words[executableIndex + 1];
      if (target && target !== "-") {
        cwd = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
      }
      continue;
    }

    if (basename(executable) !== "git") continue;
    const parsed = parseGitInvocation(words.slice(executableIndex + 1), cwd, segment.heredocs);
    if (parsed) operations.push(parsed);
  }

  return operations;
}

function parseGitInvocation(
  args: string[],
  initialCwd: string,
  heredocs: ShellHeredoc[],
): ParsedGitCommand | null {
  let cwd = initialCwd;
  let index = 0;

  while (index < args.length) {
    const arg = args[index];
    if (arg === "-C") {
      const target = args[index + 1];
      if (!target) return null;
      cwd = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
      index += 2;
      continue;
    }
    if (arg === "-c" || arg === "--config-env" || arg === "--git-dir" || arg === "--work-tree") {
      index += 2;
      continue;
    }
    if (arg === "--no-pager" || arg === "--paginate" || arg === "--literal-pathspecs") {
      index += 1;
      continue;
    }
    if (arg?.startsWith("--git-dir=") || arg?.startsWith("--work-tree=") || arg?.startsWith("--namespace=")) {
      index += 1;
      continue;
    }
    if (arg?.startsWith("-")) {
      index += 1;
      continue;
    }
    if (!arg) return null;
    const operation = normalizeOperation(arg);
    return {
      operation,
      cwd,
      ...(operation === "commit"
        ? { commitMessage: parseLiteralCommitMessage(args.slice(index + 1), heredocs) }
        : {}),
    };
  }

  return null;
}

function parseLiteralCommitMessage(args: string[], heredocs: ShellHeredoc[]): string | null {
  const messages: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") break;

    let candidate: string | undefined;
    let messageFile: string | undefined;
    if (arg === "-m" || arg === "--message") {
      candidate = args[index + 1];
      index += 1;
    } else if (arg?.startsWith("--message=")) {
      candidate = arg.slice("--message=".length);
    } else if (arg?.startsWith("-m") && arg.length > 2) {
      candidate = arg.slice(2);
    } else if (arg === "-F" || arg === "--file") {
      messageFile = args[index + 1] ?? "";
      index += 1;
    } else if (arg?.startsWith("--file=")) {
      messageFile = arg.slice("--file=".length);
    } else if (arg?.startsWith("-F") && arg.length > 2) {
      messageFile = arg.slice(2);
    } else if (
      arg === "-C"
      || arg === "-c"
      || arg === "--reuse-message"
      || arg === "--reedit-message"
      || arg?.startsWith("--reuse-message=")
      || arg?.startsWith("--reedit-message=")
    ) {
      return null;
    }

    if (messageFile !== undefined) {
      // Only a message fed to stdin by a heredoc is visible in the transcript;
      // a file on disk may have changed since the commit ran.
      const heredoc = heredocs[0];
      return messageFile === "-" && heredoc ? heredocCommitMessage(heredoc) : null;
    }
    if (candidate === undefined) continue;
    if (!isLiteralCommitMessage(candidate)) return null;
    messages.push(candidate);
  }

  return messages.length > 0 ? messages.join("\n\n") : null;
}

function isLiteralCommitMessage(value: string): boolean {
  return value.length > 0 && !/[$`]/u.test(value);
}

function heredocCommitMessage(heredoc: ShellHeredoc): string | null {
  if (heredoc.body === null) return null;
  // An unquoted delimiter leaves the body open to expansion and escapes, so
  // only a body without those characters is known verbatim.
  if (!heredoc.quoted && /[$`\\]/u.test(heredoc.body)) return null;
  return cleanupCommitMessage(heredoc.body);
}

/** Mirror git's default whitespace cleanup so the record matches the stored message. */
function cleanupCommitMessage(text: string): string | null {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/u, "");
    if (line === "" && (lines.length === 0 || lines.at(-1) === "")) continue;
    lines.push(line);
  }
  while (lines.at(-1) === "") lines.pop();
  return lines.length > 0 ? lines.join("\n") : null;
}

function findExecutableIndex(words: string[]): number {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(words[index] ?? "")) {
    index += 1;
  }
  if (["command", "env", "sudo"].includes(basename(words[index] ?? ""))) index += 1;
  while (index < words.length && words[index]?.startsWith("-")) index += 1;
  return index;
}

function normalizeOperation(operation: string): string {
  return operation.trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, "_");
}

function basename(command: string): string {
  return command.replace(/\\/gu, "/").split("/").at(-1)?.toLowerCase() ?? "";
}

interface ShellHeredoc {
  delimiter: string;
  /** A quoted delimiter keeps the body verbatim; an unquoted one expands it. */
  quoted: boolean;
  /** `<<-` strips leading tabs from the body and delimiter lines. */
  stripTabs: boolean;
  /** Lines between the command line and the delimiter; null when no body followed. */
  body: string | null;
}

interface ShellSegment {
  text: string;
  /** Heredocs declared in this segment, in order; the first feeds stdin. */
  heredocs: ShellHeredoc[];
}

/** Split at shell control operators while respecting simple quotes and heredocs. */
function splitShellSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let current = "";
  let heredocs: ShellHeredoc[] = [];
  // Heredocs declared on the current line; their bodies start after its newline.
  let pending: ShellHeredoc[] = [];
  let arithmeticDepth = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) segments.push({ text: trimmed, heredocs });
    current = "";
    heredocs = [];
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      // Backslash-newline is a line continuation: the shell drops both
      // characters, so the next line joins this segment instead of ending it.
      if (char === "\n") {
        current = current.slice(0, -1);
        continue;
      }
      current += char;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(" && command[index + 1] === "(") arithmeticDepth += 1;
    if (char === ")" && command[index + 1] === ")" && arithmeticDepth > 0) arithmeticDepth -= 1;
    // `<<` outside arithmetic opens a heredoc (`<<<` is a here-string).
    if (char === "<" && command[index + 1] === "<" && command[index + 2] !== "<" && arithmeticDepth === 0) {
      const declaration = parseHeredocDeclaration(command, index + 2);
      current += command.slice(index, declaration.end);
      heredocs.push(declaration.heredoc);
      pending.push(declaration.heredoc);
      index = declaration.end - 1;
      continue;
    }
    if (char === "\n" || char === ";" || char === "|") {
      flush();
      if (char === "|" && command[index + 1] === "|") index++;
      if (char === "\n" && pending.length > 0) {
        index = readHeredocBodies(command, index + 1, pending) - 1;
        pending = [];
      }
      continue;
    }
    if (char === "&" && command[index + 1] === "&") {
      flush();
      index++;
      continue;
    }
    current += char;
  }
  flush();
  return segments;
}

function parseHeredocDeclaration(command: string, start: number): { heredoc: ShellHeredoc; end: number } {
  let index = start;
  const stripTabs = command[index] === "-";
  if (stripTabs) index += 1;
  while (command[index] === " " || command[index] === "\t") index += 1;

  let delimiter = "";
  let quoted = false;
  while (index < command.length && !/[\s;|&<>()]/u.test(command[index] ?? "")) {
    const char = command[index];
    if (char === "'" || char === '"') {
      quoted = true;
      index += 1;
      while (index < command.length && command[index] !== char && command[index] !== "\n") {
        delimiter += command[index];
        index += 1;
      }
      if (command[index] === char) index += 1;
      continue;
    }
    if (char === "\\") {
      quoted = true;
      delimiter += command[index + 1] ?? "";
      index += 2;
      continue;
    }
    delimiter += char;
    index += 1;
  }
  return { heredoc: { delimiter, quoted, stripTabs, body: null }, end: index };
}

/** Fill each pending heredoc body in order; returns the index after the last delimiter line. */
function readHeredocBodies(command: string, start: number, pending: ShellHeredoc[]): number {
  let index = start;
  for (const heredoc of pending) {
    const lines: string[] = [];
    while (index < command.length) {
      const lineEnd = command.indexOf("\n", index);
      const rawLine = command.slice(index, lineEnd === -1 ? command.length : lineEnd);
      index = lineEnd === -1 ? command.length : lineEnd + 1;
      const line = heredoc.stripTabs ? rawLine.replace(/^\t+/u, "") : rawLine;
      if (line.replace(/\r$/u, "") === heredoc.delimiter) break;
      lines.push(line);
    }
    heredoc.body = lines.join("\n");
  }
  return index;
}

function tokenizeShellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flush = () => {
    if (current) words.push(current);
    current = "";
  };

  for (let index = 0; index < segment.length; index++) {
    const char = segment[index];
    if (escaped) {
      escaped = false;
      // Line continuation (see splitShellSegments): contributes no character.
      if (char === "\n") continue;
      current += char;
      continue;
    }
    if (char === "\\" && quote !== "'" && !/^(?:[A-Za-z]:|\\\\)/u.test(current)
      && /[\s"'\\$]/u.test(segment[index + 1] ?? "")
      && !(current === "" && segment[index + 1] === "\\")) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return words;
}
