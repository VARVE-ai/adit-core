import { describe, expect, it } from "vitest";
import { cursorUserQuery } from "./cursor-prompt.js";
import { parseCursor } from "./cursor.js";
import { promptSummary, promptText } from "./prompt-summary.js";

const envelope = (time: string, prompt = "到底") => `<timestamp>${time}</timestamp>\n<user_query>\n${prompt}\n</user_query>`;
const localTime = "Thursday, Sep 10, 2026, 1:27 PM (UTC+8)";

describe("Cursor native prompt envelopes", () => {
  it.each([
    [localTime, "2026-09-10T05:27:00.000Z"],
    ["Thursday, Jul 2, 2026, 11:59 PM (UTC-4)", "2026-07-03T03:59:00.000Z"],
    ["Friday, Jul 3, 2026, 12:00 AM (UTC-4)", "2026-07-03T04:00:00.000Z"],
    ["Thursday, Jul 2, 2026, 12:00 PM (UTC+5:30)", "2026-07-02T06:30:00.000Z"],
    ["Thursday, Jul 2, 2026, 12:00 AM (UTC+0)", "2026-07-02T00:00:00.000Z"],
  ])("parses the explicit timezone: %s", (input, expected) => {
    expect(cursorUserQuery(envelope(input))).toMatchObject({ text: "到底", timestamp: expected });
  });

  it.each([
    "Thursday, Feb 30, 2026, 1:27 PM (UTC+8)",
    "Thursday, Sep 0, 2026, 1:27 PM (UTC+8)",
    "Thursday, Sep 10, 2026, 13:27 PM (UTC+8)",
    "Thursday, Sep 10, 2026, 0:27 AM (UTC+8)",
    "Thursday, Sep 10, 2026, 1:60 PM (UTC+8)",
    "Thursday, Sep 10, 2026, 1:27 PM (UTC+24)",
    "Thursday, Sep 10, 2026, 1:27 PM (UTC+5:60)",
    "Thursday, Sep 10, 2026, 1:27 PM (UTC)",
    "not a date",
  ])("does not invent a time for %s", input => {
    expect(cursorUserQuery(envelope(input))).toMatchObject({ text: "到底", timestamp: undefined });
  });

  it("extracts full prompts and bounded titles from strings and native text blocks", () => {
    const prompt = "解释这个问题\n" + "内容".repeat(150);
    const content = [{ type: "image", data: "attachment" }, { type: "text", text: envelope(localTime, prompt) }];
    expect(promptText("cursor", content)).toBe(prompt);
    expect(promptSummary("cursor", content)).toBe(prompt.slice(0, 240));
    expect(promptText("cursor", "<user_query>没有时间也保留提问</user_query>")).toBe("没有时间也保留提问");
    expect(promptText("claude", envelope(localTime))).toBe(envelope(localTime));
  });

  it("leaves quoted or incomplete XML and nested literal tags untouched", () => {
    for (const value of ["```xml\n" + envelope(localTime) + "\n```", "解释 " + envelope(localTime),
      `<timestamp>${localTime}</timestamp>\nordinary prose`, "<user_query>incomplete"])
      expect(promptText("cursor", value)).toBe(value);
    const literal = "例子：<user_query>inner</user_query> 和 <timestamp>literal</timestamp>";
    expect(promptText("cursor", envelope(localTime, literal))).toBe(literal);
  });

  it.each(["jsonl", "txt"])("keeps native content and identities in %s, without assigning user times to replies", format => {
    const content = envelope(localTime);
    const text = format === "jsonl"
      ? [ { role: "user", message: { content: [{ type: "text", text: content }] } },
          { role: "assistant", message: { content: "answer" } }, { type: "result", status: "success" } ].map(r => JSON.stringify(r)).join("\n")
      : `user:\n${content}\nassistant:\nanswer`;
    const session = parseCursor(text, `session.${format}`, "D:/project");
    expect(session.messages.map(m => m.key)).toEqual(["0", "1"]);
    expect(session.messages[0].timestamp).toBe("2026-09-10T05:27:00.000Z");
    expect(session.messages[1].timestamp).toBeUndefined();
    expect(session.messages[0].content).toEqual(format === "jsonl" ? [{ type: "text", text: content }] : content);
  });

  it("prefers an explicit native timestamp over the embedded fallback", () => {
    const session = parseCursor(JSON.stringify({ role: "user", timestamp: "2026-09-10T05:27:12Z", message: { content: envelope(localTime) } }), "s.jsonl", "D:/project");
    expect(session.messages[0].timestamp).toBe("2026-09-10T05:27:12.000Z");
  });
});
