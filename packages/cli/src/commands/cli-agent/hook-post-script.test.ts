import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { HOOK_POST_SCRIPT, buildCloudHookCommand, quoteHookCommandArg } from "./hook-post-script.js";

/**
 * GOLDEN TEST — do not update casually.
 *
 * Codex's hook trust hash covers the full command string. If this output
 * changes by even one byte, every existing [hooks.state] trust entry for the
 * relay hooks flips to "Modified" and Codex silently skips them until the
 * next installCodexHooks run re-trusts. Any intentional change here must be
 * paired with that trust-migration understanding.
 *
 * Last migration 2026-07-08: dropped the empty-string endpoint placeholder
 * (Codex's shell-less Windows spawn swallows empty args, shifting argv and
 * turning `new URL(marker)` into a silent no-op) and switched the script to
 * URL-prefix detection for argv[1].
 */
const GOLDEN_CODEX_RELAY_COMMAND =
  `node -e "try{const a=process.argv[1]===undefined?'':process.argv[1];const argIsUrl=a.startsWith('http');const envE=process.env.ADIT_CLOUD_CODEX_HOOK_ENDPOINT===undefined?'':process.env.ADIT_CLOUD_CODEX_HOOK_ENDPOINT;const e=argIsUrl?a:envE;if(!e)process.exit(0);const argQ=process.argv[2]===undefined?'':process.argv[2];const envQ=process.env.ADIT_CLOUD_CODEX_HOOK_MARKER===undefined?'':process.env.ADIT_CLOUD_CODEX_HOOK_MARKER;const q=argIsUrl?argQ:(envQ!==''?envQ:a);let u=new URL(e);if(q&&!u.search.includes(q)){const s=u.search?'&':'?';u=new URL(u.toString()+s+q)}const m=u.protocol==='https:'?require('https'):require('http');let d='';let done=false;const finish=()=>{if(done)return;done=true;process.exit(0)};process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{d+=c});process.stdin.on('end',()=>{try{const r=m.request(u,{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(d)},timeout:3000},res=>{res.resume();res.on('end',finish)});r.on('timeout',()=>{r.destroy();finish()});r.on('error',finish);r.end(d)}catch{finish()}});setTimeout(finish,3500).unref();}catch{process.exit(0)}" "from=adit-cloud-codex-env"`;

describe("buildCloudHookCommand", () => {
  it("produces the byte-exact codex relay command (trust-hash golden)", () => {
    expect(buildCloudHookCommand("", "from=adit-cloud-codex-env"))
      .toBe(GOLDEN_CODEX_RELAY_COMMAND);
  });

  it("bakes endpoint and marker into argv for the claude relay", () => {
    const command = buildCloudHookCommand("http://127.0.0.1:4567/hook", "from=adit-cloud-cli-4567");
    expect(command).toContain('"http://127.0.0.1:4567/hook" "from=adit-cloud-cli-4567"');
    expect(command.startsWith("node -e ")).toBe(true);
  });

  it("keeps the marker in the endpoint-less command for entry identification", () => {
    // installCodexHooks dedup/cleanup finds adit entries via includes(marker).
    expect(buildCloudHookCommand("", "from=adit-cloud-codex-env"))
      .toContain("from=adit-cloud-codex-env");
  });

  it("never emits empty-string positional args", () => {
    // Codex's shell-less Windows spawn drops empty args and shifts argv —
    // a `""` placeholder turned the marker into the endpoint and silently
    // killed all codex→web sync on Windows.
    expect(buildCloudHookCommand("", "from=adit-cloud-codex-env")).not.toContain('""');
  });
});

describe("quoteHookCommandArg", () => {
  it("wraps values in double quotes", () => {
    expect(quoteHookCommandArg("abc")).toBe('"abc"');
  });

  it("rejects values containing double quotes", () => {
    expect(() => quoteHookCommandArg('a"b')).toThrow(/double quotes/);
  });
});

interface CapturedRequest {
  url: string;
  body: string;
}

/** Run HOOK_POST_SCRIPT as a real child process against a live HTTP server. */
async function runHookScript(input: {
  args?: string[];
  env?: Record<string, string>;
  withServer?: (endpoint: string) => { args?: string[]; env?: Record<string, string> };
  payload: string;
}): Promise<{ requests: CapturedRequest[]; exitCode: number | null }> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ url: request.url ?? "", body });
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${port}/hook`;

  const extra = input.withServer?.(endpoint) ?? {};
  const args = [...(input.args ?? []), ...(extra.args ?? [])];
  const env = { ...process.env, ...input.env, ...extra.env };

  const child = spawn(process.execPath, ["-e", HOOK_POST_SCRIPT, ...args], { env });
  child.stdin.end(input.payload);
  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 8_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { requests, exitCode };
}

describe("HOOK_POST_SCRIPT", () => {
  it("posts via env endpoint with the marker as the only positional arg (codex shape)", async () => {
    // Exactly what the codex hook process sees on Windows: no shell parsing,
    // argv[1] is the marker, endpoint/marker ride in the process env.
    const { requests, exitCode } = await runHookScript({
      args: ["from=adit-cloud-codex-env"],
      withServer: (endpoint) => ({
        env: {
          ADIT_CLOUD_CODEX_HOOK_ENDPOINT: endpoint,
          ADIT_CLOUD_CODEX_HOOK_MARKER: "from=adit-cloud-codex-env",
        },
      }),
      payload: '{"hook_event_name":"Stop","session_id":"s1"}',
    });
    expect(exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/hook?from=adit-cloud-codex-env");
    expect(requests[0].body).toBe('{"hook_event_name":"Stop","session_id":"s1"}');
  });

  it("falls back to the argv marker when the marker env var is absent", async () => {
    const { requests } = await runHookScript({
      args: ["from=adit-cloud-codex-env"],
      withServer: (endpoint) => ({
        env: { ADIT_CLOUD_CODEX_HOOK_ENDPOINT: endpoint },
      }),
      payload: "{}",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/hook?from=adit-cloud-codex-env");
  });

  it("posts via argv endpoint and marker (claude shape)", async () => {
    const { requests, exitCode } = await runHookScript({
      withServer: (endpoint) => ({
        args: [endpoint, "from=adit-cloud-cli-4567"],
      }),
      payload: '{"hook_event_name":"Stop"}',
    });
    expect(exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/hook?from=adit-cloud-cli-4567");
  });

  it("exits silently without an endpoint", async () => {
    const { requests, exitCode } = await runHookScript({
      args: ["from=adit-cloud-codex-env"],
      env: { ADIT_CLOUD_CODEX_HOOK_ENDPOINT: "", ADIT_CLOUD_CODEX_HOOK_MARKER: "" },
      payload: "{}",
    });
    expect(exitCode).toBe(0);
    expect(requests).toHaveLength(0);
  });
});
