import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { LocalStore, windowsLoginTaskState } from "@varveai/adit-core";
import { LoginStartup, UserLoginRegistration, type StartupRegistration } from "./login-startup.js";

vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  const mocked = vi.fn(actual.execFile);
  const { promisify } = await import("node:util");
  // Node's native promisify implementation closes over the real execFile;
  // explicitly route this test implementation through the mocked callback.
  Object.defineProperty(mocked, promisify.custom, { value: (file: string, args: string[], options: object) =>
    new Promise((resolve, reject) => mocked(file, args, options, (error, stdout, stderr) =>
      error ? reject(error) : resolve({ stdout, stderr }))) });
  return {...actual, execFile: mocked};
});
vi.mock("@varveai/adit-core", async original => { const actual = await original<typeof import("@varveai/adit-core")>(); return {...actual, windowsLoginTaskState: vi.fn(actual.windowsLoginTaskState)}; });
const resources: { store: LocalStore; root: string }[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(execFile).mockReset();
  vi.mocked(windowsLoginTaskState).mockReset();
  for (const { store, root } of resources.splice(0)) {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "adit-login-test-"));
  const store = new LocalStore(join(root, "data"));
  resources.push({ root, store });
  const path = join(root, "entry");
  const registration: StartupRegistration = {
    supported: true, path,
    installed: () => existsSync(path),
    install: vi.fn(async () => { writeFileSync(path, "registered"); }),
    remove: vi.fn(async () => { rmSync(path, { force: true }); }),
  };
  return { root, store, registration, startup: new LoginStartup(store, registration) };
}
it("enables the first-run default once and preserves disabled or externally removed registrations", async () => {
  const { startup, registration, store } = fixture();
  await Promise.all([startup.initialize(), startup.initialize()]);
  expect(startup.status()).toMatchObject({ enabled: true, supported: true, version: 1 });
  expect(registration.install).toHaveBeenCalledOnce();
  await registration.remove();
  await startup.initialize();
  expect(startup.status().enabled).toBe(false);
  expect(registration.install).toHaveBeenCalledOnce();
  await startup.save({ enabled: false, version: 1 });
  await new LoginStartup(store, registration).initialize();
  expect(startup.status()).toMatchObject({ enabled: false, supported: true, version: 2 });
  expect(registration.install).toHaveBeenCalledOnce();
});
it("keeps failed first-run registration disabled and allows an explicit retry", async () => {
  const { startup, registration } = fixture();
  vi.mocked(registration.install).mockRejectedValueOnce(new Error("permission denied"));
  await expect(startup.initialize()).resolves.toMatchObject({ enabled: false, supported: true, version: 1, error: "permission denied" });
  expect(() => startup.assertCloudMode({ cloud: { mode: "automatic" } })).toThrow();
  await startup.initialize();
  expect(registration.install).toHaveBeenCalledOnce();
  await startup.save({ enabled: true, version: 1 });
  expect(startup.status()).toMatchObject({ enabled: true, supported: true, version: 2 });
});
it("does not install a first-run entry on unsupported systems", async () => {
  const { startup, registration, store } = fixture();
  registration.supported = false;
  await expect(startup.initialize()).resolves.toMatchObject({ enabled: false, supported: false, version: 0 });
  expect(registration.install).not.toHaveBeenCalled();
  expect(store.get("login-startup", null)).toBeNull();
});
it("keeps status reads inert, verifies registration, rejects stale saves and pauses all directories on disable", async () => {
  const { startup, registration, store, root } = fixture();
  const schedule = store.schedule();
  expect(startup.status()).toMatchObject({ enabled: false, supported: true, version: 0 });
  expect(registration.install).not.toHaveBeenCalled();
  expect(() => startup.assertCloudMode({ cloud: { mode: "automatic" } })).toThrow(/Start automatically/);
  await startup.save({ enabled: true, version: 0 });
  expect(startup.status().enabled).toBe(true);
  for (const name of ["first", "second"]) {
    const path = join(root, name);
    mkdirSync(path);
    store.saveWorkspace({ path, cloud: { enabled: true, mode: "automatic", interval: 15 } });
  }
  await expect(startup.save({ enabled: false, version: 0 })).rejects.toMatchObject({ status: 409 });
  expect(registration.remove).not.toHaveBeenCalled();
  rmdirSync(join(root, "second"));
  await startup.save({ enabled: false, version: 1 });
  expect(startup.status().enabled).toBe(false);
  expect(store.workspaces().map(w => w.cloud.mode)).toEqual(["manual", "manual"]);
  expect(store.workspaces().every(w => w.version === 2 && w.cloud.enabled)).toBe(true);
  expect(store.schedule()).toEqual(schedule);
});
it("does not save successful consent after an OS registration failure", async () => {
  const { startup, registration, store } = fixture();
  vi.mocked(registration.install).mockRejectedValue(new Error("permission denied"));
  await expect(startup.save({ enabled: true, version: 0 })).rejects.toThrow("permission denied");
  expect(startup.status()).toMatchObject({ enabled: false, version: 0 });
  expect(store.get("login-startup", null)).toBeNull();
});
it("serializes competing changes and detects a removed OS entry", async () => {
  const { startup, registration } = fixture();
  const outcomes = await Promise.allSettled([
    startup.save({ enabled: true, version: 0 }), startup.save({ enabled: false, version: 0 }),
  ]);
  expect(outcomes.map(r => r.status)).toEqual(["fulfilled", "rejected"]);
  await registration.remove();
  expect(startup.status().enabled).toBe(false);
  expect(() => startup.assertCloudMode({ cloud: { mode: "automatic" } })).toThrow(/Start automatically/);
});
it.each(["darwin", "linux"] as const)("writes a quiet, directory-specific %s login entry without registering on construction", async platform => {
  const { root } = fixture();
  const data = join(root, "a space & 中文's data");
  const entry = join(root, "cli.js");
  writeFileSync(entry, "");
  const registration = new UserLoginRegistration(data, { platform, home: root, configHome: join(root, "config"), entry });
  expect(registration.installed()).toBe(false);
  await registration.install();
  expect(registration.installed()).toBe(true);
  const source = readFileSync(registration.path, "utf8");
  expect(source).not.toContain("--browser");
  if (platform === "darwin") expect(source).toContain("&amp;");
  else expect(source).toContain("Terminal=false");
  const launcher = readFileSync(join(data, "startup", "start.cjs"), "utf8");
  expect(launcher).toContain('"daemon", "start", "--on-login"');
  expect(launcher).toContain("ADIT_LOCAL_DATA_DIR");
  expect(launcher).not.toContain("ADIT_AUTH_TOKEN");
  await registration.remove();
  expect(registration.installed()).toBe(false);
});
it("registers a current-user direct Node task and removes legacy shortcuts only after verification", async () => {
  const { root } = fixture();
  const entry = join(root, "cli.js"); writeFileSync(entry, "");
  let state: "missing" | "registered" = "missing";
  vi.mocked(windowsLoginTaskState).mockImplementation(() => state);
  const calls: string[][] = [];
  vi.mocked(execFile).mockImplementation(((file: string, args: string[], options: unknown, done: (error: Error | null, stdout: string, stderr: string) => void) => {
    calls.push(args);
    if (args.join(" ").includes("RegisterTaskDefinition")) state = "registered";
    if (args.join(" ").includes("DeleteTask")) state = "missing";
    done(null, "enabled", "");
  }) as typeof execFile);
  const registration = new UserLoginRegistration(join(root, "用户's data"), { platform: "win32", appData: root, entry });
  expect(registration.installed()).toBe(false);
  await registration.install();
  expect(registration.path).toMatch(/^windows-task:ai.varve.adit./);
  expect(registration.installed()).toBe(true);
  const script = calls[0].join(" ");
  expect(script).not.toContain("EncodedCommand");
  expect(script).toContain("$t.Principal.LogonType=3");
  expect(script).toContain("$t.Principal.RunLevel=0");
  expect(script).toContain("$action.Path=");
  expect(script).toContain("start.cjs");
  await registration.remove();
  expect(registration.installed()).toBe(false);
});
it("migrates only enabled, existing legacy entries and keeps the old entry if registration fails", async () => {
  const {root}=fixture(),entry=join(root,"cli.js");writeFileSync(entry,"");
  let state:"missing"|"registered"="missing",allowed=false,fail=false;
  vi.mocked(windowsLoginTaskState).mockImplementation(()=>state);
  vi.mocked(execFile).mockImplementation(((_file:string,args:string[],_options:unknown,done:(error:Error|null,stdout:string,stderr:string)=>void)=>{
    const script=args.join(" ");
    if(script.includes("RegisterTaskDefinition")){
      if(fail){done(new Error("registration denied"),"","");return;}
      state="registered";
    }
    done(null,allowed?"enabled":"disabled","");
  }) as typeof execFile);
  const reg=new UserLoginRegistration(join(root,"data"),{platform:"win32",appData:root,entry});
  const name=reg.path.slice("windows-task:".length);
  const legacy=join(root,"Microsoft","Windows","Start Menu","Programs","Startup",name+".lnk");
  expect(await reg.migrateLegacy()).toBe(false);
  mkdirSync(join(root,"Microsoft","Windows","Start Menu","Programs","Startup"),{recursive:true});writeFileSync(legacy,"old-entry");
  expect(await reg.migrateLegacy()).toBe(false);expect(existsSync(legacy)).toBe(true);
  allowed=true;fail=true;
  await expect(reg.migrateLegacy()).rejects.toThrow("registration denied");expect(existsSync(legacy)).toBe(true);
  fail=false;expect(await reg.migrateLegacy()).toBe(true);expect(existsSync(legacy)).toBe(false);expect(reg.installed()).toBe(true);
});
it("preserves requested consent when a registration is missing or disabled and supports repair", async () => {
  const {startup,registration} = fixture();
  await startup.save({enabled:true,version:0});
  await registration.remove();
  expect(startup.status()).toMatchObject({requestedEnabled:true,enabled:false,registrationState:"missing"});
  registration.state=()=>"disabled";
  expect(startup.status()).toMatchObject({requestedEnabled:true,enabled:false,registrationState:"disabled"});
  delete registration.state;
  await startup.save({enabled:true,version:1});
  expect(startup.status()).toMatchObject({requestedEnabled:true,enabled:true,registrationState:"registered"});
});
it("preserves an explicit test-environment update opt-out in the login launcher", async () => {
  const { root } = fixture();
  const entry = join(root, "cli.js");
  writeFileSync(entry, "");
  vi.stubEnv("ADIT_DISABLE_AUTO_UPDATE", "1");
  const data = join(root, "opt-out-data");
  const registration = new UserLoginRegistration(data, { platform: "linux", home: root, configHome: join(root, "config"), entry });
  await registration.install();
  expect(readFileSync(join(data, "startup", "start.cjs"), "utf8")).toContain('process.env.ADIT_DISABLE_AUTO_UPDATE = "1";');
});
