/**
 * Platform selection for `adit init` — semantics layer.
 *
 * Builds the full supported-platform list with pre-check state, diffs the
 * user's final selection against the connected record, and provides the
 * plain-readline selection prompt used when the ink checkbox UI is not
 * available. The input widget (ink or readline) only produces a checked
 * set; everything else lives here so both widgets share one behavior.
 *
 * Pre-check rules:
 * - A project with a connected-platforms record pre-checks exactly the
 *   recorded platforms; CLI detection is annotation only. (Detection must
 *   not drive the default here: a temporarily missing CLI on PATH would
 *   otherwise silently disconnect a connected platform on plain Enter.)
 * - A first-run project (no record) pre-checks the detected CLIs.
 * - Manual platforms (Cursor) are never pre-checked unless recorded.
 */

import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import type { Platform } from "@varveai/adit-core";
import { getAdapter, listAdapters } from "@varveai/adit-hooks/adapters";

/** Companion platforms installed/removed together with their owner. */
export const BUNDLED_PLATFORMS: Partial<Record<Platform, Platform[]>> = {
  // The VS Code extension shares Claude Code's configuration; connecting
  // Claude Code always connects both.
  "claude-code": ["claude-vscode"],
};

const DISPLAY_ORDER: Platform[] = ["claude-code", "codex", "gemini", "opencode", "cursor"];

export interface PlatformChoice {
  platform: Platform;
  displayName: string;
  cliBinary?: string;
  /** CLI found on PATH */
  detected: boolean;
  /** In the connected-platforms record */
  connected: boolean;
  /** No CLI to detect — connect is always an explicit user choice */
  manual: boolean;
  preChecked: boolean;
}

export interface SelectionPlan {
  /** Final user-facing selection (bundles not expanded) */
  finalSelection: Platform[];
  /** Platforms to install hooks for, bundles expanded */
  toConnect: Platform[];
  /** Platforms to remove hooks from, bundles expanded */
  toDisconnect: Platform[];
  /** Still-connected platforms to refresh, bundles expanded */
  toRefresh: Platform[];
  /** The connected-platforms record after applying, bundles expanded */
  finalRecord: Platform[];
}

function bundledCompanions(platform: Platform): Platform[] {
  return BUNDLED_PLATFORMS[platform] ?? [];
}

function expandBundles(platforms: Platform[]): Platform[] {
  const expanded: Platform[] = [];
  for (const platform of platforms) {
    expanded.push(platform, ...bundledCompanions(platform));
  }
  return Array.from(new Set(expanded));
}

/** All user-facing selectable platforms (implemented, bundles hidden). */
export function selectablePlatforms(): Platform[] {
  const companions = new Set(
    Object.values(BUNDLED_PLATFORMS).flat(),
  );
  const implemented = listAdapters()
    .filter((adapter) => adapter.hookMappings.length > 0)
    .map((adapter) => adapter.platform)
    .filter((platform) => !companions.has(platform));
  const ordered = DISPLAY_ORDER.filter((platform) => implemented.includes(platform));
  const rest = implemented.filter((platform) => !DISPLAY_ORDER.includes(platform));
  return [...ordered, ...rest];
}

export function buildPlatformChoices(opts: {
  connected: Platform[];
  detected: Platform[];
  hasRecord: boolean;
}): PlatformChoice[] {
  const connectedSet = new Set(opts.connected);
  const detectedSet = new Set(opts.detected);

  return selectablePlatforms().map((platform) => {
    const adapter = getAdapter(platform);
    const manual = !adapter.cliBinary;
    // A bundle owner counts as connected when any of its companions is
    // recorded (covers records written by explicit companion installs).
    const connected =
      connectedSet.has(platform) ||
      bundledCompanions(platform).some((companion) => connectedSet.has(companion));
    const detected = detectedSet.has(platform);
    const preChecked = opts.hasRecord ? connected : detected && !manual;
    return {
      platform,
      displayName: adapter.displayName,
      cliBinary: adapter.cliBinary,
      detected,
      connected,
      manual,
      preChecked,
    };
  });
}

/** Short status annotation shown next to each choice. */
export function describeChoice(choice: PlatformChoice): string {
  if (choice.manual) return "manual (cannot be detected)";
  if (!choice.detected) return "not found on PATH";
  return choice.connected ? "connected" : "installed";
}

