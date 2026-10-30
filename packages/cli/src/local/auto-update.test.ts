import { afterEach, expect, it, vi } from "vitest";
import { LocalStore } from "@varveai/adit-core";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AutomaticUpdate } from "./auto-update.js";
import { detectAutomaticInstallation } from "./auto-update-installation.js";
import {
  acquireInstallationLock,
  installationLockPath,
  performAutomaticUpdate,
  updateCommand,
  type UpdateRequest,
} from "./auto-update-process.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});
function directory() {
  const root = mkdtempSync(join(tmpdir(), "adit-automatic-update-test-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function fixture() {
  const root = directory();
  const store = new LocalStore(join(root, "data"));
  cleanup.push(() => store.close());
  let now = Date.UTC(2026, 9, 30);
  let busy = false;
  const release = vi.fn();
  const acquire = vi.fn(() => (busy ? undefined : release));
  const latest = vi.fn(async () => "1.2.0");
  const launch = vi.fn(async (_request: UpdateRequest) => process.pid);
  const installation = {
    root: join(root, "global"),
    entry: join(root, "global", "dist", "index.js"),
    manager: "npm" as const,
  };
  const options = {
    acquire,
    latest,
    launch,
    detect: async () => ({ installation }),
    now: () => now,
    currentVersion: "1.1.6",
  };
  const service = new AutomaticUpdate(store, options);
  cleanup.push(() => service.close());
  return {
    root,
    store,
    service,
    options,
    release,
    acquire,
    latest,
    launch,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    busy: (value: boolean) => {
      busy = value;
    },
  };
}

it("defaults to enabled, keeps status reads inert and waits for idle before launching once", async () => {
  const test = fixture();
  test.busy(true);
  expect(test.service.status()).toMatchObject({
    enabled: true,
    supported: false,
    reason: "detecting",
  });
  expect(test.latest).not.toHaveBeenCalled();
  await test.service.tick();
  expect(test.service.status()).toMatchObject({
    supported: true,
    phase: "waiting",
    latestVersion: "1.2.0",
  });
  expect(test.launch).not.toHaveBeenCalled();
  test.busy(false);
  await Promise.all([test.service.tick(), test.service.tick()]);
  expect(test.launch).toHaveBeenCalledOnce();
  expect(test.service.updating).toBe(true);
  expect(test.service.status()).not.toHaveProperty("pid");
  expect(test.service.status()).not.toHaveProperty("requestId");
  await test.service.tick();
  expect(test.latest).toHaveBeenCalledOnce();
  expect(test.launch).toHaveBeenCalledOnce();
});

it("preserves a disabled preference across restarts without changing startup or sync settings", async () => {
  const test = fixture();
  test.store.set("login-startup", { enabled: true, version: 4 });
  const schedule = test.store.schedule();
  await test.service.initialize();
  test.service.save({ enabled: false, version: 0 });
  const restarted = new AutomaticUpdate(test.store, test.options);
  cleanup.push(() => restarted.close());
  await restarted.tick();
  expect(restarted.status().enabled).toBe(false);
  expect(test.latest).not.toHaveBeenCalled();
  expect(test.store.get("login-startup", {})).toEqual({ enabled: true, version: 4 });
  expect(test.store.schedule()).toEqual(schedule);
  expect(() => restarted.save({ enabled: true, version: 0 })).toThrow(/changed/);
  expect(() => restarted.save({ enabled: "true", version: 1 })).toThrow(/Invalid/);
});

it.each(["source", "unknown", "disabled", "permissions"] as const)(
  "does not check or install for %s environments",
  async (reason) => {
    const test = fixture();
    const service = new AutomaticUpdate(test.store, {
      ...test.options,
      detect: async () => ({ reason }),
    });
    cleanup.push(() => service.close());
    await service.tick();
    expect(service.status()).toMatchObject({ supported: false, reason });
    expect(test.latest).not.toHaveBeenCalled();
    expect(test.launch).not.toHaveBeenCalled();
    expect(() => service.save({ enabled: true, version: 0 })).toThrow(/unavailable/);
  },
);

it("persists the daily interval and checks overdue installations after restart", async () => {
  const test = fixture();
  test.latest.mockResolvedValue("1.1.6");
  await test.service.tick();
  expect(test.service.status().phase).toBe("current");
  const restarted = new AutomaticUpdate(test.store, test.options);
  cleanup.push(() => restarted.close());
  test.advance(24 * 60 * 60 * 1000 - 1);
  await restarted.tick();
  expect(test.latest).toHaveBeenCalledOnce();
  test.advance(1);
  await restarted.tick();
  expect(test.latest).toHaveBeenCalledTimes(2);
  expect(test.launch).not.toHaveBeenCalled();
});

it("does not install after the user disables updates during a network check", async () => {
  const test = fixture();
  let finish!: (version: string) => void;
  test.latest.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = test.service.tick();
  await vi.waitFor(() => expect(test.latest).toHaveBeenCalledOnce());
  test.service.save({ enabled: false, version: 0 });
  finish("1.2.0");
  await pending;
  expect(test.launch).not.toHaveBeenCalled();
});

it("backs off failures, releases background work and never downgrades or installs prereleases", async () => {
  const test = fixture();
  test.launch.mockRejectedValue(new Error("install failed"));
  await test.service.tick();
  expect(test.service.status()).toMatchObject({
    phase: "failed",
    error: "install failed",
    failures: 1,
  });
  expect(test.release).toHaveBeenCalledOnce();
  expect(test.service.updating).toBe(false);
  await test.service.tick();
  expect(test.launch).toHaveBeenCalledOnce();
  test.advance(60 * 60 * 1000);
  await test.service.tick();
  expect(test.service.status().failures).toBe(2);
  test.advance(2 * 60 * 60 * 1000);
  test.latest.mockResolvedValue("1.3.0-beta.1");
  await test.service.tick();
  expect(test.launch).toHaveBeenCalledTimes(2);
  test.advance(4 * 60 * 60 * 1000);
  test.latest.mockResolvedValue("1.0.0");
  await test.service.tick();
  expect(test.service.status().phase).toBe("current");
  expect(test.launch).toHaveBeenCalledTimes(2);
});

it.each([undefined, "registry tarball unavailable"])(
  "records detached update results across daemon restart (%s)",
  async (error) => {
    const test = fixture();
    await test.service.tick();
    const request = test.launch.mock.calls[0][0];
    expect(() => test.service.save({ enabled: false, version: 0 })).toThrow(/updating/);
    mkdirSync(dirname(request.resultPath), { recursive: true });
    writeFileSync(request.resultPath, JSON.stringify({ id: "old-result", error: "ignore me" }));
    await test.service.tick();
    expect(test.service.status().phase).toBe("installing");
    const restarted = new AutomaticUpdate(test.store, test.options);
    cleanup.push(() => restarted.close());
    writeFileSync(
      request.resultPath,
      JSON.stringify({ id: request.id, version: request.version, finishedAt: Date.now(), error }),
    );
    await restarted.tick();
    expect(restarted.status().phase).toBe(error ? "failed" : "updated");
    if (!error) expect(restarted.status().updatedVersion).toBe("1.2.0");
    expect(test.launch).toHaveBeenCalledOnce();
  },
);

it("detects interrupted update processes without an immediate reinstall loop", async () => {
  const test = fixture();
  test.launch.mockResolvedValue(0);
  await test.service.tick();
  await test.service.tick();
  expect(test.service.status()).toMatchObject({
    phase: "failed",
    error: expect.stringContaining("interrupted"),
  });
  expect(test.release).toHaveBeenCalledOnce();
  await test.service.tick();
  expect(test.launch).toHaveBeenCalledOnce();
});

it("uses the real entry point and verified global root, not cwd, ports or database paths", async () => {
  const root = directory();
  const modules = join(root, "global", "node_modules");
  const packageRoot = join(modules, "@varveai", "adit-cli");
  const entry = join(packageRoot, "dist", "index.js");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, "");
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@varveai/adit-cli", version: "1.1.6" }),
  );
  if (process.getuid) vi.spyOn(process, "getuid").mockReturnValue(501);
  if (process.geteuid) vi.spyOn(process, "geteuid").mockReturnValue(501);
  const getRoot = vi.fn(async () => modules);
  expect(
    await detectAutomaticInstallation({
      entry,
      env: { ADIT_LOCAL_DATA_DIR: "test", ADIT_INSTALL_DIR: root },
      root: getRoot,
    }),
  ).toEqual({ installation: { entry, root: packageRoot, manager: "npm" } });
  expect(
    await detectAutomaticInstallation({
      entry,
      env: { ADIT_DISABLE_AUTO_UPDATE: "1" },
      root: getRoot,
    }),
  ).toEqual({ reason: "disabled" });
  expect(getRoot).toHaveBeenCalledOnce();
  expect(await detectAutomaticInstallation({ entry, env: {}, root: async () => root })).toEqual({
    reason: "unknown",
  });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@varveai/adit-cli", version: "0.0.0" }),
  );
  expect(await detectAutomaticInstallation({ entry, env: {}, root: getRoot })).toEqual({
    reason: "source",
  });
});

