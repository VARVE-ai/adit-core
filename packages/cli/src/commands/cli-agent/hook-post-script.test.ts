import { describe, expect, it } from "vitest";
import { buildCloudHookCommand, quoteHookCommandArg } from "./hook-post-script.js";

/**
 * GOLDEN TEST — do not update casually.
 *
 * Codex's hook trust hash covers the full command string. If this output
 * changes by even one byte, every existing [hooks.state] trust entry for the
 * relay hooks flips to "Modified" and Codex silently skips them until the
 * next installCodexHooks run re-trusts. Any intentional change here must be
 * paired with that trust-migration understanding.
 */
const GOLDEN_CODEX_RELAY_COMMAND =
  `node -e "try{const a=process.argv[1]===undefined?'':process.argv[1];const envE=process.env.ADIT_CLOUD_CODEX_HOOK_ENDPOINT===undefined?'':process.env.ADIT_CLOUD_CODEX_HOOK_ENDPOINT;const e=a!==''?a:envE;if(!e)process.exit(0);const argQ=process.argv[2]===undefined?'':process.argv[2];const envQ=process.env.ADIT_CLOUD_CODEX_HOOK_MARKER===undefined?argQ:process.env.ADIT_CLOUD_CODEX_HOOK_MARKER;const q=a!==''?argQ:envQ;let u=new URL(e);if(q&&!u.search.includes(q)){const s=u.search?'&':'?';u=new URL(u.toString()+s+q)}const m=u.protocol==='https:'?require('https'):require('http');let d='';let done=false;const finish=()=>{if(done)return;done=true;process.exit(0)};process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{d+=c});process.stdin.on('end',()=>{try{const r=m.request(u,{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(d)},timeout:3000},res=>{res.resume();res.on('end',finish)});r.on('timeout',()=>{r.destroy();finish()});r.on('error',finish);r.end(d)}catch{finish()}});setTimeout(finish,3500).unref();}catch{process.exit(0)}" "" "from=adit-cloud-codex-env"`;

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
});

describe("quoteHookCommandArg", () => {
  it("wraps values in double quotes", () => {
    expect(quoteHookCommandArg("abc")).toBe('"abc"');
  });

  it("rejects values containing double quotes", () => {
    expect(() => quoteHookCommandArg('a"b')).toThrow(/double quotes/);
  });
});
