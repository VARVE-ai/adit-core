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
  const api = vi.fn(async (path: string) => path.startsWith("/shares?") ? {
    total: 1, nextOffset: null, items: [{ id: "share", title: snapshot.title, provider: "codex", published_at: 1, remote_url: remoteUrl, viewer_url: viewerUrl, prompt_count: 1, commit_count: 0 }],
  } : { id: "share", snapshot, remoteUrl, viewerUrl });
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(SharingPage, { workspace: { id: "workspace" }, api: api as any, review: false, onNavigate: vi.fn() })); });
  const open = renderer!.root.findByProps({ className: "share-open-gist" });
  expect(open.props.href).toBe(viewerUrl || remoteUrl);
  const listLink = renderer!.root.findByProps({ className: "publication-link" }).findByType("a");
  expect(listLink.props.href).toBe(viewerUrl || remoteUrl);
  expect(listLink.props.title).toBe(viewerUrl || remoteUrl);
  expect(listLink.children).toEqual(["Open share link"]);
  expect(renderer!.root.findByType(PublicationCopy).props.text).toContain(`[Saved title](${viewerUrl || remoteUrl})`);
  await act(async () => renderer!.unmount());
});
