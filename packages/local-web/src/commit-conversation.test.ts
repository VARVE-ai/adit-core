import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { CommitConversation } from "./commit-conversation";
import { setLanguage } from "./i18n";
import type { SessionTurnPreview } from "../../core/src/local-history/session-browser";

let renderer: ReactTestRenderer;
afterEach(() => { act(() => renderer?.unmount()); });
it("shows the expanded card in question/commit/reply order with real per-turn usage and exact turn links", async () => {
  setLanguage("en");
  const data: SessionTurnPreview = { session: { provider: "codex", id: "session", title: "Original title" }, targetTurnId: "turn-2",
    turns: [1, 2, 3].map(i => ({ id: `turn-${i}`, ordinal: i, prompt: `Question ${i}`, reply: i < 3 ? `Reply ${i}` : null, imageCount: 0,
      at: Date.UTC(2026, 9, 23, 9, i), replyAt: i < 3 ? Date.UTC(2026, 9, 23, 9, i, 30) : null,
      usage: { input: i < 3 ? 1900 : null, output: i < 3 ? 720 : null, cache: i < 3 ? 16100 : null, cacheWrite: null,
        models: i < 3 ? ["recorded-model"] : [], efforts: [], requests: i < 3 ? 1 : 0 },
    })) };
  const onNavigate = vi.fn();
  await act(async () => { renderer = create(React.createElement(CommitConversation, {
    workspaceId: "w", record: { provider: "codex", sessionId: "session", turnId: "turn-2", title: "Original title", ordinal: 2,
      at: Date.UTC(2026, 9, 23, 9, 2, 15), command: "git commit", prompt: "Question 2", method: "hash", matchedSha: null },
    sha: "abcdef123456", subject: "Commit subject", api: (async () => data) as any, onNavigate,
  })); });
  const card = renderer.root.findByProps({ className: "commit-conversation" });
  expect(card.type).toBe("details"); expect(card.props.open).toBe(true);
  expect(renderer.root.findByProps({ className: "commit-conversation-count" }).children).toEqual(["7"]);
  const rows = renderer.root.findAll(n => n.type === "a" && n.props.className?.startsWith("commit-context-row "));
  expect(rows.map(n => n.props["aria-label"])).toEqual([
    "Open question in turn 1", "Open reply in turn 1", "Open question in turn 2", "View commit abcdef1 in the session", "Open reply in turn 2", "Open question in turn 3", "Open reply in turn 3",
  ]);
  expect(renderer.root.findAllByProps({ className: "commit-context-usage" })).toHaveLength(2);
  expect(rows.at(-1)!.findByType("time").children).toEqual([]);
  const preventDefault = vi.fn();
  act(() => rows[4].props.onClick({ button: 0, preventDefault }));
  expect(onNavigate).toHaveBeenCalledWith("/sessions/w?provider=codex&session=session&turn=turn-2");
  act(() => card.props.onToggle({ currentTarget: { open: false } }));
  expect(card.props.open).toBe(false);
});
