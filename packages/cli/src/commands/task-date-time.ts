/** Calendar validation is independent of the machine's time zone and DST. */
export function validateTaskCalendarDate(value: string, label: string): void {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() < 1 ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${label} date must be a valid YYYY-MM-DD date`);
  }
}

/** Unzoned input belongs to the CLI user's machine, never the Cloud server. */
export function taskDueDate(value: string, label = "Due"): string {
  const match =
    /^(\d{4}-\d{2}-\d{2})(?:[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(\.\d{1,3})?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.exec(
      value,
    );
  if (!match)
    throw new Error(
      `${label} must be YYYY-MM-DD, YYYY-MM-DD HH:mm, or an ISO timestamp with Z or an explicit offset (for example +08:00)`,
    );
  validateTaskCalendarDate(match[1], label);
  const [, day, hour = "00", minute = "00", second = "00", fraction = ".000", offset = ""] = match;
  const wallTime = `${day}T${hour}:${minute}:${second}${fraction}`;
  const date = new Date(`${wallTime}${offset}`);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${label.toLowerCase()} time`);
  if (!offset) {
    const utcWall = new Date(`${wallTime}Z`);
    const matchesWall = (candidate: Date) =>
      candidate.getFullYear() === utcWall.getUTCFullYear() &&
      candidate.getMonth() === utcWall.getUTCMonth() &&
      candidate.getDate() === utcWall.getUTCDate() &&
      candidate.getHours() === utcWall.getUTCHours() &&
      candidate.getMinutes() === utcWall.getUTCMinutes() &&
      candidate.getSeconds() === utcWall.getUTCSeconds();
    if (!matchesWall(date))
      throw new Error(
        `${label} time does not exist in the machine's local time zone; use an explicit offset`,
      );
    // A repeated DST hour has two valid instants. Require the caller to choose one.
    const nearbyOffsets = new Set(
      [-1, 0, 1].map((days) => new Date(date.getTime() + days * 86_400_000).getTimezoneOffset()),
    );
    const matches = [...nearbyOffsets].filter((minutes) =>
      matchesWall(new Date(utcWall.getTime() + minutes * 60_000)),
    );
    if (matches.length > 1)
      throw new Error(
        `${label} time is ambiguous in the machine's local time zone; use an explicit offset`,
      );
  }
  return date.toISOString();
}
