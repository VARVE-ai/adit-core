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
  it("uses workspace and collaboration project labels without renaming commands or user content", async () => {
    const cloud = new Command("cloud");
    registerCloudHistoryCommands(cloud);
    const projects = cloud.commands.find(command => command.name() === "projects")!;
    const teams = cloud.commands.find(command => command.name() === "teams")!;
    expect(projects.description()).toBe("Workspaces you can read");
    expect(teams.description()).toBe("Collaboration projects you belong to");
    expect(projects.commands[0].helpInformation()).toContain("--kind <kind>");
    const result = {
      projects: [{ id: "workspace", kind: "team", name: "研发团队项目", teams: [{ name: "研发团队" }], lastActivityAt: null }],
      scope: { kind: "visible", description: "Visible workspaces" },
    };
    mocks.get.mockResolvedValue(result);
    await cloudProjectsCommand({ scope: "visible" });
    expect(output().join("\n")).toContain("Workspaces");
    expect(output().join("\n")).toContain("shared workspace");
    expect(output().join("\n")).toContain("研发团队项目");
    expect(output().join("\n")).toContain("collaboration projects");
    await cloudProjectsCommand({ scope: "visible", json: true });
    expect(JSON.parse(output().at(-1)!)).toEqual(result);
    expect(mocks.get).toHaveBeenLastCalledWith("/api/cli/projects?scope=visible");
  });

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
