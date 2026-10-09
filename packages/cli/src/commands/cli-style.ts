/**
 * Shared terminal output for adit CLI commands.
 *
 * Every command prints the same shape: a title line naming what is shown and
 * its scope, the body (aligned rows, tables or sections), and an optional
 * closing line with the conclusion or the next step. On an interactive
 * Unicode terminal the block is framed by a rail:
 *
 *   ┌  Status · adit · 3 repos
 *   │
 *   │  Session  active · Claude Code · 01M3RRP1VY
 *   │
 *   ◇  Platforms
 *   │  ✓ Claude Code  5 hook events installed
 *   │
 *   └  ! 9 events not synced · run adit cloud sync
 *
 * When stdout is not a terminal (pipes, files, agents), TERM is dumb, the
 * terminal has no Unicode, or ADIT_PLAIN is set, the same content prints
 * without the rail. Colors follow picocolors (TTY, NO_COLOR, FORCE_COLOR).
 *
 * Marks, only for check and result lines:
 *   ✓ green   passed, done, newly created
 *   ! yellow  needs attention, not blocking
 *   ✗ red     failed
 *   ~ cyan    intentional change or removal
 *   - dim     unchanged or skipped
 * Without Unicode they fall back to [+] [!] [x] [~] [-].
 *
 * Roles: titles and key values are bold, labels and secondary detail are
 * dim, cyan only marks sections. Errors go to stderr as
 * "✗ command: reason" with one line saying what to do next.
 */

import { homedir } from "node:os";
import pc from "picocolors";

// ─── Style detection ─────────────────────────────────────────────────────────

export interface OutputStyle {
  /** Frame each command's output with the ┌ │ ◇ └ rail. */
  rail: boolean;
  /** Unicode marks and arrows; ASCII fallbacks otherwise. */
  unicode: boolean;
}

export function resolveOutputStyle(input: {
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
} = {}): OutputStyle {
  const env = input.env ?? process.env;
  const unicode = supportsUnicode(env, input.platform ?? process.platform);
  const plain = isEnabledFlag(env.ADIT_PLAIN) || env.TERM === "dumb";
  return { rail: Boolean(input.isTTY) && unicode && !plain, unicode };
}

/** The style for this process, read from stdout and the environment on each call. */
export function outputStyle(): OutputStyle {
  return resolveOutputStyle({ isTTY: process.stdout.isTTY, env: process.env, platform: process.platform });
}

function isEnabledFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/** The heuristic of the widely used is-unicode-supported package. */
function supportsUnicode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return env.TERM !== "linux";
  return Boolean(env.WT_SESSION) ||
    Boolean(env.TERMINUS_SUBLIME) ||
    env.ConEmuTask === "{cmd::Cmder}" ||
    env.TERM_PROGRAM === "Terminus-Sublime" ||
    env.TERM_PROGRAM === "vscode" ||
    env.TERM === "xterm-256color" ||
    env.TERM === "alacritty" ||
    env.TERM === "rxvt-unicode" ||
    env.TERM === "rxvt-unicode-256color" ||
    env.TERMINAL_EMULATOR === "JetBrains-JediTerm";
}

// ─── Marks and text roles ────────────────────────────────────────────────────

export const marks = {
  get ok(): string { return pc.green(outputStyle().unicode ? "✓" : "[+]"); },
  get warn(): string { return pc.yellow(outputStyle().unicode ? "!" : "[!]"); },
  get fail(): string { return pc.red(outputStyle().unicode ? "✗" : "[x]"); },
  get change(): string { return pc.cyan(outputStyle().unicode ? "~" : "[~]"); },
  get skip(): string { return pc.dim(outputStyle().unicode ? "-" : "[-]"); },
};

export type MarkName = keyof typeof marks;

export function arrow(): string {
  return outputStyle().unicode ? "→" : "->";
}

export function ellipsis(): string {
  return outputStyle().unicode ? "…" : "...";
}

/** Key values: project names, IDs worth copying, commands to run. */
export function strong(text: string): string {
  return pc.bold(text);
}

/** Labels, table headers and secondary detail. */
export function dim(text: string): string {
  return pc.dim(text);
}

