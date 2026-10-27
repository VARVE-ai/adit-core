import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";

const reads = new AsyncLocalStorage<Map<string, string>>();
const snapshots = new AsyncLocalStorage<Map<string, (() => boolean)[]>>();
export function trackSourceSnapshot(path: string, validate: () => boolean): void {
  const active = snapshots.getStore();
  if (!active) return;
  path = resolve(path);
  active.set(path, [...(active.get(path) || []), validate]);
}
export function sourceStamp(path: string): string {
  try {
    const s = lstatSync(path, { bigint: true });
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode].join(":");
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "")) return "missing";
    throw error;
  }
}
export function trackSource(path: string): void {
  const active = reads.getStore();
  if (!active) return;
  path = resolve(path);
  if (!active.has(path)) active.set(path, sourceStamp(path));
}
export async function trackSourceReads<T>(path: string, read: () => Promise<T>) {
  const manifest = new Map<string, string>();
  const validators = new Map<string, (() => boolean)[]>();
  const value = await snapshots.run(validators, () => reads.run(manifest, async () => { trackSource(path); return read(); }));
  const changed = [...manifest].filter(([file, stamp]) => sourceStamp(file) !== stamp);
  return { value, manifest: [...manifest], changed: changed.length > 0,
    stable: changed.every(([file]) => validators.has(file) && validators.get(file)!.every(validate => validate())) };
}

/** Checkpoints contain dependency metadata and identities, never a second transcript blob. */
export class SourceCheckpoints {
  constructor(private db: Database.Database) {}
  unchanged(provider: string, path: string, scope: string, version: number, contains: (root:string,path:string)=>boolean): [string, string][] | undefined {
    const rows = this.db.prepare("SELECT scope,manifest_json,sessions_json FROM adit_history_file_checkpoints WHERE provider=? AND path=? AND parser_version=? ORDER BY (scope=?) DESC")
      .all(provider, path, version, scope) as { scope:string; manifest_json: string; sessions_json: string }[];
    const [root,requested]=JSON.parse(scope) as [string,string[]];
    const exists = this.db.prepare("SELECT 1 FROM adit_history_sessions WHERE provider=? AND id=?");
    for(const row of rows){
      // Cursor's encoded directory resolution depends on the exact search roots.
      if(provider==="cursor" && row.scope!==scope)continue;
      const [collectedRoot,covered]=JSON.parse(row.scope) as [string,string[]];
      if(root!==collectedRoot || !requested.every(wanted=>covered.some(previous=>contains(previous,wanted))))continue;
      const manifest = JSON.parse(row.manifest_json) as [string, string][];
      if (!manifest.every(([file, stamp]) => sourceStamp(file) === stamp)) continue;
      const sessions=JSON.parse(row.sessions_json) as [string,string][];
      if(sessions.every(([p,id])=>!!exists.get(p,id)))return sessions;
    }
  }
  save(provider: string, path: string, scope: string, version: number, manifest: [string, string][], sessions: [string, string][]): void {
    this.db.prepare(`INSERT INTO adit_history_file_checkpoints VALUES (?,?,?,?,?,?)
      ON CONFLICT(provider,path,scope) DO UPDATE SET parser_version=excluded.parser_version,manifest_json=excluded.manifest_json,sessions_json=excluded.sessions_json`)
      .run(provider, path, scope, version, JSON.stringify(manifest), JSON.stringify(sessions));
  }
}
