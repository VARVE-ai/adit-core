import type Database from "better-sqlite3";

export function createCloudPendingSchema(db: Database.Database) {
  db.exec("CREATE TABLE IF NOT EXISTS adit_local_pending_revisions (key TEXT PRIMARY KEY, revision INTEGER NOT NULL)");
  const sessionTables = [
    ["adit_history_sessions", "id"],
    ["adit_history_usage_entries", "session_id"],
    ["adit_history_deleted_turns", "session_id"],
    ["adit_history_text_edits", "session_id"],
  ];
  const identityTables = [
    "adit_history_sources", "adit_history_assignments", "adit_local_project_sessions",
  ];
  const scopeTables = [
    ["adit_local_cloud_scopes", "id"],
    ["adit_local_cloud_sessions", "scope"],
    ["adit_local_cloud_receipts", "scope"],
  ];
  const tables = [
    ...sessionTables.map(([table, column]) => ({ table, key: (row: string) => `'session:' || json_array(${row}.provider,${row}.${column})` })),
    ...identityTables.map(table => ({ table, key: () => "'identity'" })),
    ...scopeTables.map(([table, column]) => ({ table, key: (row: string) => `'scope:' || ${row}.${column}` })),
    ...["adit_local_commits", "adit_local_commit_parents", "adit_local_project_repositories", "adit_local_repository_locations"]
      .map(table => ({ table, key: () => "'commits'" })),
  ];
  const identityColumns: Record<string, string[]> = {
    adit_history_sources: ["provider", "path", "session_id"],
    adit_history_assignments: ["provider", "session_id", "workspace"],
    adit_local_project_sessions: ["workspace_id", "provider", "session_id", "original_root", "relative_cwd"],
  };
  db.transaction(() => {
    for (const { table, key } of tables) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        const rows = operation === "UPDATE" ? ["OLD", "NEW"] : [operation === "DELETE" ? "OLD" : "NEW"];
        const keys = [...new Set(["'all'", ...rows.map(key)])];
        const columns = identityColumns[table];
        const condition = operation === "UPDATE" && columns
          ? `WHEN ${columns.map(column => `OLD.${column} IS NOT NEW.${column}`).join(" OR ")}` : "";
        db.exec(`CREATE TRIGGER IF NOT EXISTS pending_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON ${table} ${condition} BEGIN
          ${keys.map(value => `INSERT INTO adit_local_pending_revisions VALUES (${value},1)
            ON CONFLICT(key) DO UPDATE SET revision=revision+1;`).join("\n")}
          END`);
      }
    }
  })();
}

export function pendingRevision(db: Database.Database, key = "all"): number {
  return (db.prepare("SELECT revision FROM adit_local_pending_revisions WHERE key=?").get(key) as { revision: number } | undefined)?.revision ?? 0;
}
