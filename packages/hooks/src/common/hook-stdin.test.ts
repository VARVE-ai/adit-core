import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ts from "typescript";
import { openDatabase, writeProjectManifest } from "@varveai/adit-core";
import { parseHookStdin } from "./hook-stdin.js";

describe("Cursor Windows hook input", () => {
  let directory: string;
  let payload: Record<string, unknown>;
  let now: number;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "adit-cursor-stdin-"));
    now = Date.now();
    payload = {
      conversation_id: randomUUID(),
      generation_id: randomUUID(),
      session_id: randomUUID(),
      cursor_version: "3.19.19",
      hook_event_name: "beforeSubmitPrompt",
      workspace_roots: ["D:/项目/中文目录"],
      prompt: "只回复 OK，不修改文件。你好 😀 café 日本語",
    };
  });

  afterEach(() => {
    const relativePath = relative(realpathSync(tmpdir()), realpathSync(directory));
    if (!relativePath.startsWith("adit-cursor-stdin-") || relativePath.includes(sep)) {
      throw new Error("Refusing to remove a directory outside the test workspace");
    }
    rmSync(directory, { recursive: true, force: true });
  });

  function writePayload(value: unknown = payload, timestamp = now): string {
    const path = join(directory, `cursor-hook-payload-123-${timestamp}-${randomUUID().replaceAll("-", "")}.json`);
    writeFileSync(path, JSON.stringify(value), "utf8");
    return path;
  }

  function parse(value: unknown, platform: NodeJS.Platform = "win32"): Record<string, unknown> {
    return parseHookStdin(`\uFEFF${JSON.stringify(value)}`, {
      platform,
      tempDirectory: directory,
      now,
    });
  }

  it("recovers the original Unicode prompt and paths instead of guessing an encoding", () => {
    writePayload();
    const corrupted = { ...payload, prompt: "鍙洖澶?OK", workspace_roots: ["D:/???"] };
    expect(parse(corrupted)).toEqual(payload);
  });

  it("recovers stop payload paths too", () => {
    payload.hook_event_name = "stop";
    payload.transcript_path = "D:/中文目录/transcript.jsonl";
    writePayload();
    expect(parse({ ...payload, transcript_path: "D:/???/transcript.jsonl" })).toEqual(payload);
  });

  it.each(["conversation_id", "generation_id", "hook_event_name", "cursor_version", "session_id"])(
    "does not mix invocations with a different %s",
    (field) => {
      writePayload({ ...payload, [field]: "another-value", prompt: "another conversation" });
      expect(parse(payload)).toEqual(payload);
    },
  );

  it("selects the matching invocation even when another conversation is newer", () => {
    writePayload(payload, now - 1000);
    writePayload({ ...payload, conversation_id: randomUUID(), prompt: "newer conversation" });
    expect(parse({ ...payload, prompt: "corrupted" })).toEqual(payload);
  });

  it("does not guess between multiple matching files", () => {
    writePayload();
    writePayload({ ...payload, prompt: "different text" });
    const received = { ...payload, prompt: "received text" };
    expect(parse(received)).toEqual(received);
  });

  it.each([-60_001, 1000])("ignores a payload with timestamp offset %i", (offset) => {
    writePayload({ ...payload, prompt: "stale or future text" }, now + offset);
    expect(parse(payload)).toEqual(payload);
  });

  it("falls back when the temporary file is unavailable", () => {
    expect(parse(payload)).toEqual(payload);
    expect(parseHookStdin(JSON.stringify(payload), {
      platform: "win32",
      tempDirectory: join(directory, "missing"),
    })).toEqual(payload);
  });

  it("ignores malformed and oversized payload files", () => {
    const malformed = writePayload();
    writeFileSync(malformed, '{"prompt":', "utf8");
    const oversized = writePayload();
    truncateSync(oversized, 8 * 1024 * 1024 + 1);
    expect(parse(payload)).toEqual(payload);
  });

  it("does not scan arbitrary JSON files", () => {
    writeFileSync(join(directory, "payload.json"), JSON.stringify({ ...payload, prompt: "wrong" }));
    expect(parse(payload)).toEqual(payload);
  });

  it("bounds the number of temporary candidates", () => {
    for (let index = 0; index < 65; index++) writePayload({ ...payload, generation_id: randomUUID() });
    writePayload();
    const received = { ...payload, prompt: "received text" };
    expect(parse(received)).toEqual(received);
  });

  it.each(["linux", "darwin"] as const)("leaves %s input unchanged", (platform) => {
    writePayload();
    const received = { ...payload, prompt: "received text" };
    expect(parse(received, platform)).toEqual(received);
  });

  it("leaves other platforms and incomplete Cursor identities unchanged", () => {
    writePayload();
    expect(parse({ session_id: payload.session_id, prompt: "Claude 中文" })).toEqual({
      session_id: payload.session_id,
      prompt: "Claude 中文",
    });
    const incomplete = { ...payload };
    delete incomplete.generation_id;
    expect(parse(incomplete)).toEqual(incomplete);
  });

  it("supports Cursor payloads without the optional session alias", () => {
    delete payload.session_id;
    writePayload();
    expect(parse({ ...payload, prompt: "corrupted" })).toEqual(payload);
  });

  it("recovers when lossy decoding also breaks JSON syntax", () => {
    writePayload();
    const malformed = JSON.stringify({ ...payload, prompt: "broken" }).replace('"prompt":"broken"', '"prompt":"broken');
    expect(parseHookStdin(malformed, { platform: "win32", tempDirectory: directory, now })).toEqual(payload);
  });

  it("still rejects invalid JSON without a uniquely matching original", () => {
    expect(() => parseHookStdin('{"prompt":', { platform: "win32", tempDirectory: directory })).toThrow();
  });

  it.runIf(process.platform === "win32").each(["cursor-default", "cp936"])(
    "preserves Unicode through Windows PowerShell 5.1 (%s)",
    (encoding) => {
      const originalPath = writePayload();
      const modulePath = join(directory, "hook-stdin.mjs");
      writeFileSync(modulePath, ts.transpileModule(
        readFileSync(new URL("./hook-stdin.ts", import.meta.url), "utf8"),
        { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } },
      ).outputText, "utf8");
      const readerPath = join(directory, "reader.mjs");
      writeFileSync(readerPath, `import { readFileSync } from 'node:fs';
import { parseHookStdin } from './hook-stdin.mjs';
const received = readFileSync(0, 'utf8');
console.log(JSON.stringify({ received, parsed: parseHookStdin(received) }));`, "utf8");
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
      const source = encoding === "cursor-default"
        ? `Get-Content -LiteralPath ${quote(originalPath)} -Raw`
        : `[System.Text.Encoding]::GetEncoding(936).GetString([System.IO.File]::ReadAllBytes(${quote(originalPath)}))`;
      const command = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);
