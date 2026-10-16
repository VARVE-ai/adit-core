import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), credentials: vi.fn() }));
vi.mock("@varveai/adit-cloud", async (original) => ({ ...await original<typeof import("@varveai/adit-cloud")>(), loadCredentials: mocks.credentials, CloudClient: class { get = mocks.get; post = mocks.post; patch = mocks.patch; delete = mocks.delete; } }));
import { CloudApiError, type CloudSessionDetail } from "@varveai/adit-cloud";
import { Command } from "commander";
import { cloudCommitsExplainCommand, cloudProjectsCommand, cloudSessionsCurrentCommand, cloudSessionsEventsCommand, cloudSessionsLinkCommand, cloudSessionsListCommand, cloudSessionsSearchCommand, registerCloudHistoryCommands, resolveCurrentSession, type CurrentSessionDeps } from "./cloud-history.js";

const sessionId = "a1111111-1111-4111-8111-111111111111";
const output = () => vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  mocks.credentials.mockReturnValue({ serverUrl: "https://cloud.example", accessToken: "private" });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

describe("history commands", () => {
  it("lists projects with filters and prints the server JSON", async () => {
    const result = { projects: [{ id: "p1", kind: "team", name: "Web" }], scope: { kind: "visible", description: "projects you can read" } };
    mocks.get.mockResolvedValue(result);
    await cloudProjectsCommand({ query: "web", kind: "team", json: true });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith("/api/cli/projects?q=web&kind=team&scope=visible");
    expect(JSON.parse(output()[0])).toEqual(result);
  });

  it("searches sessions with the period, explicit time zone and paging", async () => {
    mocks.get.mockResolvedValue({ query: "login", searchMode: "keyword", sessions: [], total: 0, nextOffset: null, scopeTruncated: false, period: { from: "2026-09-01", to: "2026-09-30", timeZone: "Asia/Shanghai" }, scope: { kind: "me", description: "your sessions" } });
    await cloudSessionsSearchCommand("login", { from: "2026-09-01", to: "2026-09-30", tz: "Asia/Shanghai", team: sessionId, json: true });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(`/api/cli/sessions/search?q=login&scope=me&team=${sessionId}&from=2026-09-01&to=2026-09-30&timeZone=Asia%2FShanghai&offset=0&limit=50`);
    await cloudSessionsSearchCommand("login", { from: "2026-13-01", json: true });
    expect(JSON.parse(output()[1])).toMatchObject({ ok: false, error: "--from must be a calendar date (YYYY-MM-DD)" });
    expect(process.exitCode).toBe(1);
  });

  it("reads events by section with type filters and truncation", async () => {
    mocks.get.mockResolvedValue({ sessionId, section: { sequence: 2, title: "Login" }, events: [], total: 0, nextOffset: null, maxChars: 100 });
    await cloudSessionsEventsCommand(sessionId, { section: "2", types: "prompt,response", maxChars: "100", limit: "10", json: true });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(`/api/cli/sessions/${sessionId}/events?section=2&types=prompt%2Cresponse&maxChars=100&offset=0&limit=10`);
  });

  it("creates and revokes read links through POST and DELETE", async () => {
    mocks.post.mockResolvedValue({ sessionId, created: true, link: { createdAt: "2026-09-30T01:00:00.000Z", expiresAt: "2026-09-30T02:00:00.000Z", revokedAt: null }, url: "https://cloud.example/api/session-context?token=adit_ctx_x", serverNow: "2026-09-30T01:00:00.000Z" });
    await cloudSessionsLinkCommand("create", sessionId, {});
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(`/api/cli/sessions/${sessionId}/context-link`, {});
    expect(output().some((line) => line.includes("token=adit_ctx_x"))).toBe(true);
    mocks.delete.mockResolvedValue({ sessionId, action: "revoke", link: { createdAt: "2026-09-30T01:00:00.000Z", expiresAt: "2026-09-30T02:00:00.000Z", revokedAt: "2026-09-30T01:30:00.000Z" }, url: null, serverNow: "2026-09-30T01:30:00.000Z" });
    await cloudSessionsLinkCommand("revoke", sessionId, {});
    expect(mocks.delete).toHaveBeenCalledExactlyOnceWith(`/api/cli/sessions/${sessionId}/context-link`);
    expect(output().at(-1)).toContain("Read link revoked");
  });

  it("relays ambiguity details from the server when explaining a commit", async () => {
    mocks.get.mockRejectedValue(new CloudApiError("API error: 409 Conflict", 409, { error: "Several commits start with that SHA", code: "COMMIT_AMBIGUOUS", candidates: [{ sha: "abc1" }, { sha: "abc2" }] }));
    await cloudCommitsExplainCommand("abc", { json: true });
    expect(JSON.parse(output()[0])).toEqual({ ok: false, error: "Several commits start with that SHA", status: 409, code: "COMMIT_AMBIGUOUS", candidates: [{ sha: "abc1" }, { sha: "abc2" }] });
    expect(process.exitCode).toBe(1);
  });

  const scopedCommands = [["projects", "list"], ["sessions", "list"], ["sessions", "search", "login"], ["commits", "explain", "abcdef1"]];

  it.each(scopedCommands.map((args) => [args.join(" "), args] as const))("registers me by default and explicit visible for %s", async (_name, args) => {
    for (const scope of ["me", "visible"] as const) {
      const result = { scope: { kind: scope, description: scope } };
      mocks.get.mockResolvedValue(result);
      const cloud = new Command("cloud");
      registerCloudHistoryCommands(cloud);
      await cloud.parseAsync([...args, ...(scope === "visible" ? ["--scope", scope] : []), "--json"], { from: "user" });
      const url = new URL(mocks.get.mock.calls.at(-1)![0], "https://cloud.example");
      expect(url.searchParams.get("scope")).toBe(scope);
      expect(JSON.parse(output().at(-1)!)).toEqual(result);
    }
  });

  it.each(scopedCommands.map((args) => [args.join(" "), args] as const))("rejects invalid scope before querying for %s", async (_name, args) => {
    const cloud = new Command("cloud").exitOverride().configureOutput({ writeErr: () => {} });
    registerCloudHistoryCommands(cloud);
    await expect(cloud.parseAsync([...args, "--scope", "all"], { from: "user" })).rejects.toThrow();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("preserves legacy project kind and rejects an explicitly conflicting scope", async () => {
    mocks.get.mockResolvedValue({ projects: [], scope: { kind: "visible", description: "projects you can read" } });
    const cloud = new Command("cloud");
    registerCloudHistoryCommands(cloud);
    await cloud.parseAsync(["projects", "list", "--kind", "team", "--json"], { from: "user" });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith("/api/cli/projects?kind=team&scope=visible");
    await cloudProjectsCommand({ scope: "me", kind: "team", json: true });
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output().at(-1)!)).toMatchObject({ ok: false, error: expect.stringContaining("cannot be combined") });
  });

  it("does not print unconfirmed or mismatched scope results from an older server", async () => {
    for (const scope of [undefined, { kind: "visible", description: "everything" }]) {
      mocks.get.mockResolvedValue({ scope, sessions: [{ id: "someone-elses-session" }] });
      await cloudSessionsListCommand({ json: true });
      await cloudSessionsSearchCommand("login", { json: true });
      await cloudProjectsCommand({ json: true });
      await cloudCommitsExplainCommand("abcdef1", { json: true });
    }
    for (const line of output()) {
      expect(JSON.parse(line)).toMatchObject({ ok: false, error: expect.stringContaining("Cloud did not confirm") });
      expect(line).not.toContain("someone-elses-session");
    }
  });

  it.each(["list", "search"])("keeps explicit scope in the sessions %s pagination hint", async (action) => {
    mocks.get.mockResolvedValue({
      scope: { kind: "visible", description: "everything you can read" },
      period: { from: null, to: null, timeZone: "UTC" }, total: 2, nextOffset: 1, searchMode: "keyword", scopeTruncated: false,
      sessions: [{ id: sessionId, startedAt: "2026-09-30T00:00:00.000Z", platform: "codex", analysis: { state: "ready" }, title: "Login", score: 3, matches: [] }],
    });
    if (action === "list") await cloudSessionsListCommand({ scope: "visible", limit: "1", tz: "UTC" });
    else await cloudSessionsSearchCommand("login", { scope: "visible", limit: "1", tz: "UTC" });
    expect(output().some((line) => line.includes("everything you can read"))).toBe(true);
    expect(output().at(-1)).toContain("--scope visible");
    expect(output().at(-1)).toContain("--offset 1");
  });
});

