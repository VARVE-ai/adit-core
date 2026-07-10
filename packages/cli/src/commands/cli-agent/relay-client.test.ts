import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { CliAgentRelayWebSocket } from "./relay-client.js";

function waitForListening(server: WebSocketServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("WebSocket server did not expose a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for condition"));
      }
    }, 25);
  });
}

describe("CliAgentRelayWebSocket", () => {
  afterEach(() => {
    delete process.env.ADIT_CLI_AGENT_WS_URL;
  });

  it("resolves a fresh access token for reconnects", async () => {
    const server = new WebSocketServer({ port: 0 });
    const port = await waitForListening(server);
    const sockets = new Set<WebSocket>();
    const observed: Array<{ authorization: string | undefined; helloToken: unknown }> = [];
    const accessToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("access-token-1")
      .mockResolvedValueOnce("access-token-2");

    server.on("connection", (socket, request) => {
      const connectionIndex = observed.length;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.once("message", (data) => {
        const message = JSON.parse(data.toString("utf8")) as { accessToken?: unknown };
        observed.push({
          authorization: request.headers.authorization,
          helloToken: message.accessToken,
        });
        socket.send(
          JSON.stringify({
            type: "hello.ok",
            connection: { id: `connection-${connectionIndex + 1}` },
            panel: { id: `panel-${connectionIndex + 1}`, name: "test-coding2" },
          }),
        );
        if (connectionIndex === 0) setTimeout(() => socket.close(), 10);
      });
    });

    process.env.ADIT_CLI_AGENT_WS_URL = `ws://127.0.0.1:${port}/ws/coding/cli-agent`;
    const relay = new CliAgentRelayWebSocket({
      serverUrl: "http://cloud.test",
      accessToken,
      register: {
        provider: "codex",
        terminalId: "terminal-1",
        projectRoot: "/tmp/test-coding2",
        projectId: "project-1",
        projectName: "test-coding2",
      },
      onHello: () => {},
      onCommand: () => {},
    });

    try {
      relay.connect();
      await waitFor(() => observed.length === 2);

      expect(accessToken).toHaveBeenCalledTimes(2);
      expect(observed).toEqual([
        {
          authorization: "Bearer access-token-1",
          helloToken: "access-token-1",
        },
        {
          authorization: "Bearer access-token-2",
          helloToken: "access-token-2",
        },
      ]);
    } finally {
      relay.close();
      for (const socket of sockets) socket.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps the active connection when a stale socket closes late", async () => {
    const server = new WebSocketServer({ port: 0 });
    const port = await waitForListening(server);
    const serverSockets: WebSocket[] = [];

    server.on("connection", (socket) => {
      const index = serverSockets.length;
      serverSockets.push(socket);
      socket.once("message", () => {
        socket.send(
          JSON.stringify({
            type: "hello.ok",
            connection: { id: `connection-${index + 1}` },
            panel: { id: `panel-${index + 1}`, name: "test-coding2" },
          }),
        );
      });
    });

    process.env.ADIT_CLI_AGENT_WS_URL = `ws://127.0.0.1:${port}/ws/coding/cli-agent`;
    const relay = new CliAgentRelayWebSocket({
      serverUrl: "http://cloud.test",
      accessToken: async () => "access-token",
      register: {
        provider: "codex",
        terminalId: "terminal-1",
        projectRoot: "/tmp/test-coding2",
        projectId: "project-1",
        projectName: "test-coding2",
      },
      onHello: () => {},
      onCommand: () => {},
    });

    try {
      relay.connect();
      await waitFor(() => relay.currentConnectionId === "connection-1");

      // Simulate a socket stuck in the closing handshake: the relay loop keeps
      // calling connect() while disconnected, which dials a replacement socket.
      const staleSocket = (relay as unknown as { socket: WebSocket | null }).socket;
      expect(staleSocket).not.toBeNull();
      Object.defineProperty(staleSocket!, "readyState", {
        value: staleSocket!.CLOSING,
        configurable: true,
      });
      relay.connect();
      await waitFor(() => relay.currentConnectionId === "connection-2");
      delete (staleSocket as unknown as Record<string, unknown>).readyState;

      // The stale socket's late close event must not clobber the new connection.
      const staleClosed = new Promise<void>((resolve) => {
        staleSocket!.once("close", () => resolve());
      });
      serverSockets[0]?.close();
      await staleClosed;

      expect(relay.currentConnectionId).toBe("connection-2");
      expect(relay.isOpen).toBe(true);
    } finally {
      relay.close();
      for (const socket of serverSockets) socket.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
