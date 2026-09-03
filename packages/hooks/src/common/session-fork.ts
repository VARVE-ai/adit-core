/**
 * Client-side conversation forks.
 *
 * Claude Code forks a conversation into a NEW session id when the user edits
 * and resends a message: the new transcript file starts with a copy of the
 * whole history (same message uuids), then diverges at the resent prompt.
 * Without special handling every fork became a separate ADIT session.
 *
 * Detection runs once, when an unknown platform session id first shows up:
 * the head of the new transcript is compared with the heads of recent
 * sessions' transcripts (same project and platform); a shared message uuid
 * means "fork of that session". The fork is then recorded as an alias of
 * the original local session, and the prompt the user abandoned (the last,
 * unanswered prompt of the original) is labelled `superseded`.
 *
 * Fail-open everywhere: any read/parse problem simply means "not a fork".
 */

import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import {
  deserialize,
  getLastEventOfSession,
  listRecentSessions,
  parseLabels,
  serialize,
  tick,
  updateEventLabels,
  type AditSession,
  type Platform,
} from "@varveai/adit-core";

/** Label put on the abandoned prompt that a fork replaced. */
export const SUPERSEDED_PROMPT_LABEL = "superseded";

const TRANSCRIPT_HEAD_BYTES = 512 * 1024;
const MAX_HEAD_UUIDS = 24;
const CANDIDATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CANDIDATES = 50;

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
  try {
    const metadata = session.metadataJson
      ? (JSON.parse(session.metadataJson) as { transcriptPath?: unknown })
      : null;
    if (typeof metadata?.transcriptPath === "string" && metadata.transcriptPath) {
      return metadata.transcriptPath;
    }
  } catch {
    /* fall through to the convention */
  }
  if (!session.platformSessionId) return null;
  return join(dirname(newTranscriptPath), `${session.platformSessionId}.jsonl`);
}

/**
 * The recent session (same project + platform) whose transcript shares its
 * opening messages with the new transcript — i.e. the session this one was
 * forked from. Null when there is no such session or nothing can be read.
 */
export function findForkedSession(
  db: Database.Database,
  input: {
    projectId: string;
    platform: Platform;
    platformSessionId: string;
    transcriptPath: string;
    now?: Date;
  },
): AditSession | null {
  if (!existsSync(input.transcriptPath)) return null;
  const headUuids = new Set(readTranscriptHeadUuids(input.transcriptPath));
  if (headUuids.size === 0) return null;

  const now = input.now ?? new Date();
  const candidates = listRecentSessions(db, {
    projectId: input.projectId,
    platform: input.platform,
    since: new Date(now.getTime() - CANDIDATE_WINDOW_MS).toISOString(),
    limit: MAX_CANDIDATES,
  });
  for (const candidate of candidates) {
    if (!candidate.platformSessionId || candidate.platformSessionId === input.platformSessionId) continue;
    const path = candidateTranscriptPath(input.transcriptPath, candidate);
    if (!path || path === input.transcriptPath || !existsSync(path)) continue;
    const shared = readTranscriptHeadUuids(path).some((uuid) => headUuids.has(uuid));
    if (shared) return candidate;
  }
  return null;
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
