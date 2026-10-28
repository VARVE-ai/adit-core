import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { SharingPage } from "./sharing";
import { PublicationCopy } from "./publication-ui";

afterEach(() => vi.unstubAllGlobals());
it.each(["https://htmlpreview.github.io/?https://gist.githubusercontent.com/test/abc/raw/def/adit-session.html", null])("uses the HTML reader for list/detail/copy, and preserves old Gist-only shares (%s)", async viewerUrl => {
  vi.stubGlobal("location", new URL("http://localhost/share/workspace"));
  const remoteUrl = "https://gist.github.com/test/abc";
  const snapshot = { schemaVersion: 1, title: "Saved title", agent: "Codex", provider: "codex", models: [], date: null, promptCount: 1, commitCount: 0, commandCount: 0, turns: [], commits: [] };
  const otherUrl = "https://gist.github.com/test/other";
  const otherSnapshot = { ...snapshot, title: "Another [session]", agent: "Claude Code", provider: "claude", promptCount: 3, commitCount: 2 };
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const api = vi.fn(async (path: string) => path.startsWith("/shares?") ? {
    total: 2, nextOffset: null, items: [
      { id: "share", title: snapshot.title, provider: "codex", published_at: 1, remote_url: remoteUrl, viewer_url: viewerUrl, prompt_count: 1, commit_count: 0 },
      { id: "other", title: otherSnapshot.title, provider: "claude", published_at: 1, remote_url: otherUrl, viewer_url: null, prompt_count: 3, commit_count: 2 },
    ],
  } : path.startsWith("/shares/other?") ? { id: "other", snapshot: otherSnapshot, remoteUrl: otherUrl } : { id: "share", snapshot, remoteUrl, viewerUrl });
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(SharingPage, { workspace: { id: "workspace" }, api: api as any, review: false, onNavigate: vi.fn() })); });
  const open = renderer!.root.findByProps({ className: "share-open-gist" });
  expect(open.props.href).toBe(viewerUrl || remoteUrl);
  const listLink = renderer!.root.findAllByProps({ className: "publication-link" })[0].findByType("a");
  expect(listLink.props.href).toBe(viewerUrl || remoteUrl);
  expect(listLink.props.title).toBe(viewerUrl || remoteUrl);
  expect(listLink.children).toEqual(["Open share link"]);
  expect(renderer!.root.findByProps({ className: "publication-toolbar" }).findAllByType(PublicationCopy)).toHaveLength(0);
  const actions = renderer!.root.findAllByProps({ className: "share-list-actions" });
  expect(actions).toHaveLength(2);
  expect(api).toHaveBeenCalledTimes(2);
  await act(async () => actions[0].findByType("button").props.onClick());
  expect(writeText).toHaveBeenLastCalledWith(`### AI collaboration record\n\nSharing a development session with Codex: 1 prompt and 0 linked commits.\n\n[Saved title](${viewerUrl || remoteUrl})`);
  await act(async () => actions[1].findByType("button").props.onClick());
  expect(writeText).toHaveBeenLastCalledWith(`### AI collaboration record\n\nSharing a development session with Claude Code: 3 prompts and 2 linked commits.\n\n[Another \\[session\\]](${otherUrl})`);
  expect(renderer!.root.findByProps({ className: "share-open-gist" }).props.href).toBe(viewerUrl || remoteUrl);
  await act(async () => renderer!.unmount());
});
