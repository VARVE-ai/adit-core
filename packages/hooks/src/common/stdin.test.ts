import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readStdin } from "./context.js";

describe("readStdin", () => {
  let stdin: PassThrough;

  beforeEach(() => {
    vi.useFakeTimers();
    stdin = new PassThrough();
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as typeof process.stdin);
  });

  afterEach(() => {
    stdin.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(["", "\uFEFF"])("reads JSON with prefix %j", async (prefix) => {
    const payload = { session_id: "cursor-session", prompt: "只回复 OK" };
    const result = readStdin();
    stdin.end(Buffer.from(`${prefix}${JSON.stringify(payload)}\r\n`, "utf8"));
    await expect(result).resolves.toEqual(payload);
  });

  it("reads a UTF-8 BOM split across chunks", async () => {
    const result = readStdin();
    stdin.write(Buffer.from([0xef]));
    stdin.write(Buffer.from([0xbb]));
    stdin.end(Buffer.concat([Buffer.from([0xbf]), Buffer.from('{"prompt":"OK"}')]));
    await expect(result).resolves.toEqual({ prompt: "OK" });
  });

  it.each(["", "\uFEFF"])("reads JSON with prefix %j when stdin stays open", async (prefix) => {
    const result = readStdin();
    stdin.write(`${prefix}{"prompt":"OK"}`);
    const assertion = expect(result).resolves.toEqual({ prompt: "OK" });
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
  });

  it("still rejects malformed JSON", async () => {
    const result = readStdin();
    stdin.end('\uFEFF{"prompt":');
    await expect(result).rejects.toThrow("Invalid JSON on stdin");
  });
});
