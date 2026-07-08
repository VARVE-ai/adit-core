import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isUuid } from "./claude/sdk-messages.js";
import { getClaudeProjectDir, isValidClaudeSession } from "./claude/transcripts.js";
import type { CliAgentRelayWebSocket } from "./relay-client.js";

/** Upper bound on reported ids — beyond this the oldest sessions are dropped,
 * which the cloud may render as locally-unavailable. Far above realistic
 * per-project session counts. */
const MAX_REPORTED_SESSIONS = 2000;

const CODEX_ROLLOUT_FILE_RE =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const CODEX_META_HEAD_BYTES = 16_384;
const CODEX_SCAN_MAX_DEPTH = 5;

interface CachedFileCheck {
  size: number;
  mtimeMs: number;
  value: boolean;
}

interface FoundSession {
  id: string;
  mtimeMs: number;
}

function sortAndCap(found: FoundSession[]): string[] {
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of found) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    ids.push(item.id);
    if (ids.length >= MAX_REPORTED_SESSIONS) break;
  }
  return ids;
}

/** Lists Claude sessions of this project that the local machine can resume.
 * Validity checks read transcript contents, so results are cached per file
 * and only re-read when size/mtime changes. */
export class ClaudeLocalSessionLister {
  private readonly cache = new Map<string, CachedFileCheck>();

  constructor(private readonly cwd: string) {}

  list(): string[] {
    const dir = getClaudeProjectDir(this.cwd);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const found: FoundSession[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const id = entry.name.slice(0, -".jsonl".length);
      if (!isUuid(id)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(path.join(dir, entry.name));
      } catch {
        continue;
      }
      const cached = this.cache.get(id);
      let valid: boolean;
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        valid = cached.value;
      } else {
        valid = isValidClaudeSession(id, this.cwd);
        this.cache.set(id, { size: stat.size, mtimeMs: stat.mtimeMs, value: valid });
      }
      if (valid) found.push({ id, mtimeMs: stat.mtimeMs });
    }
    return sortAndCap(found);
  }
}

function codexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? configured : path.join(homedir(), ".codex");
}

/** Lists Codex threads of this project that the local machine can resume.
 * Archived rollouts are included because resume auto-unarchives them. */
export class CodexLocalSessionLister {
  private readonly cache = new Map<string, CachedFileCheck>();
  private readonly root: string;

  constructor(cwd: string) {
    this.root = path.resolve(cwd);
  }

  list(): string[] {
    const home = codexHome();
    const found: FoundSession[] = [];
    for (const subdir of ["sessions", "archived_sessions"]) {
      this.collect(path.join(home, subdir), found, 0);
    }
    return sortAndCap(found);
  }

  private collect(dir: string, found: FoundSession[], depth: number): void {
    if (depth > CODEX_SCAN_MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.collect(full, found, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const match = CODEX_ROLLOUT_FILE_RE.exec(entry.name);
      if (!match) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      const cached = this.cache.get(full);
      let matches: boolean;
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        matches = cached.value;
      } else {
        matches = this.rolloutBelongsToProject(full);
        this.cache.set(full, { size: stat.size, mtimeMs: stat.mtimeMs, value: matches });
      }
      if (matches) found.push({ id: match[1].toLowerCase(), mtimeMs: stat.mtimeMs });
    }
  }

  /** Reads the rollout head and matches session_meta cwd against the project
   * root (including subdirectories). Unreadable metadata counts as a match —
   * a stray extra id is harmless while a missing one grays a real session. */
  private rolloutBelongsToProject(file: string): boolean {
    let head: string;
    try {
      const fd = fs.openSync(file, "r");
      try {
        const buffer = Buffer.alloc(CODEX_META_HEAD_BYTES);
        const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
        head = buffer.toString("utf8", 0, bytes);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
    const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
    if (!match) return true;
    let cwd: string;
    try {
      cwd = JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return true;
    }
    const resolved = path.resolve(cwd);
    return resolved === this.root || resolved.startsWith(this.root + path.sep);
  }
}

/** Pushes the locally resumable session list to the relay so the cloud can
 * mark sessions this machine cannot resume. Sends on connect and whenever the
 * list changes; otherwise at most once per interval. */
export class LocalSessionsReporter {
  private lastSignature: string | null = null;
  private lastSentAt = 0;
  private lastConnectionId: string | null = null;

  constructor(
    private readonly ws: CliAgentRelayWebSocket,
    private readonly listSessions: () => string[],
    private readonly intervalMs = 30_000,
  ) {}

  maybeReport(force = false): void {
    if (!this.ws.isOpen) return;
    const connectionId = this.ws.currentConnectionId;
    if (!connectionId) return;
    const connectionChanged = connectionId !== this.lastConnectionId;
    const now = Date.now();
    if (!force && !connectionChanged && now - this.lastSentAt < this.intervalMs) return;
    let ids: string[];
    try {
      ids = this.listSessions();
    } catch {
      return;
    }
    const signature = ids.join("\n");
    if (!connectionChanged && signature === this.lastSignature) {
      this.lastSentAt = now;
      return;
    }
    if (this.ws.sendLocalSessions(ids)) {
      this.lastSignature = signature;
      this.lastSentAt = now;
      this.lastConnectionId = connectionId;
    }
  }
}