it("rejects npm link even when the source package has a release version", async () => {
  const root = directory();
  const source = join(root, "linked-package");
  const modules = join(root, "global", "node_modules");
  const link = join(modules, "@varveai", "adit-cli");
  mkdirSync(join(source, "dist"), { recursive: true });
  mkdirSync(dirname(link), { recursive: true });
  writeFileSync(join(source, "dist", "index.js"), "");
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({ name: "@varveai/adit-cli", version: "1.1.6" }),
  );
  symlinkSync(source, link, process.platform === "win32" ? "junction" : "dir");
  expect(
    await detectAutomaticInstallation({
      entry: join(link, "dist", "index.js"),
      env: {},
      root: async () => modules,
    }),
  ).toEqual({ reason: "source" });
});

it("shares the installation lock across profiles and manual updates and recovers dead owners", () => {
  const root = directory();
  const lockDirectory = join(root, "locks");
  const release = acquireInstallationLock(root, lockDirectory);
  expect(() => acquireInstallationLock(root, lockDirectory)).toThrow(/in progress/);
  release();
  const lock = installationLockPath(root, lockDirectory);
  writeFileSync(lock, JSON.stringify({ pid: 0, id: "dead" }));
  const recovered = acquireInstallationLock(root, lockDirectory);
  expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(process.pid);
  recovered();
  expect(existsSync(lock)).toBe(false);
});