/** Search hits inside a summary. */
export function highlight(text: string): string {
  return pc.bold(pc.underline(text));
}

const STATE_TONES: Array<[(text: string) => string, string[]]> = [
  [pc.green, ["active", "ready", "success", "done", "completed", "online", "generated", "installed", "valid", "approved", "linked", "synced"]],
  [pc.cyan, ["in_progress", "developing", "updating", "syncing"]],
  [pc.yellow, ["verifying", "pending", "partial", "paused", "expired", "unsynced", "preview", "generating", "missing", "warning"]],
  [pc.red, ["failed", "error", "offline", "unreachable", "invalid", "blocked"]],
  [pc.dim, ["none", "not_started", "skipped", "available", "not supported", "unchanged", "idle", "-"]],
];

/** A status word in the color of its meaning; unknown words stay uncolored. */
export function stateWord(word: string): string {
  return inTone(word, word);
}

/** `text` in the color of the state word `word` (e.g. "9 unsynced" in the color of "unsynced"). */
export function inTone(word: string, text: string): string {
  const key = word.trim().toLowerCase();
  for (const [tone, words] of STATE_TONES) {
    if (words.includes(key)) return tone(text);
  }
  return text;
}

type Part = string | number | null | undefined | false;

/** Join the non-empty parts with a dim " · ". */
export function joinParts(parts: Part[], separator = " · "): string {
  return parts
    .filter((part): part is string | number => part !== null && part !== undefined && part !== false && part !== "")
    .map(String)
    .join(pc.dim(separator));
}

// ─── Width, truncation and formatting ────────────────────────────────────────

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** Terminal columns a string occupies: color codes are free, CJK takes two. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) width += charWidth(char.codePointAt(0) ?? 0);
  return width;
}

function charWidth(code: number): number {
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f)
  ) {
    return 0;
  }
  return isWide(code) ? 2 : 1;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

export function padEnd(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + " ".repeat(gap) : text;
}

export function padStart(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? " ".repeat(gap) + text : text;
}

/** Collapse whitespace to one line and cut it to `width` columns with an ellipsis. */
export function truncate(text: string | null | undefined, width: number): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (displayWidth(flat) <= width) return flat;
  const tail = ellipsis();
  const room = Math.max(0, width - displayWidth(tail));
  let kept = "";
  let used = 0;
  for (const char of flat) {
    const charColumns = charWidth(char.codePointAt(0) ?? 0);
    if (used + charColumns > room) break;
    kept += char;
    used += charColumns;
  }
  return kept.trimEnd() + tail;
}

/** Absolute paths inside the project become relative, paths under the home directory start with ~. */
export function shortenPaths(text: string, projectRoot?: string): string {
  let result = text;
  if (projectRoot) result = result.split(`${projectRoot}/`).join("").split(`${projectRoot}\\`).join("");
  const home = homedir();
  if (home) result = result.split(`${home}/`).join("~/").split(`${home}\\`).join("~\\");
  return result;
}

/** "adit cloud tasks list" -> "tasks list": the command named in error lines. */
export function commandLabel(command: string): string {
  return command.replace(/^adit\s+/u, "").replace(/^cloud\s+/u, "").trim() || command;
}

/** Columns left for a trailing summary column after `fixedColumns` on this terminal (60 when not a terminal). */
export function summaryColumns(fixedColumns: number): number {
  const columns = process.stdout.isTTY ? process.stdout.columns ?? 120 : 0;
  if (!columns) return 60;
  return Math.max(30, columns - fixedColumns - (outputStyle().rail ? 3 : 2));
}

