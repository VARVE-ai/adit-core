/**
 * Event detail panel — shows full details of the selected event.
 *
 * Every row renders as a single truncated line: wrapped rows break ink's
 * frame-height math and leave stale frames stacked on screen.
 */

import React from "react";
import { Box, Text } from "ink";
import { parseLabels, parseDiffStats, parseError, type AditEvent } from "@varveai/adit-core";

interface EventDetailProps {
  event: AditEvent | null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 3) + "..." : s;
}

function formatDuration(startedAt: string, endedAt: string): string {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function prettyJson(json: string, maxLen: number): string {
  try {
    const parsed = JSON.parse(json);
    const pretty = JSON.stringify(parsed, null, 2);
    return truncate(pretty.replace(/\n/g, " "), maxLen);
  } catch {
    return truncate(json.replace(/\n/g, " "), maxLen);
  }
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Text wrap="truncate">
      <Text dimColor>{label}</Text>
      {children}
    </Text>
  );
}

export function EventDetail({
  event,
}: EventDetailProps): React.ReactElement {
  if (!event) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No event selected</Text>
      </Box>
    );
  }

  const labels = parseLabels(event.labelsJson);
  const stats = parseDiffStats(event.diffStatJson);
  const error = parseError(event.errorJson);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Event Detail</Text>
      <Text dimColor>{"─".repeat(30)}</Text>

      <Field label={`ID:${"        "}`}>
        <Text>{event.id}</Text>
      </Field>
      <Field label={`Type:${"      "}`}>
        <Text>{event.eventType}</Text>
      </Field>
      <Field label={`Actor:${"     "}`}>
        <Text>{event.actor}</Text>
      </Field>
      <Field label={`Seq:${"       "}`}>
        <Text>{String(event.sequence)}</Text>
      </Field>
      <Field label={`Status:${"    "}`}>
        <Text color={event.status === "error" ? "red" : "green"}>
          {event.status}
        </Text>
      </Field>
      <Field label={`Started:${"   "}`}>
        <Text>{event.startedAt}</Text>
      </Field>

      {event.endedAt && (
        <Field label={`Ended:${"     "}`}>
          <Text>{event.endedAt}</Text>
          <Text dimColor> ({formatDuration(event.startedAt, event.endedAt)})</Text>
        </Field>
      )}

      <Field label={`Session:${"   "}`}>
        <Text>{event.sessionId}</Text>
      </Field>

      {event.parentEventId && (
        <Field label={`Parent:${"    "}`}>
          <Text>{event.parentEventId}</Text>
        </Field>
      )}

      {event.clientId && (
        <Field label={`Client:${"    "}`}>
          <Text>{event.clientId}</Text>
        </Field>
      )}

      {event.gitBranch && (
        <Field label={`Branch:${"    "}`}>
          <Text>{event.gitBranch}</Text>
          {event.gitHeadSha && (
            <Text dimColor> @ {event.gitHeadSha.substring(0, 8)}</Text>
          )}
        </Field>
      )}

      {event.checkpointSha && (
        <Field label="Checkpoint:">
          <Text color="green"> {event.checkpointSha.substring(0, 10)}</Text>
        </Field>
      )}

      {event.checkpointRef && (
        <Field label={`Ref:${"       "}`}>
          <Text>{event.checkpointRef}</Text>
        </Field>
      )}

      {event.envSnapshotId && (
        <Field label={`Env Snap:${"  "}`}>
          <Text>{event.envSnapshotId}</Text>
        </Field>
      )}

      {event.planTaskId && (
        <Field label={`Plan Task:${" "}`}>
          <Text>{event.planTaskId}</Text>
        </Field>
      )}

      {event.toolName && (
        <Field label={`Tool:${"      "}`}>
          <Text color="yellow">{event.toolName}</Text>
        </Field>
      )}

      {event.promptText && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>Prompt:</Text>
          <Text wrap="truncate">
            {truncate(event.promptText.replace(/\n/g, " "), 200)}
          </Text>
        </Box>
      )}

      {event.cotText && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>Chain of Thought:</Text>
          <Text wrap="truncate">
            {truncate(event.cotText.replace(/\n/g, " "), 200)}
          </Text>
        </Box>
      )}

      {event.responseText && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>Response:</Text>
          <Text wrap="truncate">
            {truncate(event.responseText.replace(/\n/g, " "), 200)}
          </Text>
        </Box>
      )}

      {event.toolInputJson && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>Tool Input:</Text>
          <Text wrap="truncate">{prettyJson(event.toolInputJson, 200)}</Text>
        </Box>
      )}

      {event.toolOutputJson && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>Tool Output:</Text>
          <Text wrap="truncate">{prettyJson(event.toolOutputJson, 200)}</Text>
        </Box>
      )}

      {stats.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>Files ({stats.length}):</Text>
          {stats.slice(0, 8).map((f) => (
            <Text key={f.path} wrap="truncate">
              <Text color={f.status === "A" ? "green" : f.status === "D" ? "red" : "yellow"}>
                {f.status}
              </Text>
              {" "}
              {f.path}
            </Text>
          ))}
          {stats.length > 8 && (
            <Text dimColor>... and {stats.length - 8} more</Text>
          )}
        </Box>
      )}

      {labels.length > 0 && (
        <Box marginTop={1}>
          <Text wrap="truncate">
            <Text dimColor>Labels: </Text>
            <Text color="cyan">{labels.join(", ")}</Text>
          </Text>
        </Box>
      )}

      {error && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red" bold wrap="truncate">Error: {error.category}</Text>
          <Text color="red" wrap="truncate">{truncate(error.message, 100)}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>[d]iff [p]rompt [e]nv</Text>
      </Box>
    </Box>
  );
}
