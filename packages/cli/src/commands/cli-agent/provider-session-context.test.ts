import assert from "node:assert/strict";
import { test } from "vitest";
import { ProviderSessionContext } from "./provider-session-context.js";

test("session context storage stays dormant until first use", () => {
  let factoryCalls = 0;
  const context = new ProviderSessionContext(
    () => {
      factoryCalls += 1;
      throw new Error("store should not open");
    },
    () => null,
    () => undefined,
    () => undefined,
  );

  assert.equal(factoryCalls, 0);
  context.close();
  assert.equal(factoryCalls, 0);
});

test("optional context load failure does not block a normal prompt", async () => {
  const debugMessages: string[] = [];
  const context = new ProviderSessionContext(
    () => {
      throw new Error("database unavailable");
    },
    () => null,
    () => undefined,
    (message) => debugMessages.push(message),
  );

  await assert.doesNotReject(async () => {
    assert.deepEqual(await context.claim("session-1", false), {
      claim: null,
      text: null,
    });
  });
  assert.match(debugMessages[0] ?? "", /continuing without it/);
});
