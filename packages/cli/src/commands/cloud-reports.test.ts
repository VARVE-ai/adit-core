import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), credentials: vi.fn() }));
vi.mock("@varveai/adit-cloud", async (original) => ({ ...await original<typeof import("@varveai/adit-cloud")>(), loadCredentials: mocks.credentials, CloudClient: class { get = mocks.get; } }));
import { cloudReportsDailyCommand, cloudTeamMembersCommand, cloudTeamProgressCommand, cloudUsageCommand } from "./cloud-reports.js";

const teamId = "b2222222-2222-4222-8222-222222222222";
const memberId = "c3333333-3333-4333-8333-333333333333";
const output = () => vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  mocks.credentials.mockReturnValue({ serverUrl: "https://cloud.example", accessToken: "private" });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

describe("report commands", () => {
  it("requests team usage by member for the period with the machine's or given zone", async () => {
    mocks.get.mockResolvedValue({ period: { from: "2026-09-22", to: "2026-09-28", timeZone: "UTC" }, scope: { kind: "team", team: { name: "Web" }, member: null }, by: "member", totals: { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: "0.0031", unpricedRequests: 0 }, rows: [], unreadableSessions: 0 });
    await cloudUsageCommand({ from: "2026-09-22", to: "2026-09-28", tz: "UTC", scope: "team", team: teamId, by: "member", json: true });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(`/api/cli/usage?from=2026-09-22&to=2026-09-28&timeZone=UTC&by=member&scope=team&team=${teamId}`);
    await cloudUsageCommand({ tz: "UTC" });
    expect(mocks.get.mock.calls[1][0]).toBe("/api/cli/usage?timeZone=UTC");
    expect(output().some((line) => line.startsWith("total"))).toBe(true);
  });

  it("reads one day of reports and relays role failures", async () => {
    mocks.get.mockResolvedValueOnce({ period: {}, reports: [{ workDate: "2026-09-29", team: { name: "Web" }, member: { name: "Mia" }, state: "generated", error: null, cards: [{ stage: "in_progress", title: "Login", contribution: "Built it", evidence: [] }] }] });
    await cloudReportsDailyCommand({ date: "2026-09-29", tz: "UTC", team: teamId });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(`/api/cli/reports/daily?date=2026-09-29&timeZone=UTC&team=${teamId}`);
    expect(output()[1]).toContain("[in_progress] Login");
    await cloudReportsDailyCommand({ date: "2026/09/29", json: true });
    expect(JSON.parse(output()[2])).toMatchObject({ ok: false, error: "--date must be a calendar date (YYYY-MM-DD)" });
  });

  it("requires a team for members and passes the feature words for progress", async () => {
    await cloudTeamMembersCommand({ json: true });
    expect(mocks.get).not.toHaveBeenCalled();
    expect(JSON.parse(output()[0])).toMatchObject({ ok: false, error: expect.stringContaining("--team is required") });
    mocks.get.mockResolvedValue({ team: { name: "Web", role: "owner" }, member: { name: "Mia" }, query: "login", period: { from: null, to: null }, tasks: [], sessions: [], cards: [], commits: [] });
    await cloudTeamProgressCommand({ team: teamId, member: memberId, query: "login form", tz: "UTC" });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(`/api/cli/teams/${teamId}/progress?member=${memberId}&q=login+form&timeZone=UTC`);
    expect(output().at(-1)).toContain("Nothing recorded");
  });
});
