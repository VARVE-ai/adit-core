import type Database from "better-sqlite3";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

function checkpoint(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // No LocalStore/schema initialization in this worker. It only checkpoints
    // committed pages, and leaves WAL in place when readers still need it.
    const worker = new Worker(`
      const { workerData } = require('node:worker_threads');
      const Database = require(workerData.sqlite);
      const db = new Database(workerData.path, { fileMustExist: true, timeout: 0 });
      try {
        const [result] = db.pragma('wal_checkpoint(PASSIVE)');
        if (!result.busy && result.log === result.checkpointed)
          db.pragma('wal_checkpoint(TRUNCATE)');
      } finally { db.close(); }
    `, { eval: true, workerData: { path, sqlite: createRequire(import.meta.url).resolve("better-sqlite3") } });
    worker.once("error", reject);
    worker.once("exit", code => code === 0 ? resolve() : reject(new Error("Background checkpoint interrupted")));
  });
}

/** Keep atomic deletion; perform its potentially large checkpoint off the HTTP thread. */
export class DeletionCheckpoint {
  private pending: Promise<void> = Promise.resolve();
  constructor(private db: Database.Database, private flush: () => Promise<void> = () => checkpoint(db.name)) {}

  run<T>(action: () => T): T {
    if (this.db.inTransaction) throw new Error("Deletion checkpoint requires the outer transaction");
    const previous = this.db.pragma("wal_autocheckpoint", { simple: true }) as number;
    this.db.pragma("wal_autocheckpoint=0");
    try {
      const result = action();
      this.pending = this.pending.then(this.flush).catch(() => {
        // The committed WAL remains valid. Restored automatic checkpoints and
        // the next deletion can retry without reporting a successful delete as failed.
      });
      return result;
    } finally { this.db.pragma(`wal_autocheckpoint=${previous}`); }
  }

  async close(): Promise<void> { await this.pending; }
}
