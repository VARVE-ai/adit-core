import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_CONTEXT_MAX_PENDING_CHARS } from "../session-context-store.js";
import { CodexSessionContextStore, formatCodexSessionContext } from "./session-context-store.js";

describe("CodexSessionContextStore", () => {
  const directories: string[] = [];
  const stores: CodexSessionContextStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists, claims, applies, and deduplicates context entries", async () => {
    const { dataDir, store } = createStore();
    const input = contextInput("entry-a", "session-a", "Question for Agent B");

    await expect(store.append(input)).resolves.toMatchObject({ appended: true });
    await expect(store.append(input)).resolves.toMatchObject({
      appended: false,
      alreadyApplied: false,
    });
    await expect(store.append({ ...input, content: "Different content" })).rejects.toThrow(
      "Context entry ID is already used by another collaboration request",
    );

    const claim = await store.claimPending("session-a");
    expect(claim?.entries).toHaveLength(1);
    expect(formatCodexSessionContext(claim?.entries ?? [])).toContain("Question for Agent B");
    expect(await store.claimPending("session-a")).toBeNull();
    expect(await store.commitClaim(claim!.claimId)).toEqual([{
      contextEntryId: "entry-a",
      requestId: "request-entry-a",
      sessionId: "session-a",
      kind: "collaboration_result",
    }]);
    expect(await store.claimPending("session-a")).toBeNull();
    await expect(store.append(input)).resolves.toMatchObject({
      appended: false,
      alreadyApplied: true,
    });
    expect(existsSync(join(dataDir, "cli-agent", "session-context.sqlite"))).toBe(true);
  });

  it("keeps sessions isolated and releases a failed claim", async () => {
    const { store } = createStore();
    await store.append(contextInput("entry-a", "session-a", "Answer A"));
    await store.append(contextInput("entry-b", "session-b", "Answer B"));

    const claim = await store.claimPending("session-a");
    expect(claim?.entries.map((entry) => entry.content)).toEqual(["Answer A"]);
    await store.releaseClaim(claim!.claimId);
    expect((await store.claimPending("session-a"))?.entries).toHaveLength(1);
    expect((await store.claimPending("session-b"))?.entries).toHaveLength(1);
  });

  it("allows only one store instance to claim the same entries", async () => {
    const { dataDir, store: first } = createStore();
    const second = trackStore(new CodexSessionContextStore(dataDir));
    await first.append(contextInput("entry-a", "session-a", "Answer"));

    const firstClaim = await first.claimPending("session-a");
    const secondClaim = await second.claimPending("session-a");
    expect(firstClaim?.entries).toHaveLength(1);
    expect(secondClaim).toBeNull();
  });

  it("recovers an expired claim after a process interruption", async () => {
    const { dataDir, store: first } = createStore();
    const second = trackStore(new CodexSessionContextStore(dataDir));
    await first.append(contextInput("entry-a", "session-a", "Answer"));
    expect(await first.claimPending("session-a", 1)).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await second.claimPending("session-a"))?.entries).toHaveLength(1);
  });

  it("rejects pending context beyond the per-Session budget", async () => {
    const { store } = createStore();
    const chunk = "x".repeat(32_000);
    const entryCount = SESSION_CONTEXT_MAX_PENDING_CHARS / chunk.length;
    for (let index = 0; index < entryCount; index += 1) {
      await store.append(contextInput(`entry-${index}`, "session-a", chunk));
    }
    await expect(
      store.append(contextInput("entry-over-budget", "session-a", "x")),
    ).rejects.toThrow("Collaboration context budget exceeded for this Session");
  });

  function createStore(): { dataDir: string; store: CodexSessionContextStore } {
    const dataDir = mkdtempSync(join(tmpdir(), "adit-codex-context-"));
    directories.push(dataDir);
    return { dataDir, store: trackStore(new CodexSessionContextStore(dataDir)) };
  }

  function trackStore(store: CodexSessionContextStore): CodexSessionContextStore {
    stores.push(store);
    return store;
  }
});

function contextInput(contextEntryId: string, sessionId: string, content: string) {
  return {
    sessionId,
    contextEntryId,
    requestId: `request-${contextEntryId}`,
    kind: "collaboration_result" as const,
    content,
    metadata: { targetPanelName: "Agent B" },
  };
}
