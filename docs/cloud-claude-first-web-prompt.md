# Cloud Claude First Web Prompt Response

## Problem

When `adit cloud claude` is under web control, the first prompt submitted from
adit-cloud Coding must explicitly request a Claude response. If the first prompt
is sent as a plain SDK user message, Claude Code can record a synthetic
assistant entry such as `No response requested.` and leave the real user prompt
without an assistant turn.

The symptom is:

- The cloud command is marked `completed`, not `pending` or `error`.
- The local Claude transcript contains the user prompt but no following
  assistant response.
- Sending another prompt after the session is already active may work, because
  steering prompts already request an immediate query.
- Returning with `/local` makes local input behave normally.

## Expected Behavior

The first web prompt and every later steering prompt should use the same Claude
SDK intent:

```ts
{
  priority: "now",
  shouldQuery: true,
}
```

`priority: "now"` marks the prompt as an immediate turn. `shouldQuery: true`
asks Claude Code to produce an assistant response for that user message.

## Code Path

The first web prompt is created in
`packages/cli/src/commands/cli-agent/claude-code-provider.ts` inside
`ClaudeCodeProvider.runRemoteLoop()`.

Later prompts use `ClaudeCodeProvider.steerPrompt()`, which already pushes
messages with `priority: "now"` and `shouldQuery: true`. Keep the first prompt
path aligned with the steering path so the first remote message cannot become a
silent user message.

## Regression Check

The targeted regression test should assert that `provider.sendPrompt(...)`
creates the first remote prompt stream item with:

- `priority === "now"`
- `shouldQuery === true`

Run only the focused test when checking this behavior:

```bash
pnpm exec vitest run packages/cli/src/commands/cli-agent/claude-code-provider.test.ts -t "first web prompt"
```

## Runtime Verification

When validating against a local cloud instance:

1. Start adit-cloud and the CLI agent websocket server.
2. From the target project, run `adit cloud claude`.
3. Take control from adit-cloud Coding.
4. Send one short prompt from the web panel.
5. Confirm that the Claude transcript has an assistant response after the user
   prompt.

If the source build has not been globally installed, run the local build
directly from the target project:

```bash
node /path/to/adit-core/packages/cli/dist/index.js cloud claude
```
