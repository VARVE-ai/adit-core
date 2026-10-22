import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LocalStateError } from "@varveai/adit-core";

export class LocalSecrets {
  constructor(private directory: string) {}
  private path(id: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(id))
      throw new LocalStateError("Invalid workspace identity");
    return join(this.directory, "secrets", `${id}.${process.platform === "win32" ? "dpapi" : "keychain"}`);
  }
  private account(id: string) { this.path(id); return `${createHash("sha256").update(this.directory).digest("hex").slice(0, 16)}:${id}`; }
  private systemSecret(id: string, action: "read" | "save", value?: string): Promise<string> {
    if (!["darwin", "linux"].includes(process.platform)) throw new LocalStateError("Secure credential storage is not available on this platform yet", 503);
    const account = this.account(id), mac = process.platform === "darwin";
    const args = mac ? (action === "read" ? ["find-generic-password", "-s", "adit.local.gist", "-a", account, "-w"] : ["-i"])
      : action === "read" ? ["lookup", "service", "adit.local.gist", "account", account] : ["store", "--label=ADIT local Gist", "service", "adit.local.gist", "account", account];
    return new Promise((resolve, reject) => {
      const child = spawn(mac ? "security" : "secret-tool", args, { windowsHide: true, timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
      let output = ""; child.stdout.on("data", chunk => { if (output.length < 8192) output += chunk; }); child.stderr.resume();
      child.once("error", () => reject(new LocalStateError("System keychain is unavailable", 503)));
      child.once("close", code => code === 0 ? resolve(output.trim()) : reject(new LocalStateError("Unable to access the system keychain", 503)));
      child.stdin.on("error", () => {});
      child.stdin.end(action === "save" ? mac ? `add-generic-password -U -s adit.local.gist -a ${account} -w "${value!.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n` : value : "");
    });
  }
  configured(id: string): boolean {
    return existsSync(this.path(id));
  }
  clear(id: string): void {
    if (process.platform !== "win32" && this.configured(id)) {
      const account = this.account(id), mac = process.platform === "darwin";
      const result = spawnSync(mac ? "security" : "secret-tool", mac ? ["delete-generic-password", "-s", "adit.local.gist", "-a", account] : ["clear", "service", "adit.local.gist", "account", account], { windowsHide: true, stdio: "ignore", timeout: 10000 });
      if (result.error || result.status !== 0) throw new LocalStateError("Unable to clear the system keychain credential", 503);
    }
    rmSync(this.path(id), { force: true });
  }
  async read(id: string): Promise<string> {
    if (!this.configured(id)) throw new LocalStateError("Configure a GitHub Gist token for this workspace first", 409);
    if (process.platform !== "win32") { const value = await this.systemSecret(id, "read"); if (!value) throw new LocalStateError("The saved Gist credential is unavailable", 503); return value; }
    const encrypted = readFileSync(this.path(id), "utf8");
    return new Promise<string>((resolve, reject) => {
      const script = "Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))";
      const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15000, stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      p.stdout.on("data", chunk => { output += chunk; });
      p.stderr.resume();
      p.on("error", () => reject(new LocalStateError("Secure storage unavailable", 503)));
      p.on("close", code => code === 0 && output.trim() ? resolve(output.trim()) : reject(new LocalStateError("Unable to unlock the saved Gist credential", 503)));
      p.stdin.on("error", () => {}); p.stdin.end(encrypted);
    });
  }
  async save(id: string, token: string): Promise<void> {
    if (!token.trim() || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token.trim()))
      throw new LocalStateError("Invalid credential");
    if (process.platform !== "win32") {
      await this.systemSecret(id, "save", token.trim());
      const saved = await this.systemSecret(id, "read");
      if (saved !== token.trim()) throw new LocalStateError("System keychain could not verify the saved credential", 503);
      mkdirSync(join(this.directory, "secrets"), { recursive: true });
      writeFileSync(this.path(id), "system-keychain", { mode: 0o600 }); return;
    }
    const encrypted = await new Promise<string>((resolve, reject) => {
      const script =
        "Add-Type -AssemblyName System.Security; $bytes=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))";
      const p = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: 15000, stdio: ["pipe", "pipe", "pipe"] },
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
      p.stdin.on("error", () => {}); p.stdin.end(token.trim());
    });
    mkdirSync(join(this.directory, "secrets"), { recursive: true });
    writeFileSync(this.path(id), encrypted, { mode: 0o600 });
  }
}
