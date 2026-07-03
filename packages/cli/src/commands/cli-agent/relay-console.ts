/**
 * Shared terminal output for the `adit cloud claude` / `adit cloud codex`
 * relay commands: one prefix and one set of phrasings for both tools,
 * TTY-aware notice framing, and a connection status reporter that keeps
 * reconnect churn quiet (banner once, outages debounced and deduplicated).
 */
import {
  CloudApiError,
  CloudAuthError,
  CloudNetworkError,
} from "@varveai/adit-cloud";
import type { CliAgentOwner } from "./types.js";

export type RelayTool = "claude" | "codex";

export const RECLAIM_COMMAND = "/local";

export const CLEAR_TERMINAL_LINE = "\r\x1b[2K";

export const CLEAR_TO_END_OF_LINE = "\x1b[0K";

export const TERMINAL_RECLAIM_RESET = [
  "\x1b[?1004l", // Focus in/out reporting.
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l", // Mouse modes.
  "\x1b[?2004l", // Bracketed paste.
  "\x1b[?1l", // Application cursor keys.
  "\x1b[=0u\x1b[<u\x1b[<u\x1b[<u", // Kitty/CSI-u keyboard protocol.
  "\x1b[>4;0m", // xterm modifyOtherKeys.
  "\x1b[?25h", // Cursor visible.
].join("");

// A relay outage shorter than this stays silent; quick flaps (server restarts,
// dev rebuilds) would otherwise spam the terminal that the local CLI owns.
const UNREACHABLE_NOTICE_DELAY_MS = 10_000;

const TOOL_SUBJECTS: Record<RelayTool, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export function isAditDebugEnabled(): boolean {
  const value = process.env.ADIT_DEBUG?.trim().toLowerCase();
  return Boolean(value && value !== "0" && value !== "false" && value !== "off");
}

export function formatTerminalNotice(message: string, isTTY = Boolean(process.stderr.isTTY)): string {
  const text = message.replace(/\r?\n$/u, "");
  if (!isTTY) return `\n${text}\n`;
  return `${CLEAR_TERMINAL_LINE}\r\n${CLEAR_TERMINAL_LINE}${text}${CLEAR_TO_END_OF_LINE}\r\n${CLEAR_TERMINAL_LINE}`;
}

export function restoreTerminalForReclaim(): void {
  try {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
  } catch {}
  try {
    if (process.stderr.isTTY) {
      process.stderr.write(TERMINAL_RECLAIM_RESET);
    }
  } catch {}
}

