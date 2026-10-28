/** Keep missing daily observations as gaps, without labelling them zero spend. */
export function dailyCostWindow(
  daily: { date: string; providers: Record<string, number> }[],
  range: string,
  to: string,
) {
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(end)) return [];
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const records = new Map(daily.map((day) => [day.date, day.providers]));
  return Array.from({ length: days }, (_, i) => {
    const date = new Date(end - (days - i) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const providers = records.get(date);
    return {
      date,
      providers,
      amount: providers
        ? Object.values(providers).reduce((a, b) => a + b, 0)
        : null,
    };
  });
}

/** Four equal intervals with readable currency ticks, still expressed in microdollars. */
export function costAxisMaximum(amounts: (number | null)[]): number {
  const maximum = Math.max(0, ...amounts.map((value) => value ?? 0));
  if (maximum === 0) return 1_000_000;
  const rawStep = maximum / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step =
    [1, 2, 2.5, 5, 10].find((value) => value * magnitude >= rawStep)! *
    magnitude;
  return step * 4;
}
