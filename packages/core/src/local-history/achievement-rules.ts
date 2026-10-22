export const ACHIEVEMENT_VERSION = 1;
export const achievementRules = [
  {
    key: "marathon",
    name: "Marathon",
    zh: "马拉松",
    unit: "duration",
    thresholds: [3600000, 10800000, 21600000],
  },
  {
    key: "multitasker",
    name: "Multitasker",
    zh: "多线程",
    unit: "agents",
    thresholds: [2, 3, 5],
  },
  {
    key: "streak",
    name: "Streak",
    zh: "全勤",
    unit: "workdays",
    thresholds: [5, 10, 20],
  },
  {
    key: "shipper",
    name: "Shipper",
    zh: "交付能手",
    unit: "commits",
    thresholds: [5, 10, 20],
  },
  {
    key: "commander",
    name: "Commander",
    zh: "命令行",
    unit: "commands",
    thresholds: [1000, 10000, 100000],
  },
  {
    key: "hands-off",
    name: "Hands-off",
    zh: "放手",
    unit: "runs",
    thresholds: [1, 10, 50],
  },
  {
    key: "centurion",
    name: "Centurion",
    zh: "百小时",
    unit: "duration",
    thresholds: [360000000, 1800000000, 3600000000],
  },
  {
    key: "full-month",
    name: "Full month",
    zh: "满月",
    unit: "days",
    thresholds: [30, 90, 365],
  },
] as const;
export type AchievementKey = (typeof achievementRules)[number]["key"];
export interface AchievementEvidence {
  provider?: string;
  sessionId?: string;
  turnId?: string;
  toolId?: string;
  repository?: string;
  sha?: string;
  at: number | null;
  endAt?: number | null;
  value?: number;
  timeSource?: string;
}
export interface AchievementMetric {
  value: number;
  current: number;
  bestAt: number | null;
  evidence: AchievementEvidence[];
  tiers: { tier: number; at: number | null; evidence: AchievementEvidence[] }[];
  incomplete: number;
}
export interface AchievementInterval extends AchievementEvidence {
  at: number;
  duration: number;
}
export const localDay = (at: number, timezone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
const weekday = (day: string) => new Date(day + "T12:00:00Z").getUTCDay();
const previousWorkday = (day: string) => {
  const d = new Date(day + "T12:00:00Z");
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while ([0, 6].includes(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
};

/** Replay only dated facts. Missing dates never become the import date. */
export function achievementMetrics(input: {
  intervals: AchievementInterval[];
  prompts: AchievementEvidence[];
  commands: AchievementEvidence[];
  commits: AchievementEvidence[];
  timezone: string;
  now: number;
  incompleteTime?: number;
  incompleteCommands?: number;
}) {
  const result = Object.fromEntries(
    achievementRules.map((r) => [
      r.key,
      {
        value: 0,
        current: 0,
        bestAt: null,
        evidence: [],
        tiers: [],
        incomplete: 0,
      },
    ]),
  ) as unknown as Record<AchievementKey, AchievementMetric>;
  const update = (
    key: AchievementKey,
    value: number,
    at: number | null,
    evidence: AchievementEvidence[],
  ) => {
    const m = result[key],
      rule = achievementRules.find((r) => r.key === key)!;
    if (value > m.value) {
      m.value = value;
      m.bestAt = at;
      m.evidence = evidence;
    }
    m.current = value;
    rule.thresholds.forEach((threshold, i) => {
      if (value >= threshold && !m.tiers.some((t) => t.tier === i + 1))
        m.tiers.push({ tier: i + 1, at, evidence });
    });
  };
  const intervals = input.intervals
    .filter((i) => i.duration > 0 && Number.isFinite(i.at) && i.at <= input.now)
    .map((i) => ({
      ...i,
      duration: Math.min(i.duration, 300000, input.now - i.at),
    }))
    .filter((i) => i.duration > 0);
  const turns = new Map<
    string,
    { value: number; evidence: AchievementEvidence; crossed: boolean }
  >();
  const runs: AchievementEvidence[] = [];
  // Intervals belonging to a single turn are sequential in collected history.
  for (const i of [...intervals].sort(
    (a, b) => a.at + a.duration - b.at - b.duration,
  )) {
    const id = i.turnId!,
      turn = turns.get(id) || {
        value: 0,
        evidence: { ...i, value: 0 },
        crossed: false,
      };
    const before = turn.value;
    turn.value += i.duration;
    turn.evidence = {
      ...turn.evidence,
      endAt: i.at + i.duration,
      value: turn.value,
    };
    const m = result.marathon;
    achievementRules[0].thresholds.forEach((threshold, n) => {
      if (before < threshold && turn.value >= threshold) {
        const at = i.at + threshold - before,
          existing = m.tiers.find((t) => t.tier === n + 1);
        if (!existing || existing.at! > at) {
          m.tiers = m.tiers.filter((t) => t.tier !== n + 1);
          m.tiers.push({ tier: n + 1, at, evidence: [{ ...turn.evidence }] });
        }
      }
    });
    if (turn.value > m.value) {
      m.value = turn.value;
      m.bestAt = i.at + i.duration;
      m.evidence = [{ ...turn.evidence }];
    }
    if (!turn.crossed && turn.value > 1800000) {
      turn.crossed = true;
      runs.push({
        ...turn.evidence,
        at: i.at + Math.max(0, 1800000 - before) + 1,
      });
    }
    turns.set(id, turn);
  }
  result.marathon.current = result.marathon.value;
  const events = intervals
    .flatMap((i) => [
      { at: i.at, delta: 1, item: i },
      { at: i.at + i.duration, delta: -1, item: i },
    ])
    .sort((a, b) => a.at - b.at || a.delta - b.delta);
  const live = new Map<
    string,
    { count: number; evidence: AchievementEvidence }
  >();
  let total = 0,
    previous = events[0]?.at ?? 0,
    activeIntervals = 0;
  for (const e of events) {
    const next = total + (e.at - previous) * activeIntervals;
    const m = result.centurion;
    achievementRules
      .find((r) => r.key === "centurion")!
      .thresholds.forEach((threshold, n) => {
        if (total < threshold && next >= threshold)
          m.tiers.push({
            tier: n + 1,
            at: previous + Math.ceil((threshold - total) / activeIntervals),
            evidence: [...live.values()].map((v) => v.evidence),
          });
      });
    total = next;
    previous = e.at;
    activeIntervals += e.delta;
    const id = e.item.provider + ":" + e.item.sessionId,
      entry = live.get(id) || { count: 0, evidence: e.item };
    entry.count += e.delta;
    if (entry.count > 0) live.set(id, entry);
    else live.delete(id);
    update(
      "multitasker",
      live.size,
      e.at,
      [...live.values()].map((v) => v.evidence),
    );
  }
  result.centurion.value = result.centurion.current = total;
  result.centurion.bestAt = events.at(-1)?.at ?? null;
  result.centurion.evidence = result.centurion.tiers.at(-1)?.evidence || [];
  result.multitasker.current = result.multitasker.value;
  runs
    .sort((a, b) => a.at! - b.at!)
    .forEach((r, n) => update("hands-off", n + 1, r.at, [r]));
  const days = new Map<string, AchievementEvidence>();
  for (const p of [...input.prompts]
    .filter((p) => p.at !== null && p.at <= input.now)
    .sort((a, b) => a.at! - b.at!)) {
    const day = localDay(p.at!, input.timezone);
    if (!days.has(day)) days.set(day, p);
  }
  let streak: AchievementEvidence[] = [],
    priorDay = "",
    n = 0;
  for (const [day, p] of days) {
    update("full-month", ++n, p.at, [p]);
    if ([0, 6].includes(weekday(day))) continue;
    if (previousWorkday(day) !== priorDay) streak = [];
    streak = [...streak, p];
    priorDay = day;
    update("streak", streak.length, p.at, streak);
  }
  const today = localDay(input.now, input.timezone);
  if (priorDay !== today && priorDay !== previousWorkday(today))
    result.streak.current = 0;
  const commands = input.commands
    .filter((c) => c.at === null || c.at <= input.now)
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  commands.forEach((c, index) => update("commander", index + 1, c.at, [c]));
  const submitted = new Map<string, AchievementEvidence[]>();
  for (const c of input.commits
    .filter((c) => c.at === null || c.at <= input.now)
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))) {
    const id = c.provider + ":" + c.sessionId,
      entries = [...(submitted.get(id) || []), c];
    submitted.set(id, entries);
    update("shipper", entries.length, c.at, entries);
  }
  result.shipper.current = result.shipper.value;
  for (const key of [
    "marathon",
    "multitasker",
    "hands-off",
    "centurion",
    "streak",
    "full-month",
  ] as const)
    result[key].incomplete = input.incompleteTime || 0;
  result.commander.incomplete =
    (input.incompleteCommands || 0) +
    commands.filter((c) => c.at === null).length;
  for (const m of Object.values(result))
    m.tiers.sort((a, b) => a.tier - b.tier);
  return result;
}
