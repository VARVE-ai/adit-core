import { expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { inspectProcess, ownsDaemonProcess } from "./daemon-process.js";

vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

it("checks the OS process birth identity rather than just a live PID", () => {
  const current = inspectProcess(process.pid);
  expect(current?.identity).toBeTruthy();
  expect(ownsDaemonProcess({ pid: process.pid, processIdentity: current!.identity })).toBe(true);
  expect(ownsDaemonProcess({ pid: process.pid, processIdentity: "previous-boot-or-process" })).toBe(false);
});

it("rejects legacy locks belonging to a live unrelated process", () => {
  expect(ownsDaemonProcess({ pid: process.pid })).toBe(false);
});

it("rejects invalid PIDs without querying the OS", () => {
  for (const pid of [0, -1, NaN, 1.5]) expect(ownsDaemonProcess({ pid })).toBe(false);
});

it("includes macOS boot time and process birth time and rejects MacinTalk legacy locks", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin" });
  vi.mocked(execFileSync).mockImplementation(((file: string) => file === "ps"
    ? "Tue Nov  3 09:00:00 2026 /System/Library/MacinTalkAUSP\n"
    : "{ sec = 1793660000, usec = 0 }\n") as typeof execFileSync);
  try {
    expect(inspectProcess(process.pid)).toEqual({
      identity: "{ sec = 1793660000, usec = 0 }:Tue Nov 3 09:00:00 2026",
      command: "/System/Library/MacinTalkAUSP",
    });
    expect(ownsDaemonProcess({ pid: process.pid })).toBe(false);
    expect(ownsDaemonProcess({ pid: process.pid, processIdentity: "old-boot" })).toBe(false);
  } finally {
    Object.defineProperty(process, "platform", platform);
    vi.mocked(execFileSync).mockReset();
  }
});

for (const scenario of ["exited", "reused", "same", "unknown", "legacy-unreadable"] as const) {
  it(`verifies Windows ownership after EPERM: ${scenario}`, () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    const probe = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("kill EPERM"), { code: "EPERM" }); });
    vi.mocked(execFileSync).mockImplementation((() => {
      if (scenario === "unknown") throw new Error("Access denied");
      if (scenario === "exited") return "";
      return JSON.stringify({ identity: scenario === "reused" ? "another-process" : "original", command: null });
    }) as typeof execFileSync);
    try {
      const owner = { pid: 7304, ...(scenario === "legacy-unreadable" ? {} : { processIdentity: "original" }) };
      if (["unknown", "legacy-unreadable"].includes(scenario)) expect(() => ownsDaemonProcess(owner)).toThrow(/Cannot verify/);
      else expect(ownsDaemonProcess(owner)).toBe(scenario === "same");
    } finally {
      probe.mockRestore();
      Object.defineProperty(process, "platform", platform);
      vi.mocked(execFileSync).mockReset();
    }
  });
}
