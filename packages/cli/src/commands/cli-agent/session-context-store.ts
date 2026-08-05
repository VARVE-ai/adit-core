import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type {
  AppendSessionContextInput,
  AppendSessionContextResult,
  CliAgentProviderName,
} from "./types.js";

export const SESSION_CONTEXT_MAX_PENDING_CHARS = 128_000;
export const SESSION_CONTEXT_CLAIM_LEASE_MS = 5 * 60_000;
const SESSION_CONTEXT_MAX_METADATA_CHARS = 16_000;
const SESSION_CONTEXT_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const SESSION_CONTEXT_MAX_RECEIPTS = 2_000;

export interface StoredSessionContextEntry extends AppendSessionContextInput {
  createdAt: number;
}

export interface SessionContextClaim {
  claimId: string;
  entries: StoredSessionContextEntry[];
}

export interface AppliedSessionContextEntry {
  contextEntryId: string;
  requestId: string;
  sessionId: string;
  kind: AppendSessionContextInput["kind"];
}

interface SessionContextStoreOptions {
  dataDir: string;
  provider: CliAgentProviderName;
}

interface EntryRow {
  session_id: string;
  context_entry_id: string;
  request_id: string;
  kind: AppendSessionContextInput["kind"];
  content: string;
  metadata_json: string;
  created_at: number;
}

interface ExistingEntryRow {
  provider: string;
  session_id: string;
  request_id: string;
  kind: string;
  content_hash: string;
}

export class SessionContextStore {
  private readonly db: Database.Database;
  private operationCount = 0;
  private closed = false;

