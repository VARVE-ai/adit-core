import { isIP } from "node:net";
import { scanSecretField } from "./secret-detector.js";

export type Redaction = { field: string; rule: string; start: number; end: number; replacement: string };
export const SHARE_POLICY_VERSION = 1;

/** Offsets refer to the original local field. Only the returned text is exportable. */
export class PublicationPrivacy {
  readonly redactions: Redaction[] = [];
  constructor(private identifiers: string[] = [], private names: string[] = []) {}

  text(value: string, field: string): string {
    const spans: Redaction[] = [];
    const add = (start: number, end: number, rule: string, replacement: string) => {
      if (end > start) spans.push({ field, start, end, rule, replacement });
    };
    const matches = (re: RegExp, rule: string, replacement: string, valid?: (text: string) => boolean) => {
      for (const m of value.matchAll(re)) if (!valid || valid(m[0])) add(m.index!, m.index! + m[0].length, rule, replacement);
    };
    for (const m of scanSecretField(value).matches) add(m.start, m.end, "secret", "[redacted]");
    matches(/\b[A-Z]:[\\/](?:[^\s<>"'`|]+(?:[ ][^\s<>"'`|]+)*|)/gi, "path", "[local path]");
    matches(/\/(?:Users|home)\/[\w.@-]+/g, "path", "~");
    matches(/(?:~|\/(?:Users|home)\/[^\s/]+)[\\/](?:\.codex|\.claude|\.local|AppData)(?:[\\/][^\s<>"'`|]*)?/gi, "installation", "[local installation]");
    matches(/\/(?:opt|usr\/local|Applications)\/(?:[^\s<>"'`|]+)/g, "installation", "[local installation]");
    matches(/\b[^\s<>"'`/\\]*(?:rollout-|session-)[^\s<>"'`/\\]*\.(?:jsonl|json|sqlite|db)\b/gi, "identifier", "[session file]");
    matches(/\b(?:call_|toolu_|tooluse_|fc_)[A-Za-z0-9_-]{6,}\b/g, "identifier", "[call id]");
    matches(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "identifier", "[local id]");
    matches(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "email", "[email]");
    matches(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "ip", "[IP address]", text => isIP(text) === 4);
    matches(/(?<![\w:])(?:[\da-f]{0,4}:){2,}[\da-f:.]*(?:%[\w]+)?/gi, "ip", "[IP address]", text => isIP(text.split("%")[0]) === 6);
    for (const [items, rule, replacement] of [[this.identifiers, "identifier", "[local id]"], [this.names, "name", "[name]"]] as const) {
      for (const item of items.filter(v => v.length >= (rule === "name" ? 2 : 3))) {
        let at = 0;
        while ((at = value.indexOf(item, at)) >= 0) { add(at, at + item.length, rule, replacement); at += item.length; }
      }
    }
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: Redaction[] = [];
    for (const span of spans) {
      const last = merged.at(-1);
      if (last && span.start < last.end) {
        if (span.end > last.end) { last.end = span.end; last.replacement = "[redacted]"; }
      } else merged.push({ ...span });
    }
    this.redactions.push(...merged);
    let at = 0, out = "";
    for (const span of merged) { out += value.slice(at, span.start) + span.replacement; at = span.end; }
    return out + value.slice(at);
  }
}

export function isPersonalMemoryWrite(name: string, input: string) {
  return /(?:memory|memories).*(?:write|save|add|update|store)|(?:write|save|add|update|store).*(?:memory|memories)/i.test(name)
    || /(?:tools\.|mcp__)[\w_]*(?:save_memory|create_memory|update_memory|memory_write|memory_save)\b/i.test(input)
    || /\badit\s+(?:cloud\s+)?memor(?:y|ies)\s+(?:add|save|create|update|write)\b/i.test(input)
    || (/write|edit|patch|bash|shell|exec/i.test(name) && /(?:[\\/]memory[\\/]|[\\/]memories[\\/]|\bMEMORY\.md\b)/i.test(input));
}
