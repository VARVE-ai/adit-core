import { afterEach, describe, expect, it } from "vitest";
import { taskDueDate } from "./task-date-time.js";

const originalZone = process.env.TZ;
afterEach(() => {
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});

describe("task date-time input", () => {
  it.each([
    ["Asia/Shanghai", "2026-10-03 09:00", "2026-10-03T01:00:00.000Z"],
    ["Asia/Shanghai", "2026-10-03", "2026-10-02T16:00:00.000Z"],
    ["America/Los_Angeles", "2026-10-03T23:59", "2026-10-04T06:59:00.000Z"],
    ["UTC", "2026-10-03T09:00+08:00", "2026-10-03T01:00:00.000Z"],
    ["America/Los_Angeles", "2026-10-03T09:00:25.123+08:00", "2026-10-03T01:00:25.123Z"],
    ["Asia/Shanghai", "2026-10-03T00:00Z", "2026-10-03T00:00:00.000Z"],
    ["UTC", "2028-02-29 09:00", "2028-02-29T09:00:00.000Z"],
  ])("parses %s / %s into a UTC instant", (zone, input, expected) => {
    process.env.TZ = zone;
    expect(taskDueDate(input)).toBe(expected);
  });

  it.each([
    "2026-02-29 09:00",
    "2026-02-30T09:00Z",
    "2026-10-03 24:00",
    "2026-10-03T09:60+08:00",
    "2026-10-03T09:00:60Z",
    "2026-10-03T09:00+24:00",
    "2026-10-03T09:00+08:60",
    "0000-01-01",
    "2026-10-03 junk",
    "2026-10-03T09:00 Asia/Shanghai",
  ])("rejects invalid date-time %s", (input) => {
    expect(() => taskDueDate(input)).toThrow();
  });

  it("rejects missing or repeated DST wall times, and accepts explicit offsets", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(() => taskDueDate("2026-03-08 02:30")).toThrow("does not exist");
    expect(() => taskDueDate("2026-11-01 01:30")).toThrow("ambiguous");
    expect(taskDueDate("2026-11-01T01:30-07:00")).toBe("2026-11-01T08:30:00.000Z");
    expect(taskDueDate("2026-11-01T01:30-08:00")).toBe("2026-11-01T09:30:00.000Z");
  });
});
