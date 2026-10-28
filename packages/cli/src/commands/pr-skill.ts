export const PR_SKILL = `---
name: adit-pr
description: Generate an AI usage disclosure for a pull request from local ADIT sessions and an explicit Git commit range. Use when asked to describe AI assistance in a PR or attach an ADIT disclosure. Does not create or update PRs.
---

# ADIT PR disclosure

Use the installed local CLI. No Cloud login or existing PR is required. Choose the repository and source/target branches from the user's requested change; do not silently use an unrelated current directory.

    adit pr --repo <path> --base <target> --head <source> --json

For a known list of commits, replace both branch flags with repeated --commit <sha>. The CLI starts the local background service if needed. The repository must already belong to a collected ADIT workspace. If it is not collected or analysis is incomplete, report the returned reason; do not change author filters, fabricate statistics or silently disable line statistics to claim a complete result.

Defaults: detailed English, per-commit conversation numbers, line statistics, Assisted-by lines, and the ADIT label. Prompt text and shared-session links are excluded. Options include --detail brief|detailed|project-template, --language en|zh, --template <path>, --no-adit-label, --no-sessions, --no-lines, --no-assisted-by, --prompts, --share-links and --output <path>. Include prompts only when requested; shared links must already exist and this command never publishes a session.

The JSON response contains ok, schemaVersion, id, markdown, scope, commits, sessions, summary, options, attributionVersion, warnings and localUrl. A nonzero exit or ok:false is failure. Use the returned Markdown as the disclosure; do not replace unknown attribution with human-written or AI-written claims. Keep unmatched commits, excluded commits and reasons visible. Submitter and code writers are distinct. Line totals are summed across commits, not the net PR diff. Whole-session usage may include work outside this range.

ADIT does not create, fetch, synchronize or edit a hosted PR. When the user separately requested creating/updating a PR, use the agent's own authorized PR tools and include the generated disclosure. A successful ADIT command only means the local description was generated. Regenerate for new commits; existing saved descriptions are immutable.
`;
