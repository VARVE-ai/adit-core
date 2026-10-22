import { expect, it } from "vitest";
import { dailyCostWindow, costAxisMaximum } from "./overview-chart-data";

it("shows the last 90 calendar days without turning absent usage into zero spend", () => {
  const daily: Parameters<typeof dailyCostWindow>[0] = [
    { date: "2025-01-01", providers: { codex: 999_000_000 } },
    { date: "2026-10-18", providers: { codex: 3_000_000, claude: 2_000_000 } },
    { date: "2026-10-19", providers: { codex: 0 } },
  ];
  const days = dailyCostWindow(daily, "all", "2026-10-20");
  expect(days).toHaveLength(90);
  expect(days[0].date).toBe("2026-07-22");
  expect(days.at(-1)).toMatchObject({ date: "2026-10-19", amount: 0 });
  expect(days.at(-2)).toMatchObject({ date: "2026-10-18", amount: 5_000_000 });
  expect(days.at(-3)?.amount).toBeNull();
  expect(costAxisMaximum(days.map((d) => d.amount))).toBe(8_000_000);
  expect(daily[0].providers.codex).toBe(999_000_000);
});
it("uses the selected 7/30 day window across year boundaries", () => {
  const days = dailyCostWindow([], "7d", "2027-01-03");
  expect(days).toHaveLength(7);
  expect(days[0].date).toBe("2026-12-27");
  expect(days.at(-1)?.date).toBe("2027-01-02");
  expect(days.every((d) => d.amount === null)).toBe(true);
  expect(dailyCostWindow([], "30d", "2027-01-03")).toHaveLength(30);
  expect(dailyCostWindow([], "all", "invalid")).toEqual([]);
});
it("keeps chart scales above all observed daily totals, including tiny nonzero amounts", () => {
  for (const maximum of [1, 500, 10000, 999999, 12_000_000, 21_000_000])
    expect(costAxisMaximum([null, 0, maximum])).toBeGreaterThanOrEqual(maximum);
});
