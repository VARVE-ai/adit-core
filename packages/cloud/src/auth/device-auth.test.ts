import { afterEach, expect, it, vi } from "vitest";
import { pollForToken } from "./device-auth.js";

afterEach(() => {
  vi.unstubAllGlobals();
});
it("cancels local UI authorization without another network request", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    pollForToken("https://example.test", "device", 10, 100, controller.signal),
  ).rejects.toThrow("cancelled");
  expect(fetchMock).not.toHaveBeenCalled();
});
it("cancels a pending authorization wait promptly", async () => {
  const controller = new AbortController();
  const fetchMock = vi.fn().mockResolvedValue({ status: 428, ok: false });
  vi.stubGlobal("fetch", fetchMock);
  const pending = pollForToken(
    "https://example.test",
    "device",
    10000,
    300000,
    controller.signal,
  );
  const assertion = expect(pending).rejects.toThrow("cancelled");
  await new Promise((r) => setTimeout(r, 5));
  controller.abort(new Error("cancelled"));
  await assertion;
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
