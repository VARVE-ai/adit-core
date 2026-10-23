import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupLegacyHooks } from "./legacy-hook-cleanup.js";
let root:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"adit-hook-retirement-"));});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
it("removes only collection entries, preserves mixed user/relay hooks byte-for-byte, and is idempotent",()=>{
 const relay="node -e \"from=adit-cloud-codex-env\"",user="echo user";
 mkdirSync(join(root,".codex"));const file=join(root,".codex","hooks.json");
 writeFileSync(file,JSON.stringify({custom:42,hooks:{Empty:[],UserPromptSubmit:[{matcher:"*",hooks:[{command:"adit-hook prompt-submit"},{command:relay},{command:user}]},{command:"node C:\\app\\hooks\\dist\\index.js stop"}]}}));
 const before=readFileSync(file,"utf8");expect(cleanupLegacyHooks(root,true).changed).toEqual([".codex/hooks.json"]);expect(readFileSync(file,"utf8")).toBe(before);
 expect(cleanupLegacyHooks(root).errors).toEqual([]);const next=JSON.parse(readFileSync(file,"utf8"));
 expect(next).toEqual({custom:42,hooks:{Empty:[],UserPromptSubmit:[{matcher:"*",hooks:[{command:relay},{command:user}]}]}});
 expect(cleanupLegacyHooks(root).changed).toEqual([]);expect(existsSync(join(root,".adit"))).toBe(false);
});
it("reports invalid configuration without overwriting it and removes only the marked OpenCode plugin",()=>{
 mkdirSync(join(root,".claude"));const file=join(root,".claude","settings.json");writeFileSync(file,"{broken");
 mkdirSync(join(root,".opencode","plugins"),{recursive:true});const plugin=join(root,".opencode","plugins","adit.js");writeFileSync(plugin,"// my plugin");
 expect(cleanupLegacyHooks(root).errors[0]).toContain("adit hook uninstall");expect(readFileSync(file,"utf8")).toBe("{broken");expect(existsSync(plugin)).toBe(true);
 writeFileSync(plugin,"// @varveai/adit-auto-generated\nadit-hook stop");cleanupLegacyHooks(root);expect(existsSync(plugin)).toBe(false);
});
