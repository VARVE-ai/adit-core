/** Static parsing only: logged commands and scripts are never executed. */
export const normalizeLine = (line: string) => line.trim().replace(/\s+/g, " ");
export const eligibleLine = (line: string) =>
  normalizeLine(line).replace(/[\s{}()[\],;]+/g, "").length >= 8;
export type WrittenText = { kind: string; path: string | null; text: string };
type Literal = { start: number; end: number; text: string };
export function decodeEscapes(value: string): string {
  return value.replace(
    /\\(u\{[0-9a-f]+\}|u[0-9a-f]{4}|x[0-9a-f]{2}|[nrtbfv\\'"`]|\r?\n)/gi,
    (all, key: string) => {
      if (key.startsWith("u{")) {
        const n = parseInt(key.slice(2, -1), 16);
        return n <= 0x10ffff ? String.fromCodePoint(n) : all;
      }
      if (key[0] === "u" || key[0] === "x")
        return String.fromCharCode(parseInt(key.slice(1), 16));
      return (
        (
          {
            n: "\n",
            r: "\r",
            t: "\t",
            b: "\b",
            f: "\f",
            v: "\v",
            "\\": "\\",
            "'": "'",
            '"': '"',
            "`": "`",
            "\n": "",
            "\r\n": "",
          } as Record<string, string>
        )[key] ?? all
      );
    },
  );
}
export function literals(source: string): Literal[] {
  const result: Literal[] = [];
  for (let i = 0; i < source.length; i++) {
    const quote = source[i];
    if (!['"', "'", "`"].includes(quote)) continue;
    if (source[i - 1] === "@" && /^\r?\n/.test(source.slice(i + 1))) {
      const end = source.indexOf("\n" + quote + "@", i + 1);
      if (end !== -1) {
        const raw = source.slice(i + 1, end).replace(/^\r?\n/, "");
        result.push({
          start: i - 1,
          end: end + 3,
          text:
            quote === "'"
              ? raw
              : raw
                  .replace(/`n/g, "\n")
                  .replace(/`r/g, "\r")
                  .replace(/`t/g, "\t"),
        });
        i = end + 2;
        continue;
      }
    }
    const start = i,
      triple = source.slice(i, i + 3) === quote.repeat(3),
      delimiter = triple ? quote.repeat(3) : quote;
    i += delimiter.length;
    const body = i;
    while (i < source.length) {
      if (source[i] === "\\") {
        i += 2;
        continue;
      }
      if (source.startsWith(delimiter, i)) break;
      i++;
    }
    if (i >= source.length) break;
    const raw = source.slice(body, i),
      prefix = source.slice(Math.max(0, start - 2), start);
    result.push({
      start,
      end: i + delimiter.length,
      text: /\br$/i.test(prefix) ? raw : decodeEscapes(raw),
    });
    i += delimiter.length - 1;
  }
  return result;
}
function patchTexts(source: string): WrittenText[] {
  const result: WrittenText[] = [];
  let path: string | null = null,
    lines: string[] = [];
  const flush = () => {
    if (lines.length)
      result.push({ kind: "patch", path, text: lines.join("\n") });
    lines = [];
  };
  for (const line of source.split(/\r?\n/)) {
    const file =
      /^\*\*\* (?:Add|Update) File: (.+)$/.exec(line) ||
      /^\+\+\+ b\/(.+)$/.exec(line);
    if (file) {
      flush();
      path = file[1];
    } else if (/^\*\*\* (?:Delete File|End Patch)|^diff --git/.test(line)) {
      flush();
      path = null;
    } else if (line.startsWith("+") && !line.startsWith("+++"))
      lines.push(line.slice(1));
  }
  flush();
  return result;
}
export function extractWritten(
  tool: string,
  input: unknown,
  command?: string | null,
): WrittenText[] {
  let value: any = input;
  if (typeof value === "string")
    try {
      value = JSON.parse(value);
    } catch {}
  const result: WrittenText[] = [];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const path = value.file_path ?? value.path ?? null;
    if (/edit|write/i.test(tool)) {
      const edits = Array.isArray(value.edits) ? value.edits : [value];
      for (const edit of edits) {
        const text =
          edit.new_string ??
          edit.new_str ??
          edit.newText ??
          edit.new_text ??
          edit.new_content ??
          edit.content;
        if (typeof text === "string")
          result.push({ kind: "native_write", path, text });
      }
      return result;
    }
    if (/patch/i.test(tool)) {
      const text = value.patch ?? value.input ?? value.patch_text;
      if (typeof text === "string") return patchTexts(text);
    }
  }
  const script =
    command ||
    (typeof value === "string"
      ? value
      : (value?.code ?? value?.script ?? value?.command ?? value?.cmd ?? ""));
  if (typeof script !== "string" || !script) return result;
  if (/patch/i.test(tool) && script.includes("*** Begin Patch"))
    return patchTexts(script);
  if (
    // String replacement, reads, HTTP headers and temporary diagnostic bodies
    // are not writes. Require an explicit file-writing API or shell operation.
    !/\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|write_text|write_bytes|WriteAllText|WriteAllLines|WriteAllBytes|AppendAllText)\s*\(|\bapply_patch\b|\b(?:set-content|add-content|out-file)\b|\b(?:cat|printf|echo)[^\n]*>|\bopen\([^\n]*["'](?:w|a)[+b]?["']/i.test(
      script,
    )
  )
    return result;
  const collect = (source: string, depth: number) => {
    if (depth > 3) return;
    if (source.includes("*** Begin Patch")) {
      const patch = source.slice(source.indexOf("*** Begin Patch"));
      if (/^\*\*\* Begin Patch\r?\n/.test(patch))
        result.push(...patchTexts(patch));
      else
        for (const literal of literals(source))
          if (literal.text.includes("*** Begin Patch"))
            collect(literal.text, depth + 1);
      return;
    }
    const strings = literals(source);
    const excluded = new Set<number>();
    const replacedNames = new Set(
      [
        ...source.matchAll(/\.(?:replace|replaceAll)\(\s*([a-zA-Z_]\w*)\s*,/g),
      ].map((m) => m[1]),
    );
    for (const [i, item] of strings.entries()) {
      const before = source.slice(Math.max(0, item.start - 100), item.start);
      const assignment = /\b([a-zA-Z_]\w*)\s*=\s*(?:[rbuf]{1,2})?$/i.exec(
        before,
      );
      if (assignment && replacedNames.has(assignment[1])) excluded.add(i);
      if (
        /(?:\b(?:old\w*|search\w*|pattern\w*|file_?path|path|filename)\s*[:=]\s*(?:[rbuf]{1,2})?|\.(?:replace|replaceAll)\(\s*|-replace\s*|\b(?:Path|readFileSync|readFile|open)\(\s*|\b(?:rg|grep)\s+)$/i.test(
          before,
        )
      )
        excluded.add(i);
      // A literal that is only a path is not written code.
      if (
        /^(?:[a-z]:[\\/]|\.{0,2}\/|[\w.-]+\/)[^\n]+$/i.test(item.text) &&
        !/[;{}=]/.test(item.text)
      )
        excluded.add(i);
    }
    let scrubbed = source;
    for (let i = strings.length - 1; i >= 0; i--)
      if (excluded.has(i))
        scrubbed =
          scrubbed.slice(0, strings[i].start) +
          "[excluded]" +
          scrubbed.slice(strings[i].end);
    // Keep executable script bodies, excluding reads, search expressions and old replacement values.
    const body = scrubbed
      .split(/\r?\n/)
      .filter(
        (line) =>
          !line.includes("[excluded]") &&
          !/\b(?:rg|grep|readFile|read_text|old\w*\s*=|search\w*\s*=)\b/.test(
            line,
          ),
      );
    result.push({ kind: "script", path: null, text: body.join("\n") });
    for (const [i, item] of strings.entries())
      if (!excluded.has(i) && eligibleLine(item.text)) {
        if (item.text.includes("\\n") || /write|replace|patch/i.test(item.text))
          collect(item.text, depth + 1);
        else
          result.push({ kind: "script_literal", path: null, text: item.text });
      }
    for (const match of source.matchAll(
      /<<-?\s*['"]?(\w+)['"]?\s*\r?\n([\s\S]*?)\r?\n\1\b/g,
    ))
      collect(match[2], depth + 1);
  };
  collect(script, 0);
  return result;
}

export function jsonTextValue(line: string): string | null {
  const match = /^\s*"(?:[^"\\]|\\.)*"\s*:\s*("(?:[^"\\]|\\.)*")\s*,?\s*$/.exec(
    line,
  );
  if (!match) return null;
  try {
    const text = JSON.parse(match[1]);
    return typeof text === "string" && eligibleLine(text)
      ? normalizeLine(text)
      : null;
  } catch {
    return null;
  }
}
export const wordTokens = (text: string) =>
  new Set(text.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || []);
export function tokenOverlap(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection++;
  return intersection / (a.size + b.size - intersection || 1);
}
