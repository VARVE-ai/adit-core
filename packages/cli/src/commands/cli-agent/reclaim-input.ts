export interface ReclaimInputUpdate {
  buffer: string;
  echo: string;
  submittedLines: string[];
  interrupted: boolean;
}

export function normalizeReclaimInput(text: string): string {
  return text
    .replace(/\x1b\[(\d+)(?:;([0-9:]+))?u/g, (_match, rawCode: string, rawModifier: string | undefined) =>
      decodeCsiUCode(Number(rawCode), rawModifier),
    )
    .replace(/\x1b\[(?:I|O)/g, "")
    .replace(/\x1b\[[?=>]?[0-9;:]*[A-Za-z~]/g, "");
}

export function decodeCsiUCode(code: number, rawModifier?: string): string {
  if (code === 99 && isCsiUCtrlModifier(rawModifier)) return "\u0003";
  if (code === 13) return "\n";
  if (code === 9) return "\t";
  if (code === 8 || code === 127) return "\b";
  if (code < 32 || !Number.isFinite(code)) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

export function isCsiUCtrlModifier(rawModifier: string | undefined): boolean {
  if (!rawModifier) return false;
  return rawModifier.split(":").includes("5");
}

export function applyReclaimInput(buffer: string, text: string): ReclaimInputUpdate {
  let next = buffer;
  let echo = "";
  let interrupted = false;
  const submittedLines: string[] = [];
  const normalized = normalizeReclaimInput(text).replace(/\r\n/g, "\n");

  for (const char of normalized) {
    if (char === "\u0003") {
      interrupted = true;
      next = "";
      echo += "^C\r\n";
      break;
    }
    if (char === "\b" || char === "\x7f") {
      if (next.length > 0) {
        next = next.slice(0, -1);
        echo += "\b \b";
      }
      continue;
    }
    if (char === "\r" || char === "\n") {
      submittedLines.push(next);
      next = "";
      echo += "\r\n";
      continue;
    }
    if (char === "\t" || char >= " ") {
      next += char;
      echo += char;
    }
  }

  return { buffer: next, echo, submittedLines, interrupted };
}
