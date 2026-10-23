import { analyticsSessions, projectUploadRepositories, nativeContextSql, type LocalStore, type LocalWorkspace } from "@varveai/adit-core";
import { cloudCommitSelection, cloudFinalReply, cloudTurnUsage, syncKey, type CloudBaseline } from "./cloud-projection.js";

export type CloudPending =
  | { state: "ready"; sessions: number; commits: number }
  | { state: "disabled" | "disconnected" | "uninitialized" | "unverified"; sessions: null; commits: null };

/** Counts unconfirmed prompts/replies independently, plus commits awaiting upload/analysis.
 * No transcript parsing, Cloud requests, mapping creation or upload confirmations on a status read. */
export function cloudPending(store: LocalStore, workspace: LocalWorkspace, scope: string, baseline: CloudBaseline): CloudPending {
  const db = store.db;
  const cutoff = baseline.before ? Date.parse(baseline.before) : null;
  const revision = db.prepare("SELECT revision FROM adit_local_cloud_sessions WHERE scope=? AND provider=? AND native_id=?");
  const receipt = db.prepare("SELECT 1 FROM adit_local_cloud_receipts WHERE scope=? AND kind=? AND id=?");
  const turns = db.prepare(`SELECT t.id,t.prompt_message_id,m.occurred_at,
    EXISTS(SELECT 1 FROM adit_history_turns later WHERE later.provider=t.provider AND later.session_id=t.session_id AND later.ordinal>t.ordinal) has_next
    FROM adit_history_turns t JOIN adit_history_messages m ON m.id=t.prompt_message_id
    WHERE t.provider=? AND t.session_id=? AND (? IS NULL OR t.ended_at IS NULL OR t.ended_at>?)
    AND NOT ${nativeContextSql()}
    AND NOT EXISTS(SELECT 1 FROM adit_history_deleted_turns d WHERE d.provider=t.provider AND d.session_id=t.session_id AND d.prompt_key=m.source_key)
    AND EXISTS(SELECT 1 FROM adit_history_blocks b LEFT JOIN adit_history_text_edits e
      ON e.provider=m.provider AND e.session_id=m.session_id AND e.message_key=m.source_key AND e.block_index=b.block_index
      WHERE b.message_id=m.id AND (b.kind IN ('input_image','image','image_url') OR
        (b.kind IN ('text','input_text','output_text') AND trim(coalesce(e.text_content,b.text_content,''),char(9)||char(10)||char(13)||' ')<>'')))`);
  const sessions=new Set<string>();let commits = 0;
  for (const s of analyticsSessions(db,workspace)) {
    const saved = revision.get(scope,s.provider,s.id) as {revision:number} | undefined;
    if (saved?.revision === s.transcript_revision) continue;
    const visible = turns.all(s.provider,s.id,cutoff,cutoff) as {id:string;prompt_message_id:string;occurred_at:number|null;has_next:number}[];
    if (visible.some(t => {
      if ((cutoff===null || (t.occurred_at!==null && t.occurred_at>cutoff)) &&
        !receipt.get(scope,"event",`lh_${syncKey(scope,t.prompt_message_id)}`)) return true;
      const final=cloudFinalReply(store,t.id,!!t.has_next);
      if(!final || (cutoff!==null && (final.occurred_at===null || final.occurred_at<=cutoff)))return false;
      return !receipt.get(scope,"event",`lh_${syncKey(scope,final.id)}`) ||
        !receipt.get(scope,"usage",syncKey(t.id,cloudTurnUsage(store,t.id)));
    })) sessions.add(`${s.provider}\0${s.conversation_id}`);
  }
  for (const repo of projectUploadRepositories(db,workspace)) {
    const selection = cloudCommitSelection(store,scope,baseline,repo);
    // The legacy boundary cannot safely be guessed from the local archive total.
    if (!selection) return {state:"unverified",sessions:null,commits:null};
    commits += (db.prepare(`SELECT count(*) n FROM adit_local_commits c WHERE ${selection.where}`)
      .get(...selection.params) as {n:number}).n;
  }
  return {state:"ready",sessions:sessions.size,commits};
}