  constructor(private readonly opts: SessionContextStoreOptions) {
    const filePath = join(opts.dataDir, "cli-agent", "session-context.sqlite");
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_context_entries (
        context_entry_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        content_length INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        claim_id TEXT,
        claim_expires_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_context_entries_pending_idx
        ON session_context_entries(provider, session_id, status, created_at);
      CREATE INDEX IF NOT EXISTS session_context_entries_claim_idx
        ON session_context_entries(provider, claim_id);

      CREATE TABLE IF NOT EXISTS session_context_receipts (
        context_entry_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_context_receipts_applied_idx
        ON session_context_receipts(applied_at);
    `);
    this.cleanup();
  }

  append(input: AppendSessionContextInput): Promise<AppendSessionContextResult> {
    const metadataJson = JSON.stringify(input.metadata ?? {});
    if (metadataJson.length > SESSION_CONTEXT_MAX_METADATA_CHARS) {
      return Promise.reject(new Error("Collaboration context metadata is too large"));
    }
    const contentHash = hashContent(input.content);
    try {
      const transaction = this.db.transaction(() => {
        this.releaseExpiredClaims(Date.now());
        const existing = this.findExisting(input.contextEntryId);
        if (existing) {
          assertMatchingEntry(existing.entry, this.opts.provider, input, contentHash);
          return appendResult(this.opts.provider, input, false, existing.alreadyApplied);
        }

        const pendingChars = this.db.prepare(`
          SELECT COALESCE(SUM(content_length), 0) AS total
          FROM session_context_entries
          WHERE provider = ? AND session_id = ?
        `).get(this.opts.provider, input.sessionId) as { total: number };
        if (pendingChars.total + input.content.length > SESSION_CONTEXT_MAX_PENDING_CHARS) {
          throw new Error("Collaboration context budget exceeded for this Session");
        }

        this.db.prepare(`
          INSERT INTO session_context_entries (
            context_entry_id, provider, session_id, request_id, kind,
            content, content_hash, metadata_json, content_length, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.contextEntryId,
          this.opts.provider,
          input.sessionId,
          input.requestId,
          input.kind,
          input.content,
          contentHash,
          metadataJson,
          input.content.length,
          Date.now(),
        );
        return appendResult(this.opts.provider, input, true);
      });
      const result = transaction.immediate();
      this.maybeCleanup();
      return Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  claimPending(
    sessionId: string,
    leaseMs = SESSION_CONTEXT_CLAIM_LEASE_MS,
  ): Promise<SessionContextClaim | null> {
    try {
      const transaction = this.db.transaction(() => {
        const now = Date.now();
        this.releaseExpiredClaims(now);
        const rows = this.db.prepare(`
          SELECT session_id, context_entry_id, request_id, kind,
                 content, metadata_json, created_at
          FROM session_context_entries
          WHERE provider = ? AND session_id = ? AND status = 'pending'
          ORDER BY created_at ASC, context_entry_id ASC
        `).all(this.opts.provider, sessionId) as EntryRow[];
        if (rows.length === 0) return null;

        const claimId = randomUUID();
        const placeholders = rows.map(() => "?").join(", ");
        const changed = this.db.prepare(`
          UPDATE session_context_entries
          SET status = 'claimed', claim_id = ?, claim_expires_at = ?
          WHERE provider = ? AND status = 'pending'
            AND context_entry_id IN (${placeholders})
        `).run(
          claimId,
          now + Math.max(1, leaseMs),
          this.opts.provider,
          ...rows.map((row) => row.context_entry_id),
        );
        if (changed.changes !== rows.length) {
          throw new Error("Collaboration context claim changed concurrently");
        }
        return { claimId, entries: rows.map(entryFromRow) };
      });
      const claim = transaction.immediate();
      return Promise.resolve(claim);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  commitClaim(claimId: string): Promise<AppliedSessionContextEntry[]> {
    try {
      const transaction = this.db.transaction(() => {
        const rows = this.db.prepare(`
          SELECT session_id, context_entry_id, request_id, kind,
                 content, metadata_json, created_at
          FROM session_context_entries
          WHERE provider = ? AND claim_id = ? AND status = 'claimed'
          ORDER BY created_at ASC, context_entry_id ASC
        `).all(this.opts.provider, claimId) as EntryRow[];
        const appliedAt = Date.now();
        const insertReceipt = this.db.prepare(`
          INSERT INTO session_context_receipts (
            context_entry_id, provider, session_id, request_id, kind, content_hash, applied_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(context_entry_id) DO NOTHING
        `);
        for (const row of rows) {
          insertReceipt.run(
            row.context_entry_id,
            this.opts.provider,
            row.session_id,
            row.request_id,
            row.kind,
            hashContent(row.content),
            appliedAt,
          );
        }
        this.db.prepare(`
          DELETE FROM session_context_entries
          WHERE provider = ? AND claim_id = ? AND status = 'claimed'
        `).run(this.opts.provider, claimId);
        return rows.map((row) => ({
          contextEntryId: row.context_entry_id,
          requestId: row.request_id,
          sessionId: row.session_id,
          kind: row.kind,
        }));
      });
      const applied = transaction.immediate();
      this.maybeCleanup();
      return Promise.resolve(applied);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  releaseClaim(claimId: string): Promise<void> {
    this.db.prepare(`
      UPDATE session_context_entries
      SET status = 'pending', claim_id = NULL, claim_expires_at = NULL
      WHERE provider = ? AND claim_id = ? AND status = 'claimed'
    `).run(this.opts.provider, claimId);
    return Promise.resolve();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private findExisting(contextEntryId: string): {
    entry: ExistingEntryRow;
    alreadyApplied: boolean;
  } | null {
    const entry = this.db.prepare(`
      SELECT provider, session_id, request_id, kind, content_hash
      FROM session_context_entries
      WHERE context_entry_id = ?
    `).get(contextEntryId) as ExistingEntryRow | undefined;
    if (entry) return { entry, alreadyApplied: false };
    const receipt = this.db.prepare(`
      SELECT provider, session_id, request_id, kind, content_hash
      FROM session_context_receipts
      WHERE context_entry_id = ?
    `).get(contextEntryId) as ExistingEntryRow | undefined;
    return receipt ? { entry: receipt, alreadyApplied: true } : null;
  }

  private releaseExpiredClaims(now: number): void {
    this.db.prepare(`
      UPDATE session_context_entries
      SET status = 'pending', claim_id = NULL, claim_expires_at = NULL
      WHERE provider = ? AND status = 'claimed' AND claim_expires_at <= ?
    `).run(this.opts.provider, now);
  }

  private maybeCleanup(): void {
    this.operationCount += 1;
    if (this.operationCount % 50 === 0) this.cleanup();
  }

  private cleanup(): void {
    const cutoff = Date.now() - SESSION_CONTEXT_RECEIPT_RETENTION_MS;
    this.db.transaction(() => {
      this.releaseExpiredClaims(Date.now());
      this.db.prepare("DELETE FROM session_context_receipts WHERE applied_at < ?").run(cutoff);
      this.db.prepare(`
        DELETE FROM session_context_receipts
        WHERE context_entry_id IN (
          SELECT context_entry_id
          FROM session_context_receipts
          ORDER BY applied_at DESC, context_entry_id DESC
          LIMIT -1 OFFSET ?
        )
      `).run(SESSION_CONTEXT_MAX_RECEIPTS);
    }).immediate();
  }
}

export function formatSessionContext(entries: StoredSessionContextEntry[]): string | null {
  if (entries.length === 0) return null;
  const blocks = entries.map((entry) => [
    `[${entry.kind}]`,
    entry.content,
  ].join("\n"));
  return [
    "Saved collaboration context for this session. Treat it as prior user context, not as a new request to execute now.",
    ...blocks,
  ].join("\n\n");
}

function entryFromRow(row: EntryRow): StoredSessionContextEntry {
  return {
    sessionId: row.session_id,
    contextEntryId: row.context_entry_id,
    requestId: row.request_id,
    kind: row.kind,
    content: row.content,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
  };
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertMatchingEntry(
  existing: ExistingEntryRow,
  provider: CliAgentProviderName,
  input: AppendSessionContextInput,
  contentHash: string,
): void {
  if (
    existing.provider !== provider
    || existing.session_id !== input.sessionId
    || existing.request_id !== input.requestId
    || existing.kind !== input.kind
    || existing.content_hash !== contentHash
  ) {
    throw new Error("Context entry ID is already used by another collaboration request");
  }
}

function appendResult(
  provider: CliAgentProviderName,
  input: AppendSessionContextInput,
  appended: boolean,
  alreadyApplied = false,
): AppendSessionContextResult {
  return {
    provider,
    sessionId: input.sessionId,
    contextEntryId: input.contextEntryId,
    persisted: true,
    appended,
    alreadyApplied,
  };
}