$OutputEncoding = [System.Text.Encoding]::UTF8;
${source} | & { $input | & ${quote(process.execPath)} ${quote(readerPath)} }`;
      const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
        env: { ...process.env, TMP: resolve(directory), TEMP: resolve(directory) },
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.parsed).toEqual(payload);
      if (encoding === "cp936") expect(output.received).not.toContain(payload.prompt);
    },
    15_000,
  );

  it.runIf(process.platform === "win32").each(["claude", "cursor"])(
    "records a Unicode turn through the built %s hook and PowerShell 5.1",
    (platform) => {
      const timestamp = new Date().toISOString();
      writeProjectManifest(directory, {
        schemaVersion: 1,
        projectId: randomUUID(),
        projectType: "repo",
        repositories: [{ relativePath: "." }],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const dbPath = join(directory, ".adit", "adit.sqlite");
      openDatabase(dbPath).close();
      const response = "记录成功：中文和 emoji 😀";
      const transcriptPath = join(directory, "中文对话.jsonl");
      writeFileSync(transcriptPath, JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: response }] },
      }) + "\n", "utf8");
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
      const hookPath = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
      const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      for (const [event, command] of [["beforeSubmitPrompt", "prompt-submit"], ["stop", "stop"]]) {
        const originalPath = writePayload({
          ...payload,
          hook_event_name: event,
          transcript_path: event === "stop" ? transcriptPath : null,
          status: "completed",
        });
        const script = `$OutputEncoding = [System.Text.Encoding]::UTF8;
Get-Content -LiteralPath ${quote(originalPath)} -Raw | & { $input | & ${quote(process.execPath)} ${quote(hookPath)} --platform ${platform} --project-root-b64 ${Buffer.from(directory).toString("base64url")} ${command} }`;
        const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
          cwd: directory,
          env: {
            ...process.env,
            TMP: directory,
            TEMP: directory,
            ADIT_DEBUG: "false",
            ADIT_CLOUD_AUTO_SYNC: "false",
            ADIT_CLOUD_ENABLED: "false",
          },
          encoding: "utf8",
          timeout: 12_000,
          windowsHide: true,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
      }
      const db = openDatabase(dbPath);
      try {
        const events = db.prepare("SELECT event_type, prompt_text, response_text FROM events ORDER BY sequence").all();
        expect(events).toEqual([
          { event_type: "prompt_submit", prompt_text: payload.prompt, response_text: null },
          { event_type: "assistant_response", prompt_text: null, response_text: response },
        ]);
      } finally {
        db.close();
      }
    },
    30_000,
  );
});
