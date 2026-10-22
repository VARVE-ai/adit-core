import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ skills: vi.fn(), status: vi.fn(), stop: vi.fn(), start: vi.fn() }));
vi.mock("./commands/skills.js", () => ({ installSkillsCommand: mocks.skills }));
vi.mock("./local/daemon.js", () => ({ daemonStatus: mocks.status, stopDaemon: mocks.stop, startDaemon: mocks.start }));
import { completeInstallation } from "./installation.js";
import { CLI_VERSION } from "./version.js";
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console,"log").mockImplementation(() => {});
  vi.spyOn(console,"warn").mockImplementation(() => {});
  if(process.getuid) vi.spyOn(process,"getuid").mockReturnValue(501);
  if(process.geteuid) vi.spyOn(process,"geteuid").mockReturnValue(501);
  mocks.skills.mockReturnValue({ installed: [], unchanged: [], skipped: [], errors: [] });
  mocks.status.mockResolvedValue(null);
  mocks.start.mockResolvedValue({ version: CLI_VERSION, instance: "new", url: "http://127.0.0.1:1234" });
});
afterEach(() => vi.restoreAllMocks());
it("installs Skills before starting a new service", async () => {
  await completeInstallation();
  expect(mocks.stop).not.toHaveBeenCalled();
  expect(mocks.skills.mock.invocationCallOrder[0]).toBeLessThan(mocks.start.mock.invocationCallOrder[0]);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining("setup complete"));
});
it("waits for the old service to stop before starting the new one", async () => {
  mocks.status.mockResolvedValue({ instance: "old" });
  let finish!: () => void;
  mocks.stop.mockImplementation(() => new Promise<void>(resolve => { finish=resolve; }));
  const task=completeInstallation();
  await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());
  expect(mocks.start).not.toHaveBeenCalled();
  finish(); await task;
  expect(mocks.start).toHaveBeenCalledOnce();
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining("restarted"));
});
it("keeps the old service running if Skills cannot be updated", async () => {
  mocks.skills.mockReturnValue({ errors: ["permission denied"] });
  await expect(completeInstallation()).rejects.toThrow("Skill installation is incomplete");
  expect(mocks.status).not.toHaveBeenCalled();
  expect(mocks.stop).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
});
it("does not touch Skills or the running service if the requested version was not installed",async()=>{
  await expect(completeInstallation({expectedVersion:"999.0.0"})).rejects.toThrow("Expected ADIT v999.0.0");
  expect(mocks.skills).not.toHaveBeenCalled();expect(mocks.stop).not.toHaveBeenCalled();expect(mocks.start).not.toHaveBeenCalled();
});
it.each(["stop", "start"] as const)("does not claim success on %s failure", async stage => {
  mocks.status.mockResolvedValue({ instance: "old" });
  mocks[stage].mockRejectedValue(new Error(`${stage} failed`));
  await expect(completeInstallation()).rejects.toThrow(`${stage} failed`);
  expect(console.log).not.toHaveBeenCalled();
  if(stage==="stop")expect(mocks.start).not.toHaveBeenCalled();
});
it.each([{ version: "old-version", instance: "new" }, { version: CLI_VERSION, instance: "old" }])("rejects an old or unexpected running service (%j)", async service => {
  mocks.status.mockResolvedValue({ instance: "old" }); mocks.start.mockResolvedValue(service);
  await expect(completeInstallation()).rejects.toThrow("could not be verified");
  expect(console.log).not.toHaveBeenCalled();
});
it("reports preserved custom Skills instead of claiming every Skill was updated", async () => {
  mocks.skills.mockReturnValue({ errors: [], skipped: ["customized"] });
  await completeInstallation();
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("kept, not updated"));
  expect(vi.mocked(console.log).mock.calls.flat().join("\n")).not.toContain("setup complete");
});
it("does not start a service for workspace dependency installation", async () => {
  await completeInstallation({ skillsOnly: true });
  expect(mocks.skills).toHaveBeenCalledOnce();expect(mocks.start).not.toHaveBeenCalled();
});
it.skipIf(!process.getuid)("does not write Skills or start a daemon in the root account", async () => {
  vi.mocked(process.getuid).mockReturnValue(0);
  await expect(completeInstallation()).rejects.toThrow("regular user account");
  expect(mocks.skills).not.toHaveBeenCalled();expect(mocks.start).not.toHaveBeenCalled();
});
