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
    const words = tokenizeShellWords(segment);
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
    const parsed = parseGitInvocation(words.slice(executableIndex + 1), cwd);
    if (parsed) operations.push(parsed);
  }

  return operations;
}

function parseGitInvocation(args: string[], initialCwd: string): ParsedGitCommand | null {
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
    return { operation: normalizeOperation(arg), cwd };
  }

  return null;
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

/** Split at shell control operators while respecting simple quotes. */
function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) segments.push(trimmed);
    current = "";
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) {
      current += char;
      escaped = false;
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
    if (char === "\n" || char === ";" || char === "|") {
      flush();
      if (char === "|" && command[index + 1] === "|") index++;
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

function tokenizeShellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flush = () => {
    if (current) words.push(current);
    current = "";
  };

  for (const char of segment) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
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
