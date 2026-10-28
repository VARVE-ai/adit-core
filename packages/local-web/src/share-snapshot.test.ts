import { expect, it } from "vitest";
import { validateShareSnapshot } from "./share-snapshot";

it("validates public Gist fields before rendering, including optional tool labels", () => {
  const snapshot = { schemaVersion: 1, title: "Shared session", agent: "Codex", provider: "codex", models: [], date: null,
    promptCount: 1, commitCount: 0, commandCount: 1, commits: [],
    turns: [{ prompt: "A question", models: [], efforts: [], input: null, output: 0, cache: null, commits: [], events: [{ kind: "command", text: "git status", summary: "git status", icon: "git" }] }] };
  expect(validateShareSnapshot(snapshot)).toBe(true);
  for (const value of [null, {}, [], { ...snapshot, costMicrousd: "secret" }, { ...snapshot, date: 1e20 },
    { ...snapshot, turns: [{ ...snapshot.turns[0], input: -2 }] },
    { ...snapshot, turns: [{ ...snapshot.turns[0], events: [{ kind: "command", text: "test", summary: { invalid: true } }] }] },
    { ...snapshot, turns: [{ ...snapshot.turns[0], events: [null] }] }]) expect(validateShareSnapshot(value)).toBe(false);
});
