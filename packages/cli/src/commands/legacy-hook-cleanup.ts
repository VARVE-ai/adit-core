import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const collectionCommand = (command: unknown): boolean => typeof command === "string" && /adit-hook|hooks\/dist\/index\.js/.test(command.replaceAll("\\", "/").toLowerCase());
/** Remove only collection commands, including mixed arrays with user/Cloud hooks. */
export function cleanHookEntries(value: any): any {
  if (Array.isArray(value)) return value.flatMap(entry => {
    if (collectionCommand(entry?.command)) return [];
    if (entry && Array.isArray(entry.hooks)) {
      const hooks = cleanHookEntries(entry.hooks);
      return hooks.length || !entry.hooks.length ? [{...entry,hooks}] : [];
    }
    return [entry];
  });
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).flatMap(([key,entries])=>{
    const next=cleanHookEntries(entries);
    return Array.isArray(next)&&!next.length&&Array.isArray(entries)&&entries.length?[]:[[key,next]];
  }));
  return value;
}
export function cleanupLegacyHooks(root: string, dryRun = false) {
  const changed: string[] = [], errors: string[] = [];
  for (const relative of [".claude/settings.json",".claude/settings.local.json",".codex/hooks.json",".cursor/hooks.json",".gemini/settings.json"]) {
    const path=join(root,relative);
    if (!existsSync(path)) continue;
    try {
      const original=readFileSync(path,"utf8");
      const settings=JSON.parse(original.replace(/^\uFEFF/,""));
      if (!settings.hooks) continue;
      const next=cleanHookEntries(settings.hooks);
      if (JSON.stringify(next)===JSON.stringify(settings.hooks)) continue;
      settings.hooks=next;
      if (!Object.keys(next).length) delete settings.hooks;
      if (!dryRun) {
        if(readFileSync(path,"utf8")!==original)throw new Error("Settings changed during cleanup; retry");
        writeFileSync(path,JSON.stringify(settings,null,2)+"\n");
      }
      changed.push(relative);
    } catch(error) {errors.push(`${relative}: ${error instanceof Error?error.message:String(error)}. Fix this file and run adit hook uninstall again.`);}
  }
  const plugin=join(root,".opencode/plugins/adit.js");
  try { if(existsSync(plugin)) {
    const content=readFileSync(plugin,"utf8");
    if(content.includes("@varveai/adit-auto-generated") && collectionCommand(content)) {
      if(!dryRun)unlinkSync(plugin);
      changed.push(".opencode/plugins/adit.js");
    }
  } } catch(error) { errors.push(`${plugin}: ${error instanceof Error?error.message:String(error)}. Remove only the old generated ADIT collection plugin.`); }
  return {changed,errors};
}
