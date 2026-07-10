/**
 * Search screen — text search with highlighted results.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AditEvent } from "@varveai/adit-core";
import { getEventSummary } from "../../utils/summary.js";

interface SearchScreenProps {
  onSearch: (query: string) => void;
  onCancel: () => void;
  submitted: boolean;
  events: AditEvent[];
  selectedIndex: number;
  height: number;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const time = d.toLocaleTimeString("en-US", { hour12: false });
    return `${month}/${day} ${time}`;
  } catch {
    return iso.substring(5, 19).replace("T", " ");
  }
}

function actorSymbol(actor: string): string {
  switch (actor) {
    case "assistant":
      return "[A]";
    case "user":
      return "[U]";
    case "tool":
      return "[T]";
    case "system":
      return "[S]";
    default:
      return "[?]";
  }
}

function getSummary(event: AditEvent): string {
  return getEventSummary(event, 60);
}

export function SearchScreen({
  onSearch,
  onCancel,
  submitted,
  events,
  selectedIndex,
  height,
}: SearchScreenProps): React.ReactElement {
  const [query, setQuery] = useState("");

  // Window the result list to the available height (same scheme as
  // EventList); rendering all results overflows the terminal and breaks
  // ink's in-place redraw. Chrome: query line + margin, count line,
  // range line, footer + margin.
  const listHeight = Math.max(height - 6, 3);
  const halfVisible = Math.floor(listHeight / 2);
  let scrollStart = Math.max(0, selectedIndex - halfVisible);
  const scrollEnd = Math.min(events.length, scrollStart + listHeight);
  if (scrollEnd === events.length) {
    scrollStart = Math.max(0, scrollEnd - listHeight);
  }
  const visible = events.slice(scrollStart, scrollEnd);

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.return) {
        onSearch(query);
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input) {
        setQuery((q) => q + input);
      }
    },
    { isActive: !submitted },
  );

  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <Box flexDirection="row" marginBottom={1}>
        <Text bold>Search: </Text>
        <Text color="cyan">{query}</Text>
        {!submitted && <Text dimColor>_</Text>}
      </Box>

      {submitted && events.length === 0 && (
        <Text dimColor>No results found for "{query}"</Text>
      )}

      {submitted && events.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>
            {events.length} result{events.length !== 1 ? "s" : ""}:
          </Text>
          {visible.map((event, idx) => {
            const actualIndex = scrollStart + idx;
            const isSelected = actualIndex === selectedIndex;
            return (
              <Box key={event.id}>
                <Text wrap="truncate-end">
                  <Text inverse={isSelected}>
                    {isSelected ? ">" : " "}{" "}
                  </Text>
                  <Text dimColor>{formatTime(event.startedAt)} </Text>
                  <Text color="cyan">{actorSymbol(event.actor)} </Text>
                  <Text inverse={isSelected}>{getSummary(event)}</Text>
                </Text>
              </Box>
            );
          })}
          {events.length > listHeight && (
            <Text dimColor>
              [{scrollStart + 1}-{scrollEnd} of {events.length}]
            </Text>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {submitted
            ? "[Esc] back  [j/k] navigate  [/] edit query"
            : "Type query, [Enter] search, [Esc] cancel"}
        </Text>
      </Box>
    </Box>
  );
}