export function describeRelayError(error: unknown): string {
  if (error instanceof CloudAuthError) {
    return "authentication failed — run 'adit cloud login' again";
  }
  if (error instanceof CloudApiError) return `cloud API error (${error.status})`;
  if (error instanceof CloudNetworkError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export interface RelayNotices {
  readonly subject: string;
  line(text: string): void;
  notice(text: string): void;
  debug(text: string): void;
  cloudError(context: string, error: unknown): void;
  takenOverByWeb(): void;
  webOwnsReminder(): void;
  releasingToLocal(): void;
  shutdown(reason: string): void;
}

export interface RelayNoticesOptions {
  write?: (text: string) => void;
  isTTY?: () => boolean;
  debugEnabled?: () => boolean;
  restoreTerminal?: () => void;
}

export function createRelayNotices(tool: RelayTool, opts: RelayNoticesOptions = {}): RelayNotices {
  const prefix = `[adit ${tool}]`;
  const subject = TOOL_SUBJECTS[tool];
  const write = opts.write ?? ((text: string) => void process.stderr.write(text));
  const isTTY = opts.isTTY ?? (() => Boolean(process.stderr.isTTY));
  const debugEnabled = opts.debugEnabled ?? isAditDebugEnabled;
  const restoreTerminal = opts.restoreTerminal ?? restoreTerminalForReclaim;
  const line = (text: string): void => write(`${prefix} ${text}\n`);
  const notice = (text: string): void => write(formatTerminalNotice(`${prefix} ${text}`, isTTY()));
  return {
    subject,
    line,
    notice,
    debug(text: string): void {
      if (debugEnabled()) line(`debug: ${text}`);
    },
    cloudError(context: string, error: unknown): void {
      if (error instanceof CloudAuthError) {
        line(`${context}: authentication failed. Run 'adit cloud login' again.`);
        write(`${error.message}\n`);
      } else if (error instanceof CloudNetworkError) {
        line(`${context}: cannot reach adit-cloud.`);
        write(`${error.message}\n`);
      } else if (error instanceof CloudApiError) {
        line(`${context}: cloud API error (${error.status}).`);
        write(`${error.message}\n`);
      } else {
        line(`${context}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    takenOverByWeb(): void {
      restoreTerminal();
      notice(`Web has taken over this session — type ${RECLAIM_COMMAND} here to reclaim.`);
    },
    webOwnsReminder(): void {
      notice(`Web owns this session — type ${RECLAIM_COMMAND} here to reclaim.`);
    },
    releasingToLocal(): void {
      notice(`Releasing web control — restarting local ${subject}…`);
    },
    shutdown(reason: string): void {
      notice(`Received ${reason} — shutting down.`);
    },
  };
}

export interface RelayHelloStatus {
  connectionId: string;
  panelId: string | null;
  panelName: string | null;
  owner: CliAgentOwner;
}

export interface RelayStatusReporter {
  helloOk(info: RelayHelloStatus): void;
  relayError(error: unknown): void;
  retryScheduled(attempt: number, delayMs: number): void;
}

export interface RelayStatusReporterOptions {
  notices: RelayNotices;
  projectName: string;
  projectRoot?: string;
  terminalId: string;
  serverUrl?: string;
  unreachableDelayMs?: number;
}

export function createRelayStatusReporter(opts: RelayStatusReporterOptions): RelayStatusReporter {
  const { notices } = opts;
  const unreachableDelayMs = opts.unreachableDelayMs ?? UNREACHABLE_NOTICE_DELAY_MS;
  let helloSeen = false;
  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  let outageVisible = false;
  let lastErrorDesc: string | null = null;
  const printedErrorDescs = new Set<string>();

  const unreachableNotice = (desc: string): void => {
    printedErrorDescs.add(desc);
    notices.notice(`Cloud relay unreachable (${desc}) — retrying in background…`);
  };

  const revealOutage = (): void => {
    revealTimer = null;
    outageVisible = true;
    unreachableNotice(lastErrorDesc ?? "connection failed");
  };

  const ownerLine = (owner: CliAgentOwner): string =>
    owner === "web"
      ? `Web owns this session — type ${RECLAIM_COMMAND} here to reclaim.`
      : `Local ${notices.subject} owns this session — if the web page takes over, ` +
        `type ${RECLAIM_COMMAND} here to reclaim.`;

  return {
    helloOk(info: RelayHelloStatus): void {
      const outageWasVisible = outageVisible;
      if (revealTimer) {
        clearTimeout(revealTimer);
        revealTimer = null;
      }
      outageVisible = false;
      lastErrorDesc = null;
      printedErrorDescs.clear();
      if (!helloSeen) {
        helloSeen = true;
        notices.line(`Connected ${opts.projectName} → adit-cloud Coding`);
        notices.line(ownerLine(info.owner));
        if (opts.projectRoot) notices.debug(`project ${opts.projectRoot}`);
        if (opts.serverUrl) notices.debug(`server ${opts.serverUrl}`);
        notices.debug(`terminal ${opts.terminalId}`);
      } else if (outageWasVisible) {
        notices.notice(
          info.owner === "web"
            ? "Cloud relay reconnected — web still owns this session."
            : "Cloud relay reconnected.",
        );
      }
      notices.debug(`connection ${info.connectionId}`);
      if (info.panelId) {
        notices.debug(`panel ${info.panelName ?? opts.projectName} (${info.panelId})`);
      }
    },
    relayError(error: unknown): void {
      const desc = describeRelayError(error);
      lastErrorDesc = desc;
      if (outageVisible) {
        if (!printedErrorDescs.has(desc)) unreachableNotice(desc);
        return;
      }
      if (!revealTimer) {
        revealTimer = setTimeout(revealOutage, unreachableDelayMs);
        revealTimer.unref?.();
      }
    },
    retryScheduled(attempt: number, delayMs: number): void {
      const delayText = delayMs >= 1000 ? `${Math.round(delayMs / 1000)}s` : `${delayMs}ms`;
      notices.debug(`ws retry #${attempt} in ${delayText}${lastErrorDesc ? `: ${lastErrorDesc}` : ""}`);
    },
  };
}
