/**
 * Colored diff output component.
 */

import React from "react";
import { Box, Text } from "ink";

interface DiffViewProps {
  diffText: string | null;
  title?: string;
  maxLines?: number;
}

export function DiffView({
  diffText,
  title,
  maxLines,
}: DiffViewProps): React.ReactElement {
  if (!diffText) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No diff available</Text>
      </Box>
    );
  }

  const allLines = diffText.split("\n");
  // Cap to the viewport: overflowing frames break ink's in-place redraw.
  const cap = maxLines ? Math.max(maxLines - (title ? 2 : 1), 1) : allLines.length;
  const lines = allLines.slice(0, cap);
  const hidden = allLines.length - lines.length;

  return (
    <Box flexDirection="column" paddingX={1}>
      {title && (
        <Text bold>{title}</Text>
      )}
      {lines.map((line, idx) => {
        let color: "green" | "red" | "cyan" | "yellow" | undefined;
        let dimColor = false;

        if (line.startsWith("+++") || line.startsWith("---")) {
          color = "cyan";
        } else if (line.startsWith("+")) {
          color = "green";
        } else if (line.startsWith("-")) {
          color = "red";
        } else if (line.startsWith("@@")) {
          color = "yellow";
        } else if (line.startsWith("diff ") || line.startsWith("index ")) {
          dimColor = true;
        }

        return (
          <Text key={idx} color={color} dimColor={dimColor} wrap="truncate">
            {line}
          </Text>
        );
      })}
      {hidden > 0 && (
        <Text dimColor>... {hidden} more line{hidden !== 1 ? "s" : ""}</Text>
      )}
    </Box>
  );
}
