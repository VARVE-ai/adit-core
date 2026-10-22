import { expect, it } from "vitest";
import type {
  AchievementItem,
  AchievementsData,
} from "../../core/src/local-history/achievements";
import { badgeSvg, readmeCode } from "./achievement-export";
const item: AchievementItem = {
  key: "marathon",
  value: 3600000,
  current: 3600000,
  bestAt: 1,
  tier: 1,
  incomplete: 0,
  unlocks: [{ id: "u", tier: 1, at: 0, discoveredAt: 1000, unread: false }],
  evidence: [
    {
      at: 0,
      provider: "codex",
      prompt: '<script>alert("secret")</script>',
      messages: 3,
    },
  ],
  options: {
    selected: true,
    style: "plain",
    showValue: true,
    showDate: true,
    showAgent: false,
    showPrompt: false,
  },
};
const data = {
  workspaceName: "project & <script>",
  repositories: 2,
  timezone: "UTC",
} as AchievementsData;
it("exports standalone snapshots with safe XML and no prompt or Agent by default", () => {
  const svg = badgeSvg(data, item);
  expect(svg).toContain("1h 0m on one prompt");
  expect(svg).toContain("Jan 1, 1970");
  expect(svg).not.toContain("secret");
  expect(svg).not.toContain("Codex");
  const rich = badgeSvg(data, item, "rich");
  expect(rich).toContain("project &amp; &lt;script&gt;");
  expect(rich).not.toContain("<script>");
  expect(rich).not.toContain("href=");
  const opted = badgeSvg(data, {
    ...item,
    options: { ...item.options, showAgent: true, showPrompt: true },
  });
  expect(opted).toContain("Codex");
  expect(opted).toContain("&lt;script&gt;");
  expect(opted).not.toContain("<script>");
});
it("omits disabled fields and generates relative README paths in the chosen format", () => {
  const svg = badgeSvg(data, {
    ...item,
    options: { ...item.options, showValue: false, showDate: false },
  });
  expect(svg).not.toContain("1970");
  expect(svg).not.toContain("1h 0m");
  expect(readmeCode([item], "png")).toBe(
    "![Marathon](.github/adit/achv-marathon.png)",
  );
});
