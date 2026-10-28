import Database from "better-sqlite3";
import { resolve } from "node:path";

export type AttributionEvidence = {
  id: string;
  provider: string;
  sessionId: string;
  turnId: string | null;
  toolId: string | null;
  kind: string;
  sourcePath: string | null;
  filePath: string | null;
  at: number;
  text: string;
  group: string;
  repository: string | null;
};

export class AttributionEvidenceStore {
  private db: Database.Database;
  private insert;

  constructor() {
    const db = this.db = new Database("");
    try {
      db.pragma("cache_size=-4096");
      db.pragma("journal_mode=OFF");
      db.pragma("synchronous=OFF");
      db.exec(`CREATE TABLE evidence (
        id TEXT PRIMARY KEY,provider TEXT,sessionId TEXT,turnId TEXT,toolId TEXT,kind TEXT,
        sourcePath TEXT,filePath TEXT,at INTEGER,text TEXT,"group" TEXT,repository TEXT,pathKey TEXT);
        CREATE INDEX evidence_scope ON evidence(repository,pathKey,at);`);
      this.insert = db.prepare("INSERT OR IGNORE INTO evidence VALUES (@id,@provider,@sessionId,@turnId,@toolId,@kind,@sourcePath,@filePath,@at,@text,@group,@repository,@pathKey)");
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private pathKey(path: string): string {
    const absolute = resolve(path);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  }

  add(evidence: AttributionEvidence) {
    this.insert.run({ ...evidence, pathKey: evidence.filePath === null ? null : this.pathKey(evidence.filePath) });
  }

  forCommit(repository: string, paths: string[], at: number) {
    return this.db.prepare(`SELECT * FROM evidence WHERE repository=? AND at<=?
      AND (pathKey IS NULL OR pathKey IN (SELECT value FROM json_each(?))) ORDER BY rowid`)
      .iterate(repository, at, JSON.stringify(paths.map(path => this.pathKey(path)))) as Iterable<AttributionEvidence>;
  }

  close() {
    this.db.close();
  }
}
