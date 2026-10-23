import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionsPage } from "./sessions";
import { setLanguage } from "./i18n";
import type { SessionDayItem, SessionList } from "../../core/src/local-history/session-browser";

let renderer: ReactTestRenderer;
const observers: { fire: () => void; disconnected: boolean; root: unknown }[] = [];
const listNode = { scrollTop: 0 };
const detailNode = { scrollTop: 0, scrollHeight: 1000, querySelector: () => null };
beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("location", { search: "" });
  vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("IntersectionObserver", class {
    record: typeof observers[number];
    constructor(callback: (entries: unknown[]) => void, options: { root: unknown }) {
      this.record = { fire: () => callback([{ isIntersecting: true }]), disconnected: false, root: options.root };
      observers.push(this.record);
    }
    observe() {}
    disconnect() { this.record.disconnected = true; }
  });
  setLanguage("en");
});
afterEach(() => { act(() => renderer?.unmount()); vi.unstubAllGlobals(); });
const row = (i: number): SessionDayItem => {
  const at = Date.UTC(2026, 9, 23 - i, 9);
  return { provider: "claude", id: "same-conversation", day: new Date(at).toISOString().slice(0, 10), dayIndex: 101 - i, dayCount: 101,
    title: "Conversation", startedAt: at, lastActivityAt: at + 3600000, messages: 12, prompts: i + 1,
    commits: 0, cost: i === 0 ? 2360000 : null, unpriced: 0 };
};
const page = (offset: number, total = 101): SessionList => ({
  items: Array.from({ length: Math.min(50, total - offset) }, (_, i) => ({ ...row(i + offset), dayIndex: total - i - offset, dayCount: total })),
  total, messages: total * 12, first: row(total - 1).startedAt,
  providers: [{ id: "claude", name: "Claude Code", count: 1 }],
  nextOffset: offset + 50 < total ? offset + 50 : null,
});
function apiWithList(read: (params: URLSearchParams) => Promise<SessionList>, readDetail?: (params: URLSearchParams) => Promise<any>) {
  return vi.fn(async (url: string) => {
    const parsed = new URL(url, "http://localhost");
    if (parsed.pathname === "/sessions") return read(parsed.searchParams);
    if (readDetail) return readDetail(parsed.searchParams);
    return { pageOffset: 0, totalEntries: 0, session: row(0), models: [], cost: null, unpriced: 0, repositories: [], turns: [],
      totalTurns: 0, nextOffset: null, children: [], parent: null, commits: [], context: [],
      contextNextOffset: null, previousOffset: null, matchTurnId: null };
  });
}
async function mount(api: ReturnType<typeof apiWithList>) {
  await act(async () => {
    renderer = create(React.createElement(SessionsPage, {
      workspace: { id: "workspace", name: "Project" }, api: api as any, onCommit: () => {},
    }), { createNodeMock: element => element.props.className === "sessions-list" ? listNode : element.props.className === "session-events-scroll" ? detailNode : {
      closest: () => detailNode, dataset: {}, style: { setProperty() {} },
      getBoundingClientRect: () => ({ width: 100 }),
    } });
  });
}
const rows = () => renderer.root.findAll(n => n.type === "button" && n.props.className?.startsWith("session-row "));
const activeObserver = () => observers.filter(o => !o.disconnected).at(-1)!;

it("renders daily metrics on one row and loads 50 more only once per pending intersection", async () => {
  let resolvePage: (value: SessionList) => void = () => {};
  const read = vi.fn(async (params: URLSearchParams) => {
    const offset = Number(params.get("offset"));
    return offset === 50 ? new Promise<SessionList>(resolve => { resolvePage = resolve; }) : page(offset);
  });
  const api = apiWithList(read);
  await mount(api);
  expect(rows()).toHaveLength(50);
  expect(read.mock.calls[0][0].get("timezone")).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const meta = rows()[0].findByProps({ className: "session-row-meta" });
  expect(meta.findAllByType("span").map(n => n.children.join(""))).toEqual([
    expect.stringContaining("–"), "1 prompts", "Cost $2.36",
  ]);
  expect(renderer.root.findAll(n => n.type === "button" && n.children.includes("Load more"))).toHaveLength(0);
  await act(async () => rows()[1].props.onClick());
  expect(rows().filter(n => n.props["aria-pressed"])).toEqual([rows()[1]]);
  const observer = activeObserver();
  expect(observer.root).toBe(listNode);
  await act(async () => { observer.fire(); observer.fire(); });
  expect(read.mock.calls.map(c => c[0].get("offset"))).toEqual(["0", "50"]);
  await act(async () => resolvePage(page(50)));
  expect(rows()).toHaveLength(100);
  await act(async () => activeObserver().fire());
  expect(rows()).toHaveLength(101);
  expect(observers.every(o => o.disconnected)).toBe(true);
});

