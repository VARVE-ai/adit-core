import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { LocalPrices, type CostUsage } from "./pricing.js";

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const rates = {
  mode: "chat",
  input_cost_per_token: 0.00001,
  output_cost_per_token: 0.00005,
  cache_read_input_token_cost: 0.00000025,
  cache_creation_input_token_cost: 0.0000125,
  cache_creation_input_token_cost_above_1hr: 0.00002,
};
const usage: CostUsage = {
  provider: "claude", model: "claude-fable-5-1", scope: "message",
  input_total_tokens: 530, uncached_input_tokens: 100, output_tokens: 20,
  cache_read_tokens: 400, cache_write_tokens: 30,
  cache_write_5m_tokens: 10, cache_write_1h_tokens: 20,
};
function fixture(overrides: Record<string, unknown> = {}) {
  const db = new Database(":memory:");
  databases.push(db);
  const prices = new LocalPrices(db);
  prices.install({ [usage.model!]: { ...rates, ...overrides } });
  return { db, prices };
}

it("prices both Claude cache TTLs once and reloads the 1h rate from the saved catalog offline", () => {
  const { db, prices } = fixture();
  // Input 1000 + output 1000 + reads 100 + 5m writes 125 + 1h writes 400 microUSD.
  expect(prices.estimate(usage)).toBe(2625);
  expect(prices.estimate({ ...usage, cache_write_5m_tokens: null })).toBe(2625);
  expect(new LocalPrices(db).estimate(usage)).toBe(2625);
  expect(prices.estimate({ ...usage, cache_write_5m_tokens: 0, cache_write_1h_tokens: 30 })).toBe(2700);
});

it("keeps unknown 1h prices unknown without blocking requests that only use the ordinary write rate", () => {
  const { prices } = fixture({ cache_creation_input_token_cost_above_1hr: null });
  expect(prices.estimate(usage)).toBeNull();
  expect(prices.estimate({ ...usage, cache_write_1h_tokens: 0, cache_write_5m_tokens: 30 })).toBe(2475);
  expect(prices.estimate({ ...usage, cache_write_1h_tokens: null, cache_write_5m_tokens: null })).toBe(2475);
  const all1h = fixture({ cache_creation_input_token_cost: null }).prices;
  expect(all1h.estimate(usage)).toBeNull();
  expect(all1h.estimate({ ...usage, cache_write_1h_tokens: 30, cache_write_5m_tokens: 0 })).toBe(2700);
});

it("applies the request threshold to the 1h rate and rounds only once for the whole request", () => {
  const { prices } = fixture({ cache_creation_input_token_cost_above_1hr_above_200k_tokens: 0.00004 });
  expect(prices.estimate({ ...usage, input_total_tokens: 200000 })).toBe(2625);
  expect(prices.estimate({ ...usage, input_total_tokens: 200001 })).toBe(3025);
  expect(prices.estimate({ ...usage, uncached_input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 1, cache_write_tokens: 2, cache_write_5m_tokens: 1, cache_write_1h_tokens: 1 })).toBe(33);
});

it("rejects inconsistent TTL splits and retains the Codex cache-write guard", () => {
  const { prices } = fixture();
  for (const split of [
    { cache_write_1h_tokens: 31, cache_write_5m_tokens: null },
    { cache_write_1h_tokens: -1, cache_write_5m_tokens: null },
    { cache_write_1h_tokens: 0.5, cache_write_5m_tokens: null },
    { cache_write_1h_tokens: 20, cache_write_5m_tokens: 30 },
    { cache_write_tokens: null },
  ]) expect(prices.estimate({ ...usage, ...split })).toBeNull();
  expect(prices.estimate({ ...usage, provider: "codex" })).toBeNull();
});
