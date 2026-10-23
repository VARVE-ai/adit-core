import { expect, it } from "vitest";
import type { ShareSnapshot } from "../../core/src/local-history/sharing-types";
import { renderShareHtml } from "./share-html";

const snapshot: ShareSnapshot = {
  schemaVersion: 1, title: "Reviewed conversation", agent: "Codex", provider: "codex", models: ["test-model"],
  date: null, promptCount: 1, commandCount: 1, commitCount: 1, commits: [], turns: [{
    prompt: "Explain the change", models: ["test-model"], efforts: [], input: 1200, output: 300, cache: null,
    events: [{ kind: "reply", text: "**Fixed** the issue.\n\n```ts\nconst value = 1;\n```" },
      { kind: "command", text: "git status --short", name: "Git", summary: "Check changes", icon: "git" }],
    commits: [{ sha: "abcdef123", subject: "fix: example", repository: "example", files: 2, additions: 4, deletions: 1 }],
  }],
};
it("exports the preview layout as standalone HTML with rich replies and native disclosures", () => {
  const html = renderShareHtml(snapshot);
  expect(html).toMatch(/^<!doctype html>/);
  expect(html).toContain('<strong>Fixed</strong>');
  expect(html).toContain('class="shared-timeline"');
  expect(html).toContain('class="shared-commit"');
  expect(html).toContain('<details class="shared-operations">');
  expect(html).toContain('git status --short');
  expect(html).toContain('<symbol id="codex"');
  expect(html).toContain('href="#codex"');
  expect(html).not.toContain('/agent-icons.svg');
  expect(html).not.toMatch(/<(?:script|link|img)\b/);
  expect(html).not.toContain('src=');
});
it("escapes user content, drops raw HTML and remote images, and does not serialize private extras", () => {
  const unsafe = '</title><script>alert(1)</script><img src=x onerror=alert(1)>';
  const html = renderShareHtml({ ...snapshot, title: unsafe, secret: "DO_NOT_EXPORT", turns: [{
    ...snapshot.turns[0], prompt: unsafe,
    events: [{ kind: "reply", text: `${unsafe}\n\n[bad](javascript:alert%281%29)\n\n![attachment](https://example.com/tracker.png)` },
      { kind: "command", text: unsafe, summary: unsafe }],
  }] } as ShareSnapshot);
  expect(html).not.toMatch(/<(?:script|img)\b/);
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('https://example.com/tracker.png');
  expect(html).not.toContain('DO_NOT_EXPORT');
  expect(html).toContain('&lt;script&gt;');
});
it("supports command-only and unknown metadata without inserting excluded dialogue or costs", () => {
  const html = renderShareHtml({ ...snapshot, title: "Commands only", promptCount: 1, commitCount: 0, models: [], turns: [{
    models: [], efforts: [], input: null, output: null, cache: null,
    events: [{ kind: "command", text: "git status" }], commits: [],
  }] });
  expect(html).toContain("git status");
  expect(html).not.toContain("Explain the change");
  expect(html).not.toContain("Cost:");
  expect(html).not.toContain("NaN");
});
