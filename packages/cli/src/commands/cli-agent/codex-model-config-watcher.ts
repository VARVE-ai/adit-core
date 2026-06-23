import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export interface CodexModelConfigWatcher {
  refresh(): void;
  stop(): void;
}

export interface CodexModelConfigWatcherOptions {
  cwd: string;
  onModel: (modelId: string) => void;
  codexHome?: string;
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 50;

export function startCodexModelConfigWatcher(
  opts: CodexModelConfigWatcherOptions,
): CodexModelConfigWatcher {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeModel = readCodexConfiguredModel(opts);
  const configPaths = codexModelConfigPaths(opts);
  const watchers = configPaths
    .map((filePath) => watchConfigFile(filePath, scheduleRefresh))
    .filter((item): item is FSWatcher => Boolean(item));

  if (activeModel) opts.onModel(activeModel);

  function refresh(): void {
    if (stopped) return;
    const nextModel = readCodexConfiguredModel(opts);
    if (!nextModel || nextModel === activeModel) return;
    activeModel = nextModel;
    opts.onModel(nextModel);
  }

  function scheduleRefresh(): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      refresh();
    }, opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    timer.unref?.();
  }

  return {
    refresh,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {}
      }
    },
  };
}

export function readCodexConfiguredModel(opts: {
  cwd: string;
  codexHome?: string;
}): string | null {
  for (const filePath of codexModelConfigPaths(opts)) {
    const model = readCodexModelFromConfigFile(filePath);
    if (model) return model;
  }
  return null;
}

export function readCodexModelFromConfigFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    return readCodexModelFromConfig(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function readCodexModelFromConfig(config: string): string | null {
  for (const rawLine of config.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) return null;
    const match = /^model\s*=\s*(.+)$/u.exec(line);
    if (!match) continue;
    return readTomlStringValue(stripTomlComment(match[1])) ?? null;
  }
  return null;
}

function codexModelConfigPaths(opts: { cwd: string; codexHome?: string }): string[] {
  // Codex TUI model selection persists through config/batchWrite into the user config.
  return [
    join(resolveCodexHome(opts.codexHome), "config.toml"),
    join(opts.cwd, ".codex", "config.toml"),
  ];
}

function watchConfigFile(filePath: string, onChange: () => void): FSWatcher | null {
  const dir = dirname(filePath);
  if (!existsSync(dir)) return null;
  try {
    const targetName = basename(filePath);
    const watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (filename && filename.toString() !== targetName) return;
      onChange();
    });
    watcher.unref?.();
    return watcher;
  } catch {
    return null;
  }
}

function resolveCodexHome(codexHome?: string): string {
  return codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function stripTomlComment(value: string): string {
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote === "\"") {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return value.slice(0, index).trim();
  }
  return value.trim();
}

function readTomlStringValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("\"")) {
    const end = findClosingQuote(trimmed, "\"");
    if (end <= 0) return null;
    try {
      const parsed = JSON.parse(trimmed.slice(0, end + 1));
      return typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith("'")) {
    const end = findClosingQuote(trimmed, "'");
    if (end <= 0) return null;
    const parsed = trimmed.slice(1, end);
    return parsed.trim() ? parsed.trim() : null;
  }
  return trimmed ? trimmed : null;
}

function findClosingQuote(value: string, quote: "'" | "\""): number {
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (quote === "\"" && !escaped && char === "\\") {
      escaped = true;
      continue;
    }
    if (!escaped && char === quote) return index;
    escaped = false;
  }
  return -1;
}
