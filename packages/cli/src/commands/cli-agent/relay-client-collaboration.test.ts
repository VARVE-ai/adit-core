import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const socketMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    handlers: Map<string, (value: unknown) => void>;
    sent: string[];
  }>,
}));

vi.mock("ws", () => ({
  default: class MockWebSocket {
    static OPEN = 1;
    readyState = 1;
    handlers = new Map<string, (value: unknown) => void>();
    sent: string[] = [];

    constructor() {
      socketMocks.instances.push(this);
    }

    on(name: string, handler: (value: unknown) => void) {
      this.handlers.set(name, handler);
    }

    send(value: string) { this.sent.push(value); }
    close() {}
    terminate() {}
  },
}));

import { CliAgentRelayWebSocket } from "./relay-client.js";

describe("CliAgentRelayWebSocket collaboration commands", () => {
  it("accepts collaboration commands from Relay", async () => {
    const onCommand = vi.fn();
    const onEventsAck = vi.fn();
    const client = new CliAgentRelayWebSocket({
      serverUrl: "http://127.0.0.1:3000",
      accessToken: "token",
      register: {
        provider: "codex",
        terminalId: "terminal",
        projectRoot: "/project",
        projectId: "project",
        projectName: "project",
      },
      onHello: vi.fn(),
      onCommand,
      onEventsAck,
    });

    client.connect();
    await Promise.resolve();
    const socket = socketMocks.instances.at(-1);
    expect(socket).toBeDefined();
    socket?.handlers.get("message")?.({
      toString: () => JSON.stringify({
        type: "command",
        command: {
          id: "command-1",
          type: "append-session-context",
          payload: { sessionId: "session-1" },
          createdAt: Date.now(),
        },
      }),
    });

    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      id: "command-1",
      type: "append-session-context",
    }));
    socket?.handlers.get("message")?.({
      toString: () => JSON.stringify({
        type: "command",
        command: {
          id: "command-2",
          type: "collaboration-prompt",
          payload: { requestId: "request-1", runId: "run-1", question: "Where?" },
          createdAt: Date.now(),
        },
      }),
    });
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      id: "command-2",
      type: "collaboration-prompt",
    }));
    const batchId = "00000000-0000-4000-8000-000000000001";
    const eventId = "00000000-0000-4000-8000-000000000002";
    expect(client.sendEvents([{
      eventId,
      type: "message",
      payload: { text: "saved" },
    }], batchId)).toBe(true);
    expect(socket?.sent.map((value) => JSON.parse(value))).toContainEqual({
      type: "events",
      batchId,
      events: [{
        eventId,
        type: "message",
        payload: { text: "saved" },
      }],
    });
    socket?.handlers.get("message")?.({
      toString: () => JSON.stringify({ type: "events.ack", batchId }),
    });
    expect(onEventsAck).toHaveBeenCalledWith(batchId);
    expect(client.sendEvents([{
      type: "state",
      payload: { busy: false },
    }])).toBe(true);
    expect(socket?.sent.map((value) => JSON.parse(value))).toContainEqual({
      type: "events",
      events: [{ type: "state", payload: { busy: false } }],
    });
    client.close();
  });

  it("waits for collaboration event ACKs without changing ordinary provider events", () => {
    const codexSource = readFileSync(new URL("../cloud-codex.ts", import.meta.url), "utf8");
    const claudeSource = readFileSync(new URL("../cloud-claude.ts", import.meta.url), "utf8");

    expect(codexSource).toContain("const hasDispatchableEvents = eventQueue.length > 0 && !inFlightEventBatch");
    expect(codexSource).toContain("ws.sendEvents(reliableBatch, batchId)");
    expect(codexSource).toContain("if (!ws.sendEvents(batch)) eventQueue.unshift(...batch)");
    expect(codexSource).toContain("trimRelayEventQueue({");
    expect(codexSource).toContain("reliableEventsForRetry({");
    expect(codexSource).toContain("inFlightEventBatch.sentAt = Date.now()");
    expect(codexSource).not.toContain("const protectedCount = inFlightEventBatch");
    expect(claudeSource).toContain("const hasDispatchableEvents = eventQueue.length > 0 && !inFlightEventBatch");
    expect(claudeSource).toContain("ws.sendEvents(reliableBatch, batchId)");
    expect(claudeSource).toContain("if (!ws.sendEvents(batch)) eventQueue.unshift(...batch)");
    expect(claudeSource).toContain("trimRelayEventQueue({");
    expect(claudeSource).toContain("reliableEventsForRetry({");
    expect(claudeSource).toContain("inFlightEventBatch.sentAt = Date.now()");
    expect(claudeSource).not.toContain("const protectedCount = inFlightEventBatch");
  });
});