describe("current session resolution", () => {
  const local = (session: { id: string; platformSessionId: string | null; startedAt: string }) => ({ ...session, projectId: "project", clientId: "client", sessionType: "interactive" as const, platform: "claude-code" as const, metadataJson: null, vclockJson: "{}", deletedAt: null });
  function deps(overrides: Partial<CurrentSessionDeps> & { localOverrides?: Partial<CurrentSessionDeps["local"]> } = {}): CurrentSessionDeps {
    const { localOverrides, ...rest } = overrides;
    return {
      env: {}, serverUrl: "https://cloud.example", now: new Date("2026-09-30T02:00:00.000Z"),
      local: {
        loadConfig: vi.fn().mockReturnValue({ initialization: "initialized", dbPath: "/tmp/adit.sqlite", projectId: "project", projectRoot: "/repo", clientId: "client" }) as unknown as CurrentSessionDeps["local"]["loadConfig"],
        existsSync: vi.fn().mockReturnValue(true) as unknown as CurrentSessionDeps["local"]["existsSync"],
        openDatabase: vi.fn().mockReturnValue({}) as unknown as CurrentSessionDeps["local"]["openDatabase"],
        closeDatabase: vi.fn(),
        getSessionByPlatformSessionId: vi.fn().mockReturnValue(null),
        getLatestSession: vi.fn().mockReturnValue(null),
        listRecentSessions: vi.fn().mockReturnValue([]),
        getLastEventOfSession: vi.fn().mockReturnValue({ startedAt: "2026-09-30T01:50:00.000Z" }),
        getSyncState: vi.fn().mockReturnValue({ lastSyncedEventId: "e1", lastSyncedAt: "2026-09-30T01:00:00.000Z" }),
        countUnsyncedEvents: vi.fn().mockReturnValue(0),
        ...localOverrides,
      } as CurrentSessionDeps["local"],
      cloud: null,
      ...rest,
    };
  }

  it("reports an uninitialized directory without touching the database", async () => {
    const d = deps({ env: { CLAUDE_CODE_SESSION_ID: "platform-1" }, localOverrides: { loadConfig: vi.fn().mockReturnValue({ initialization: "uninitialized", dbPath: "/nowhere" }) as unknown as CurrentSessionDeps["local"]["loadConfig"] } });
    const report = await resolveCurrentSession(d);
    expect(report).toMatchObject({ state: "notInitialized", platformSessionId: "platform-1", platform: "claude-code", session: null });
    expect(d.local.openDatabase).not.toHaveBeenCalled();
  });

  it("reports a session the project never recorded, with recent candidates", async () => {
    const recent = local({ id: "s-recent", platformSessionId: "other", startedAt: "2026-09-30T00:00:00.000Z" });
    const report = await resolveCurrentSession(deps({ env: { CLAUDE_CODE_SESSION_ID: "platform-1" }, localOverrides: { listRecentSessions: vi.fn().mockReturnValue([recent]) } }));
    expect(report.state).toBe("notRecorded");
    expect(report.candidates.map((candidate) => candidate.id)).toEqual(["s-recent"]);
    expect(report.hint).toContain("adit doctor");
  });

  it("asks which session when nothing identifies it and several were active", async () => {
    const recent = ["s1", "s2"].map((id) => local({ id, platformSessionId: null, startedAt: "2026-09-30T00:00:00.000Z" }));
    const report = await resolveCurrentSession(deps({ localOverrides: { listRecentSessions: vi.fn().mockReturnValue(recent) } }));
    expect(report.state).toBe("ambiguous");
    expect(report.candidates).toHaveLength(2);
  });

  it("resolves the environment's session and explains unsynced events and a missing Cloud copy", async () => {
    const session = local({ id: sessionId, platformSessionId: "platform-1", startedAt: "2026-09-30T01:00:00.000Z" });
    const d = deps({
      env: { CLAUDE_CODE_SESSION_ID: "platform-1" },
      localOverrides: { getSessionByPlatformSessionId: vi.fn().mockReturnValue(session), countUnsyncedEvents: vi.fn().mockReturnValue(3) },
      cloud: vi.fn().mockRejectedValue(new CloudApiError("API error: 404 Not Found", 404, { error: "Session not found" })),
    });
    const report = await resolveCurrentSession(d);
    expect(report).toMatchObject({ state: "resolved", inferred: false, session: { id: sessionId, lastEventAt: "2026-09-30T01:50:00.000Z" }, local: { unsyncedEvents: 3, lastSyncedAt: "2026-09-30T01:00:00.000Z" }, cloud: { status: "notSynced" } });
    expect(report.hint).toContain("adit cloud sync");
    expect(d.local.getSessionByPlatformSessionId).toHaveBeenCalledWith({}, "platform-1");
    expect(d.local.closeDatabase).toHaveBeenCalledOnce();
  });

  it("falls back to the latest local session and reads its Cloud analysis", async () => {
    const session = local({ id: sessionId, platformSessionId: null, startedAt: "2026-09-30T01:00:00.000Z" });
    const detail = { session: { title: "Login page", analysis: { state: "ready", sections: 2, pendingBatches: 0, failedBatches: 0 } } } as unknown as CloudSessionDetail;
    const d = deps({ localOverrides: { listRecentSessions: vi.fn().mockReturnValue([session]) }, cloud: vi.fn().mockResolvedValue(detail) });
    await cloudSessionsCurrentCommand({ json: true }, d);
    const report = JSON.parse(output()[0]);
    expect(report).toMatchObject({ state: "resolved", inferred: true, session: { id: sessionId }, cloud: { status: "ready", title: "Login page", analysis: { state: "ready" } } });
    expect(report.hint).toContain("latest session");
  });
});
