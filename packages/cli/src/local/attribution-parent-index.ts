import { createHash } from "node:crypto";
import { normalizeLine } from "./attribution-evidence.js";
import { AttributionGitObjects, type GitTreeFile } from "./attribution-git-objects.js";
import { parentMatchingLines, type ParentScanTiming } from "./attribution-parent-lines.js";

/** Mirrors the fixed Git exclusion pathspecs in attribution-analysis. */
export const parentSourceFile = (path: string) =>
  !/(?:^|\/)(?:node_modules|dist|build|vendor|migrations|__snapshots__|tmp|\.cache|coverage)\//.test(
    path,
  ) &&
  !/(?:\.log|\.map|\.lock|\.snap|\.tsbuildinfo|\.min\.[^/]*|(?:^|\/)pnpm-lock\.yaml|(?:^|\/)package-lock\.json)$/.test(
    path,
  );

/** File contents are immutable; membership in the current parent is not. */
export class AttributionParentIndex {
  private lookup;
  private readBinary;
  private insert;
  private save;
  private activate;
  private match;
  constructor(private objects: AttributionGitObjects) {
    const db = objects.db;
    db.exec(`CREATE TABLE parent_blobs(id INTEGER PRIMARY KEY,repository TEXT,oid TEXT,binary INTEGER,raw BLOB,error INTEGER,UNIQUE(repository,oid));
      CREATE TABLE parent_lines(hash BLOB,blob INTEGER,line TEXT);
      CREATE INDEX parent_lines_text ON parent_lines(hash,blob);
      CREATE TABLE active_parent(id INTEGER PRIMARY KEY);`);
    this.lookup = db.prepare(
      "SELECT id,binary,raw IS NOT NULL hasRaw,error FROM parent_blobs WHERE repository=? AND oid=?",
    );
    this.readBinary = db.prepare("SELECT raw FROM parent_blobs WHERE id=?");
    this.save =
      db.prepare(`INSERT INTO parent_blobs(repository,oid,binary,raw,error) VALUES (?,?,?,?,?)
      ON CONFLICT(repository,oid) DO UPDATE SET binary=excluded.binary,raw=excluded.raw,error=excluded.error RETURNING id`);
    this.insert = db.prepare("INSERT INTO parent_lines VALUES (?,?,?)");
    this.activate = db.prepare("INSERT OR IGNORE INTO active_parent VALUES (?)");
    // Hash narrows the lookup; compare the original normalized text as well.
    this.match =
      db.prepare(`SELECT json_extract(value,'$.line') line FROM json_each(?) wanted WHERE EXISTS (
      SELECT 1 FROM parent_lines l JOIN active_parent p ON p.id=l.blob
      WHERE l.hash=unhex(json_extract(wanted.value,'$.hash')) AND l.line=json_extract(wanted.value,'$.line'))`);
  }
  async matching(
    repository: string,
    parent: string,
    files: Map<string, GitTreeFile>,
    paths: string[],
    wanted: Set<string>,
    signal?: AbortSignal,
    diagnostic?: (timing: ParentScanTiming) => void,
  ) {
    const started = performance.now();
    let bytes = 0,
      lines = 0,
      processingMs = 0,
      indexedBlobs = 0,
      reusedBlobs = 0;
    const selected = [...files].filter(
      ([path, file]) =>
        /^100(?:644|755)$/.test(file.mode) &&
        file.size <= 8 * 1024 * 1024 &&
        parentSourceFile(path),
    );
    const attributes = await this.objects.diffAttributes(
      repository,
      selected.map(([path]) => path),
      signal,
    );
    // Named diff drivers can override binary detection. Retain Git's exact
    // behavior for that uncommon configuration instead of guessing the driver.
    if ([...attributes.values()].some((value) => !["set", "unset", "unspecified"].includes(value)))
      return parentMatchingLines(repository, parent, paths, wanted, signal, undefined, diagnostic);
    const needed = new Map<string, { file: GitTreeFile; forceText: boolean }>();
    for (const [path, file] of selected) {
      const attr = attributes.get(path);
      if (attr === "unset") continue;
      const old = needed.get(file.oid);
      needed.set(file.oid, { file, forceText: attr === "set" || !!old?.forceText });
    }
    const db = this.objects.db;
    // This connection belongs exclusively to one sequential analysis. Batch the
    // writes across async object reads; per-file/autocommit flushes dwarf matching.
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM active_parent");
      for (const [oid, { file, forceText }] of needed) {
        signal?.throwIfAborted();
        let saved = this.lookup.get(repository, oid) as
          { id: number; binary: number; hasRaw: number; error: number } | undefined;
        if (!saved || (saved.hasRaw && forceText)) {
          const raw = saved?.hasRaw
            ? (this.readBinary.get(saved.id) as { raw: Buffer }).raw
            : undefined;
          const body = raw || (await this.objects.read(repository, oid, file.size, signal)).body!;
          if (!saved) bytes += body.length;
          const processingStarted = performance.now();
          const binary = body.subarray(0, 8000).includes(0);
          const text = binary && !forceText ? [] : body.toString("utf8").split("\n");
          const error = text.some((line) => line.length > 1024 * 1024);
          const normalized = new Set<string>();
          if (!error)
            for (const line of text) {
              lines++;
              const value = normalizeLine(line);
              if (value) normalized.add(value);
            }
          {
            const { id } = this.save.get(
              repository,
              oid,
              Number(binary),
              binary && !forceText ? body : null,
              Number(error),
            ) as { id: number };
            if ((!binary || forceText) && !error) {
              for (const line of normalized)
                this.insert.run(createHash("sha256").update(line).digest(), id, line);
            }
            saved = {
              id,
              binary: Number(binary),
              hasRaw: Number(binary && !forceText),
              error: Number(error),
            };
          }
          processingMs += performance.now() - processingStarted;
          indexedBlobs++;
        } else reusedBlobs++;
        if (saved!.binary && !forceText) continue;
        if (saved!.error)
          throw new Error(
            "A parent text line exceeds the analysis size limit; commit analysis remains pending",
          );
        this.activate.run(saved!.id);
      }
      const query = [...wanted].map((line) => ({
        line,
        hash: createHash("sha256").update(line).digest("hex"),
      }));
      const matches = new Set(
        (this.match.all(JSON.stringify(query)) as { line: string }[]).map((row) => row.line),
      );
      db.exec("COMMIT");
      try {
        diagnostic?.({
          totalMs: Math.round((performance.now() - started) * 100) / 100,
          spawnMs: null,
          firstOutputMs: null,
          processingMs: Math.round(processingMs * 100) / 100,
          bytes,
          lines,
          wantedLines: wanted.size,
          matchedLines: matches.size,
          exitCode: 0,
          failed: false,
          indexedBlobs,
          reusedBlobs,
          mode: "objects",
        });
      } catch {
        /* Diagnostics cannot affect the result. */
      }
      return matches;
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
}
