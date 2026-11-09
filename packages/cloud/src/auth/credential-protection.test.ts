import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { unprotectCredentialKey } from "./credential-protection.js";
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
afterEach(() => vi.resetAllMocks());
it.each(["EPERM", "ETIMEDOUT", "ENOENT"])(
  "reports %s without leaking input, stdout or stderr",
  (code) => {
    vi.mocked(spawnSync).mockReturnValue({
      error: Object.assign(new Error("secret-input"), { code }),
      status: null,
      stdout: "secret-output",
      stderr: "secret-stderr",
    } as any);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(() => unprotectCredentialKey({ scheme: "dpapi", value: "secret-key" })).toThrow(code);
      try {
        unprotectCredentialKey({ scheme: "dpapi", value: "secret-key" });
      } catch (error) {
        expect(String(error)).not.toMatch(/secret-(input|output|stderr|key)/);
        expect(String(error)).toContain("sandbox");
      }
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  },
);
