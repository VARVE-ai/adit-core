/**
 * Timeline manager — the high-level orchestrator.
 *
 * Coordinates between the database, git operations, and snapshot creation
 * to provide the unified timeline experience.
 */

import type Database from "better-sqlite3";
import {
  generateId,
  createClock,
  serialize,
  insertEventAutoSeq,
  getEventById,
  queryEvents,
  searchEvents,
  getDiffText,
  type AditEvent,
  type EventType,
  type Actor,
  type AditConfig,
} from "@varveai/adit-core";
import { getHeadSha, getCurrentBranch } from "../git/runner.js";

export interface TimelineManager {
  /** Record a new event in the timeline */
  recordEvent(params: RecordEventParams): Promise<AditEvent>;

  /** Search events by text */
  search(query: string, limit?: number): Promise<AditEvent[]>;

  /** List recent events */
  list(opts?: ListOptions): Promise<AditEvent[]>;

  /** Get a single event by ID */
  get(eventId: string): Promise<AditEvent | null>;

  /** Get diff text for an event */
  getDiff(
    eventId: string,
    maxLines?: number,
    offsetLines?: number,
  ): Promise<string | null>;
}

export interface RecordEventParams {
  sessionId: string;
  parentEventId?: string | null;
  eventType: EventType;
  actor: Actor;
  promptText?: string | null;
  cotText?: string | null;
  responseText?: string | null;
  toolName?: string | null;
  toolInputJson?: string | null;
  toolOutputJson?: string | null;
  errorJson?: string | null;
  diffStatJson?: string | null;
  gitBranch?: string | null;
  gitHeadSha?: string | null;
}

export interface ListOptions {
  sessionId?: string;
  eventType?: EventType;
  actor?: Actor;
  limit?: number;
}

/** Create a timeline manager instance */
export function createTimelineManager(
  db: Database.Database,
  config: AditConfig,
): TimelineManager {
  const cwd = config.projectRoot;

  return {
    async recordEvent(params: RecordEventParams): Promise<AditEvent> {
      const id = generateId();
      const now = new Date().toISOString();
      const hasGitBranchOverride = Object.prototype.hasOwnProperty.call(params, "gitBranch");
      const hasGitHeadShaOverride = Object.prototype.hasOwnProperty.call(params, "gitHeadSha");
      const branch = hasGitBranchOverride ? params.gitBranch ?? null : await getCurrentBranch(cwd);
      const headSha = hasGitHeadShaOverride ? params.gitHeadSha ?? null : await getHeadSha(cwd);
      const vclock = serialize(createClock(config.clientId));

      // Use insertEventAutoSeq to atomically allocate the sequence number
      // inside the INSERT, preventing duplicate sequences from concurrent
      // hook processes that could read the same MAX(sequence).
      insertEventAutoSeq(db, {
        id,
        sessionId: params.sessionId,
        parentEventId: params.parentEventId ?? null,
        eventType: params.eventType,
        actor: params.actor,
        promptText: params.promptText ?? null,
        cotText: params.cotText ?? null,
        responseText: params.responseText ?? null,
        toolName: params.toolName ?? null,
        toolInputJson: params.toolInputJson ?? null,
        toolOutputJson: params.toolOutputJson ?? null,
        gitBranch: branch,
        gitHeadSha: headSha,
        startedAt: now,
        status: "success",
        endedAt: now,
        errorJson: params.errorJson ?? null,
        diffStatJson: params.diffStatJson ?? null,
        clientId: config.clientId,
        vclockJson: vclock,
      });

      const event = getEventById(db, id);
      if (!event) {
        throw new Error(`Failed to retrieve event after insert: ${id}`);
      }
      return event;
    },

    async search(query: string, limit = 20): Promise<AditEvent[]> {
      return searchEvents(db, query, limit);
    },

    async list(opts?: ListOptions): Promise<AditEvent[]> {
      return queryEvents(db, {
        sessionId: opts?.sessionId,
        eventType: opts?.eventType,
        actor: opts?.actor,
        limit: opts?.limit ?? 50,
      });
    },

    async get(eventId: string): Promise<AditEvent | null> {
      return getEventById(db, eventId);
    },

    async getDiff(
      eventId: string,
      maxLines?: number,
      offsetLines?: number,
    ): Promise<string | null> {
      return getDiffText(db, eventId, maxLines, offsetLines);
    },
  };
}
