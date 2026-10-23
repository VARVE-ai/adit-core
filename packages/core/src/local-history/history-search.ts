import type Database from "better-sqlite3";

/** Retire derived search copies; original blocks and ordinary lookup indexes remain. */
export function removeHistorySearchIndex(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      DROP TRIGGER IF EXISTS adit_history_blocks_insert;
      DROP TRIGGER IF EXISTS adit_history_blocks_delete;
      DROP TRIGGER IF EXISTS adit_history_blocks_update;
      DROP TABLE IF EXISTS adit_history_text_fts;
      DROP VIEW IF EXISTS adit_history_search_content;
    `);
    db.prepare("DELETE FROM adit_history_inspection_meta WHERE key='safe-index'").run();
  })();
}

/** SQL identifiers are supplied by code, never user input. Redact only candidates. */
export function historyTextMatch(column: string): string {
  // A query containing the masking character may match newly masked text even
  // though the original body does not contain that character.
  return `CASE WHEN @masked=1 OR ${column} LIKE @pattern ESCAPE '\\'
    THEN adit_history_redact(${column}) LIKE @pattern ESCAPE '\\' ELSE 0 END`;
}
