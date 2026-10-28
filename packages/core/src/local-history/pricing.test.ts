import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { LocalPrices, type CostUsage } from "./pricing.js";
import { createHistorySchema } from "./schema.js";
import { StructuredHistory } from "./structured-store.js";

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

it("allocates sub-microUSD remainders while retaining the original rounded total", () => {
  const {prices} = fixture();
  const cost = prices.breakdown({...usage,uncached_input_tokens:0,output_tokens:0,cache_read_tokens:1,
    cache_write_tokens:2,cache_write_5m_tokens:1,cache_write_1h_tokens:1})!;
  expect(cost.cost_microusd).toBe(33);
  expect(cost.input_cost_microusd+cost.output_cost_microusd+cost.cache_read_cost_microusd+cost.cache_write_cost_microusd).toBe(33);
});

it("persists fees, freezes saved prices and refines corrected usage using the original snapshot", () => {
  const {db,prices} = fixture();
  createHistorySchema(db);
  const history = new StructuredHistory(db);
  const session = {id:"saved",provider:"claude",cwd:"/project",messages:[
    {key:"u",role:"user",content:"question",timestamp:"2026-10-27T00:00:00Z",raw:{}},
    {key:"a",role:"assistant",content:"answer",timestamp:"2026-10-27T00:01:00Z",model:usage.model!,raw:{},
      usage:{input_tokens:100,output_tokens:20,cache_read_input_tokens:400,cache_creation_input_tokens:30,
        cache_creation:{ephemeral_5m_input_tokens:10,ephemeral_1h_input_tokens:20}}},
  ]};
  history.write(session);
  const read = () => db.prepare("SELECT * FROM adit_history_usage_entries WHERE ledger_role='canonical'").get() as Record<string,unknown>;
  expect(read()).toMatchObject({input_cost_microusd:1000,output_cost_microusd:1000,
    cache_read_cost_microusd:100,cache_write_cost_microusd:525,cost_microusd:2625});
  const revision = () => (db.prepare("SELECT transcript_revision FROM adit_history_sessions").get() as {transcript_revision:number}).transcript_revision;
  const before = revision();
  prices.install({[usage.model!]:{...rates,input_cost_per_token:0.0001}});
  expect(read().cost_microusd).toBe(2625);
  expect(revision()).toBe(before);
  session.messages[1].usage!.input_tokens = 200;
  history.write(session);
  expect(read().cost_microusd).toBe(3625);
  expect(revision()).toBeGreaterThan(before);
});

it("fills previously unpriced usage when prices arrive and advances its sync revision", () => {
  const db = new Database(":memory:");databases.push(db);createHistorySchema(db);
  const prices = new LocalPrices(db), history = new StructuredHistory(db);
  history.write({id:"pending",provider:"codex",cwd:"/project",messages:[
    {key:"u",role:"user",content:"question",raw:{}},
    {key:"a",role:"assistant",content:"answer",raw:{},model:"test",usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1,total_tokens:2}},
  ]});
  expect(db.prepare("SELECT cost_microusd FROM adit_history_usage_entries").get()).toEqual({cost_microusd:null});
  const before = db.prepare("SELECT transcript_revision FROM adit_history_sessions").get() as {transcript_revision:number};
  prices.install({test:{mode:"chat",input_cost_per_token:0.000001,output_cost_per_token:0.000001}});
  expect(db.prepare("SELECT cost_microusd FROM adit_history_usage_entries").get()).toEqual({cost_microusd:2});
  expect((db.prepare("SELECT transcript_revision FROM adit_history_sessions").get() as {transcript_revision:number}).transcript_revision).toBeGreaterThan(before.transcript_revision);
});
