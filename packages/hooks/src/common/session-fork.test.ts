/**
 * Tests for client-side fork detection (edited + resent messages that Claude
 * Code records under a new session id with a copied transcript).
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  createClock,
  getEventsBySession,
  getSessionById,
  getSessionByPlatformSessionId,
  insertEventAutoSeq,
  insertSession,
  listSessionPlatformAliases,
  openDatabase,
  parseLabels,
  serialize,
  type AditSession,
} from "@varveai/adit-core";
import type Database from "better-sqlite3";
import {
  candidateTranscriptPath,
  findForkedSession,
  FORK_CHECK_PENDING_KEY,
  isForkCheckPending,
  lookupForkedSession,
  markSupersededPrompt,
  readTranscriptHeadUuids,
  resolvePendingFork,
  SUPERSEDED_PROMPT_LABEL,
} from "./session-fork.js";

const PROJECT = "project-1";
const CLIENT = "client-1";
const ORIGINAL_ID = "f1cf8e72-fc2d-4cb7-bc78-be4d17fb45fe";
const FORK_ID = "9bb8dea1-1fe7-460c-a502-b8be6e5733eb";
const UNRELATED_ID = "0d5e2e5a-2a74-44be-8535-406693837bfd";

function record(type: string, uuid: string, sessionId: string, text = "x"): string {
  return JSON.stringify({
    type,
    uuid,
    parentUuid: null,
    sessionId,
    message: { role: type, content: [{ type: "text", text }] },
  });
}

function transcript(sessionId: string, uuids: string[]): string {
  const lines = [
    JSON.stringify({ type: "custom-title", customTitle: "t", sessionId }),
    JSON.stringify({ type: "mode", mode: "normal", sessionId }),
    ...uuids.map((uuid, index) => record(index % 2 === 0 ? "user" : "assistant", uuid, sessionId)),
  ];
  return lines.join("\n") + "\n";
}

describe("session forks", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = join(tmpdir(), `adit-fork-${randomBytes(8).toString("hex")}`);
    mkdirSync(dir, { recursive: true });
    db = openDatabase(join(dir, "adit.sqlite"));
    insertSession(db, {
      id: "local-original",
      projectId: PROJECT,
      clientId: CLIENT,
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      vclockJson: serialize(createClock(CLIENT)),
      platformSessionId: ORIGINAL_ID,
      metadataJson: JSON.stringify({ workingDirectory: dir }),
    });
    writeFileSync(join(dir, `${ORIGINAL_ID}.jsonl`), transcript(ORIGINAL_ID, ["m1", "m2", "m3", "m4"]));
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads message uuids from the head of a transcript, skipping meta records", () => {
    expect(readTranscriptHeadUuids(join(dir, `${ORIGINAL_ID}.jsonl`))).toEqual(["m1", "m2", "m3", "m4"]);
    expect(readTranscriptHeadUuids(join(dir, "missing.jsonl"))).toEqual([]);
  });

  it("derives a session's transcript path from its metadata or the platform convention", () => {
    const newPath = join(dir, `${FORK_ID}.jsonl`);
    const session = {
      id: "s",
      projectId: PROJECT,
      clientId: CLIENT,
      sessionType: "interactive" as const,
      platform: "claude-code" as const,
      startedAt: "",
      metadataJson: null,
      vclockJson: "{}",
      platformSessionId: ORIGINAL_ID,
      deletedAt: null,
    };
    expect(candidateTranscriptPath(newPath, session)).toBe(join(dir, `${ORIGINAL_ID}.jsonl`));
    expect(
      candidateTranscriptPath(newPath, { ...session, metadataJson: JSON.stringify({ transcriptPath: "/x/y.jsonl" }) }),
    ).toBe("/x/y.jsonl");
    expect(candidateTranscriptPath(newPath, { ...session, platformSessionId: null })).toBeNull();
  });

  it("recognises a transcript that starts with the original's messages as a fork", () => {
    // Fork: same opening messages, diverging later with the resent prompt.
    const forkPath = join(dir, `${FORK_ID}.jsonl`);
    writeFileSync(forkPath, transcript(FORK_ID, ["m1", "m2", "m3", "m4", "m5-resent"]));

    const found = findForkedSession(db, {
      projectId: PROJECT,
      platform: "claude-code",
      platformSessionId: FORK_ID,
      transcriptPath: forkPath,
    });
    expect(found?.id).toBe("local-original");
  });

  it("treats a transcript with its own opening messages as a new conversation", () => {
    const freshPath = join(dir, `${UNRELATED_ID}.jsonl`);
    writeFileSync(freshPath, transcript(UNRELATED_ID, ["n1", "n2"]));

    expect(
      findForkedSession(db, {
        projectId: PROJECT,
        platform: "claude-code",
        platformSessionId: UNRELATED_ID,
        transcriptPath: freshPath,
      }),
    ).toBeNull();
  });

  it("ignores sessions of other platforms and unreadable transcripts", () => {
    insertSession(db, {
      id: "local-codex",
      projectId: PROJECT,
      clientId: CLIENT,
      sessionType: "interactive",
      platform: "codex",
      startedAt: new Date().toISOString(),
      vclockJson: serialize(createClock(CLIENT)),
      platformSessionId: "codex-1",
    });
    const forkPath = join(dir, `${FORK_ID}.jsonl`);
    writeFileSync(forkPath, transcript(FORK_ID, ["m1", "m2"]));
    expect(
      findForkedSession(db, {
        projectId: PROJECT,
        platform: "codex",
        platformSessionId: FORK_ID,
        transcriptPath: forkPath,
      }),
    ).toBeNull();
    expect(
      findForkedSession(db, {
        projectId: PROJECT,
        platform: "claude-code",
        platformSessionId: FORK_ID,
        transcriptPath: join(dir, "does-not-exist.jsonl"),
      }),
    ).toBeNull();
  });

  it("labels the original's abandoned last prompt as superseded, once", () => {
    const clock = serialize(createClock(CLIENT));
    insertEventAutoSeq(db, {
      id: "e-prompt-answered",
      sessionId: "local-original",
      eventType: "prompt_submit",
      actor: "user",
      promptText: "first",
      startedAt: "2026-09-03T09:00:00.000Z",
      status: "completed",
      vclockJson: clock,
    });
    insertEventAutoSeq(db, {
      id: "e-response",
      sessionId: "local-original",
      eventType: "assistant_response",
      actor: "assistant",
      responseText: "ok",
      startedAt: "2026-09-03T09:01:00.000Z",
      status: "completed",
      vclockJson: clock,
    });
    insertEventAutoSeq(db, {
      id: "e-prompt-abandoned",
      sessionId: "local-original",
      eventType: "prompt_submit",
      actor: "user",
      promptText: "typo verison",
      startedAt: "2026-09-03T09:02:00.000Z",
      status: "completed",
      vclockJson: clock,
    });
    const session = {
      id: "local-original",
      projectId: PROJECT,
      clientId: CLIENT,
      sessionType: "interactive" as const,
      platform: "claude-code" as const,
      startedAt: "",
      metadataJson: null,
      vclockJson: clock,
      platformSessionId: ORIGINAL_ID,
      deletedAt: null,
    };

    expect(markSupersededPrompt(db, session, CLIENT)).toBe(true);
    expect(markSupersededPrompt(db, session, CLIENT)).toBe(false);

    const events = getEventsBySession(db, "local-original");
    expect(parseLabels(events.find((e) => e.id === "e-prompt-abandoned")!.labelsJson)).toEqual([SUPERSEDED_PROMPT_LABEL]);
    expect(parseLabels(events.find((e) => e.id === "e-prompt-answered")!.labelsJson)).toEqual([]);
  });

  it("cannot classify a transcript the platform has not written yet", () => {
    const forkPath = join(dir, `${FORK_ID}.jsonl`);
    const input = { projectId: PROJECT, platform: "claude-code" as const, platformSessionId: FORK_ID, transcriptPath: forkPath };

    expect(lookupForkedSession(db, input)).toEqual({ kind: "pending" });
    // Meta records only: no message has been flushed yet.
    writeFileSync(forkPath, transcript(FORK_ID, []));
    expect(lookupForkedSession(db, input)).toEqual({ kind: "pending" });

    writeFileSync(forkPath, transcript(FORK_ID, ["m1", "m2", "m3", "m4", "m5-resent"]));
    expect(lookupForkedSession(db, input)).toMatchObject({ kind: "fork", original: { id: "local-original" } });

    writeFileSync(forkPath, transcript(FORK_ID, ["n1"]));
    expect(lookupForkedSession(db, input)).toEqual({ kind: "none" });
  });

  it("never anchors a fork on a placeholder that is itself unresolved", () => {
    // An earlier fork that never got a second hook (interrupted again before
    // any reply) is more recent than the original but must not win.
    const stalePath = join(dir, `${UNRELATED_ID}.jsonl`);
    writeFileSync(stalePath, transcript(UNRELATED_ID, ["m1", "m2", "m3", "m4", "m5-stale"]));
    insertSession(db, {
      id: "local-stale-fork",
      projectId: PROJECT,
      clientId: CLIENT,
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: new Date().toISOString(),
      vclockJson: serialize(createClock(CLIENT)),
      platformSessionId: UNRELATED_ID,
      metadataJson: JSON.stringify({ transcriptPath: stalePath, [FORK_CHECK_PENDING_KEY]: true }),
    });
    const forkPath = join(dir, `${FORK_ID}.jsonl`);
    writeFileSync(forkPath, transcript(FORK_ID, ["m1", "m2", "m3", "m4", "m5-resent"]));

    expect(
      findForkedSession(db, {
        projectId: PROJECT,
        platform: "claude-code",
        platformSessionId: FORK_ID,
        transcriptPath: forkPath,
      })?.id,
    ).toBe("local-original");
  });

  describe("deferred check of a placeholder session", () => {
    const forkPath = () => join(dir, `${FORK_ID}.jsonl`);
    const clock = () => serialize(createClock(CLIENT));
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString();

    function recordOriginalTurns(): void {
      for (const [id, eventType, actor, text, minute] of [
        ["e-prompt-answered", "prompt_submit", "user", "first", 0],
        ["e-response", "assistant_response", "assistant", "ok", 1],
        ["e-prompt-abandoned", "prompt_submit", "user", "typo verison", 2],
      ] as const) {
        insertEventAutoSeq(db, {
          id,
          sessionId: "local-original",
          eventType,
          actor,
          promptText: actor === "user" ? text : null,
          responseText: actor === "assistant" ? text : null,
          startedAt: minutesAgo(30 - minute),
          status: "completed",
          vclockJson: clock(),
        });
      }
    }

    /** The session created for the fork id while its transcript was unreadable. */
    function insertPlaceholder(): AditSession {
      insertSession(db, {
        id: "local-placeholder",
        projectId: PROJECT,
        clientId: CLIENT,
        sessionType: "interactive",
        platform: "claude-code",
        startedAt: new Date().toISOString(),
        vclockJson: clock(),
        platformSessionId: FORK_ID,
        metadataJson: JSON.stringify({ transcriptPath: forkPath(), [FORK_CHECK_PENDING_KEY]: true }),
      });
      insertEventAutoSeq(db, {
        id: "e-prompt-resent",
        sessionId: "local-placeholder",
        eventType: "prompt_submit",
        actor: "user",
        promptText: "typo version, fixed",
        startedAt: minutesAgo(1),
        status: "completed",
        vclockJson: clock(),
      });
      return getSessionById(db, "local-placeholder")!;
    }

    const input = (session: AditSession) => ({
      session,
      clientId: CLIENT,
      projectId: PROJECT,
      platform: "claude-code" as const,
      platformSessionId: FORK_ID,
      transcriptPath: forkPath(),
    });

    it("waits while the transcript is still unwritten", () => {
      const session = insertPlaceholder();

      expect(resolvePendingFork(db, input(session))).toBeNull();

      expect(isForkCheckPending(getSessionById(db, "local-placeholder")!)).toBe(true);
      expect(getSessionById(db, "local-placeholder")?.deletedAt).toBeNull();
      expect(getEventsBySession(db, "local-placeholder").map((e) => e.id)).toEqual(["e-prompt-resent"]);
    });

    it("folds the placeholder into the original once the transcript can be read", () => {
      recordOriginalTurns();
      const session = insertPlaceholder();
      writeFileSync(forkPath(), transcript(FORK_ID, ["m1", "m2", "m3", "m4", "m5-resent"]));

      expect(resolvePendingFork(db, input(session))?.id).toBe("local-original");

      const events = getEventsBySession(db, "local-original");
      expect(events.map((e) => [e.id, e.sequence])).toEqual([
        ["e-prompt-answered", 1],
        ["e-response", 2],
        ["e-prompt-abandoned", 3],
        ["e-prompt-resent", 4],
      ]);
      expect(parseLabels(events[2]!.labelsJson)).toEqual([SUPERSEDED_PROMPT_LABEL]);
      expect(parseLabels(events[3]!.labelsJson)).toEqual([]);
      expect(getSessionById(db, "local-placeholder")?.deletedAt).not.toBeNull();
      expect(getSessionByPlatformSessionId(db, FORK_ID)?.id).toBe("local-original");
      expect(listSessionPlatformAliases(db, "local-original")).toEqual([FORK_ID]);
    });

    it("stops checking once the transcript proves to be a conversation of its own", () => {
      const session = insertPlaceholder();
      writeFileSync(forkPath(), transcript(FORK_ID, ["n1", "n2"]));

      expect(resolvePendingFork(db, input(session))).toBeNull();

      expect(isForkCheckPending(session)).toBe(false);
      const stored = getSessionById(db, "local-placeholder")!;
      expect(isForkCheckPending(stored)).toBe(false);
      expect(JSON.parse(stored.metadataJson!)).toEqual({ transcriptPath: forkPath() });
      expect(stored.deletedAt).toBeNull();
      expect(listSessionPlatformAliases(db, "local-original")).toEqual([]);
    });
  });
});