it("pins versions and rejects commands embedded in version or manager input", () => {
  expect(updateCommand("npm", "1.2.0")).toBe("npm install -g @varveai/adit-cli@1.2.0");
  expect(updateCommand("pnpm", "1.2.0")).toBe("pnpm add -g @varveai/adit-cli@1.2.0");
  expect(() => updateCommand("npm", "1.2.0 & echo unsafe")).toThrow();
  expect(() => updateCommand("npm", "1.2.0-beta")).toThrow();
  expect(() => updateCommand("other" as "npm", "1.2.0")).toThrow();
});

it.each([false, true])(
  "only invokes silent setup after installation succeeds (failure=%s)",
  async (fails) => {
    const root = directory();
    const request: UpdateRequest = {
      id: "test",
      version: "1.2.0",
      directory: root,
      resultPath: join(root, "result.json"),
      installation: {
        root: join(root, "install"),
        entry: join(root, "install", "dist", "index.js"),
        manager: "npm",
      },
    };
    const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const run = vi.fn(async (command: string, args: string[], env: NodeJS.ProcessEnv) => {
      calls.push({ command, args, env: { ...env } });
      if (fails) throw new Error("404");
    });
    const result = performAutomaticUpdate(request, run, join(root, "locks"));
    if (fails) await expect(result).rejects.toThrow("404");
    else await result;
    expect(calls).toHaveLength(fails ? 1 : 2);
    expect(calls[0].env.ADIT_DEFER_INSTALL_SETUP).toBe("1");
    if (!fails) {
      expect(calls[1].args).toEqual([
        join(root, "install", "dist", "install-skills.js"),
        "--expected-version",
        "1.2.0",
      ]);
      expect(calls[1].env.ADIT_DEFER_INSTALL_SETUP).toBeUndefined();
      expect(calls[1].env.ADIT_LOCAL_DATA_DIR).toBe(root);
      expect(calls[1].args).not.toContain("--open-browser");
    }
    expect(existsSync(installationLockPath(request.installation.root, join(root, "locks")))).toBe(
      false,
    );
  },
);
