/**
 * Ink checkbox widget for the `adit init` platform selection.
 *
 * Arrow keys move, space toggles, Enter confirms, Esc keeps the pre-checked
 * state. Ink is used for rendering only — raw-mode handling and key parsing
 * are managed directly on stdin so keys are processed reliably even when
 * several arrive in one chunk (fast typing, paste, test automation). The
 * pre-check rules, diffing, and the disconnect confirmation live in
 * init-platform-select.ts, shared with the readline fallback.
 */

import React from "react";
import { Box, Text, render } from "ink";
import type { Platform } from "@varveai/adit-core";
import { describeChoice, type PlatformChoice } from "./init-platform-select.js";

interface PlatformListProps {
  choices: PlatformChoice[];
  cursor: number;
  checked: ReadonlySet<Platform>;
  confirmNames: string | null;
}

function PlatformList({ choices, cursor, checked, confirmNames }: PlatformListProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text dimColor>  ↑/↓ move · space toggle · enter apply · esc keep as shown</Text>
      {choices.map((choice, index) => {
        const active = confirmNames === null && index === cursor;
        const isChecked = checked.has(choice.platform);
        const binary = choice.cliBinary ? ` (${choice.cliBinary})` : "";
        const willDisconnect = choice.connected && !isChecked;
        return (
          <Box key={choice.platform}>
            <Text color="cyan">{active ? "  ❯ " : "    "}</Text>
            <Text color={isChecked ? "green" : undefined} dimColor={!isChecked}>
              {isChecked ? "[✓]" : "[ ]"}
            </Text>
            <Text>{` ${`${choice.displayName}${binary}`.padEnd(26)}`}</Text>
            <Text dimColor={!willDisconnect} color={willDisconnect ? "yellow" : undefined}>
              {willDisconnect ? "will disconnect" : describeChoice(choice)}
            </Text>
          </Box>
        );
      })}
      {confirmNames !== null && (
        <Text color="yellow">
          {`  Disconnect ${confirmNames} — their hooks will be removed. y = confirm · n = keep connected`}
        </Text>
      )}
    </Box>
  );
}

/** Whether the terminal can run the ink checkbox UI. */
export function canUseInkSelect(): boolean {
  return Boolean(
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    typeof process.stdin.setRawMode === "function" &&
    !process.env.ADIT_PLAIN_PROMPTS,
  );
}

/** Split a raw stdin chunk into individual key tokens. */
function splitKeys(chunk: string): string[] {
  const keys: string[] = [];
  let index = 0;
  while (index < chunk.length) {
    if (chunk[index] === "\x1b" && chunk[index + 1] === "[" && index + 2 < chunk.length) {
      keys.push(chunk.slice(index, index + 3));
      index += 3;
      continue;
    }
    keys.push(chunk[index]);
    index += 1;
  }
  return keys;
}

/** Run the checkbox UI and resolve with the final checked set. */
export async function runInkPlatformSelect(
  choices: PlatformChoice[],
): Promise<Set<Platform>> {
  const preChecked = new Set(
    choices.filter((choice) => choice.preChecked).map((choice) => choice.platform),
  );

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let cursor = 0;
    let confirming = false;
    const checked = new Set(preChecked);

    const disconnecting = (): PlatformChoice[] =>
      choices.filter((choice) => choice.connected && !checked.has(choice.platform));

    const view = (): React.ReactElement => (
      <PlatformList
        choices={choices}
        cursor={cursor}
        checked={checked}
        confirmNames={
          confirming
            ? disconnecting().map((choice) => choice.displayName).join(", ")
            : null
        }
      />
    );

    let app: ReturnType<typeof render>;
    try {
      app = render(view());
    } catch (error) {
      reject(error);
      return;
    }

    const finish = (selection: Set<Platform> | null): void => {
      stdin.off("data", onData);
      try {
        stdin.setRawMode(false);
      } catch {
        /* terminal already gone */
      }
      stdin.pause();
      // Clear the widget frame — the applied result lines replace it.
      try {
        app.clear();
      } catch {
        /* best effort */
      }
      app.unmount();
      if (selection === null) {
        process.exit(130); // Ctrl+C
      }
      resolve(selection);
    };

    const onSelectKey = (key: string): boolean => {
      if (key === "\x1b[A") {
        cursor = (cursor + choices.length - 1) % choices.length;
      } else if (key === "\x1b[B") {
        cursor = (cursor + 1) % choices.length;
      } else if (key === " ") {
        const platform = choices[cursor].platform;
        if (checked.has(platform)) {
          checked.delete(platform);
        } else {
          checked.add(platform);
        }
      } else if (key === "\r" || key === "\n") {
        // Unchecking a connected platform uninstalls its hooks — confirm
        // in-widget so the whole interaction has a single stdin owner.
        if (disconnecting().length > 0) {
          confirming = true;
        } else {
          finish(new Set(checked));
          return true;
        }
      } else if (key === "\x1b") {
        finish(new Set(preChecked));
        return true;
      }
      return false;
    };

    const onConfirmKey = (key: string): boolean => {
      if (key === "y" || key === "Y") {
        finish(new Set(checked));
        return true;
      }
      if (key === "n" || key === "N" || key === "\x1b") {
        for (const choice of choices) {
          if (choice.connected) checked.add(choice.platform);
        }
        confirming = false;
      }
      return false;
    };

    const onData = (buffer: Buffer): void => {
      for (const key of splitKeys(buffer.toString("utf8"))) {
        if (key === "\x03") {
          finish(null);
          return;
        }
        const finished = confirming ? onConfirmKey(key) : onSelectKey(key);
        if (finished) return;
      }
      app.rerender(view());
    };

    try {
      stdin.setRawMode(true);
    } catch (error) {
      app.unmount();
      reject(error);
      return;
    }
    stdin.resume();
    stdin.on("data", onData);
  });
}
