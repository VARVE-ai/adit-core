/**
 * Client-side conversation forks.
 *
 * Claude Code forks a conversation into a NEW session id when the user edits
 * and resends a message: the new transcript file starts with a copy of the
 * whole history (same message uuids), then diverges at the resent prompt.
 * Without special handling every fork became a separate ADIT session.
 *
 * Detection compares the head of the new transcript with the heads of
 * recently active sessions' transcripts (same project and platform); a
 * shared message uuid means "fork of that session". The fork is then
 * recorded as an alias of the original local session, and the prompt the
 * user abandoned (the last, unanswered prompt of the original) is labelled
 * `superseded`.
 *
 * Timing matters: Claude Code writes the forked transcript only after the
 * first hook of the new session id (UserPromptSubmit) has returned, so at
 * that moment there is nothing to compare yet. The lookup then reports
 * `pending`; the session created in the meantime carries a pending flag in
 * its metadata and the check is repeated on later hooks. Once the transcript
 * can be read, a confirmed fork folds that placeholder session (and whatever
 * it recorded) back into the original.
 *
 * Fail-open everywhere: any read/parse problem simply means "not a fork".
 */

import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import {
  deserialize,
  getLastEventOfSession,
  insertSessionPlatformAlias,
  listRecentSessions,
  mergeSessionInto,
  parseLabels,
  serialize,
  tick,
  updateEventLabels,
  type AditSession,
  type Platform,
} from "@varveai/adit-core";

/** Label put on the abandoned prompt that a fork replaced. */
export const SUPERSEDED_PROMPT_LABEL = "superseded";

/**
 * Session metadata key of a session whose fork check could not run when it
 * was created (transcript not written yet); removed once the check has run.
 */
export const FORK_CHECK_PENDING_KEY = "forkCheckPending";

const TRANSCRIPT_HEAD_BYTES = 512 * 1024;
const MAX_HEAD_UUIDS = 24;
const CANDIDATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CANDIDATES = 50;

export interface ForkLookupInput {
  projectId: string;
  platform: Platform;
  platformSessionId: string;
  transcriptPath: string;
  now?: Date;
}

export type ForkLookup =
  /** The transcript continues `original`'s conversation. */
  | { kind: "fork"; original: AditSession }
  /** The transcript starts a conversation of its own. */
  | { kind: "none" }
  /** The transcript holds no message yet (not written): retry on a later hook. */
  | { kind: "pending" };

/**
 * Message uuids from the first records of a transcript (JSONL). Only
 * conversational records (user / assistant) count; meta records such as
 * titles carry no uuid. Reads a bounded prefix of the file.
 */
export function readTranscriptHeadUuids(path: string, maxUuids = MAX_HEAD_UUIDS): string[] {
  let text: string;
  try {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
      const bytes = readSync(fd, buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, bytes).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const uuids: string[] = [];
  const lines = text.split("\n");
  // The last line may be cut mid-record by the byte limit; JSON.parse
  // rejects it and it is skipped like any other unparsable line.
  for (const line of lines) {
    if (uuids.length >= maxUuids) break;
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { type?: unknown; uuid?: unknown };
      if ((record.type === "user" || record.type === "assistant") && typeof record.uuid === "string") {
        uuids.push(record.uuid);
      }
    } catch {
      /* skip */
    }
  }
  return uuids;
}

/**
 * Where a session's own transcript should live: an explicitly recorded path
 * from its metadata, else the platform's convention — a sibling of the new
 * transcript named after the session's platform session id.
 */
export function candidateTranscriptPath(
  newTranscriptPath: string,
  session: AditSession,
): string | null {
  const metadata = parseMetadata(session.metadataJson);
  if (typeof metadata?.transcriptPath === "string" && metadata.transcriptPath) {
    return metadata.transcriptPath;
  }
  if (!session.platformSessionId) return null;
  return join(dirname(newTranscriptPath), `${session.platformSessionId}.jsonl`);
}

/**
 * Classify a transcript against the recently active sessions of the same
 * project and platform: a fork of one of them, a new conversation, or not
 * decidable yet because the platform has not written any message to it.
 */
