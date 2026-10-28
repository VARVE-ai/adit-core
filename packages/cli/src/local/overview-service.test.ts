import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalStore, LocalAnalytics, LocalHistory } from "@varveai/adit-core";
import { StructuredHistory } from "../../../core/src/local-history/structured-store.js";
import { OverviewService } from "./overview-service.js";

it("computes off-thread and sees fact and price changes committed by the daemon connection", async () => {
  const root = mkdtempSync(join(tmpdir(), "adit-overview-worker-")),
    store = new LocalStore(join(root, "state"));
  new LocalHistory(store.db);
  const analytics = new LocalAnalytics(store.db),
    history = new StructuredHistory(store.db),
    workspace = store.saveWorkspace({
      path: root,
      providers: ["claude"],
      repositories: [],
    });
  const service = new OverviewService(
    store.dbPath,
    new URL("../../dist/local/overview-worker.js", import.meta.url),
  );
  try {
    const opts = { range: "all", timezone: "UTC", year: 2026 };
    expect((await service.query(workspace, opts)).summary.sessions).toBe(0);
    history.write({
      provider: "claude",
      id: "s",
      cwd: root,
      messages: [
        {
          key: "a",
          role: "assistant",
          timestamp: "2026-10-18T01:00:00Z",
          model: "fixture",
          content: "done",
          raw: {},
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 10,
          },
        },
      ],
    });
    analytics.prices.install({
      fixture: {
        mode: "chat",
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000008,
      },
    });
    expect((await service.query(workspace, opts)).summary).toMatchObject({
      sessions: 1,
      messages: 1,
      estimatedCost: 280,
    });
    analytics.prices.install({
      fixture: {
        mode: "chat",
        input_cost_per_token: 0.000004,
        output_cost_per_token: 0.000008,
      },
    });
    expect((await service.query(workspace, opts)).summary.estimatedCost).toBe(
      280,
    );
    await expect(
      service.query(workspace, { range: "bad" }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await service.query(workspace, opts)).summary.sessions).toBe(1);
    store.db.prepare("DELETE FROM adit_history_sessions").run();
    expect((await service.query(workspace, opts)).summary.sessions).toBe(0);
  } finally {
    await service.close();
    await analytics.prices.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
