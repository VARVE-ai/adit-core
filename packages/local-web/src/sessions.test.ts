import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionTurnView } from "./sessions";
import { setLanguage, type Language } from "./i18n";
import type {
  SessionEvent,
  SessionTurn,
} from "../../core/src/local-history/session-browser";

let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => "en" });
  setLanguage("en");
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
const event = (
  id: string,
  kind: SessionEvent["kind"] = "tool",
): SessionEvent => ({
  id,
  kind,
  text: id,
  name: kind === "tool" ? "Bash" : undefined,
  at: null,
});
const opener = event("opening", "reply"),
  final = event("final", "reply");
const middle = [
  event("tool1"),
  event("progress1", "reply"),
  event("tool2"),
  event("progress2", "reply"),
  event("tool3"),
  event("tool4"),
];
const turn = (extra: Partial<SessionTurn> = {}): SessionTurn => ({
  id: "turn",
  ordinal: 1,
  prompt: "Question",
  promptBlockId: null,
  promptTruncated: false,
  at: null,
  usage: {
    models: [],
    efforts: [],
    requests: 0,
    input: null,
    output: null,
    cache: null,
    cacheWrite: null,
  },
  events: [opener, ...middle, final],
  openingEvents: [opener],
  closingEvents: [final],
  commits: [
    {
      sha: "abcdef123",
      repository: "repo",
      subject: "Change",
      at: null,
      turnId: "turn",
    },
  ],
  contextOnly: false,
  previousOffset: null,
  nextOffset: null,
  matchEventId: null,
  ...extra,
});
const request = vi.fn(async () => ({
  text: "Full tool body",
  nextOffset: null,
})) as any;
function render(
  value = turn(),
  mode: "normal" | "focused" = "normal",
  api = request,
) {
  act(() => {
    renderer = create(
      React.createElement(SessionTurnView, {
        turn: value,
        mode,
        request: api,
        onCommit: () => {},
      }),
    );
  });
}
const renderedEvents = () =>
  renderer.root
    .findAll((n) => typeof n.type === "string" && !!n.props["data-event-id"])
    .map((n) => n.props["data-event-id"]);
it.each([['en', 'Image prompt (2)'], ['zh', '图片提问（2 张）']])("shows an image-only prompt in %s with its reply", (language, label) => {
  setLanguage(language as Language);
  render(turn({prompt: "", imageCount: 2, events: [final]}));
  expect(JSON.stringify(renderer.toJSON())).toContain(label);
  expect(renderedEvents()).toEqual(['final']);
});
it("normal keeps every reply in order and groups only consecutive tools, with each input/output collapsed", async () => {
  render();
  expect(renderedEvents()).toEqual([
    "opening",
    ...middle.map((e) => e.id),
    "final",
  ]);
  const groups = renderer.root.findAllByProps({
    className: "session-operations",
  });
  expect(
    groups.map(
      (group) =>
        group.findAllByProps({ className: "session-operation" }).length,
    ),
  ).toEqual([1, 1, 2]);
  expect(groups.every(group => group.type === "details" && !group.props.open)).toBe(true);
  expect(renderer.root.findAllByProps({ className: "session-tool-node" })).toHaveLength(3);
  expect(
    renderer.root
      .findAllByProps({ className: "session-operation" })
      .every((tool) => !tool.props.open),
  ).toBe(true);
  expect(
    renderer.root.findAllByProps({ className: "session-tool-content" }),
  ).toHaveLength(0);
  expect(
    renderer.root.findAllByProps({ className: "session-commit" }),
  ).toHaveLength(1);
  act(() => groups[2].props.onToggle({ currentTarget: { open: true } }));
  expect(groups[2].props.open).toBe(true);
  await act(async () =>
    renderer.root
      .findByProps({ "data-event-id": "tool3" })
      .props.onToggle({ currentTarget: { open: true } }),
  );
  expect(
    renderer.root.findAllByProps({ className: "session-tool-content" }),
  ).toHaveLength(1);
  expect(renderedEvents()).toEqual([
    "opening",
    ...middle.map((e) => e.id),
    "final",
  ]);
  act(() => groups[2].props.onToggle({ currentTarget: { open: false } }));
  expect(groups[2].props.open).toBe(false);
});

it("pages normal activity in its original order without injecting replies from other pages", async () => {
  const api = vi.fn(async (_path: string, params: Record<string, string>) =>
    turn(
      params.offset === "0"
        ? {
            events: [opener, event("early")],
            previousOffset: null,
            nextOffset: 40,
          }
        : {
            events: [event("late"), final],
            previousOffset: 40,
            nextOffset: null,
          },
    ),
  );
  render(
    turn({ events: middle, previousOffset: 0, nextOffset: 80 }),
    "normal",
    api,
  );
  expect(renderedEvents()).toEqual(middle.map((e) => e.id));
  expect(
    renderer.root.findAllByProps({ className: "session-commit" }),
  ).toHaveLength(1);
  const load = async (label: string) => {
    const button = renderer.root
      .findAllByType("button")
      .find((b) => b.children.includes(label))!;
    await act(async () => {
      await button.props.onClick();
    });
  };
  await load("Load earlier activity");
  await load("Load more activity");
  expect(renderedEvents()).toEqual([
    "opening",
    "early",
    ...middle.map((e) => e.id),
    "late",
    "final",
  ]);
  expect(api.mock.calls.map((c) => c[1].offset)).toEqual(["0", "80"]);
});

