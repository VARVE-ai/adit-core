import { describe, expect, it } from "vitest";
import { applyReclaimInput, normalizeReclaimInput } from "./reclaim-input.js";

describe("applyReclaimInput", () => {
  it("echoes typed text and submits a complete reclaim command", () => {
    const typing = applyReclaimInput("", "/local");
    expect(typing).toEqual({
      buffer: "/local",
      echo: "/local",
      submittedLines: [],
      interrupted: false,
    });

    expect(applyReclaimInput(typing.buffer, "\r")).toEqual({
      buffer: "",
      echo: "\r\n",
      submittedLines: ["/local"],
      interrupted: false,
    });
  });

  it("edits the buffered line and emits terminal backspace sequences", () => {
    expect(applyReclaimInput("/locxx", "\b\bal\r")).toEqual({
      buffer: "",
      echo: "\b \b\b \bal\r\n",
      submittedLines: ["/local"],
      interrupted: false,
    });
  });

  it("decodes CSI-u input without echoing terminal protocol escapes", () => {
    const encoded = "\x1b[I\x1b[47u\x1b[108u\x1b[111u\x1b[99u\x1b[97u\x1b[108u\x1b[13u";

    expect(applyReclaimInput("", encoded)).toEqual({
      buffer: "",
      echo: "/local\r\n",
      submittedLines: ["/local"],
      interrupted: false,
    });
  });

  it("renders Ctrl+C and clears pending input", () => {
    expect(applyReclaimInput("/loc", "\x1b[99;5u")).toEqual({
      buffer: "",
      echo: "^C\r\n",
      submittedLines: [],
      interrupted: true,
    });
  });
});

describe("normalizeReclaimInput", () => {
  it("strips unrelated terminal escape sequences", () => {
    expect(normalizeReclaimInput("\x1b[?1004h/local\x1b[?2004l")).toBe("/local");
  });
});