export function lookupForkedSession(
  db: Database.Database,
  input: ForkLookupInput,
): ForkLookup {
  if (!existsSync(input.transcriptPath)) return { kind: "pending" };
  const headUuids = new Set(readTranscriptHeadUuids(input.transcriptPath));
  if (headUuids.size === 0) return { kind: "pending" };

  const now = input.now ?? new Date();
  const candidates = listRecentSessions(db, {
    projectId: input.projectId,
    platform: input.platform,
    since: new Date(now.getTime() - CANDIDATE_WINDOW_MS).toISOString(),
    limit: MAX_CANDIDATES,
  });
  for (const candidate of candidates) {
    if (!candidate.platformSessionId || candidate.platformSessionId === input.platformSessionId) continue;
    // A session whose own identity is still unresolved cannot anchor a fork:
    // a fork of a fork resolves to the conversation both were copied from.
    if (isForkCheckPending(candidate)) continue;
    const path = candidateTranscriptPath(input.transcriptPath, candidate);
    if (!path || path === input.transcriptPath || !existsSync(path)) continue;
    const shared = readTranscriptHeadUuids(path).some((uuid) => headUuids.has(uuid));
    if (shared) return { kind: "fork", original: candidate };
  }
  return { kind: "none" };
}

/**
 * The recent session the transcript was forked from; null for a new
 * conversation or when nothing can be compared yet (see lookupForkedSession).
 */
export function findForkedSession(
  db: Database.Database,
  input: ForkLookupInput,
): AditSession | null {
  const lookup = lookupForkedSession(db, input);
  return lookup.kind === "fork" ? lookup.original : null;
}

/** Whether the session still awaits its deferred fork check. */
export function isForkCheckPending(session: AditSession): boolean {
  return parseMetadata(session.metadataJson)?.[FORK_CHECK_PENDING_KEY] === true;
}

/** Drop the pending flag: the check has run, whatever its verdict. */
export function clearForkCheckPending(db: Database.Database, session: AditSession): void {
  const metadata = parseMetadata(session.metadataJson);
  if (!metadata || !(FORK_CHECK_PENDING_KEY in metadata)) return;
  delete metadata[FORK_CHECK_PENDING_KEY];
  const metadataJson = JSON.stringify(metadata);
  db.prepare("UPDATE sessions SET metadata_json = ? WHERE id = ?").run(metadataJson, session.id);
  session.metadataJson = metadataJson;
}

/**
 * Record `platformSessionId` as an alias of `original`, so later hooks under
 * that id reattach to it, and label the prompt the fork replaced.
 */
export function attachForkAlias(
  db: Database.Database,
  original: AditSession,
  input: { platformSessionId: string; clientId: string },
): void {
  insertSessionPlatformAlias(db, {
    platformSessionId: input.platformSessionId,
    sessionId: original.id,
  });
  markSupersededPrompt(db, original, input.clientId);
}

/**
 * Deferred fork check for a session created while its transcript was still
 * unwritten. Returns the original session when the transcript turns out to
 * continue one — `session` has then been folded into it (events moved,
 * alias recorded, placeholder row soft-deleted) — and null when hooks should
 * keep recording into `session`: still nothing to read, or a conversation of
 * its own (the pending flag is cleared so the check does not repeat).
 */
export function resolvePendingFork(
  db: Database.Database,
  input: ForkLookupInput & { session: AditSession; clientId: string },
): AditSession | null {
  let lookup: ForkLookup;
  try {
    lookup = lookupForkedSession(db, input);
  } catch {
    return null;
  }
  if (lookup.kind === "pending") return null;
  if (lookup.kind === "none") {
    try {
      clearForkCheckPending(db, input.session);
    } catch {
      /* fail-open */
    }
    return null;
  }
  const original = lookup.original;
  try {
    db.transaction(() => {
      // Label before moving: afterwards the original's last event is the
      // fork's own prompt, not the one it replaced.
      attachForkAlias(db, original, input);
      mergeSessionInto(db, {
        sourceSessionId: input.session.id,
        targetSessionId: original.id,
        clientId: input.clientId,
      });
    })();
    return original;
  } catch {
    // Keep recording into the placeholder rather than retrying a failing
    // merge on every hook.
    try {
      clearForkCheckPending(db, input.session);
    } catch {
      /* fail-open */
    }
    return null;
  }
}

/**
 * Label the abandoned prompt a fork replaced: the original session's last
 * event, when it is a prompt nothing has answered yet.
 */
export function markSupersededPrompt(
  db: Database.Database,
  session: AditSession,
  clientId: string,
): boolean {
  const last = getLastEventOfSession(db, session.id);
  if (!last || last.eventType !== "prompt_submit") return false;
  const labels = new Set(parseLabels(last.labelsJson));
  if (labels.has(SUPERSEDED_PROMPT_LABEL)) return false;
  labels.add(SUPERSEDED_PROMPT_LABEL);
  let clock;
  try {
    clock = tick(deserialize(last.vclockJson), clientId);
  } catch {
    return false;
  }
  updateEventLabels(db, last.id, JSON.stringify(Array.from(labels)), serialize(clock));
  return true;
}

function parseMetadata(metadataJson: string | null): Record<string, unknown> | null {
  if (!metadataJson) return null;
  try {
    const parsed: unknown = JSON.parse(metadataJson);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
