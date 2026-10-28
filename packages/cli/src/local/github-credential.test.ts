import { afterEach, expect, it, vi } from "vitest";
import { importGitHubCredential, readGitHubCliToken } from "./github-credential.js";

const exec = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), execFile: exec,
}));
afterEach(() => { vi.unstubAllEnvs(); exec.mockReset(); });
const fixtureToken = "gho_TEST_ONLY_NOT_A_REAL_CREDENTIAL";
const readToken = async () => fixtureToken;
const response = (scopes: string | null = "repo, gist", status = 200, user: unknown = { login: "test-user", id: 42 }) =>
  new Response(JSON.stringify(user), { status, headers: scopes === null ? {} : { "x-oauth-scopes": scopes } });

it("reads the saved github.com login without environment overrides or shell expansion", async () => {
  vi.stubEnv("GH_TOKEN", "ENV_TEST_SECRET"); vi.stubEnv("GITHUB_TOKEN", "ENV_TEST_SECRET"); vi.stubEnv("GH_DEBUG", "api");
  exec.mockImplementation((command, args, options, callback) => {
    expect(command).toBe("gh"); expect(args).toEqual(["auth", "token", "--hostname", "github.com"]);
    expect(options.env.GH_TOKEN).toBeUndefined(); expect(options.env.GITHUB_TOKEN).toBeUndefined(); expect(options.env.GH_DEBUG).toBeUndefined();
    expect(options.shell).toBeUndefined(); expect(options.timeout).toBe(15000);
    callback(null, `${fixtureToken}\n`);
  });
  expect(await readGitHubCliToken()).toBe(fixtureToken);
});
it.each(["ENOENT", 1, "ETIMEDOUT"])("sanitizes CLI errors (%s)", async code => {
  exec.mockImplementation((_cmd, _args, _options, callback) => callback(Object.assign(new Error(fixtureToken), { code }), fixtureToken));
  await expect(readGitHubCliToken()).rejects.toThrow(code === "ENOENT" ? "not installed" : "Could not read");
  await expect(readGitHubCliToken()).rejects.not.toThrow(fixtureToken);
});
it("verifies identity and granted scope before saving; returns only public account details", async () => {
  const save = vi.fn(async () => {}), request = vi.fn(async () => response());
  const result = await importGitHubCredential({ save }, "workspace-test", { readToken, request: request as typeof fetch });
  expect(result).toEqual({ configured: true, account: "test-user" });
  expect(JSON.stringify(result)).not.toContain(fixtureToken);
  expect(save).toHaveBeenCalledWith("workspace-test", fixtureToken);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toBe("https://api.github.com/user");
  expect(request.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "error", headers: { authorization: `Bearer ${fixtureToken}` } });
});
it.each([
  ["repo, read:org", 200, "lacks Gist"],
  ["", 200, "lacks Gist"],
  [null, 200, "Could not confirm"],
  ["gist", 401, "expired"],
  ["gist", 403, "could not verify"],
  ["gist", 429, "could not verify"],
])("never replaces a credential when verification fails (%s, %s)", async (scopes, status, message) => {
  const save = vi.fn();
  await expect(importGitHubCredential({ save }, "workspace-test", { readToken, request: (async () => response(scopes as string | null, status as number)) as typeof fetch })).rejects.toThrow(message as string);
  expect(save).not.toHaveBeenCalled();
});
it("does not mistake accepted scopes for granted permissions", async () => {
  const denied = response(null); denied.headers.set("x-accepted-oauth-scopes", "gist");
  const save = vi.fn();
  await expect(importGitHubCredential({ save }, "ws", { readToken, request: (async () => denied) as typeof fetch })).rejects.toThrow("Could not confirm");
  expect(save).not.toHaveBeenCalled();
});
it("sanitizes network and secure storage errors", async () => {
  const save = vi.fn(async () => { throw new Error(fixtureToken); });
  await expect(importGitHubCredential({ save }, "ws", { readToken, request: (async () => { throw new Error(fixtureToken); }) as typeof fetch })).rejects.toThrow("Unable to verify");
  expect(save).not.toHaveBeenCalled();
  await expect(importGitHubCredential({ save }, "ws", { readToken, request: (async () => response()) as typeof fetch })).rejects.toThrow("Unable to save");
});
it("rejects invalid credentials or account responses before saving", async () => {
  const save = vi.fn(), request = vi.fn(async () => response("gist", 200, { login: fixtureToken }));
  await expect(importGitHubCredential({ save }, "ws", { readToken: async () => "bad\nvalue", request: request as typeof fetch })).rejects.toThrow("unavailable");
  expect(request).not.toHaveBeenCalled();
  await expect(importGitHubCredential({ save }, "ws", { readToken, request: request as typeof fetch })).rejects.toThrow("invalid account");
  expect(save).not.toHaveBeenCalled();
});
