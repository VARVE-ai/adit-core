import { Box, Text, render } from "ink";
import { emitKeypressEvents, type Key } from "node:readline";
import { createInterface } from "node:readline/promises";

export interface InitChoice {
  id: string;
  label: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
}
export class InitCancelled extends Error {}
export function canPromptForInit(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function question(prompt: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const abort = new AbortController();
  terminal.on("SIGINT", () => abort.abort());
  terminal.on("close", () => abort.abort());
  try { return await terminal.question(prompt, { signal: abort.signal }); }
  catch (error) { if (abort.signal.aborted) throw new InitCancelled(); throw error; }
  finally { terminal.close(); }
}

export async function confirmInit(): Promise<boolean> {
  for (;;) {
    const answer = (await question("Start organizing? [Y/n] ")).trim().toLowerCase();
    if (!answer || answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    console.log("Enter y to start or n to cancel.");
  }
}

export async function selectInitChoices(title: string, choices: InitChoice[]): Promise<string[]> {
  if (!choices.length) { console.log(`${title}: none available`); return []; }
  if (process.env.ADIT_PLAIN_PROMPTS || typeof process.stdin.setRawMode !== "function") {
    console.log(title);
    choices.forEach((c, i) => console.log(`  ${i + 1}. [${c.checked ? "✓" : " "}] ${c.label} · ${c.detail}`));
    for (;;) {
      const answer = (await question("Numbers separated by commas; enter keeps selection; none clears; q cancels: ")).trim();
      if (answer.toLowerCase() === "q") throw new InitCancelled();
      if (!answer) return choices.filter(c => c.checked).map(c => c.id);
      if (answer.toLowerCase() === "none") return [];
      if (!/^\d+(?:\s*,\s*\d+)*$/.test(answer)) { console.log("Enter valid choice numbers."); continue; }
      const selected = [...new Set(answer.split(",").map(n => Number(n.trim()) - 1))];
      if (selected.some(i => !choices[i] || choices[i].disabled && !choices[i].checked)) { console.log("Choose an available source."); continue; }
      return selected.map(i => choices[i].id);
    }
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw, wasPaused = stdin.isPaused();
    const checked = new Set(choices.filter(c => c.checked).map(c => c.id));
    let cursor = 0, finished = false;
    const view = () => {
      const size = Math.max(3, Math.min(10, (process.stdout.rows || 24) - 7));
      const start = Math.max(0, Math.min(cursor - Math.floor(size / 2), choices.length - size));
      return <Box flexDirection="column">
        <Text bold>{title}</Text>
        <Text dimColor>  ↑/↓ move · space toggle · enter continue · esc cancel</Text>
        {choices.slice(start, start + size).map((c, i) => <Box key={c.id}>
          <Text color="cyan">{start + i === cursor ? " > " : "   "}</Text>
          <Text color={checked.has(c.id) ? "green" : undefined} dimColor={c.disabled}>[{checked.has(c.id) ? "✓" : " "}] </Text>
          <Text wrap="truncate-end" dimColor={c.disabled}>{c.label} · {c.detail}</Text>
        </Box>)}
        <Text dimColor>  {checked.size} selected · {cursor + 1}/{choices.length}</Text>
      </Box>;
    };
    const app = render(view(), { exitOnCtrlC: false, patchConsole: false });
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      stdin.off("keypress", onKey);
      stdin.off("end", onEnd);
      try { stdin.setRawMode(!!wasRaw); } catch { /* Terminal may have closed. */ }
      if (wasPaused) stdin.pause();
      app.clear(); app.unmount();
      if (error) reject(error);
      else resolve(choices.filter(c => checked.has(c.id)).map(c => c.id));
    };
    const onEnd = () => finish(new InitCancelled());
    const onKey = (value: string, key: Key) => {
      if (key.name === "escape" || key.ctrl && key.name === "c") { finish(new InitCancelled()); return; }
      if (key.name === "up") cursor = (cursor + choices.length - 1) % choices.length;
      else if (key.name === "down") cursor = (cursor + 1) % choices.length;
      else if (key.name === "return" || key.name === "enter") { finish(); return; }
      else if (value === " " && !choices[cursor].disabled) {
        const id = choices[cursor].id;
        if (checked.has(id)) checked.delete(id); else checked.add(id);
      }
      app.rerender(view());
    };
    try {
      emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.on("keypress", onKey);
      stdin.once("end", onEnd);
      stdin.resume();
    } catch (error) { finish(error instanceof Error ? error : new Error("Unable to open terminal selection")); }
  });
}
