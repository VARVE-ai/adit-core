import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

export const priceSource =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
type Price = {
  model: string;
  provider: string;
  aliases: string[];
  rates: Record<string, string | null>;
};
export type CostUsage = {
  provider: string;
  model: string | null;
  scope: string;
  input_total_tokens: number | null;
  uncached_input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cache_write_5m_tokens: number | null;
  cache_write_1h_tokens: number | null;
};
export type RequestCost = {
  input_cost_microusd: number;
  output_cost_microusd: number;
  cache_read_cost_microusd: number;
  cache_write_cost_microusd: number;
  cost_microusd: number;
  matched_model: string;
};
const databases = new WeakMap<Database.Database, LocalPrices>();
export function persistHistoryCosts(db: Database.Database, provider: string, sessionId: string) {
  const prices = databases.get(db) ?? new LocalPrices(db);
  prices.persist(provider, sessionId);
}
const fields = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_read_input_token_cost",
  "cache_creation_input_token_cost",
];
const pricingFields = [...fields, "cache_creation_input_token_cost_above_1hr"];
// Bare model names use the official API's reference price. Explicit channel
// IDs keep their own prices; never select an arbitrary matching suffix.
const officialModelIds = new Map([
  ["glm-5.3", "zai/glm-5.3"],
]);
function valid(value: unknown): value is string | number {
  return (
    (typeof value === "number" ||
      (typeof value === "string" && !!value.trim())) &&
    Number.isFinite(Number(value)) &&
    Number(value) >= 0
  );
}
export function parsePrices(payload: unknown): Price[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("Invalid price catalog");
  const rows: Price[] = [];
  for (const [model, raw] of Object.entries(payload)) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (
      model === "sample_spec" ||
      model.startsWith("openrouter/") ||
      row.litellm_provider === "openrouter" ||
      !["chat", "completion"].includes(String(row.mode))
    )
      continue;
    if (!valid(row[fields[0]]) || !valid(row[fields[1]])) continue;
    rows.push({
      model,
      provider: String(row.litellm_provider || "unknown"),
      aliases: Array.isArray(row.aliases)
        ? [
            ...new Set(
              row.aliases.filter(
                (x): x is string => typeof x === "string" && !!x.trim(),
              ),
            ),
          ]
        : [],
      rates: Object.fromEntries(
        Object.entries(row)
          .filter(([key]) => key.includes("cost"))
          .map(([key, value]) => [key, valid(value) ? String(value) : null]),
      ),
    });
  }
  if (!rows.length) throw new Error("No valid text model prices");
  return rows;
}
// Decimal USD/token -> exact rational microUSD, rounded once per request below.
function fraction(rate: string): [bigint, bigint] {
  const [mantissa, exponent = "0"] = rate.toLowerCase().split("e");
  const [whole, decimals = ""] = mantissa.split(".");
  const power = Number(exponent) + 6 - decimals.length;
  return power >= 0
    ? [BigInt(whole + decimals) * 10n ** BigInt(power), 1n]
    : [BigInt(whole + decimals), 10n ** BigInt(-power)];
}
export class LocalPrices {
  private prices: Price[] = [];
  private version: string | null = null;
  private fetchedAt: number | null = null;
  private nextAttempt = 0;
  private pending?: Promise<void>;
  private controller = new AbortController();
  private lookup = new Map<string, Price | null>();
  private compiled = new WeakMap<
    Price,
    { threshold: number; rate: [bigint, bigint] | null }[][]
  >();
  error: string | null = null;
  constructor(private db: Database.Database) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS adit_model_price_snapshots(version TEXT PRIMARY KEY,fetched_at INTEGER NOT NULL,source_url TEXT NOT NULL,catalog_json TEXT NOT NULL)",
    );
    db.exec(`CREATE TABLE IF NOT EXISTS adit_model_prices(
      version TEXT NOT NULL REFERENCES adit_model_price_snapshots(version), model_id TEXT NOT NULL,provider TEXT NOT NULL,
      input_rate TEXT,output_rate TEXT,cache_read_rate TEXT,cache_write_rate TEXT,currency TEXT NOT NULL,rate_unit TEXT NOT NULL,
      PRIMARY KEY(version,model_id));
      CREATE TABLE IF NOT EXISTS adit_model_price_aliases(version TEXT NOT NULL,model_id TEXT NOT NULL,alias TEXT NOT NULL,
      PRIMARY KEY(version,model_id,alias),FOREIGN KEY(version,model_id) REFERENCES adit_model_prices(version,model_id));
      CREATE INDEX IF NOT EXISTS adit_model_price_alias_lookup ON adit_model_price_aliases(version,alias);
      CREATE TABLE IF NOT EXISTS adit_model_price_rates(version TEXT NOT NULL,model_id TEXT NOT NULL,rate_key TEXT NOT NULL,rate_value TEXT,
      PRIMARY KEY(version,model_id,rate_key),FOREIGN KEY(version,model_id) REFERENCES adit_model_prices(version,model_id));
      CREATE INDEX IF NOT EXISTS adit_model_price_snapshot_time ON adit_model_price_snapshots(fetched_at DESC);`);
    this.reload();
    databases.set(db, this);
    db.exec(`CREATE TABLE IF NOT EXISTS adit_history_cost_basis (
      usage_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, pricing_status TEXT NOT NULL,
      unpriced_reason TEXT, matched_model TEXT, price_snapshot_id TEXT, pricing_version INTEGER NOT NULL,
      calculated_at INTEGER NOT NULL, costs_json TEXT NOT NULL)`);
  }
  reload() {
    const row = this.db
      .prepare(
        "SELECT version,fetched_at FROM adit_model_price_snapshots ORDER BY fetched_at DESC LIMIT 1",
      )
      .get() as { version: string; fetched_at: number } | undefined;
    if (row && row.version !== this.version) {
      const detail = this.db
        .prepare(
          "SELECT catalog_json FROM adit_model_price_snapshots WHERE version=?",
        )
        .get(row.version) as { catalog_json: string };
      this.prices = JSON.parse(detail.catalog_json);
      this.lookup.clear();
      this.version = row.version;
    }
    if (row) {
      this.fetchedAt = row.fetched_at;
      this.nextAttempt = row.fetched_at + 86_400_000;
    }
  }
  status() {
    return {
      version: this.version,
      fetchedAt: this.fetchedAt,
      error: this.error,
      source: priceSource,
    };
  }
  /** Public metadata only; never called synchronously by overview queries. */
  refresh(fetcher: typeof fetch = fetch, force = false): Promise<void> {
    if (this.pending) return this.pending;
    if (
      (!force && Date.now() < this.nextAttempt) ||
      this.controller.signal.aborted
    )
      return Promise.resolve();
    this.pending = (async () => {
      try {
        const response = await fetcher(priceSource, {
          signal: AbortSignal.any([
            this.controller.signal,
            AbortSignal.timeout(20_000),
          ]),
        });
        if (!response.ok || !response.body)
          throw new Error("Public price catalog unavailable");
        const reader = response.body.getReader(),
          chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 32 * 1024 * 1024)
              throw new Error("Price catalog exceeds 32MB");
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
        this.install(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        this.error = "公开价格更新失败，保留上次价格";
        this.nextAttempt = Date.now() + 3_600_000;
      } finally {
        this.pending = undefined;
      }
    })();
    return this.pending;
  }
  install(payload: unknown) {
    const prices = parsePrices(payload),
      json = JSON.stringify(prices),
      version = createHash("sha256").update(json).digest("hex"),
        at = Math.max(Date.now(), (this.fetchedAt ?? 0) + 1);
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO adit_model_price_snapshots VALUES(?,?,?,?) ON CONFLICT(version) DO UPDATE SET fetched_at=excluded.fetched_at",
        )
        .run(version, at, priceSource, json);
      const save = this.db.prepare(
          "INSERT INTO adit_model_prices VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(version,model_id) DO NOTHING",
        ),
        alias = this.db.prepare(
          "INSERT OR IGNORE INTO adit_model_price_aliases VALUES(?,?,?)",
        ),
        rate = this.db.prepare(
          "INSERT OR IGNORE INTO adit_model_price_rates VALUES(?,?,?,?)",
        );
      for (const p of prices) {
        save.run(
          version,
          p.model,
          p.provider,
          ...fields.map((key) => p.rates[key] ?? null),
          "USD",
          "USD/token",
        );
        for (const name of p.aliases) alias.run(version, p.model, name);
        for (const [key, value] of Object.entries(p.rates))
          rate.run(version, p.model, key, value);
      }
    })();
    this.prices = prices;
    this.lookup.clear();
    this.version = version;
    this.fetchedAt = at;
    this.error = null;
    this.nextAttempt = at + 86_400_000;
    this.persist();
  }
  persist(provider?: string, sessionId?: string) {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='adit_history_usage_entries'").get()) return;
    this.reload();
    const columns = ["input_cost_microusd", "output_cost_microusd", "cache_read_cost_microusd", "cache_write_cost_microusd", "cost_microusd"];
    const rows = this.db.prepare(`SELECT * FROM adit_history_usage_entries WHERE ledger_role='canonical' AND id>?
      ${provider === undefined ? "" : "AND provider=? AND session_id=?"} ORDER BY id LIMIT 500`);
    const read = this.db.prepare("SELECT * FROM adit_history_cost_basis WHERE usage_id=?");
    const save = this.db.prepare(`INSERT INTO adit_history_cost_basis VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(usage_id) DO UPDATE SET fingerprint=excluded.fingerprint,pricing_status=excluded.pricing_status,
      unpriced_reason=excluded.unpriced_reason,matched_model=excluded.matched_model,price_snapshot_id=excluded.price_snapshot_id,
      pricing_version=excluded.pricing_version,calculated_at=excluded.calculated_at,costs_json=excluded.costs_json`);
    const update = this.db.prepare(`UPDATE adit_history_usage_entries SET ${columns.map(name => `${name}=?`).join(",")} WHERE id=?`);
    const changed = new Set<string>();
    this.db.transaction(() => {
      let after = "";
      for (;;) {
        const batch = rows.all(after,...(provider === undefined ? [] : [provider, sessionId!])) as (CostUsage & {id:string;session_id:string;cost_microusd:number|null;completeness:string})[];
        if (!batch.length) break;
        after = batch[batch.length - 1].id;
        for (const row of batch) {
          const fingerprint = createHash("sha256").update(JSON.stringify([row.provider,row.model,row.scope,row.input_total_tokens,
            row.uncached_input_tokens,row.output_tokens,row.cache_read_tokens,row.cache_write_tokens,row.cache_write_5m_tokens,row.cache_write_1h_tokens,row.completeness])).digest("hex");
          const prior = read.get(row.id) as {fingerprint:string;pricing_status:string;price_snapshot_id:string|null;matched_model:string|null;costs_json:string}|undefined;
          let values: (number|null)[];
          if (prior?.fingerprint === fingerprint && (prior.pricing_status === "priced" || prior.price_snapshot_id === this.version)) {
            values = JSON.parse(prior.costs_json);
          } else {
            const snapshot = prior?.matched_model ? prior.price_snapshot_id : this.version;
            const cost = row.completeness === "complete" ? this.atSnapshot(row,snapshot) : null;
            values = columns.map(name => cost ? cost[name as keyof RequestCost] as number : null);
            save.run(row.id,fingerprint,cost ? "priced" : "unpriced",cost ? null : "missing_price_or_incomplete_usage",
              cost?.matched_model ?? prior?.matched_model ?? null,snapshot,1,Date.now(),JSON.stringify(values));
          }
          if (columns.some((name,index) => (row as unknown as Record<string,unknown>)[name] !== values[index])) {
            update.run(...values,row.id);
            changed.add(JSON.stringify([row.provider,row.session_id]));
          }
        }
      }
      const revision = this.db.prepare("UPDATE adit_history_sessions SET transcript_revision=transcript_revision+1 WHERE provider=? AND id=?");
      for (const key of changed) revision.run(...JSON.parse(key));
    })();
  }
  estimate(record: CostUsage): number | null {
    return this.breakdown(record)?.cost_microusd ?? null;
  }
  private atSnapshot(record: CostUsage, version: string | null): RequestCost | null {
    if (version === this.version) return this.breakdown(record);
    const snapshot = this.db.prepare("SELECT catalog_json FROM adit_model_price_snapshots WHERE version=?").get(version) as {catalog_json:string}|undefined;
    if (!snapshot) return null;
    const current = this.prices, lookup = this.lookup;
    try {
      this.prices = JSON.parse(snapshot.catalog_json);
      this.lookup = new Map();
      return this.breakdown(record);
    } finally { this.prices = current; this.lookup = lookup; }
  }
  breakdown(record: CostUsage): RequestCost | null {
    if (!record.model || record.scope !== "message") return null;
    if (!this.lookup.has(record.model)) {
      const exact = this.prices.find((p) => p.model === record.model),
        officialId = officialModelIds.get(record.model.trim().toLowerCase()),
        aliases = this.prices.filter((p) => p.aliases.includes(record.model!));
      this.lookup.set(
        record.model,
        exact || (officialId
          ? this.prices.find((p) => p.model === officialId) ?? null
          : aliases.length === 1 ? aliases[0] : null),
      );
    }
    const price = this.lookup.get(record.model);
    if (!price) return null;
    let rules = this.compiled.get(price);
    if (!rules) {
      rules = pricingFields.map((field) => {
        const pattern = new RegExp(`^${field}_above_(\\d+)k_tokens$`);
        const thresholds = Object.entries(price.rates).flatMap(
          ([key, value]) => {
            const match = pattern.exec(key);
            return match
              ? [
                  {
                    threshold: Number(match[1]) * 1000,
                    rate: value === null ? null : fraction(value),
                  },
                ]
              : [];
          },
        );
        thresholds.sort((a, b) => b.threshold - a.threshold);
        const base = price.rates[field];
        thresholds.push({
          threshold: -1,
          rate: base == null ? null : fraction(base),
        });
        return thresholds;
      });
      this.compiled.set(price, rules);
    }
    if (record.provider === "codex" && (record.cache_write_tokens ?? 0) > 0)
      return null;
    const write1h = record.cache_write_1h_tokens ?? 0;
    const write = record.provider === "codex" ? 0 : record.cache_write_tokens;
    const write5m = write === null ? null : write - write1h;
    // The total already includes both TTLs. Price the 1h portion separately,
    // without counting it again at the ordinary cache-write rate.
    if (write1h > 0 && record.cache_write_5m_tokens !== null &&
        record.cache_write_5m_tokens !== write5m) return null;
    const counts = [
      record.uncached_input_tokens,
      record.output_tokens,
      record.cache_read_tokens,
      write5m,
      write1h,
    ];
    let numerator = 0n,
      denominator = 1n;
    const parts: [bigint, bigint][] = [];
    for (let i = 0; i < counts.length; i++) {
      const count = counts[i];
      if (count === null || !Number.isSafeInteger(count) || count < 0)
        return null;
      if (!count) { parts.push([0n, 1n]); continue; }
      const rule = rules[i].find(
        ({ threshold }) =>
          threshold < 0 ||
          (record.input_total_tokens !== null &&
            record.input_total_tokens > threshold),
      )!;
      if (rule.rate === null) return null;
      const [n, d] = rule.rate;
      parts.push([n * BigInt(count), d]);
      numerator = numerator * d + n * BigInt(count) * denominator;
      denominator *= d;
    }
    const amount = Number((numerator + denominator / 2n) / denominator);
    if (!Number.isSafeInteger(amount)) return null;
    const combined = [parts[0], parts[1], parts[2],
      [parts[3][0] * parts[4][1] + parts[4][0] * parts[3][1], parts[3][1] * parts[4][1]] as [bigint, bigint]];
    const allocated = combined.map(([value, divisor]) => value / divisor);
    const order = combined.map(([value, divisor], index) => ({ index, remainder: value % divisor, divisor }))
      .sort((left, right) => {
        const difference = left.remainder * right.divisor - right.remainder * left.divisor;
        return difference > 0n ? -1 : difference < 0n ? 1 : left.index - right.index;
      });
    const remaining = BigInt(amount) - allocated.reduce((sum, value) => sum + value, 0n);
    for (let index = 0; index < Number(remaining); index++) allocated[order[index].index]++;
    return { input_cost_microusd: Number(allocated[0]), output_cost_microusd: Number(allocated[1]),
      cache_read_cost_microusd: Number(allocated[2]), cache_write_cost_microusd: Number(allocated[3]),
      cost_microusd: amount, matched_model: price.model };
  }
  async close() {
    this.controller.abort();
    await this.pending;
  }
}
