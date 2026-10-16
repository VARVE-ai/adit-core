/**
 * Root TUI application component.
 *
 * Routes between screens and manages global state.
 */

import React, { useState, useCallback, useMemo } from "react";
import { Box, Text, useApp, useStdout } from "ink";
import Spinner from "ink-spinner";
import { useTimeline } from "./hooks/useTimeline.js";
import { useKeyboard, type Screen } from "./hooks/useKeyboard.js";
import { StatusBar } from "./components/StatusBar.js";
import { TimelineScreen } from "./screens/TimelineScreen.js";
import { DiffScreen } from "./screens/DiffScreen.js";
import { SearchScreen } from "./screens/SearchScreen.js";
import { EnvScreen } from "./screens/EnvScreen.js";
import type { EnvSnapshot } from "@varveai/adit-core";
import { type SortField, sortEvents } from "../commands/list.js";

export function App(): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  // Keep the frame strictly shorter than the terminal: once a frame fills
  // every row, ink falls back to clear-screen redraws, which flicker and
  // push stale frames into the scrollback.
  const appHeight = Math.max(termHeight - 1, 8);

  const [screen, setScreen] = useState<Screen>("timeline");
  const [searchSubmitted, setSearchSubmitted] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [envSnapshot, setEnvSnapshot] = useState<EnvSnapshot | null>(null);
  const [sortField, setSortField] = useState<SortField>("TIME");

  const SORT_CYCLE: SortField[] = ["TIME", "ACTOR"];

  const {
    state,
    filters,
    setFilters,
    getEventDiff,
    getEnvSnapshot,
  } = useTimeline();

  const events = useMemo(
    () => sortEvents(state.events, sortField),
    [state.events, sortField],
  );

  // Ensure selectedIndex stays in bounds
  const safeIndex = useMemo(
    () => Math.min(selectedIndex, Math.max(0, events.length - 1)),
    [selectedIndex, events.length],
  );

  const selectedEvent = events[safeIndex] ?? null;

  const navigateUp = useCallback(() => {
    setSelectedIndex((i) => Math.max(0, i - 1));
  }, []);

  const navigateDown = useCallback(() => {
    setSelectedIndex((i) => Math.min(events.length - 1, i + 1));
  }, [events.length]);

  const handleShowDiff = useCallback(() => {
    if (selectedEvent) {
      setScreen("diff");
    }
  }, [selectedEvent]);

  const handleShowEnv = useCallback(() => {
    const snap = getEnvSnapshot();
    setEnvSnapshot(snap);
    setScreen("env");
  }, [getEnvSnapshot]);

  const handleSearch = useCallback(() => {
    setSearchSubmitted(false);
    setScreen("search");
  }, []);

  const handleFilter = useCallback(() => {
    setShowFilters((v) => !v);
  }, []);

  const handleSort = useCallback(() => {
    setSortField((current) => {
      const idx = SORT_CYCLE.indexOf(current);
      return SORT_CYCLE[(idx + 1) % SORT_CYCLE.length];
    });
  }, []);

  const handleBack = useCallback(() => {
    if (screen !== "timeline") {
      setScreen("timeline");
      // Clear search filter when leaving search
      if (screen === "search") {
        setFilters({});
      }
    }
  }, [screen, setFilters]);

  const handleHelp = useCallback(() => {
    setScreen(screen === "help" ? "timeline" : "help");
  }, [screen]);

  const handleQuit = useCallback(() => {
    exit();
  }, [exit]);

  const handleSearchSubmit = useCallback(
    (query: string) => {
      setSearchSubmitted(true);
      setFilters({ ...filters, searchQuery: query });
    },
    [filters, setFilters],
  );

  useKeyboard(
    {
      onNavigateUp: navigateUp,
      onNavigateDown: navigateDown,
      onShowDiff: handleShowDiff,
      onShowEnv: handleShowEnv,
      onSearch: handleSearch,
      onFilter: handleFilter,
      onSort: handleSort,
      onHelp: handleHelp,
      onBack: handleBack,
      onQuit: handleQuit,
    },
    // Disabled only while the search input is capturing text; on the
    // results view global keys (j/k, Esc, q, ...) must stay live.
    screen !== "search" || searchSubmitted,
  );

  // Header
  const header = (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      width="100%"
      paddingX={1}
    >
      <Text bold color="cyan" wrap="truncate">
        ADIT — AI Development Intent Tracker
      </Text>
      {state.session?.id && (
        <Text dimColor wrap="truncate">
          [{state.session.platform}]{" "}
          {state.session.id.substring(0, 10)}
        </Text>
      )}
    </Box>
  );

  // Loading state
  if (state.loading) {
    return (
      <Box flexDirection="column" width="100%">
        {header}
        <Box paddingX={1}>
          <Spinner type="dots" />
          <Text> Loading timeline...</Text>
        </Box>
      </Box>
    );
  }

  // Error state
  if (state.error) {
    return (
      <Box flexDirection="column" width="100%">
        {header}
        <Box paddingX={1}>
          <Text color="red">Error: {state.error}</Text>
        </Box>
        <Box paddingX={1}>
          <Text dimColor>
            Try running "adit init" first. Press q to quit.
          </Text>
        </Box>
      </Box>
    );
  }

  // Content height = frame - header (1) - status bar (1)
  const contentHeight = appHeight - 2;

  let content: React.ReactElement;

  switch (screen) {
    case "diff":
      content = (
        <DiffScreen
          event={selectedEvent}
          getDiff={getEventDiff}
          height={contentHeight}
        />
      );
      break;

    case "search":
      content = (
        <SearchScreen
          onSearch={handleSearchSubmit}
          onCancel={handleBack}
          submitted={searchSubmitted}
          events={events}
          selectedIndex={safeIndex}
          height={contentHeight}
        />
      );
      break;

    case "env":
      content = <EnvScreen snapshot={envSnapshot} />;
      break;

    case "help":
      content = (
        <Box flexDirection="column" paddingX={1}>
          <Text bold>Keybindings</Text>
          <Text dimColor>{"─".repeat(30)}</Text>
          <Text>j/k or ↑/↓{"   "}Navigate events (detail updates live)</Text>
          <Text>d{"            "}Show diff for checkpoint</Text>
          <Text>e{"            "}Show environment snapshot</Text>
          <Text>/{"            "}Open search</Text>
          <Text>f{"            "}Toggle filter panel</Text>
          <Text>s{"            "}Cycle sort (TIME→ACTOR)</Text>
          <Text>Esc / b{"      "}Go back</Text>
          <Text>q{"            "}Quit</Text>
          <Text>?{"            "}Toggle this help</Text>
          <Box marginTop={1}>
            <Text dimColor>Press ? or Esc to close</Text>
          </Box>
        </Box>
      );
      break;

    case "timeline":
    default:
      content = (
        <TimelineScreen
          events={events}
          selectedIndex={safeIndex}
          selectedEvent={selectedEvent}
          filters={filters}
          showFilters={showFilters}
          sortField={sortField}
          height={contentHeight}
        />
      );
      break;
  }

  return (
    <Box flexDirection="column" width="100%" height={appHeight}>
      {header}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {content}
      </Box>
      <StatusBar
        session={state.session}
        eventCount={state.totalCount}
        screen={screen}
        sortField={sortField}
      />
    </Box>
  );
}