it("stops automatic pagination on failure and reloads through the visible retry action", async () => {
  const read = vi.fn(async (params: URLSearchParams) => {
    if (params.get("offset") === "50") throw new Error("Page unavailable");
    return page(0);
  });
  await mount(apiWithList(read));
  const observer = activeObserver();
  await act(async () => observer.fire());
  expect(rows()).toHaveLength(50);
  expect(renderer.root.findAllByProps({ role: "alert" }).length).toBeGreaterThan(0);
  await act(async () => observer.fire());
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => renderer.root.findAll(n => n.type === "button" && n.children.includes("Retry"))[0].props.onClick());
  expect(read).toHaveBeenCalledTimes(3);
  expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
});

it("discards a pending page when filters change", async () => {
  let resolvePage: (value: SessionList) => void = () => {};
  const read = vi.fn(async (params: URLSearchParams) => {
    if (params.get("provider") === "claude") return page(0, 1);
    return params.get("offset") === "50" ? new Promise<SessionList>(resolve => { resolvePage = resolve; }) : page(0);
  });
  await mount(apiWithList(read));
  await act(async () => activeObserver().fire());
  await act(async () => renderer.root.findByProps({ className: "sessions-segment session-agent-filters" }).findAllByType("button")[1].props.onClick());
  expect(rows()).toHaveLength(1);
  await act(async () => resolvePage(page(50)));
  expect(rows()).toHaveLength(1);
});


it.each(["zh", "en"] as const)("marks multi-day sessions in %s and hides single-day badges", async language => {
  setLanguage(language);
  await mount(apiWithList(async () => page(0, 3)));
  expect(renderer.root.findAllByProps({ className: "session-day-badge" }).map(n => n.children.join(""))).toEqual(
    language === "zh" ? ["第 3/3 天", "第 2/3 天", "第 1/3 天"] : ["Day 3/3", "Day 2/3", "Day 1/3"],
  );
  act(() => renderer.unmount());
  await mount(apiWithList(async () => page(0, 1)));
  expect(renderer.root.findAllByProps({ className: "session-day-badge" })).toHaveLength(0);
});


const detailPage = (offset: number) => ({
  pageOffset: offset, totalEntries: 105, session: row(0), models: [], cost: null, unpriced: 0,
  repositories: [], totalTurns: 1, nextOffset: offset < 100 ? offset + 50 : null,
  previousOffset: offset ? offset - 50 : null, children: [], parent: null, commits: [], context: [],
  contextNextOffset: null, matchTurnId: null,
  turns: [{ id: "long-turn", ordinal: 1, prompt: "Question", promptVisible: offset === 0,
    promptBlockId: null, promptTruncated: false, at: null,
    usage: { input: null, output: null, cache: null, cacheWrite: null, requests: 0, models: [], efforts: [] },
    events: Array.from({ length: offset === 0 ? 49 : offset === 50 ? 50 : 5 }, (_, i) => ({
      id: `reply-${offset + i}`, kind: "reply", text: `**Reply ${offset + i}**`, at: null,
    })), commits: [], contextOnly: false, previousOffset: null, nextOffset: null, matchEventId: null,
  }],
});
it("automatically loads detail pages, merges a continuing turn and keeps replies collapsed with nodes", async () => {
  let resolve: (value: any) => void = () => {};
  const readDetail = vi.fn(async (params: URLSearchParams) => {
    const offset = Number(params.get("offset"));
    return offset === 50 ? new Promise(r => { resolve = r; }) : detailPage(offset);
  });
  await mount(apiWithList(async () => page(0,1), readDetail));
  expect(renderer.root.findAllByProps({ className: "session-reply-node" })).toHaveLength(49);
  const observer = activeObserver();
  expect(observer.root).toBe(detailNode);
  await act(async () => { observer.fire(); observer.fire(); });
  expect(readDetail).toHaveBeenCalledTimes(2);
  await act(async () => resolve(detailPage(50)));
  expect(renderer.root.findAllByProps({ className: "session-reply-node" })).toHaveLength(99);
  await act(async () => activeObserver().fire());
  expect(renderer.root.findAllByProps({ className: "session-reply-node" })).toHaveLength(104);
  expect(renderer.root.findAllByProps({ className: "session-prompt-node" })).toHaveLength(1);
  expect(renderer.root.findAllByProps({ className: "session-reply" }).every(n =>
    !n.findByProps({ className: "session-message" }).props.open && n.findAllByType("strong").length === 0)).toBe(true);
  expect(observers.every(o => o.disconnected)).toBe(true);
});
it("ignores a pending detail page after switching display mode", async () => {
  let resolve: (value: any) => void = () => {};
  const readDetail = vi.fn(async (params: URLSearchParams) => {
    if (params.get("mode") === "focused") return { ...detailPage(100), pageOffset: 0, previousOffset: null };
    return params.get("offset") === "50" ? new Promise(r => { resolve = r; }) : detailPage(0);
  });
  await mount(apiWithList(async () => page(0,1), readDetail));
  await act(async () => activeObserver().fire());
  await act(async () => renderer.root.findAll(n => n.type === "button" && n.children.includes("Focused"))[0].props.onClick());
  await act(async () => resolve(detailPage(50)));
  expect(renderer.root.findAllByProps({ className: "session-reply-node" })).toHaveLength(5);
});