export function shortId(id: string, length = 10): string {
  return id.length > length ? id.slice(0, length) : id;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function parseTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "2026-09-30 17:00" in this machine's time zone ("-" when missing). */
export function localDateTime(value: string | null | undefined, options: { seconds?: boolean } = {}): string {
  const date = parseTime(value);
  if (!date) return value ? value : "-";
  return `${localDate(value)} ${localTime(value, options)}`;
}

/** "2026-09-30" in this machine's time zone. */
export function localDate(value: string | null | undefined): string {
  const date = parseTime(value);
  if (!date) return value ? value : "-";
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
}

/** "17:00" (or "17:00:15") in this machine's time zone. */
export function localTime(value: string | null | undefined, options: { seconds?: boolean } = {}): string {
  const date = parseTime(value);
  if (!date) return value ? value : "-";
  const time = `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
  return options.seconds ? `${time}:${twoDigits(date.getSeconds())}` : time;
}

/** Time of day when the moment falls on the reference day, the full local date and time otherwise. */
export function localMoment(value: string | null | undefined, reference: string | null | undefined, options: { seconds?: boolean } = {}): string {
  return parseTime(value) && parseTime(reference) && localDate(value) === localDate(reference)
    ? localTime(value, options)
    : localDateTime(value, options);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : String(value);
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// ─── Block output ────────────────────────────────────────────────────────────

interface BlockState {
  /** A title was printed and the closing line has not been. */
  open: boolean;
  /** The title is out but no body line yet; the gap under it prints with the first body line. */
  gapPending: boolean;
  /** The last line printed was an empty body line. */
  lastBlank: boolean;
  /** A transient line is on screen and the next output replaces it. */
  transient: boolean;
  /** An update notice to show above the closing line. */
  notice: string | null;
}

const state: BlockState = { open: false, gapPending: false, lastBlank: false, transient: false, notice: null };

/** Forget any open block and pending notice (tests, nested commands). */
export function resetOutputState(): void {
  state.open = false;
  state.gapPending = false;
  state.lastBlank = false;
  state.transient = false;
  state.notice = null;
}

export function isBlockOpen(): boolean {
  return state.open;
}

function railed(): boolean {
  return state.open && outputStyle().rail;
}

function clearTransient(): void {
  if (!state.transient) return;
  state.transient = false;
  process.stdout.write("\u001b[1A\u001b[2K");
}

function out(line: string): void {
  clearTransient();
  console.log(line);
}

function err(line: string): void {
  clearTransient();
  console.error(line);
}

function scopeSuffix(scope: Part[]): string {
  const parts = scope
    .filter((part): part is string | number => part !== null && part !== undefined && part !== false && part !== "")
    .map((part) => {
      const text = String(part);
      return text.includes("\u001b[") ? text : pc.dim(text);
    });
  return parts.length > 0 ? pc.dim(" · ") + parts.join(pc.dim(" · ")) : "";
}

function blankLine(): void {
  state.gapPending = false;
  out(railed() ? pc.dim("│") : "");
  state.lastBlank = true;
}

/** One empty line between the title and the first body line, never more. */
function separate(): void {
  if (state.gapPending || !state.lastBlank) blankLine();
}

/**
 * Open a block with "┌  Title · scope". The empty line under it appears
 * with the first body line, so a block that only closes stays two lines.
 */
export function printTitle(title: string, ...scope: Part[]): void {
  const text = pc.bold(title) + scopeSuffix(scope);
  state.open = true;
  state.lastBlank = false;
  out(outputStyle().rail ? `${pc.dim("┌")}  ${text}` : text);
  state.gapPending = true;
}

/** Start a section inside the block: an empty line, then "◇  Section · scope". */
export function printSection(title: string, ...scope: Part[]): void {
  separate();
  const text = pc.bold(title) + scopeSuffix(scope);
  out(railed() ? `${pc.cyan("◇")}  ${text}` : text);
  state.lastBlank = false;
}

/**
 * A body line; an empty string prints one empty body line. Embedded
 * newlines become body lines. Warnings and failures that used to go to
 * stderr can stay there with `stream: "stderr"`.
 */
export function printLine(text = "", options: { stream?: "stdout" | "stderr" } = {}): void {
  if (text === "") {
    separate();
    return;
  }
  if (state.gapPending) blankLine();
  const write = options.stream === "stderr" ? err : out;
  const prefix = railed() ? `${pc.dim("│")}  ` : "  ";
  for (const piece of text.split("\n")) {
    write(piece === "" ? (railed() ? pc.dim("│") : "") : prefix + piece);
  }
  state.lastBlank = false;
}

/**
 * A progress line the next output replaces (interactive terminals only).
 * In plain mode it prints as an ordinary line when `keepInPlain` is set and
 * is skipped otherwise.
 */
export function printTransient(text: string, options: { keepInPlain?: boolean } = {}): void {
  if (!outputStyle().rail) {
    if (options.keepInPlain) printLine(text);
    return;
  }
  printLine(text);
  state.transient = true;
}

export interface Row {
  mark?: string;
  label: string;
  value: string;
}

/** "✓ Label   value" with the label dimmed and padded; continuation lines align under the value. */
export function formatRow(row: Row, labelWidth: number): string {
  const head = `${row.mark ? `${row.mark} ` : ""}${pc.dim(padEnd(row.label, labelWidth))}  `;
  const indent = " ".repeat(displayWidth(head));
  const [first = "", ...rest] = row.value.split("\n");
  return [`${head}${first}`.trimEnd(), ...rest.map((line) => `${indent}${line}`.trimEnd())].join("\n");
}

export function rowLabelWidth(rows: Array<{ label: string }>): number {
  return rows.reduce((width, row) => Math.max(width, displayWidth(row.label)), 0);
}

export function printRows(rows: Row[], labelWidth = rowLabelWidth(rows)): void {
  for (const row of rows) printLine(formatRow(row, labelWidth));
}

export interface Column {
  header: string;
  align?: "left" | "right";
}

/** A table with a dim header row; widths follow the widest cell, the last column is not padded. */
export function formatTable(columns: Column[], rows: string[][]): string[] {
  const widths = columns.map((column, index) =>
    rows.reduce((width, row) => Math.max(width, displayWidth(row[index] ?? "")), displayWidth(column.header)),
  );
  const render = (cells: string[]): string =>
    cells
      .map((cell, index) => {
        if (columns[index]?.align === "right") return padStart(cell, widths[index] ?? 0);
        return index === cells.length - 1 ? cell : padEnd(cell, widths[index] ?? 0);
      })
      .join("  ")
      .trimEnd();
  const lines: string[] = [];
  if (columns.some((column) => column.header !== "")) lines.push(pc.dim(render(columns.map((column) => column.header))));
  for (const row of rows) lines.push(render(row));
  return lines;
}

export function printTable(columns: Column[], rows: string[][]): void {
  for (const line of formatTable(columns, rows)) printLine(line);
}

/** Show the update notice above the closing line instead of before the command. */
export function setPendingNotice(text: string | null): void {
  state.notice = text;
}

export function takePendingNotice(): string | null {
  const notice = state.notice;
  state.notice = null;
  return notice;
}

function flushNotice(): void {
  const notice = takePendingNotice();
  if (notice) err(railed() ? `${pc.dim("│")}  ${notice}` : `  ${notice}`);
}

/**
 * Close the block: an empty line, the pending update notice, then
 * "└  conclusion". Without text the rail just ends.
 */
export function printEnd(text?: string): void {
  if (state.gapPending) state.gapPending = false;
  else if (text && !state.lastBlank) blankLine();
  flushNotice();
  if (railed()) out(text ? `${pc.dim("└")}  ${text}` : pc.dim("└"));
  else if (text) out(text);
  state.open = false;
  state.lastBlank = false;
}

/**
 * Report a failure on stderr. Outside a block: "✗  command: reason" with the
 * hint under it. Inside a block the reason closes the block.
 */
export function printError(command: string, reason: string, hint?: string): void {
  const rail = outputStyle().rail;
  if (state.open) {
    if (state.gapPending) state.gapPending = false;
    else if (!state.lastBlank) blankLine();
    const closing = railed();
    state.open = false;
    state.lastBlank = false;
    err(closing ? `${pc.dim("└")}  ${marks.fail} ${reason}` : `${marks.fail} ${reason}`);
    if (hint) err(`${closing ? "   " : "  "}${pc.dim(hint)}`);
    return;
  }
  const label = command ? `${command}: ` : "";
  err(rail ? `${marks.fail}  ${label}${reason}` : `${marks.fail} ${label}${reason}`);
  if (hint) err(rail ? `${pc.dim("└")}  ${pc.dim(hint)}` : `  ${pc.dim(hint)}`);
}

/** The prefix for a question asked inside a block, so the rail stays continuous. */
export function promptPrefix(): string {
  return railed() ? `${pc.dim("│")}  ` : "  ";
}
