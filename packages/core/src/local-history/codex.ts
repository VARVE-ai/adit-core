import { basename } from "node:path";
import { isCompactedReply } from "./message-semantics.js";
import { requireSession } from "./provider-common.js";
import { HistoryFormatError, jsonLines, record, string, type HistoryMessage, type HistorySession } from "./types.js";

/** Desktop page state is not a prompt. Native kinds distinguish it from user quotations. */
function isPageContext(payload: Record<string, unknown>): boolean {
  const kinds = record(payload.internal_chat_message_metadata_passthrough).content_item_kinds;
  return payload.type === "message" && payload.role === "user" &&
    Array.isArray(kinds) && kinds.length > 0 &&
    kinds.every(kind => kind === "additional_content.codex_apps_open_page");
}

/** A page can point to the previous page while retaining the same native thread. */
export function codexContinuationRoot(meta: Record<string,unknown>, physicalId:string): string | null {
  const root=string(meta.id), legacy=string(meta.session_id), base=string(record(meta.history_base).thread_id);
  if(!root || meta.forked_from_id || (legacy && legacy!==root) || !physicalId.startsWith(`${root}_`))return null;
  if(!/^[a-f\d-]{36}$/i.test(physicalId.slice(root.length+1)))return null;
  return base===root || (legacy===root && /^[a-f\d-]{36}$/i.test(base)) ? root : null;
}

export function parseCodex(text: string, parentTurns?: ReadonlySet<string>,path?:string): HistorySession {
  return parseCodexRows(jsonLines(text),parentTurns,path);
}
export function parseCodexRows(rows:Iterable<Record<string,unknown>>, parentTurns?:ReadonlySet<string>,path?:string):HistorySession {
  const session: HistorySession = {
    id: "",
    provider: "codex",
    cwd: "",
    messages: [],
  };
  let model = "",
    effort = "",
    usageDigest = "",
    lastAssistant = -1;
  const ids = new Map<string, number>();
  const turns=new Set<string>();let replay=false,parent="",positive=false;
  let nativeMeta:Record<string,unknown>={};
  for (const row of rows) {
    const payload = record(row.payload);
    const type = string(row.type);
    if (type === "session_meta") {
      const id = string(payload.id);
      if(session.id&&id===parent){positive=true;replay=!!parentTurns;continue;}
      if (session.id && id && session.id !== id)
        throw new HistoryFormatError(
          "Multiple Codex session identities in one source",
        );
      session.id = id || session.id;
      nativeMeta=payload;
      session.cwd = string(payload.cwd) || session.cwd;
      const subagent =
        string(
          record(record(record(payload.source).subagent).thread_spawn)
            .parent_thread_id,
        ) || undefined;
      parent=string(payload.forked_from_id)||subagent||"";
      session.parentId=parent||undefined;
      if(parent)session.relationship=payload.forked_from_id?"fork":"subagent";
      if(payload.forked_from_id){positive=true;replay=!!parentTurns;}
      session.metadata={...session.metadata,historyBase:payload.history_base};
      continue;
    }
    if(type==="turn_context"){
      const turn=string(payload.turn_id);if(turn)turns.add(turn);
      if(replay&&(!turn||!parentTurns?.has(turn)))replay=false;
    }
    if(replay)continue;
    if (type === "turn_context") {
      model = string(payload.model);
      effort = string(payload.effort);
      continue;
    }
    if (type === "event_msg") {
      if (payload.type === "task_started") usageDigest = "";
      if (["task_complete", "task_completed"].includes(string(payload.type)) && lastAssistant >= 0) {
        const completed = session.messages[lastAssistant];
        const native = record(completed.raw.payload);
        if (["message", "agent_message"].includes(string(native.type)) && !["analysis", "commentary"].includes(string(native.phase ?? native.channel))) completed.finalReply = true;
      }
      if (payload.type === "token_count") {
        const usage = record(record(payload.info).last_token_usage);
        const digest = JSON.stringify(usage);
        if (
          Object.keys(usage).length &&
          lastAssistant >= 0 &&
          digest !== usageDigest
        ) {
          const target = session.messages[lastAssistant];
          if (!target.usage) target.usage = usage;
          usageDigest = digest;
        }
      }
      continue;
    }
    if(type==="compacted" && lastAssistant>=0 && isCompactedReply(row,session.messages[lastAssistant].raw))session.messages[lastAssistant].contextKind="compaction";
    if (type !== "response_item") continue;
    const kind = string(payload.type);
    const role =
      string(payload.role) || (kind.endsWith("_output") ? "tool" : "assistant");
    if (
      kind !== "message" &&
      ![
        "function_call",
        "function_call_output",
        "custom_tool_call",
        "custom_tool_call_output",
        "reasoning",
        "agent_message",
      ].includes(kind)
    )
      continue;
    if (role === "user" && !isPageContext(payload)) {
      lastAssistant = -1;
      usageDigest = "";
    }
    const key = string(payload.id) || `${kind}:${session.messages.length}`;
    const message: HistoryMessage = {
      key,
      role,
      timestamp: string(row.timestamp) || undefined,
      model: string(payload.model) || model || undefined,
      effort: effort || undefined,
      content:
        payload.content ??
        payload.summary ??
        payload.output ??
        payload.arguments ??
        payload.input ??
        payload,
      raw: row,
    };
    const existing = ids.get(key);
    const index = existing ?? session.messages.length;
    if (existing === undefined) {
      ids.set(key, index);
      session.messages.push(message);
    } else session.messages[index] = message;
    if (role === "assistant" && kind !== "reasoning") lastAssistant = index;
  }
  // Assign native/fallback keys before filtering so existing edits and deletions
  // still target the same messages when an older archive is collected again.
  session.messages = session.messages.filter(message => !isPageContext(record(message.raw.payload)));
  session.metadata={...session.metadata,nativeContextVersion:1,turnIds:[...turns],...(positive&&!parentTurns?{lineageRetry:`Parent turns unresolved: ${parent}`}:{})};
  if(path){
    const stem=basename(path,".jsonl"),legacyThread=string(nativeMeta.session_id),metaId=session.id;
    const thread=legacyThread&&stem.endsWith(`${legacyThread}_${metaId}`)?legacyThread:metaId;
    const marker=`${thread}_`,position=stem.lastIndexOf(marker),page=position<0?"":stem.slice(position+marker.length);
    if(/^[a-f\d-]{36}$/i.test(page)){
      const base=record(nativeMeta.history_base),baseThread=string(base.thread_id),fork=string(nativeMeta.forked_from_id);
      const inherited=!!fork&&(baseThread===fork||(nativeMeta.forked_from_ordinal_exclusive!==undefined&&nativeMeta.forked_from_ordinal_exclusive===base.end_ordinal_exclusive));
      session.id=`${thread}_${page}`;
      session.parentId=inherited?fork:baseThread&&baseThread!==thread?`${thread}_${baseThread}`:thread;
      session.relationship="fork";
      // A rollout page is a storage segment, not a fork of the conversation.
      // Require native lineage evidence; filename similarity alone is insufficient.
      const continuation=codexContinuationRoot(nativeMeta,session.id);
      if(continuation) {
        session.parentId=continuation;
        session.relationship="continuation";
        session.metadata={...session.metadata,nativeSessionId:continuation};
      }
    }
  }
  return requireSession(session);
}
