import { beforeEach, expect, it, vi } from "vitest";
vi.mock("./daemon.js", () => ({
  startDaemon: vi.fn(async () => ({ url: "http://127.0.0.1:1234" })),
  stopDaemon: vi.fn(), daemonStatus: vi.fn(), serveCommand: vi.fn(),
}));
import { createProgram } from "../main.js";
import { startDaemon, serveCommand } from "./daemon.js";
beforeEach(() => vi.clearAllMocks());
it.each(["sync", "claude", "codex"])("ensures the background service before cloud %s", async name => {
  const program = createProgram();
  const action = vi.fn(() => expect(startDaemon).toHaveBeenCalledOnce());
  program.commands.find(c => c.name() === "cloud")!.commands.find(c => c.name() === name)!.action(action);
  await program.parseAsync(["node", "adit", "cloud", name]);
  expect(action).toHaveBeenCalledOnce();
});
it("keeps status and help read-only, and does not proceed if startup fails", async () => {
  const program = createProgram();
  const cloud = program.commands.find(c => c.name() === "cloud")!;
  cloud.commands.find(c => c.name() === "status")!.action(() => {});
  await program.parseAsync(["node", "adit", "cloud", "status"]);
  expect(startDaemon).not.toHaveBeenCalled();
  const action = vi.fn();
  cloud.commands.find(c => c.name() === "sync")!.action(action);
  vi.mocked(startDaemon).mockRejectedValueOnce(new Error("could not start"));
  await expect(program.parseAsync(["node", "adit", "cloud", "sync"])).rejects.toThrow("could not start");
  expect(action).not.toHaveBeenCalled();
});
it.each(["server", "serve"])("routes %s to the same UI entry", async name => {
  await createProgram().parseAsync(["node", "adit", name, "--no-browser"]);
  expect(serveCommand).toHaveBeenCalledOnce();
});
