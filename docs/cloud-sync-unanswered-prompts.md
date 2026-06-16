# Cloud Sync And Unanswered Prompts

## Problem

Cloud sync batches can encounter a `prompt_submit` event before the matching
`assistant_response` event has been recorded. This happens during active
sessions, interrupted sessions, or relay failures where the user prompt exists
locally but the assistant turn has not arrived yet.

Earlier sync logic treated the first unanswered prompt as a batch barrier. Once
that barrier was found, the serializer stopped uploading events at that event
ID and also applied the same upper bound to sessions, environment snapshots,
and plans.

That protected the cloud from seeing incomplete prompt-response pairs, but it
could also block unrelated later sessions for the same project. If the missing
assistant response never appeared, cloud sync could remain stuck behind one
old unanswered prompt.

## Policy Choice

ADIT should not let one incomplete conversation block later project sync. The
serializer may include unanswered prompts in the batch, and later sessions can
continue syncing.

This means the cloud may briefly see an incomplete prompt-response pair. That is
preferable to a permanent project-level sync stall. Downstream consumers should
treat prompt-response completeness as a per-session state, not as a guarantee
made by the sync serializer.

## Code Path

The batch is built by `buildSyncBatch(...)` in
`packages/cloud/src/sync/serializer.ts`.

Avoid reintroducing a global event upper bound based on the first unanswered
prompt. In particular, do not restore helper logic equivalent to:

- finding the first `prompt_submit` without a later `assistant_response`
- storing that event ID as a batch-wide upper bound
- applying that upper bound to sessions, events, environment snapshots, and
  plans

Such a barrier can cause a single stale prompt to block newer sessions and
project metadata from reaching adit-cloud.

## Regression Check

The serializer test should cover this shape:

1. Session A has a `prompt_submit` without a later `assistant_response`.
2. Session B is created after Session A.
3. `buildSyncBatch(...)` includes both sessions.
4. The unanswered prompt does not prevent later events from being included.

Run the focused serializer test file when checking this behavior:

```bash
pnpm exec vitest run packages/cloud/src/sync/serializer.test.ts
```

## Operational Notes

If cloud sync appears stuck:

- Check whether the local database has old `prompt_submit` events without
  later `assistant_response` events.
- Confirm that the server cursor is not ahead of local events for the project.
- Confirm that the batch includes later sessions even when an older session is
  incomplete.

The serializer should move records forward. Completeness checks belong in UI,
analysis, scoring, or session-level consumers that can tolerate active or
interrupted conversations.