it("keeps intermediate reply search hits visible and expands only the matched tool", async () => {
  render(turn({ matchEventId: "progress2" }));
  expect(renderedEvents()).toContain("progress2");
  expect(
    renderer.root.findByProps({ "data-event-id": "progress2" }).props.className,
  ).toContain("search-event-match");
  act(() => renderer.unmount());
  await act(async () => render(turn({ matchEventId: "tool4" })));
  expect(
    renderer.root.findByProps({ "data-event-id": "tool4" }).props.open,
  ).toBe(true);
  expect(
    renderer.root.findByProps({ "data-event-id": "tool3" }).props.open,
  ).toBe(false);
  expect(renderer.root.findAllByProps({ className: "session-operations" }).map(group => group.props.open)).toEqual([false, false, true]);
});

it("shows each associated commit as its own timeline node and retains the detail action", () => {
  const commits = [turn().commits[0], { ...turn().commits[0], sha: "123456789", subject: "Second change" }];
  const onCommit = vi.fn();
  act(() => {
    renderer = create(React.createElement(SessionTurnView, {
      turn: turn({ commits }), mode: "normal", request, onCommit,
    }));
  });
  const entries = renderer.root.findAllByProps({ className: "session-commit" });
  expect(entries).toHaveLength(2);
  expect(entries.every(entry => entry.type === "details" && !entry.props.open)).toBe(true);
  expect(entries.map(entry => entry.findByProps({ className: "session-commit-node" }).type)).toEqual(["span", "span"]);
  expect(entries.map(entry => entry.findByType("summary").findByType("code").children.join(""))).toEqual(["abcdef1", "1234567"]);
  act(() => entries[1].findByType("button").props.onClick());
  expect(onCommit).toHaveBeenCalledWith(commits[1]);
});

it("keeps focused mode to the final reply and commits, and never invents a final reply for an unfinished turn", () => {
  render(
    turn({ events: [final], openingEvents: [], closingEvents: [] }),
    "focused",
  );
  expect(renderedEvents()).toEqual(["final"]);
  expect(
    renderer.root.findAllByProps({ className: "session-operations" }),
  ).toHaveLength(0);
  act(() => renderer.unmount());
  render(turn({ events: [opener, ...middle], closingEvents: [] }));
  expect(renderedEvents()).not.toContain("final");
});

it("keeps normal replies before trailing cleanup tools and renders consecutive thinking and context separately", () => {
  const sequence = [
    opener,
    event("reasoning", "thinking"),
    event("tool1"),
    event("context", "system"),
    event("tool2"),
    final,
    event("cleanup"),
  ];
  render(turn({ events: sequence }));
  expect(renderedEvents()).toEqual(sequence.map((e) => e.id));
  const groups = renderer.root.findAllByProps({
    className: "session-operations",
  });
  expect(groups).toHaveLength(3);
  expect(
    groups.every(
      (group) =>
        group.findAll(
          (n) =>
            n.props["data-event-id"] === "reasoning" ||
            n.props["data-event-id"] === "context",
        ).length === 0,
    ),
  ).toBe(true);
  expect(
    renderer.root.findAllByProps({ className: "session-commit" }),
  ).toHaveLength(1);
});

it("does not label a reply on the next page as unfinished", () => {
  render(turn({ events: [], hasMoreEvents: true }), "focused");
  expect(JSON.stringify(renderer.toJSON())).not.toContain("No final reply for this prompt yet");
});

it("collapses prompts and replies independently and preserves Markdown when expanded", () => {
  const markdown = "**Summary**\n\n| Name | Value |\n| --- | --- |\n| Item | 1 |\n\n```js\nconst value = 1;\n```";
  render(turn({ prompt: markdown, events: [{ ...final, text: markdown }] }));
  const messages = () => renderer.root.findAllByProps({ className: "session-message" });
  expect(messages()).toHaveLength(2);
  expect(messages().every(m => !m.props.open)).toBe(true);
  expect(renderer.root.findAllByType("table")).toHaveLength(0);
  expect(renderer.root.findAllByProps({ className: "session-reply-node" })).toHaveLength(1);
  for (const index of [0, 1]) {
    act(() => messages()[index].props.onToggle({ currentTarget: { open: true } }));
    expect(messages()[index].findAllByType("table")).toHaveLength(1);
    expect(messages()[index].findAllByType("pre")).toHaveLength(1);
    expect(messages()[index].findAllByType("strong")).toHaveLength(1);
    expect(messages()[1 - index].props.open).toBe(false);
    act(() => messages()[index].props.onToggle({ currentTarget: { open: false } }));
    expect(messages()[index].findAllByType("table")).toHaveLength(0);
  }
});

it("loads truncated reply content only when expanded and retains Markdown rendering", async () => {
  const api = vi.fn(async () => ({ text: "**Full response**", nextOffset: null }));
  render(turn({ events: [{ ...final, truncated: true }] }), "normal", api);
  expect(api).not.toHaveBeenCalled();
  const reply = renderer.root.findByProps({ "data-event-id": "final" });
  await act(async () => reply.findByType("details").props.onToggle({ currentTarget: { open: true } }));
  expect(api).toHaveBeenCalledWith("content", { eventId: "final", kind: "reply", offset: "0" });
  expect(reply.findByType("strong").children).toEqual(["Full response"]);
});