export function diffSelection(
  choices: PlatformChoice[],
  finalChecked: Set<Platform>,
): SelectionPlan {
  const finalSelection = choices
    .filter((choice) => finalChecked.has(choice.platform))
    .map((choice) => choice.platform);
  const connectedNow = choices
    .filter((choice) => choice.connected)
    .map((choice) => choice.platform);

  const toConnect = finalSelection.filter(
    (platform) => !connectedNow.includes(platform),
  );
  const toDisconnect = connectedNow.filter(
    (platform) => !finalChecked.has(platform),
  );
  const toRefresh = connectedNow.filter((platform) => finalChecked.has(platform));

  return {
    finalSelection,
    toConnect: expandBundles(toConnect),
    toDisconnect: expandBundles(toDisconnect),
    toRefresh: expandBundles(toRefresh),
    finalRecord: expandBundles(finalSelection),
  };
}

/** Re-plan after the user declined the disconnect confirmation. */
export function keepDisconnectedSelection(
  choices: PlatformChoice[],
  finalChecked: Set<Platform>,
): Set<Platform> {
  const kept = new Set(finalChecked);
  for (const choice of choices) {
    if (choice.connected) kept.add(choice.platform);
  }
  return kept;
}

/**
 * Parse the fallback prompt's answer against the pre-checked state.
 * Returns null for an unrecognized answer.
 */
export function parseSelectionAnswer(
  answer: string,
  choices: PlatformChoice[],
): Set<Platform> | null {
  const preChecked = new Set(
    choices.filter((choice) => choice.preChecked).map((choice) => choice.platform),
  );
  const normalized = answer.trim().toLowerCase();

  if (normalized === "" ) return preChecked;
  if (normalized === "a" || normalized === "all") {
    return new Set(choices.map((choice) => choice.platform));
  }
  if (normalized === "n" || normalized === "none") return new Set();

  const tokens = normalized.split(/[\s,]+/u).filter(Boolean);
  const indexes = tokens.map((token) => Number.parseInt(token, 10));
  if (
    tokens.length === 0 ||
    indexes.some((index) => !Number.isInteger(index) || index < 1 || index > choices.length)
  ) {
    return null;
  }

  const toggled = new Set(preChecked);
  for (const index of new Set(indexes)) {
    const platform = choices[index - 1].platform;
    if (toggled.has(platform)) {
      toggled.delete(platform);
    } else {
      toggled.add(platform);
    }
  }
  return toggled;
}

/** Print the numbered choice list used by the readline fallback. */
export function printChoiceList(choices: PlatformChoice[]): void {
  choices.forEach((choice, index) => {
    const box = choice.preChecked ? pc.green("[x]") : pc.dim("[ ]");
    const binary = choice.cliBinary ? `(${choice.cliBinary})` : "";
    const name = `${choice.displayName} ${binary}`.trim();
    console.log(`    ${index + 1}. ${box} ${name.padEnd(24)} ${pc.dim(`— ${describeChoice(choice)}`)}`);
  });
}

/**
 * Plain-readline selection prompt (fallback when the ink UI is unavailable).
 * One input: Enter keeps the pre-checked state, numbers toggle, a/n select
 * all/none. An unrecognized answer keeps the pre-checked state. The
 * disconnect confirmation runs on the same readline session, so the whole
 * interaction has a single stdin owner.
 */
export async function promptPlatformSelectionFallback(
  choices: PlatformChoice[],
): Promise<Set<Platform>> {
  printChoiceList(choices);
  console.log(pc.dim('  Enter = keep as shown · numbers toggle ("2,3") · a = all · n = none'));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("  Select: ");
    let selection = parseSelectionAnswer(answer, choices);
    if (selection === null) {
      console.log(pc.dim("  [ ] Unrecognized answer — keeping the current selection."));
      return new Set(
        choices.filter((choice) => choice.preChecked).map((choice) => choice.platform),
      );
    }

    const disconnecting = choices.filter(
      (choice) => choice.connected && !selection!.has(choice.platform),
    );
    if (disconnecting.length > 0) {
      const names = disconnecting.map((choice) => choice.displayName).join(", ");
      const confirm = (await rl.question(
        `  ${pc.yellow(`Disconnect ${names} — their hooks will be removed.`)} Confirm? ${pc.dim("(y/N):")} `,
      )).trim().toLowerCase();
      if (confirm !== "y" && confirm !== "yes") {
        selection = keepDisconnectedSelection(choices, selection);
        console.log(pc.dim("  [=] Keeping them connected."));
      }
    }
    return selection;
  } finally {
    rl.close();
  }
}
