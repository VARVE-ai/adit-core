import type Database from "better-sqlite3";

type Identity = {id:string;parent_id:string|null;relationship:string|null};
/** Physical segments retain their IDs, source checkpoints and local edits. */
export function nativeConversationId(session: Identity): string {
  return session.relationship === "continuation" && session.parent_id ? session.parent_id : session.id;
}

export function conversationSegments(db: Database.Database, provider: string, id: string): string[] {
  const row=db.prepare("SELECT id,parent_id,relationship FROM adit_history_sessions WHERE provider=? AND id=?").get(provider,id) as Identity|undefined;
  if(!row)return [];
  const native=nativeConversationId(row);
  return (db.prepare(`SELECT id FROM adit_history_sessions WHERE provider=? AND
    (id=? OR (relationship='continuation' AND parent_id=?)) ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,started_at,id`)
    .all(provider,native,native,native) as {id:string}[]).map(s=>s.id);
}

export function conversationRevision(db:Database.Database,provider:string,id:string):number|null {
  return (db.prepare("SELECT sum(transcript_revision) revision FROM adit_history_sessions WHERE provider=? AND id IN (SELECT value FROM json_each(?))")
    .get(provider,JSON.stringify(conversationSegments(db,provider,id))) as {revision:number|null}).revision;
}

/** Display identity falls back to the first available segment if the root is absent. */
export function conversationScope<T extends Identity & {provider:string}>(rows:T[]): (T & {conversation_id:string})[] {
  const groups=new Map<string,T[]>();
  for(const row of rows){const key=`${row.provider}\0${nativeConversationId(row)}`;const group=groups.get(key)||[];group.push(row);groups.set(key,group);}
  return rows.map(row=>{const native=nativeConversationId(row),group=groups.get(`${row.provider}\0${native}`)!;
    return {...row,conversation_id:group.find(s=>s.id===native)?.id||group[0].id};});
}
