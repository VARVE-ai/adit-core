/**
 * Shared relay hook POST script for cloud CLI-agent sessions.
 *
 * A minified Node one-liner installed as a hook command: it reads the hook
 * payload from stdin and POSTs it to the local relay hook-server. The
 * endpoint and marker come from argv (Claude bakes them into the command)
 * or from ADIT_CLOUD_CODEX_HOOK_{ENDPOINT,MARKER} env vars (Codex hooks are
 * project-scoped and shared across sessions, so the per-session endpoint
 * must come from the spawned Codex process env — the env names are
 * codex-specific for that reason; the Claude path never reads them).
 *
 * argv CONTRACT: Codex on Windows executes hook commands without a shell and
 * DROPS empty-string positional args, shifting everything after them — argv
 * positions cannot be trusted. The script therefore treats argv[1] as the
 * endpoint only when it looks like a URL, and the builder never emits
 * empty-string placeholder args. (This exact combination — `"" "marker"`
 * collapsing to argv[1]="marker" and `new URL(marker)` throwing into the
 * fail-open catch — silently killed all codex→web sync on Windows.)
 *
 * WARNING: Codex's hook trust hash covers the full command string. Any byte
 * change here invalidates the [hooks.state] approvals users granted inside
 * Codex — Codex then silently skips the hooks until the user re-approves
 * them via /hooks (ADIT never writes that config). The golden test in
 * hook-post-script.test.ts pins the exact output; update it only together
 * with a conscious trust-migration decision.
 */
export const HOOK_POST_SCRIPT = [
  "try{",
  "const a=process.argv[1]===undefined?'':process.argv[1];",
  "const argIsUrl=a.startsWith('http');",
  "const envE=process.env.ADIT_CLOUD_CODEX_HOOK_ENDPOINT===undefined?'':process.env.ADIT_CLOUD_CODEX_HOOK_ENDPOINT;",
  "const e=argIsUrl?a:envE;",
  "if(!e)process.exit(0);",
  "const argQ=process.argv[2]===undefined?'':process.argv[2];",
  "const envQ=process.env.ADIT_CLOUD_CODEX_HOOK_MARKER===undefined?'':process.env.ADIT_CLOUD_CODEX_HOOK_MARKER;",
  "const q=argIsUrl?argQ:(envQ!==''?envQ:a);",
  "let u=new URL(e);",
  "if(q&&!u.search.includes(q)){const s=u.search?'&':'?';u=new URL(u.toString()+s+q)}",
  "const m=u.protocol==='https:'?require('https'):require('http');",
  "let d='';",
  "let done=false;",
  "const finish=()=>{if(done)return;done=true;process.exit(0)};",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data',c=>{d+=c});",
  "process.stdin.on('end',()=>{try{",
  "const r=m.request(u,{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(d)},timeout:3000},res=>{res.resume();res.on('end',finish)});",
  "r.on('timeout',()=>{r.destroy();finish()});",
  "r.on('error',finish);",
  "r.end(d)",
  "}catch{finish()}});",
  "setTimeout(finish,3500).unref();",
  "}catch{process.exit(0)}",
].join("");

/**
 * Build the relay hook command. With an endpoint, both endpoint and marker
 * ride in argv (Claude). Without one, only the marker is appended (Codex —
 * endpoint comes from process env): the marker arg keeps the command
 * identifiable via `includes(marker)` for install dedup and cleanup, and a
 * non-empty arg survives Codex's shell-less Windows spawn (an empty-string
 * placeholder would be dropped and shift argv — see module doc).
 */
export function buildCloudHookCommand(endpoint: string, marker: string): string {
  const args = endpoint
    ? [quoteHookCommandArg(endpoint), quoteHookCommandArg(marker)]
    : [quoteHookCommandArg(marker)];
  return ["node", "-e", quoteHookCommandArg(HOOK_POST_SCRIPT), ...args].join(" ");
}

export function quoteHookCommandArg(value: string): string {
  if (value.includes("\"")) {
    throw new Error("Hook command arguments cannot contain double quotes");
  }
  return `"${value}"`;
}
