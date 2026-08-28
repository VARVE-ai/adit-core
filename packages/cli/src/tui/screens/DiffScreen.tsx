/**
 * Diff viewer screen — shows the diff captured for an event.
 */

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { DiffView } from "../components/DiffView.js";
import type { AditEvent } from "@varveai/adit-core";

interface DiffScreenProps {
  event: AditEvent | null;
  getDiff: (eventId: string) => string | null;
  height: number;
}

export function DiffScreen({
  event,
  getDiff,
  height,
}: DiffScreenProps): React.ReactElement {
  const [diffText, setDiffText] = useState<string | null>(null);

  useEffect(() => {
    if (event?.id) {
      const text = getDiff(event.id);
      setDiffText(text);
    }
  }, [event, getDiff]);

  if (!event) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>No event selected. Press [Esc] to go back.</Text>
      </Box>
    );
  }

  const title = `Diff for event ${event.id.substring(0, 10)}`;

  return (
    <Box flexDirection="column" width="100%">
      {/* title (1) + footer with margin (2) */}
      <DiffView diffText={diffText} title={title} maxLines={Math.max(height - 3, 3)} />
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>[Esc] back to timeline</Text>
      </Box>
    </Box>
  );
}
