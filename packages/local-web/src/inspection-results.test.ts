import { expect, it, vi } from "vitest";
import type {
  InspectionData,
  InspectionFinding,
} from "../../core/src/local-history/inspection";
import {
  inspectionSessionKey,
  readInspectionResults,
  type InspectionApi,
} from "./inspection-results";
const finding = (id: string): InspectionFinding => ({
  id,
  sessionId: "session",
  provider: "codex",
  title: "Session",
  rule: "github",
  confidence: "definite",
  status: "pending",
  masked: "masked",
  location: "prompt",
  occurredAt: 1,
  turn: 1,
  line: 1,
});
const data = (
  items: InspectionFinding[],
  nextOffset: number | null = null,
): InspectionData => ({
  rules: [],
  total: 125,
  main: 123,
  children: 2,
  checked: 125,
  maskReady: true,
  pendingDefinite: 53,
  pendingCandidate: 51974,
  counts: { pending: 53, handled: 2, ignored: 1 },
  items,
  nextOffset,
  run: null,
});
it("keeps sessions with the same native ID but different providers separate", () => {
  expect(inspectionSessionKey(finding("a"))).not.toBe(
    inspectionSessionKey({ ...finding("a"), provider: "claude" }),
  );
});
it("reads only the requested session summary page even for tens of thousands of findings", async () => {
  const page = {
    ...data([], 50),
    sessions: [
      {
        provider: "codex",
        sessionId: "s",
        title: "Session",
        occurredAt: 1,
        count: 51974,
        rules: ["candidate"],
      },
    ],
  };
  const api = vi.fn().mockResolvedValue(page);
  const result = await readInspectionResults(
    api as InspectionApi,
    "/inspection?workspaceId=w&view=sessions",
    "pending",
    "candidate",
    new AbortController().signal,
  );
  expect(api).toHaveBeenCalledTimes(1);
  expect(api.mock.calls[0][0]).toBe(
    "/inspection?workspaceId=w&view=sessions&status=pending&offset=0&rule=candidate",
  );
  expect(result).toEqual(page);
});
it("refreshes loaded occurrence pages together, preserving filter scope, counts and individual findings", async () => {
  const first = Array.from({ length: 50 }, (_, i) => finding(String(i)));
  const api = vi
    .fn()
    .mockResolvedValueOnce(data(first, 50))
    .mockResolvedValueOnce(data([finding("50"), finding("51")]));
  const result = await readInspectionResults(
    api as InspectionApi,
    "/inspection?workspaceId=w&provider=codex&sessionId=s",
    "ignored",
    "github",
    new AbortController().signal,
    50,
  );
  expect(result.items).toHaveLength(52);
  expect(result).toMatchObject({
    total: 125,
    pendingDefinite: 53,
    pendingCandidate: 51974,
    counts: { pending: 53, handled: 2, ignored: 1 },
    nextOffset: null,
  });
  expect(api.mock.calls.map((call) => call[0])).toEqual([
    "/inspection?workspaceId=w&provider=codex&sessionId=s&status=ignored&offset=0&rule=github",
    "/inspection?workspaceId=w&provider=codex&sessionId=s&status=ignored&offset=50&rule=github",
  ]);
});
it("does not publish stale pages after the selection changes", async () => {
  const controller = new AbortController();
  const api = vi.fn(async () => {
    controller.abort();
    return data([finding("1")]);
  });
  await expect(
    readInspectionResults(
      api as InspectionApi,
      "/inspection?workspaceId=w",
      "pending",
      "",
      controller.signal,
    ),
  ).rejects.toThrow();
});
