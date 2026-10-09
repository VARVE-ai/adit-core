import { stripVTControlCharacters } from "node:util";
import pc from "picocolors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  displayWidth,
  formatRow,
  formatTable,
  localDateTime,
  localMoment,
  marks,
  printEnd,
  printError,
  printLine,
  printRows,
  printSection,
  printTitle,
  resetOutputState,
  resolveOutputStyle,
  setPendingNotice,
  stateWord,
  truncate,
} from "./cli-style.js";

const originalIsTTY = process.stdout.isTTY;
const originalPlain = process.env.ADIT_PLAIN;

function setTerminal(isTTY: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
}

function captured(): { out: string[]; err: string[] } {
  return {
    out: vi.mocked(console.log).mock.calls.map((call) => stripVTControlCharacters(String(call[0]))),
    err: vi.mocked(console.error).mock.calls.map((call) => stripVTControlCharacters(String(call[0]))),
  };
}

beforeEach(() => {
  resetOutputState();
  vi.stubEnv("TERM", "xterm-256color");
  delete process.env.ADIT_PLAIN;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setTerminal(originalIsTTY);
  vi.unstubAllEnvs();
  if (originalPlain === undefined) delete process.env.ADIT_PLAIN;
  else process.env.ADIT_PLAIN = originalPlain;
  resetOutputState();
  vi.restoreAllMocks();
});

describe("resolveOutputStyle", () => {
  it("draws the rail only on an interactive Unicode terminal", () => {
    expect(resolveOutputStyle({ isTTY: true, env: { TERM: "xterm-256color" }, platform: "darwin" })).toEqual({ rail: true, unicode: true });
    expect(resolveOutputStyle({ isTTY: false, env: {}, platform: "darwin" })).toEqual({ rail: false, unicode: true });
  });

  it("honors ADIT_PLAIN and dumb terminals", () => {
    expect(resolveOutputStyle({ isTTY: true, env: { ADIT_PLAIN: "1" }, platform: "linux" }).rail).toBe(false);
    expect(resolveOutputStyle({ isTTY: true, env: { ADIT_PLAIN: "0" }, platform: "linux" }).rail).toBe(true);
    expect(resolveOutputStyle({ isTTY: true, env: { TERM: "dumb" }, platform: "linux" }).rail).toBe(false);
  });

  it("falls back to ASCII on terminals without Unicode", () => {
    expect(resolveOutputStyle({ isTTY: true, env: { TERM: "linux" }, platform: "linux" })).toEqual({ rail: false, unicode: false });
    expect(resolveOutputStyle({ isTTY: true, env: {}, platform: "win32" })).toEqual({ rail: false, unicode: false });
    expect(resolveOutputStyle({ isTTY: true, env: { WT_SESSION: "1" }, platform: "win32" }).unicode).toBe(true);
  });
});

