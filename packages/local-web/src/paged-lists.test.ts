import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommitsPage } from "./commits";
import { SharingPage } from "./sharing";
import { PrDescriptionsPage } from "./pr-descriptions";
import { setLanguage } from "./i18n";

let renderer: ReactTestRenderer;
const observers: { fire: () => void; disconnected: boolean; root: unknown }[] = [];
const scroll = { scrollTop: 0 };
const workspace = { id: "w", providers: [], repositories: ["repo"] };
const analysis = { runId: "run", status: "done", finishedAt: 1, completed: 101, total: 101, stale: false, error: null };
type Menu = "commits" | "shares" | "pr-descriptions";
beforeEach(() => {
  vi.useFakeTimers(); observers.length = 0;
  vi.stubGlobal("location", { search: "" });
  vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
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
afterEach(() => { act(() => renderer?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

function page(menu: Menu, offset: number, total = 101) {
  const items = Array.from({ length: Math.max(0, Math.min(50, total - offset)) }, (_, i) => ({
    id: String(offset + i), title: `Entry ${offset + i}`, subject: `Entry ${offset + i}`, repository: "repo", sha: String(offset + i).padStart(40, "0"),
    authoredAt: 1700000000000 - (offset + i) * 1000, branch: null, analyzed: true, sourceCount: 0, record: null, files: [],
    created_at: 1700000000000 - (offset + i) * 1000, published_at: 1700000000000 - (offset + i) * 1000, provider: "codex",
    prompt_count: 1, commit_count: 0, session_count: 0, remote_url: "https://example.test/share", source_ref: "feature/test", target_ref: "develop",
  }));
  return { items, commits: items, total, nextOffset: offset + 50 < total ? offset + 50 : null,
    nextCursor: offset + 50 < total ? `cursor-${offset + 50}` : null, repositories: ["repo"], analysis,
    summary: { total, linked: 0, first: 1700000000000 - (total - 1) * 1000 } };
}
async function mount(menu: Menu, read: (params: URLSearchParams) => Promise<any>) {
  const api = vi.fn(async (path: string) => {
    const url = new URL(path, "http://localhost");
    if (url.pathname === `/${menu}`) return read(url.searchParams);
    if (url.pathname === "/commits/sources") return { analysis, eligible: 0, matched: 0, sources: [], coverage: "" };
    // These tests exercise the lists independently of a large right-hand document.
    return new Promise(() => {});
  });
  const Component = menu === "commits" ? CommitsPage : menu === "shares" ? SharingPage : PrDescriptionsPage;
  await act(async () => { renderer = create(React.createElement(Component as any, { workspace, api, review: false, create: false, onNavigate: () => {} }), { createNodeMock: () => scroll }); });
  return api;
}
const rows = () => renderer.root.findAll(n => typeof n.type === "string" && /^(commit-choice|publication-choice) /.test(n.props.className || ""));
const active = () => observers.filter(o => !o.disconnected).at(-1)!;

it.each<Menu>(["commits", "shares", "pr-descriptions"])("%s loads 50, 50, 1 by scrolling and guards simultaneous intersections", async menu => {
  let resolve: (value: any) => void = () => {};
  const read = vi.fn(async (params: URLSearchParams) => params.get("offset") === "50" ? new Promise(r => { resolve = r; }) : page(menu, Number(params.get("offset"))));
  await mount(menu, read);
  expect(rows()).toHaveLength(50);
  expect(read.mock.calls[0][0].get("limit")).toBe("50");
  expect(active().root).toBe(scroll);
  expect(renderer.root.findAll(n => n.type === "button" && n.children.includes("Load more"))).toHaveLength(0);
  await act(async () => { const observer = active(); observer.fire(); observer.fire(); });
  expect(read.mock.calls.map(c => c[0].get("offset"))).toEqual(["0", "50"]);
  if (menu !== "commits") expect(read.mock.calls[1][0].get("cursor")).toBe("cursor-50");
  await act(async () => resolve(page(menu, 50)));
  expect(rows()).toHaveLength(100);
  await act(async () => active().fire());
  expect(rows()).toHaveLength(101);
  expect(observers.every(o => o.disconnected)).toBe(true);
  if (menu === "commits") expect(renderer.root.findByProps({ className: "commits-summary" }).findAllByType("b")[0].children).toEqual(["101"]);
});

it.each<Menu>(["commits", "shares", "pr-descriptions"])("%s retains rows on failure, stops automatic retries, and retries the failed page", async menu => {
  let failed = true;
  const read = vi.fn(async (params: URLSearchParams) => {
    if (params.get("offset") === "50" && failed) throw Error("Offline");
    return page(menu, Number(params.get("offset")));
  });
  await mount(menu, read);
  const observer = active();
  await act(async () => observer.fire());
  expect(rows()).toHaveLength(50);
  expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(1);
  await act(async () => { observer.fire(); vi.advanceTimersByTime(10000); });
  expect(read).toHaveBeenCalledTimes(2);
  failed = false;
  await act(async () => renderer.root.findAll(n => n.type === "button" && n.children.includes("Retry"))[0].props.onClick());
  expect(read.mock.calls.map(c => c[0].get("offset"))).toEqual(["0", "50", "50"]);
  expect(rows()).toHaveLength(100);
});

it("discards a pending commit page when repository or search changes", async () => {
  let resolve: (value: any) => void = () => {};
  const read = vi.fn(async (params: URLSearchParams) => {
    if (params.get("q")) return page("commits", 0, 0);
    if (params.get("repository")) return page("commits", 0, 1);
    return params.get("offset") === "50" ? new Promise(r => { resolve = r; }) : page("commits", 0);
  });
  await mount("commits", read);
  await act(async () => active().fire());
  scroll.scrollTop = 1000;
  await act(async () => renderer.root.findAllByProps({ className: "commits-segment" })[0].findAllByType("button")[1].props.onClick());
  expect(rows()).toHaveLength(1); expect(scroll.scrollTop).toBe(0);
  await act(async () => resolve(page("commits", 50)));
  expect(rows()).toHaveLength(1);
  act(() => renderer.root.findByType("input").props.onChange({ target: { value: "absent" } }));
  await act(async () => { vi.advanceTimersByTime(250); });
  expect(rows()).toHaveLength(0);
  expect(read.mock.calls.at(-1)![0].get("offset")).toBe("0");
});

it("refreshes already loaded commit pages without collapsing the list or losing selection", async () => {
  const read = vi.fn(async (params: URLSearchParams) => page("commits", Number(params.get("offset"))));
  await mount("commits", read);
  await act(async () => active().fire());
  await act(async () => rows()[70].props.onClick());
  scroll.scrollTop = 500;
  await act(async () => { vi.advanceTimersByTime(5000); });
  expect(rows()).toHaveLength(100); expect(scroll.scrollTop).toBe(500);
  expect(rows()[70].props["aria-pressed"]).toBe(true);
  expect(read.mock.calls.map(c => c[0].get("offset"))).toEqual(["0", "50", "0", "50"]);
});

it("opens a deep-linked commit outside the first page without downloading the entire list", async () => {
  const sha = "9".repeat(40);
  vi.stubGlobal("location", { search: `?repository=repo&sha=${sha}` });
  const read = vi.fn(async (params: URLSearchParams) => {
    const result = page("commits", 0);
    if (params.get("sha")) return { ...result, commits: [{ ...result.commits[0], sha, subject: "Linked commit" }] };
    return result;
  });
  await mount("commits", read);
  expect(renderer.root.findByType("h2").children).toEqual(["Linked commit"]);
  expect(rows()).toHaveLength(50);
  expect(read).toHaveBeenCalledTimes(2);
});

it.each<Menu>(["commits", "shares", "pr-descriptions"])("%s stops at exactly 50 rows and supports an empty result", async menu => {
  const read = vi.fn(async () => page(menu, 0, 50));
  await mount(menu, read);
  expect(rows()).toHaveLength(50); expect(active()).toBeUndefined(); expect(read).toHaveBeenCalledOnce();
  act(() => renderer.unmount());
  await mount(menu, async () => page(menu, 0, 0));
  expect(rows()).toHaveLength(0); expect(active()).toBeUndefined();
});

it.each<Menu>(["commits", "shares", "pr-descriptions"])("%s can retry a failed initial request", async menu => {
  const read = vi.fn().mockRejectedValueOnce(Error("Offline")).mockResolvedValue(page(menu, 0, 1));
  await mount(menu, read);
  expect(rows()).toHaveLength(0);
  await act(async () => renderer.root.findAll(n => n.type === "button" && n.children.includes("Retry"))[0].props.onClick());
  expect(rows()).toHaveLength(1); expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
});
