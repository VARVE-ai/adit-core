import { expect, it } from "vitest";
import {
  achievementMetrics,
  type AchievementInterval,
} from "./achievement-rules.js";
import { commandExecutions, scriptCommands } from "./achievement-commands.js";
const start = Date.parse("2026-09-01T00:00:00Z"),
  now = Date.parse("2026-10-20T12:00:00Z");
const base = {
  intervals: [],
  prompts: [],
  commands: [],
  commits: [],
  timezone: "UTC",
  now,
};
const intervals = (
  n: number,
  sessionId = "s",
  at = start,
): AchievementInterval[] =>
  Array.from({ length: n }, (_, i) => ({
    at: at + i * 300000,
    duration: 300000,
    provider: "codex",
    sessionId,
    turnId: sessionId,
  }));
it("replays every duration tier and separates earliest unlock from later best", () => {
  const result = achievementMetrics({
    ...base,
    intervals: [...intervals(72), ...intervals(73, "later", start + 86400000)],
  });
  expect(result.marathon.tiers.map((t) => t.at)).toEqual([
    start + 3600000,
    start + 10800000,
    start + 21600000,
  ]);
  expect(result.marathon.value).toBe(21900000);
  expect(result.marathon.bestAt).toBe(start + 86400000 + 21900000);
  expect(result.marathon.evidence[0].sessionId).toBe("later");
});
it("caps idle gaps, excludes zero intervals and applies strict half-hour threshold", () => {
  expect(
    achievementMetrics({ ...base, intervals: intervals(6) })["hands-off"].value,
  ).toBe(0);
  const result = achievementMetrics({
    ...base,
    intervals: [
      ...intervals(6),
      { ...intervals(1)[0], at: start + 1800000, duration: 1 },
    ],
  });
  expect(result["hands-off"].tiers[0].at).toBe(start + 1800001);
  expect(
    achievementMetrics({
      ...base,
      intervals: [{ ...intervals(1)[0], duration: 9000000 }],
    }).marathon.value,
  ).toBe(300000);
});
it("counts concurrent original sessions, with endings before starts and no double counting", () => {
  const result = achievementMetrics({
    ...base,
    intervals: [
      ...intervals(1),
      ...intervals(1),
      ...intervals(1, "b", start + 1000),
      ...intervals(1, "c", start + 300000),
      { ...intervals(1, "zero")[0], duration: 0 },
    ],
  });
  expect(result.multitasker.value).toBe(2);
  expect(result.multitasker.tiers[0].at).toBe(start + 1000);
});
it("skips weekends, retains the historic streak, and distinguishes local active dates", () => {
  const prompts = [
    "2026-10-08",
    "2026-10-09",
    "2026-10-12",
    "2026-10-13",
    "2026-10-14",
  ].map((d) => ({ at: Date.parse(d + "T12:00:00Z") }));
  const r = achievementMetrics({ ...base, prompts });
  expect(r.streak.value).toBe(5);
  expect(r.streak.current).toBe(0);
  expect(r.streak.tiers[0].at).toBe(prompts[4].at);
  expect(
    achievementMetrics({
      ...base,
      now: Date.parse("2026-10-15T12:00:00Z"),
      prompts,
    }).streak.current,
  ).toBe(5);
  const midnight = [
    { at: Date.parse("2026-10-10T23:59:00Z") },
    { at: Date.parse("2026-10-11T00:01:00Z") },
  ];
  expect(
    achievementMetrics({ ...base, prompts: midnight })["full-month"].value,
  ).toBe(2);
  expect(
    achievementMetrics({
      ...base,
      prompts: midnight,
      timezone: "Asia/Shanghai",
    })["full-month"].value,
  ).toBe(1);
});
it("does not invent dates or merge original sessions when counting commands and commits", () => {
  const r = achievementMetrics({
    ...base,
    commands: Array.from({ length: 1000 }, () => ({ at: null })),
    commits: [
      ...Array.from({ length: 3 }, () => ({
        at: start,
        provider: "codex",
        sessionId: "a",
      })),
      ...Array.from({ length: 3 }, () => ({
        at: start,
        provider: "codex",
        sessionId: "b",
      })),
    ],
  });
  expect(r.commander.tiers[0].at).toBeNull();
  expect(r.shipper.value).toBe(3);
  expect(r.shipper.tiers).toEqual([]);
  expect(
    achievementMetrics({ ...base, commands: [{ at: now + 1 }] }).commander
      .value,
  ).toBe(0);
});
it("counts only supported execution evidence without running historical scripts", () => {
  const source =
    'const r = await Promise.allSettled([tools.exec_command({cmd:"x"}), tools.exec_command({cmd:"y"})]); text(r);';
  expect(scriptCommands(source)).toBe(2);
  expect(
    commandExecutions({
      name: "exec",
      command: null,
      input: JSON.stringify(source),
      result: 'Script completed\nOutput: {"chunk_id":"a","exit_code":0}\n{"chunk_id":"b","exit_code":1}',
    }),
  ).toEqual({ count: 2, incomplete: false });
  expect(commandExecutions({name:"exec",command:null,input:JSON.stringify(source),result:"Script completed\nOutput: ok"})).toEqual({count:0,incomplete:true});
  expect(
    scriptCommands('for(let i=0;i<10;i++) await tools.exec_command({cmd:"x"})'),
  ).toBeNull();
  expect(scriptCommands('tools.exec_command({cmd:"x"})')).toBeNull();
  expect(
    commandExecutions({
      name: "exec_command",
      command: "exit 1",
      input: null,
      result: "failed",
      exitCode: 1,
    }).count,
  ).toBe(1);
  expect(
    commandExecutions({
      name: "exec_command",
      command: "x",
      input: null,
      result: "Approval rejected by user",
    }).count,
  ).toBe(0);
  expect(
    commandExecutions({
      name: "write_stdin",
      command: null,
      input: null,
      result: "ok",
    }).count,
  ).toBe(0);
  expect(
    commandExecutions({
      name: "exec",
      command: null,
      input: JSON.stringify(source),
      result: 'Script completed\n{"status":"rejected"}',
    }).incomplete,
  ).toBe(true);
});
it("reaches all three levels of cumulative duration, active days, commands, commits and hands-off runs", () => {
  const r = achievementMetrics({
    ...base,
    intervals: intervals(12000),
    prompts: Array.from({ length: 365 }, (_, i) => ({
      at: now - (364 - i) * 86400000,
    })),
    commands: Array.from({ length: 100000 }, () => ({ at: start })),
    commits: Array.from({ length: 20 }, () => ({
      at: start,
      provider: "codex",
      sessionId: "s",
    })),
  });
  for (const key of [
    "centurion",
    "full-month",
    "streak",
    "commander",
    "shipper",
  ] as const)
    expect(r[key].tiers.map((t) => t.tier)).toEqual([1, 2, 3]);
  expect(r.centurion.tiers.map((t) => t.at)).toEqual([
    start + 360000000,
    start + 1800000000,
    start + 3600000000,
  ]);
  const many = achievementMetrics({
    ...base,
    intervals: Array.from({ length: 50 }, (_, i) =>
      intervals(7, String(i), start + i * 86400000),
    ).flat(),
  });
  expect(many["hands-off"].tiers.map((t) => t.tier)).toEqual([1, 2, 3]);
  expect(
    achievementMetrics({
      ...base,
      intervals: Array.from({ length: 5 }, (_, i) =>
        intervals(1, String(i)),
      ).flat(),
    }).multitasker.tiers.map((t) => t.tier),
  ).toEqual([1, 2, 3]);
});