it("loads earlier search-context pages without duplicating the continued turn", async () => {
  const readDetail = vi.fn(async (params: URLSearchParams) => detailPage(params.has("offset") ? Number(params.get("offset")) : 50));
  await mount(apiWithList(async () => page(0,1), readDetail));
  expect(renderer.root.findAllByProps({ className: "session-prompt-node" })).toHaveLength(0);
  const previous = observers.find(o => !o.disconnected && o.root === detailNode)!;
  await act(async () => previous.fire());
  expect(renderer.root.findAllByProps({ className: "session-prompt-node" })).toHaveLength(1);
  expect(renderer.root.findAllByProps({ className: "session-reply-node" })).toHaveLength(99);
  expect(readDetail.mock.calls[1][0].get("offset")).toBe("0");
});

it("stops detail pagination after an error and allows a visible retry", async () => {
  const readDetail = vi.fn(async (params: URLSearchParams) => {
    if (params.get("offset") === "50") throw new Error("Detail unavailable");
    return detailPage(0);
  });
  await mount(apiWithList(async () => page(0,1), readDetail));
  const observer = activeObserver();
  await act(async () => observer.fire());
  await act(async () => observer.fire());
  expect(readDetail).toHaveBeenCalledTimes(2);
  expect(renderer.root.findAllByProps({ className: "session-reply-node" })).toHaveLength(49);
  await act(async () => renderer.root.findAll(n => n.type === "button" && n.children.includes("Retry"))[0].props.onClick());
  expect(readDetail).toHaveBeenCalledTimes(3);
  expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
});

it("reloads the same session on each selected day and keeps pagination inside that day", async () => {
  const readDetail = vi.fn(async (params: URLSearchParams) => {
    const detail = detailPage(Number(params.get("offset")));
    detail.turns[0].events = [{ id: `reply-${params.get("day")}-${detail.pageOffset}`, kind: "reply", text: `Answer for ${params.get("day")}`, at: null }];
    return detail;
  });
  await mount(apiWithList(async () => page(0, 3), readDetail));
  const visibleReply = () => renderer.root.findAllByProps({ className: "session-reply" })[0]
    .findByProps({ className: "session-message-preview" }).children.join("");
  expect(visibleReply()).toBe("Answer for 2026-10-23");
  await act(async () => rows()[1].props.onClick());
  expect(visibleReply()).toBe("Answer for 2026-10-22");
  await act(async () => rows()[2].props.onClick());
  expect(visibleReply()).toBe("Answer for 2026-10-21");
  await act(async () => activeObserver().fire());
  expect(readDetail.mock.calls.map(([params]) => [params.get("day"), params.get("offset")])).toEqual([
    ["2026-10-23",null], ["2026-10-22",null], ["2026-10-21",null], ["2026-10-21","50"],
  ]);
  expect(readDetail.mock.calls.every(([params]) => params.get("timezone") === Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(true);
});

it("discards a pending page from another day of the same session", async () => {
  let resolve: (value: any) => void = () => {};
  const readDetail = vi.fn(async (params: URLSearchParams) => params.get("offset") === "50"
    ? new Promise(r => { resolve = r; }) : params.get("day") === "2026-10-22"
      ? { ...detailPage(100), pageOffset: 0, previousOffset: null } : detailPage(0));
  await mount(apiWithList(async () => page(0, 2), readDetail));
  await act(async () => activeObserver().fire());
  await act(async () => rows()[1].props.onClick());
  await act(async () => resolve(detailPage(50)));
  expect(renderer.root.findAllByProps({ className: "session-reply-node" })).toHaveLength(5);
  expect(rows()[1].props["aria-pressed"]).toBe(true);
});

it("requests the undated group explicitly and leaves an exact-turn link unfiltered", async () => {
  const readDetail = vi.fn(async () => detailPage(0));
  await mount(apiWithList(async () => ({ ...page(0,1), items: [{ ...row(0), day: null }] }), readDetail));
  expect(readDetail.mock.calls).toHaveLength(1);
  const api = renderer.root.findByType(SessionsPage).props.api;
  expect(new URL(api.mock.calls.find(([url]: [string]) => url.startsWith("/sessions/detail"))[0], "http://localhost").searchParams.get("day")).toBe("unknown");
  act(() => renderer.unmount());
  vi.stubGlobal("location", { search: "?provider=claude&session=same-conversation&turn=original-turn" });
  const linked = vi.fn(async (params: URLSearchParams) => detailPage(0));
  await mount(apiWithList(async () => page(0,3), linked));
  expect(linked.mock.calls.every(([params]) => !params.has("day") && params.get("turnId") === "original-turn")).toBe(true);
});