// CJK samples are written as escapes: adit-core keeps its sources free of Chinese characters.
describe("text measurement", () => {
  it("counts CJK as two columns and ignores color codes", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("\u6768\u9e4f\u98de")).toBe(6);
    expect(displayWidth("\u001b[1mok\u001b[22m")).toBe(2);
    expect(displayWidth("\uff0c\u3001")).toBe(4);
  });

  it("truncates by display width with an ellipsis", () => {
    expect(truncate("\u56e2\u961f\u534f\u4f5c\u9875\u6309\u9879\u76ee\u98ce\u683c\u7f8e\u5316", 9)).toBe("\u56e2\u961f\u534f\u4f5c…");
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("a\n  b", 10)).toBe("a b");
  });

  it("aligns tables that mix CJK and ASCII cells", () => {
    const lines = formatTable(
      [{ header: "id" }, { header: "name" }, { header: "email" }],
      [["1", "\u6768\u9e4f\u98de", "a@example.com"], ["2", "Li", "b@example.com"]],
    );
    expect(lines.map(stripVTControlCharacters)).toEqual([
      "id  name    email",
      "1   \u6768\u9e4f\u98de  a@example.com",
      "2   Li      b@example.com",
    ]);
  });

  it("right-aligns numeric columns", () => {
    expect(formatTable([{ header: "n", align: "right" }, { header: "x" }], [["5", "a"], ["123", "b"]]).map(stripVTControlCharacters)).toEqual([
      "  n  x",
      "  5  a",
      "123  b",
    ]);
  });

  it("aligns continuation lines of a row under its value", () => {
    expect(stripVTControlCharacters(formatRow({ label: "Uploads", value: "events\ndiffs" }, 9))).toBe("Uploads    events\n           diffs");
    expect(stripVTControlCharacters(formatRow({ mark: "+", label: "A", value: "x" }, 3))).toBe("+ A    x");
  });

  it("colors known state words only", () => {
    expect(stateWord("ready")).toBe(pc.green("ready"));
    expect(stateWord("custom")).toBe("custom");
  });

  it("formats times in the local time zone", () => {
    const previous = process.env.TZ;
    process.env.TZ = "Asia/Shanghai";
    try {
      expect(localDateTime("2026-09-30T09:00:15.631Z")).toBe("2026-09-30 17:00");
      expect(localDateTime("2026-09-30T09:00:15.631Z", { seconds: true })).toBe("2026-09-30 17:00:15");
      expect(localMoment("2026-09-30T09:00:15Z", "2026-09-30T01:00:00Z")).toBe("17:00");
      expect(localMoment("2026-09-29T09:00:15Z", "2026-09-30T01:00:00Z")).toBe("2026-09-29 17:00");
      expect(localDateTime(null)).toBe("-");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});

describe("block output", () => {
  it("prints ASCII failure marks without rails on a non-Unicode terminal", () => {
    vi.stubEnv("TERM", "linux");
    for (const key of ["WT_SESSION", "TERMINUS_SUBLIME", "ConEmuTask", "TERM_PROGRAM", "TERMINAL_EMULATOR"]) {
      vi.stubEnv(key, undefined);
    }
    setTerminal(true);
    printError("link", "not logged in", "run adit cloud login");
    expect(captured().err).toEqual(["[x] link: not logged in", "  run adit cloud login"]);
  });

  it("prints the plain shape when stdout is not a terminal", () => {
    setTerminal(false);
    printTitle("Status", "adit", "3 repos");
    printRows([{ label: "Session", value: "active" }, { label: "Git", value: "adit-core" }]);
    printSection("Platforms");
    printLine(`${marks.ok} Claude Code`);
    printEnd(`${marks.warn} 9 events not synced`);
    expect(captured().out).toEqual([
      "Status · adit · 3 repos",
      "",
      "  Session  active",
      "  Git      adit-core",
      "",
      "Platforms",
      "  ✓ Claude Code",
      "",
      "! 9 events not synced",
    ]);
  });

  it("frames the block with the rail on a terminal", () => {
    setTerminal(true);
    printTitle("Config", "adit");
    printLine("Project root  /tmp/x");
    printEnd();
    expect(captured().out).toEqual(["┌  Config · adit", "│", "│  Project root  /tmp/x", "└"]);
  });

  it("does not repeat empty lines between the title, sections and the end", () => {
    setTerminal(true);
    printTitle("Init", "demo");
    printSection("Skills");
    printLine("x");
    printLine();
    printEnd("done");
    expect(captured().out).toEqual(["┌  Init · demo", "│", "◇  Skills", "│  x", "│", "└  done"]);
  });

  it("shows the update notice above the closing line", () => {
    setTerminal(true);
    printTitle("Status");
    printLine("a");
    setPendingNotice("! Update available");
    printEnd("! 9 events not synced");
    expect(captured().out).toEqual(["┌  Status", "│", "│  a", "│", "└  ! 9 events not synced"]);
    expect(captured().err).toEqual(["│  ! Update available"]);
  });

  it("reports a standalone failure with its hint", () => {
    setTerminal(true);
    printError("show", "event bogus not found", "find IDs with adit timeline");
    expect(captured().err).toEqual(["✗  show: event bogus not found", "└  find IDs with adit timeline"]);

    vi.mocked(console.error).mockClear();
    setTerminal(false);
    printError("show", "event bogus not found", "find IDs with adit timeline");
    expect(captured().err).toEqual(["✗ show: event bogus not found", "  find IDs with adit timeline"]);
  });

  it("closes an open block with the failure", () => {
    setTerminal(true);
    printTitle("Link", "adit");
    printLine("x");
    printError("link", "not logged in", "run adit cloud login");
    expect(captured().out).toEqual(["┌  Link · adit", "│", "│  x", "│"]);
    expect(captured().err).toEqual(["└  ✗ not logged in", "   run adit cloud login"]);
  });

  it("keeps a block that only closes to two lines", () => {
    setTerminal(true);
    printTitle("Search", '"xyz"', "adit");
    printEnd("No events match.");
    expect(captured().out).toEqual(['┌  Search · "xyz" · adit', "└  No events match."]);
  });

  it("drops the rail when ADIT_PLAIN is set", () => {
    setTerminal(true);
    process.env.ADIT_PLAIN = "1";
    printTitle("Config");
    printLine("a");
    printEnd();
    expect(captured().out).toEqual(["Config", "", "  a"]);
  });
});
