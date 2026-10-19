import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LocalStateError } from "@varveai/adit-core";

export class LocalSecrets {
  constructor(private directory: string) {}
  private path(id: string) {
    if (!/^p_[a-f0-9-]+$/.test(id))
      throw new LocalStateError("Invalid workspace identity");
    return join(this.directory, "secrets", `${id}.dpapi`);
  }
  configured(id: string): boolean {
    return existsSync(this.path(id));
  }
  clear(id: string): void {
    rmSync(this.path(id), { force: true });
  }
  async save(id: string, token: string): Promise<void> {
    if (!token.trim() || token.length > 4096)
      throw new LocalStateError("Invalid credential");
    if (process.platform !== "win32")
      throw new LocalStateError(
        "Secure credential storage is not available on this platform yet",
        503,
      );
    const encrypted = await new Promise<string>((resolve, reject) => {
      const script =
        "Add-Type -AssemblyName System.Security; $bytes=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))";
      const p = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      let result = "";
      p.stdout.on("data", (chunk) => {
        result += chunk;
      });
      p.stderr.resume();
      p.on("error", () => reject(new Error("Secure storage unavailable")));
      p.on("close", (code) =>
        code === 0 && result.trim()
          ? resolve(result.trim())
          : reject(new Error("Secure storage failed")),
      );
      p.stdin.end(token.trim());
    });
    mkdirSync(join(this.directory, "secrets"), { recursive: true });
    writeFileSync(this.path(id), encrypted, { mode: 0o600 });
  }
}
