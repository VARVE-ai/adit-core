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
  insertEventAutoSeq,
  insertSession,
  openDatabase,
  parseLabels,
  serialize,
} from "@varveai/adit-core";
import type Database from "better-sqlite3";
import {
  candidateTranscriptPath,
  findForkedSession,
  markSupersededPrompt,
  readTranscriptHeadUuids,
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
});
