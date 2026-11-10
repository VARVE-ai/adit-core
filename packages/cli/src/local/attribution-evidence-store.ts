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
  private select;
  private selectRepository;
  private selectWrites;
  private hasFile;
  private selectFile;
  private insertBatch;

  constructor() {
    const db = this.db = new Database("");
    try {
      db.pragma("cache_size=-4096");
      db.pragma("journal_mode=MEMORY");
      db.pragma("synchronous=OFF");
      db.exec(`CREATE TABLE evidence (
        id TEXT PRIMARY KEY,provider TEXT,sessionId TEXT,turnId TEXT,toolId TEXT,kind TEXT,
        sourcePath TEXT,filePath TEXT,at INTEGER,text TEXT,"group" TEXT,repository TEXT,pathKey TEXT);
        CREATE INDEX evidence_scope ON evidence(repository,pathKey,at);
        CREATE INDEX evidence_writes ON evidence(repository,pathKey,at) WHERE kind='file_write';
        CREATE INDEX evidence_call ON evidence(repository,provider,sessionId,toolId,pathKey,at);`);
      this.insert = db.prepare("INSERT OR IGNORE INTO evidence VALUES (@id,@provider,@sessionId,@turnId,@toolId,@kind,@sourcePath,@filePath,@at,@text,@group,@repository,@pathKey)");
      this.insertBatch = db.transaction((rows: Iterable<AttributionEvidence>) => {
        let previousPath: string | null | undefined, pathKey: string | null = null;
        for (const evidence of rows) {
          if (evidence.filePath !== previousPath) {
            previousPath = evidence.filePath;
            pathKey = previousPath === null ? null : this.pathKey(previousPath);
          }
          this.insert.run({ ...evidence, pathKey });
        }
      });
      // Both branches use (repository,pathKey,at). The outer rowid lookup keeps
      // insertion order, including unlocated scripts, without scanning the repo.
      this.select = db.prepare(`SELECT * FROM evidence WHERE rowid IN (
        SELECT rowid FROM evidence WHERE repository=? AND pathKey IS NULL AND at<=?
        UNION ALL
        SELECT rowid FROM evidence WHERE repository=?
          AND pathKey IN (SELECT value FROM json_each(?)) AND at<=?
      ) ORDER BY rowid`);
      this.selectRepository = db.prepare("SELECT * FROM evidence WHERE repository=? AND at<=? ORDER BY rowid");
      this.selectWrites = db.prepare(`SELECT * FROM evidence WHERE repository=? AND kind='file_write'
        AND pathKey IN (SELECT value FROM json_each(?)) AND at<=? ORDER BY rowid`);
      this.hasFile = db.prepare("SELECT 1 FROM evidence WHERE repository=? AND pathKey=? AND at<=? LIMIT 1");
      this.selectFile = db.prepare(`SELECT * FROM evidence WHERE rowid IN (
        SELECT rowid FROM evidence WHERE repository=? AND pathKey=? AND at<=?
        UNION
        SELECT code.rowid FROM evidence target JOIN evidence code
          ON code.repository=target.repository AND code.provider=target.provider
          AND code.sessionId=target.sessionId AND code.toolId=target.toolId
          AND code.pathKey IS NULL AND code.at<=?
        WHERE target.repository=? AND target.pathKey=? AND target.at<=? AND target.kind='file_write'
      ) ORDER BY rowid`);
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

  /** Preserve insertion order and first-write wins without per-line commits. */
  addAll(evidence: Iterable<AttributionEvidence>) {
    this.insertBatch(evidence);
  }

  forCommit(repository: string, paths: string[], at: number) {
    return this.select.iterate(repository, at, repository,
      JSON.stringify(paths.map(path => this.pathKey(path))), at) as Iterable<AttributionEvidence>;
  }

  forRepository(repository: string, at: number) {
    return this.selectRepository.iterate(repository, at) as Iterable<AttributionEvidence>;
  }

  forFileWrites(repository: string, paths: string[], at: number) {
    return this.selectWrites.iterate(repository, JSON.stringify(paths.map(path => this.pathKey(path))), at) as Iterable<AttributionEvidence>;
  }

  forFile(repository: string, path: string, at: number) {
    const pathKey = this.pathKey(path);
    if (!this.hasFile.get(repository, pathKey, at))
      return { mode: "fallback" as const, evidence: {
        [Symbol.iterator]: () => this.forCommit(repository, [], at)[Symbol.iterator](),
      } };
    return { mode: "path" as const, evidence: {
      [Symbol.iterator]: () => this.selectFile.iterate(repository, pathKey, at, at, repository, pathKey, at) as IterableIterator<AttributionEvidence>,
    } };
  }

  close() {
    this.db.close();
  }
}
