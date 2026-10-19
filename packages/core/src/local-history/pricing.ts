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
const fields = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_read_input_token_cost",
  "cache_creation_input_token_cost",
];
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
      at = Date.now();
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
  }
  estimate(record: CostUsage): number | null {
    if (!record.model || record.scope !== "message") return null;
    if (!this.lookup.has(record.model)) {
      const exact = this.prices.find((p) => p.model === record.model),
        aliases = this.prices.filter((p) => p.aliases.includes(record.model!));
      this.lookup.set(
        record.model,
        exact || (aliases.length === 1 ? aliases[0] : null),
      );
    }
    const price = this.lookup.get(record.model);
    if (!price) return null;
    if (record.provider === "codex" && (record.cache_write_tokens ?? 0) > 0)
      return null;
    const counts = [
      record.uncached_input_tokens,
      record.output_tokens,
      record.cache_read_tokens,
      record.provider === "codex" ? 0 : record.cache_write_tokens,
    ];
    let numerator = 0n,
      denominator = 1n;
    for (let i = 0; i < counts.length; i++) {
      const count = counts[i];
      if (count === null || !Number.isSafeInteger(count) || count < 0)
        return null;
      if (!count) continue;
      // A known TTL split needs an exact matching price; do not apply generic creation pricing.
      if (i === 3 && (record.cache_write_1h_tokens ?? 0) > 0) return null;
      let rate = price.rates[fields[i]],
        threshold = -1;
      for (const [key, value] of Object.entries(price.rates)) {
        const match = new RegExp(`^${fields[i]}_above_(\\d+)k_tokens$`).exec(
          key,
        );
        if (
          match &&
          record.input_total_tokens !== null &&
          record.input_total_tokens > Number(match[1]) * 1000 &&
          Number(match[1]) > threshold
        ) {
          threshold = Number(match[1]);
          rate = value;
        }
      }
      if (rate === undefined || rate === null) return null;
      const [n, d] = fraction(rate);
      numerator = numerator * d + n * BigInt(count) * denominator;
      denominator *= d;
    }
    const amount = Number((numerator + denominator / 2n) / denominator);
    return Number.isSafeInteger(amount) ? amount : null;
  }
  async close() {
    this.controller.abort();
    await this.pending;
  }
}
