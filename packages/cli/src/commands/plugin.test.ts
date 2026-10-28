import { it, expect, vi, afterEach } from "vitest";
import { pluginInstallCommand, pluginUninstallCommand } from "./plugin.js";
afterEach(()=>{vi.restoreAllMocks();process.exitCode=0;});
it("rejects old installation and recursive clean options with actionable replacements",async()=>{
 const error=vi.spyOn(console,"error").mockImplementation(()=>{});
 await pluginInstallCommand("codex");expect(error).toHaveBeenLastCalledWith(expect.stringContaining("retired"));
 await pluginUninstallCommand(undefined,{clean:true});expect(error).toHaveBeenLastCalledWith(expect.stringContaining("adit uninstall"));expect(process.exitCode).toBe(1);
});
