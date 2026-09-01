import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCloudSetupSection, type CloudSetupDeps } from "./init-cloud-setup.js";

describe("runCloudSetupSection", () => {
  let originalLog: typeof console.log;
  let output: string[];

  beforeEach(() => {
    originalLog = console.log;
    output = [];
    console.log = ((...args: unknown[]) => {
      output.push(args.join(" "));
    }) as never;
  });

  afterEach(() => {
    console.log = originalLog;
  });

  function deps(overrides: Partial<CloudSetupDeps>): Partial<CloudSetupDeps> {
    return {
      isLoggedIn: () => false,
      resolveServerUrl: () => "https://cloud.example.com",
      isProjectLinked: () => false,
      login: vi.fn(async () => true),
      link: vi.fn(async () => true),
      askYes: vi.fn(async () => true),
      ...overrides,
    };
  }

  const base = { projectId: "p1", dbPath: "/nonexistent/db.sqlite" };

  it("silently passes when already logged in and linked", async () => {
    const d = deps({ isLoggedIn: () => true, isProjectLinked: () => true });
    const result = await runCloudSetupSection({ ...base, interactive: true, deps: d });
    expect(result.linked).toBe(true);
    expect(d.askYes).not.toHaveBeenCalled();
    expect(output.join("\n")).toContain("[=] Project already linked");
  });

  it("skips entirely on non-interactive runs", async () => {
    const d = deps({});
    const result = await runCloudSetupSection({ ...base, interactive: false, deps: d });
    expect(result.linked).toBe(false);
    expect(d.login).not.toHaveBeenCalled();
    expect(output.join("\n")).toContain("skipped (non-interactive)");
  });

  it("logged in but not linked asks one link question", async () => {
    const d = deps({ isLoggedIn: () => true });
    const result = await runCloudSetupSection({ ...base, interactive: true, deps: d });
    expect(result.linked).toBe(true);
    expect(d.login).not.toHaveBeenCalled();
    expect(d.link).toHaveBeenCalledTimes(1);
  });

  it("not logged in runs login then link after one combined question", async () => {
    const d = deps({});
    const result = await runCloudSetupSection({ ...base, interactive: true, deps: d });
    expect(result.linked).toBe(true);
    expect(d.login).toHaveBeenCalledTimes(1);
    expect(d.link).toHaveBeenCalledTimes(1);
  });

  it("declining the question skips without touching the network", async () => {
    const d = deps({ askYes: vi.fn(async () => false) });
    const result = await runCloudSetupSection({ ...base, interactive: true, deps: d });
    expect(result.linked).toBe(false);
    expect(d.login).not.toHaveBeenCalled();
    expect(d.link).not.toHaveBeenCalled();
    expect(output.join("\n")).toContain("Skipped");
  });

  it("a failed login stops before link and never fails init", async () => {
    const d = deps({ login: vi.fn(async () => false) });
    const result = await runCloudSetupSection({ ...base, interactive: true, deps: d });
    expect(result.linked).toBe(false);
    expect(d.link).not.toHaveBeenCalled();
    expect(output.join("\n")).toContain("Login not completed");
  });

  it("a failed link reports and returns unlinked", async () => {
    const d = deps({ isLoggedIn: () => true, link: vi.fn(async () => false) });
    const result = await runCloudSetupSection({ ...base, interactive: true, deps: d });
    expect(result.linked).toBe(false);
    expect(output.join("\n")).toContain("Link failed");
  });
});
