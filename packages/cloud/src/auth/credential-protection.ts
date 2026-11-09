import { spawnSync } from "node:child_process";

export type ProtectedKey = { scheme: string; value: string };
function storageFailure(command: string, result: { error?: NodeJS.ErrnoException; status: number | null; signal?: string | null }, operation = "unlock-key"): Error {
  const rawCode = result.error?.code;
  const code = rawCode && /^[A-Z_0-9]+$/.test(rawCode) ? rawCode : result.signal ? "INTERRUPTED" : result.status !== 0 ? "VAULT_COMMAND_FAILED" : "EMPTY_RESULT";
  // Never include child output, input, or raw spawn errors: they may contain keys.
  return Object.assign(new Error(`Unable to access secure Cloud credential storage (${process.platform}, ${operation}, ${command}, ${code}${typeof result.status === "number" ? `, exit ${result.status}` : ""}). Check the current OS user and agent sandbox permissions; no new login is required to diagnose this error.`), { code });
}
function run(command: string, args: string[], input = "", operation = "unlock-key"): string {
  const result = spawnSync(command, args, {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 65536,
  });
  if (result.error || result.status !== 0 || !result.stdout.trim())
    throw storageFailure(command, result, operation);
  return result.stdout.trim();
}

/** Only the database encryption key goes to the OS vault. Tokens stay encrypted in SQLite. */
export function protectCredentialKey(id: string, key: Buffer): ProtectedKey {
  if (process.platform === "win32") {
    const script =
      "Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))";
    return {
      scheme: "dpapi",
      value: run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        key.toString("base64"),
        "protect-key",
      ),
    };
  }
  const value = key.toString("base64");
  if (process.platform === "darwin") {
    // Interactive stdin keeps the key out of process arguments.
    const result = spawnSync("security", ["-i"], {
      input: `add-generic-password -U -s adit.local.cloud -a ${id} -w "${value}"\n`,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    });
    if (result.error || result.status !== 0)
      throw storageFailure("security", result, "store-key");
  } else if (process.platform === "linux") {
    const result = spawnSync(
      "secret-tool",
      [
        "store",
        "--label=ADIT Cloud database key",
        "service",
        "adit.local.cloud",
        "account",
        id,
      ],
      { input: value, encoding: "utf8", windowsHide: true, timeout: 15000 },
    );
    if (result.error || result.status !== 0)
      throw storageFailure("secret-tool", result, "store-key");
  } else
    throw new Error(
      "Secure Cloud credential storage is unavailable on this platform",
    );
  const protectedKey = { scheme: "keychain", value: id };
  if (!unprotectCredentialKey(protectedKey).equals(key))
    throw new Error("Secure Cloud credential storage verification failed");
  return protectedKey;
}

export function unprotectCredentialKey(protectedKey: ProtectedKey): Buffer {
  let value: string;
  if (protectedKey.scheme === "dpapi" && process.platform === "win32") {
    const script =
      "Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))";
    value = run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      protectedKey.value,
    );
  } else if (
    protectedKey.scheme === "keychain" &&
    process.platform === "darwin"
  ) {
    value = run("security", [
      "find-generic-password",
      "-s",
      "adit.local.cloud",
      "-a",
      protectedKey.value,
      "-w",
    ]);
  } else if (
    protectedKey.scheme === "keychain" &&
    process.platform === "linux"
  ) {
    value = run("secret-tool", [
      "lookup",
      "service",
      "adit.local.cloud",
      "account",
      protectedKey.value,
    ]);
  } else
    throw new Error(
      "Unable to unlock secure Cloud credential storage on this platform",
    );
  const key = Buffer.from(value, "base64");
  if (key.length !== 32)
    throw new Error("Invalid Cloud credential encryption key");
  return key;
}
