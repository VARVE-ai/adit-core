import { createHash, randomBytes } from "node:crypto";
import type { LocalStore } from "@varveai/adit-core";

export const BROWSER_SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Browser authorization only; unrelated to collected Agent conversations. */
export class BrowserSessions {
  constructor(private store: LocalStore) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS adit_local_browser_sessions (
        session_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS adit_local_browser_sessions_expiry
        ON adit_local_browser_sessions(expires_at);
    `);
  }

  issue(): string {
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    this.store.db.transaction(() => {
      this.store.db
        .prepare("DELETE FROM adit_local_browser_sessions WHERE expires_at<=?")
        .run(now);
      this.store.db
        .prepare("INSERT INTO adit_local_browser_sessions VALUES (?,?,?)")
        .run(hash(token), now, now + BROWSER_SESSION_MAX_AGE * 1000);
      this.store.db
        .prepare(
          "DELETE FROM adit_local_browser_sessions WHERE rowid IN (SELECT rowid FROM adit_local_browser_sessions ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 100)",
        )
        .run();
    })();
    return token;
  }

  valid(token: string | undefined): boolean {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
    return !!this.store.db
      .prepare(
        "SELECT 1 FROM adit_local_browser_sessions WHERE session_hash=? AND expires_at>?",
      )
      .get(hash(token), Date.now());
  }
}
