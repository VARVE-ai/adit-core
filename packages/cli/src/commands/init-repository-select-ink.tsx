/** Ink checkbox widget for selecting Workspace repositories during adit init. */

import React from "react";
import { Box, Text, render } from "ink";
import {
  describeRepositoryChoice,
  type RepositorySyncChoice,
} from "./init-repository-select-model.js";

interface RepositoryListProps {
  choices: RepositorySyncChoice[];
  cursor: number;
  checked: ReadonlySet<string>;
}

function RepositoryList({
  choices,
  cursor,
  checked,
}: RepositoryListProps): React.ReactElement {
  const labelWidth = Math.max(18, ...choices.map((choice) => choice.relativePath.length + 2));

  return (
    <Box flexDirection="column">
      <Text dimColor>  ↑/↓ move · space toggle · enter apply · esc keep as shown</Text>
      {choices.map((choice, index) => {
        const active = index === cursor;
        const isChecked = checked.has(choice.relativePath);
        const state = describeRepositoryChoice(choice, isChecked);
        return (
          <Box key={choice.relativePath}>
            <Text color="cyan">{active ? "  ❯ " : "    "}</Text>
            <Text color={isChecked ? "green" : undefined} dimColor={!isChecked}>
              {isChecked ? "[✓]" : "[ ]"}
            </Text>
            <Text>{" " + choice.relativePath.padEnd(labelWidth)}</Text>
            <Text
              color={choice.cloudDeleted ? (isChecked ? "green" : "yellow") : undefined}
              dimColor={!choice.cloudDeleted}
            >
              {state}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

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

export async function runInkRepositorySelect(
  choices: RepositorySyncChoice[],
): Promise<Set<string>> {
  const preChecked = new Set(
    choices.filter((choice) => choice.preChecked).map((choice) => choice.relativePath),
  );

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let cursor = 0;
    const checked = new Set(preChecked);
    const view = (): React.ReactElement => (
      <RepositoryList choices={choices} cursor={cursor} checked={checked} />
    );

    let app: ReturnType<typeof render>;
    try {
      app = render(view());
    } catch (error) {
      reject(error);
      return;
    }

    const finish = (selection: Set<string> | null): void => {
      stdin.off("data", onData);
      try {
        stdin.setRawMode(false);
      } catch {
        // Terminal may already be closed.
      }
      stdin.pause();
      try {
        app.clear();
      } catch {
        // The applied result replaces the widget when clearing is unsupported.
      }
      app.unmount();
      if (selection === null) {
        process.exit(130);
      }
      resolve(selection);
    };

    const onData = (buffer: Buffer): void => {
      for (const key of splitKeys(buffer.toString("utf8"))) {
        if (key === "\x03") {
          finish(null);
          return;
        }
        if (key === "\x1b[A") {
          cursor = (cursor + choices.length - 1) % choices.length;
        } else if (key === "\x1b[B") {
          cursor = (cursor + 1) % choices.length;
        } else if (key === " ") {
          const repository = choices[cursor].relativePath;
          if (checked.has(repository)) {
            checked.delete(repository);
          } else {
            checked.add(repository);
          }
        } else if (key === "\r" || key === "\n") {
          finish(new Set(checked));
          return;
        } else if (key === "\x1b") {
          finish(new Set(preChecked));
          return;
        }
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
