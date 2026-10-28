import { expect, it } from "vitest";
import { strFromU8 } from "fflate";
import {
  defaultProfilePreferences,
  profileDays,
  profileBadgePairs,
  withProfileBadgeStyle,
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
    ".github/adit/card.svg",
    "README.md",
  ]);
  const wide = profileSvg(data, "work & <script>", prefs, "card");
  expect(strFromU8(files[".github/adit/card.svg"])).toBe(wide);
  expect(wide).toContain("work &amp; &lt;script&gt;");
  expect(wide).toContain("model &lt;&amp;&quot;");
  expect(wide).toContain("70%");
  expect(wide).toContain("Unknown 30%");
  expect(wide).not.toContain("$123");
  expect(wide).not.toContain("<script>");
  expect(wide).not.toContain("href=");
  expect(strFromU8(files["README.md"])).not.toContain("badge-sessions");
  expect(profileReadme({...prefs, selected:["card-commits"]}, "name")).toContain(
    'card-commits.svg" height="56"',
  );
});
it("changes the actual image for all display flags, retaining unknown versus zero", () => {
  const prefs = defaultProfilePreferences();
  prefs.show.cost = true;
  let wide = profileSvg(data, "name", prefs, "card");
  expect(wide).toContain("AI-assisted development");
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
  });
  expect(
    profileReadme(
      { ...defaultProfilePreferences(), selected: [] },
      "name",
    ),
  ).toBe("");
  expect(readProfilePreferences('{"selected":["badge-model","card-commits"]}').selected).toEqual(["badge-model"]);
  expect(readProfilePreferences('{"selected":["missing"]}').selected).toEqual(["card"]);
});
it("keeps badge values escaped and distinguishes unanalysed commits from zero when restoring legacy language settings", async () => {
  for (const language of ["en", "zh"] as const) {
    const preferences = readProfilePreferences(JSON.stringify({ language, selected: ["badge-model"] }));
    const source = profileSvg(data, "private workspace", preferences, "badge-model");
    expect(source).toContain("model &lt;&amp;&quot;");
    expect(source).not.toContain("private workspace");
    expect(source).not.toContain("href=");
    const unknown = { ...data, profile: { ...data.profile, submissionAnalyzed: false } };
    expect(profileSvg(unknown, "name", preferences, "badge-commits")).toContain("— / 3");
    const zero = { ...data, summary: { ...data.summary, linkedCommits: 0 } };
    expect(profileSvg(zero, "name", preferences, "badge-commits")).toContain("0 / 3");
    const files = await profileFiles(data, "name", preferences);
    expect(Object.keys(files)).toEqual([".github/adit/badge-model.svg", "README.md"]);
    expect(strFromU8(files["README.md"])).toContain(".github/adit/badge-model.svg");
  }
});

it("keeps each of six metrics selected across styles, persistence and export, without changing the wide card", async () => {
  const defaults = defaultProfilePreferences();
  const wide = profileSvg(data, "name", defaults, "card");
  for (const [plain, rich] of profileBadgePairs) {
    const original = { ...defaults, selected: [plain] };
    const switched = withProfileBadgeStyle(original, "rich");
    expect(switched.selected).toEqual([rich]);
    expect(readProfilePreferences(JSON.stringify(switched))).toEqual(switched);
    expect(readProfilePreferences(JSON.stringify({ selected: [rich] }))).toMatchObject({ badgeStyle: "rich", selected: [rich] });
    expect(withProfileBadgeStyle(switched, "plain")).toEqual(original);
    const files = await profileFiles(data, "name", switched);
    expect(Object.keys(files)).toEqual([`.github/adit/${rich}.svg`, "README.md"]);
    expect(strFromU8(files["README.md"])).toContain(`${rich}.svg`);
    expect(profileSvg(data, "name", switched, "card")).toBe(wide);
  }
  expect(withProfileBadgeStyle(defaults, "rich").selected).toEqual(["card"]);
  expect(profileSvg(data, "name", defaults, "card-sessions")).toContain("AI SESSIONS: 4, 10 prompts");
  expect(profileSvg(data, "name", defaults, "card-prompts")).toContain("AI PROMPTS: 10, 4 sessions");
});

it("exports all thirteen profile images as standalone UTF-8 SVG with matching README references", async () => {
  for (const language of ["en", "zh"] as const) {
    for (const item of profileItems) {
      const prefs = readProfilePreferences(JSON.stringify({ language, selected: [item] }));
      const files = await profileFiles(data, "中文工作区 & <test>", prefs);
      expect(Object.keys(files)).toEqual([`.github/adit/${item}.svg`, "README.md"]);
      const source = strFromU8(files[`.github/adit/${item}.svg`]);
      expect(source).toBe(profileSvg(data, "中文工作区 & <test>", prefs, item));
      expect(source).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(strFromU8(files["README.md"])).toContain(`.github/adit/${item}.svg`);
    }
  }
});

it("ignores old Chinese image preferences and keeps all generated labels English", () => {
  const prefs = readProfilePreferences('{"language":"zh","range":"30d","selected":["card-prompts"],"show":{"cost":true}}');
  expect(prefs).not.toHaveProperty("language");
  expect(prefs).toMatchObject({range: "30d", badgeStyle: "rich", selected: ["card-prompts"], show: {cost: true}});
  for (const item of profileItems) {
    const source = profileSvg(data, "Project", prefs, item);
    expect(source).not.toMatch(/[\u4e00-\u9fff]/);
  }
  const wide = profileSvg(data, "中文项目", prefs, "card");
  expect(wide).toContain("中文项目");
  expect(wide).toContain("AI-assisted development");
  expect(wide).toContain("Oct 2, 2026");
});
