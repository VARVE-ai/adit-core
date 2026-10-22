const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Cursor records a local wall clock with an explicit UTC offset, not the machine's timezone. */
function cursorTimestamp(value: string): string | undefined {
  const match = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) (AM|PM) \(UTC([+-])(\d{1,2})(?::(\d{2}))?\)$/.exec(value);
  if (!match) return;
  const [, month, day, year, hour, minute, period, sign, zoneHour, zoneMinute = "0"] = match;
  if (+hour < 1 || +hour > 12 || +minute > 59 || +zoneHour > 23 || +zoneMinute > 59) return;
  const date = new Date(0);
  date.setUTCFullYear(+year, months.indexOf(month), +day);
  date.setUTCHours(+hour % 12 + (period === "PM" ? 12 : 0), +minute, 0, 0);
  // Date normalizes impossible dates; reject them instead of silently changing the day.
  if (date.getUTCFullYear() !== +year || date.getUTCMonth() !== months.indexOf(month) || date.getUTCDate() !== +day) return;
  const offset = (+zoneHour * 60 + +zoneMinute) * (sign === "+" ? 1 : -1);
  return new Date(date.getTime() - offset * 60_000).toISOString();
}

/** Recognize only a complete native envelope, leaving quoted XML and ordinary prose untouched. */
export function cursorUserQuery(value: string): { text: string; start: number; end: number; timestamp?: string } | undefined {
  const match = /^(\s*(?:<timestamp>([^<]*)<\/timestamp>\s*)?<user_query>)([\s\S]*)(<\/user_query>\s*)$/.exec(value);
  if (!match) return;
  const body = match[3];
  const start = match[1].length + body.length - body.trimStart().length;
  return {
    text: body.trim(),
    start,
    end: Math.max(start, match[1].length + body.trimEnd().length),
    timestamp: match[2] ? cursorTimestamp(match[2]) : undefined,
  };
}
