import { expect, it, vi } from "vitest";
import { strFromU8 } from "fflate";
vi.mock("./achievement-export", () => ({ pngBytes: vi.fn(async () => new Uint8Array([137,80,78,71,13,10,26,10])) }));
import {
  defaultProfilePreferences,
  profileDays,
  profileFiles,
  profileItems,
  profileReadme,
  profileSvg,
  readProfilePreferences,
  type ProfileData,
} from "./profile-export";
const data = {
  scope: { range: "all", first: "2026-09-30", from: "0000-01-01" },
  summary: {
    sessions: 4,
    prompts: 10,
    activeDays: 2,
    totalCommits: 3,
    linkedCommits: 2,
    estimatedCost: 123000000,
  },
  profile: {
    through: "2026-10-02",
    repositories: 2,
    days: [
      { date: "2026-09-30", count: 3 },
      { date: "2026-10-02", count: 7 },
    ],
    agents: [{ id: "codex", name: "Codex", count: 10 }],
    models: [{ model: 'model <&"', count: 7 }],
    unknownModelPrompts: 3,
    submissionAnalyzed: true,
  },
} as ProfileData;
it("exports the exact chosen files and relative README links without private or disabled fields", async () => {
  const prefs = defaultProfilePreferences();
  prefs.selected = ["card", "badge-model", "card-commits"];
  const files = await profileFiles(data, "work & <script>", prefs);
  expect(Object.keys(files)).toEqual([
    ".github/adit/card.png",
    "README.md",
  ]);
  expect([...files[".github/adit/card.png"]]).toEqual([137,80,78,71,13,10,26,10]);
  const wide = profileSvg(data, "work & <script>", prefs, "card");
  expect(wide).toContain("work &amp; &lt;script&gt;");
  expect(wide).toContain("model &lt;&amp;&quot;");
  expect(wide).toContain("70%");
  expect(wide).toContain("Unknown 30%");
  expect(wide).not.toContain("$123");
  expect(wide).not.toContain("<script>");
  expect(wide).not.toContain("href=");
  expect(strFromU8(files["README.md"])).not.toContain("badge-sessions");
  expect(profileReadme({...prefs, selected:["card-commits"]}, "name")).toContain(
    'card-commits.png" height="56"',
  );
});
it("changes the actual image for all display flags and image language, retaining unknown versus zero", () => {
  const prefs = defaultProfilePreferences();
  prefs.language = "zh";
  prefs.show.cost = true;
  let wide = profileSvg(data, "name", prefs, "card");
  expect(wide).toContain("AI 辅助开发");
  expect(wide).toContain("$123.00");
  prefs.show = {
    activity: false,
    sessions: false,
    commits: false,
    agents: false,
    models: false,
    cost: false,
  };
  wide = profileSvg(data, "name", prefs, "card");
  for (const value of [
    "model",
    "Codex",
    "$123",
    "2 / 3",
    '<rect x="24" y="71"',
  ])
    expect(wide).not.toContain(value);
  const unknown = {
    ...data,
    profile: { ...data.profile, submissionAnalyzed: false },
  };
  expect(profileSvg(unknown, "name", prefs, "card-commits")).toContain("— / 3");
  for (const item of profileItems)
    expect(profileSvg(data, "name", prefs, item)).toMatch(
      /^<svg.+<title>.+<\/svg>$/,
    );
});
it("covers zero-activity days and safely restores only recognized workspace export preferences", () => {
  expect(profileDays(data).map((d) => d.count)).toEqual([3, 0, 7]);
  expect(
    profileDays({
      ...data,
      scope: { ...data.scope, range: "30d", from: "2026-10-01" },
    }),
  ).toEqual([
    { date: "2026-10-01", count: 0 },
    { date: "2026-10-02", count: 7 },
  ]);
  expect(readProfilePreferences("broken")).toEqual(defaultProfilePreferences());
  expect(
    readProfilePreferences(
      '{"selected":["card","not-real","card"],"show":{"cost":true,"activity":"false"}}',
    ),
  ).toMatchObject({
    selected: ["card"],
    show: { cost: true, activity: true },
    language: "en",
  });
  expect(
    profileReadme(
      { ...defaultProfilePreferences(), selected: [] },
      "name",
      "png",
    ),
  ).toBe("");
  expect(readProfilePreferences('{"selected":["badge-model","card-commits"]}').selected).toEqual(["badge-model"]);
  expect(readProfilePreferences('{"selected":["missing"]}').selected).toEqual(["card"]);
});
