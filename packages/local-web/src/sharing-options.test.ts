import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { SharingPage } from "./sharing";
import { defaultShareOptions, type ShareDraft } from "../../core/src/local-history/sharing-types";
import { setLanguage } from "./i18n";

let renderer: ReactTestRenderer | undefined;
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; vi.useRealTimers(); setLanguage("en"); vi.unstubAllGlobals(); });
function fixture(legacy = false) {
  vi.useFakeTimers();
  vi.stubGlobal("location", new URL(`http://localhost/share-review/workspace${legacy ? '?draft=saved' : '?provider=codex&session=session'}`));
  vi.stubGlobal("history", { replaceState: vi.fn() });
  vi.stubGlobal("localStorage", { getItem: () => "normal", setItem: vi.fn() });
  setLanguage("zh");
  let draft: ShareDraft = {
    id: "saved", provider: "codex", sessionId: "session", version: "v1", sourceRevision: 1, digest: "digest", status: "ready",
    options: { ...defaultShareOptions }, markdown: "", redactions: {}, excludedCategories: 4, memoryActions: 0,
    turns: [{ id: "turn", ordinal: 1, prompt: "Question" }],
    snapshot: { schemaVersion: 1, title: "会话标题", agent: "Codex", provider: "codex", models: [], date: null,
      promptCount: 1, commandCount: 1, commitCount: 0, turns: [], commits: [] },
  };
  if (legacy) {
    delete (draft.options as Partial<typeof draft.options>).mode;
    draft.options.outputs = true; draft.options.thinking = true;
    draft.snapshot.title = "# Files mentioned by the user:";
  }
  const api = vi.fn(async (_path: string, method = "GET", body?: any) => {
    if (method !== "GET") draft = { ...draft, version: "v2", options: { ...draft.options, ...body?.options },
      snapshot: { ...draft.snapshot, title: body?.title || "会话标题" } };
    return draft;
  });
  return api;
}
async function mount(api: ReturnType<typeof fixture>) {
  await act(async () => { renderer = create(createElement(SharingPage, {
    workspace: { id: "workspace" }, api: api as any, review: true, onNavigate: vi.fn(),
  })); });
}
const include = () => renderer!.root.findAllByType("h4").find(h => h.children.join("") === "包含的内容")!.parent!;
const controls = () => include().findAllByType("input");
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(350); });

it("defaults to focused only regardless of session display mode and saves independent choices without publishing", async () => {
  const api = fixture(); await mount(api);
  expect(api.mock.calls[0][2].options).toBeUndefined();
  expect(include().findAllByType("label").map(n => n.children.filter(c => typeof c === "string").join("")))
    .toEqual(["聚焦", "所有提问和回复", "执行命令", "关联提交", "花费"]);
  expect(controls().map(n => n.props.type)).toEqual(["radio", "radio", "checkbox", "checkbox", "checkbox"]);
  expect(controls().map(n => n.props.checked)).toEqual([true, false, false, false, false]);
  await act(async () => controls()[1].props.onChange()); await flush();
  expect(controls().slice(0, 2).map(n => n.props.checked)).toEqual([false, true]);
  expect(api.mock.calls.at(-1)?.[2].options).toMatchObject({ mode: "normal", dialogue: true, outputs: false, thinking: false });
  await act(async () => { controls()[2].props.onChange({ target: { checked: true } }); controls()[4].props.onChange({ target: { checked: true } }); });
  await flush();
  expect(api.mock.calls.at(-1)?.[2].options).toMatchObject({ mode: "normal", commands: true, commits: false, cost: true });
  expect(api.mock.calls.some(([path]) => path.includes("/publish"))).toBe(false);
});

it("refreshes an older editable preview so hidden output/thinking options cannot remain enabled", async () => {
  const api = fixture(true); await mount(api);
  expect(api.mock.calls.map(([, method]) => method || "GET")).toEqual(["GET", "PATCH"]);
  expect(api.mock.calls[1][2]).toEqual({ options: { mode: "normal", dialogue: true, outputs: false, thinking: false } });
  expect(renderer!.root.findByProps({ "aria-label": "标题" }).props.value).toBe("会话标题");
  expect(controls().slice(0, 2).map(n => n.props.checked)).toEqual([false, true]);
  await flush(); expect(api).toHaveBeenCalledTimes(2);
});
