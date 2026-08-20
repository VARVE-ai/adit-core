import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { isCollaborationLifecycleEvent } from "./collaboration-commands.js";
import {
  reliableEventsForRetry,
  trimRelayEventQueue,
} from "./reliable-event-queue.js";
import type { CliAgentRelayEvent } from "./types.js";

function event(type: string): CliAgentRelayEvent {
  return { type, payload: {} };
}

function trim(queue: CliAgentRelayEvent[], maxSize: number): number {
  return trimRelayEventQueue({
    queue,
    maxSize,
    isReliable: isCollaborationLifecycleEvent,
  });
}

describe("trimRelayEventQueue", () => {
  it("drops the oldest ordinary events first", () => {
    const queue = [event("message.old"), event("message.new"), event("state")];

    assert.equal(trim(queue, 2), 1);
    assert.deepEqual(queue.map((item) => item.type), ["message.new", "state"]);
  });

  it("preserves queued collaboration lifecycle events", () => {
    const queue = [
      event("collaboration.started"),
      event("message.old"),
      event("collaboration.completed"),
      event("message.new"),
    ];

    assert.equal(trim(queue, 2), 2);
    assert.deepEqual(queue.map((item) => item.type), [
      "collaboration.started",
      "collaboration.completed",
    ]);
  });

  it("preserves reliable events regardless of whether they are already in flight", () => {
    const queue = [
      event("collaboration.started"),
      event("context.applied"),
      event("message"),
    ];

    assert.equal(trim(queue, 2), 1);
    assert.deepEqual(queue.map((item) => item.type), [
      "collaboration.started",
      "context.applied",
    ]);
  });

  it("allows an all-reliable queue to exceed the soft limit", () => {
    const queue = [
      event("collaboration.started"),
      event("collaboration.completed"),
      event("collaboration.failed"),
    ];

    assert.equal(trim(queue, 1), 0);
    assert.equal(queue.length, 3);
  });

  it("retries the same reliable events only after the ACK timeout", () => {
    const first = { ...event("collaboration.started"), eventId: "event-1" };
    const second = { ...event("collaboration.completed"), eventId: "event-2" };
    const queue = [first, event("message"), second];
    const batch = {
      batchId: "batch-1",
      eventIds: ["event-1", "event-2"],
      sentAt: 1_000,
    };

    assert.deepEqual(reliableEventsForRetry({
      queue,
      batch,
      now: 10_999,
      timeoutMs: 10_000,
    }), []);
    assert.deepEqual(reliableEventsForRetry({
      queue,
      batch,
      now: 11_000,
      timeoutMs: 10_000,
    }), [first, second]);
  });
});
