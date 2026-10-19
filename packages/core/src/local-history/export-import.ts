import { createHash } from "node:crypto";
import { exportFiles } from "./export-files.js";
import { HistoryFormatError, record, string, type HistorySession } from "./types.js";
import { array, message, session } from "./provider-common.js";
import { parseGeminiAppsHTML } from "./gemini-apps.js";

export const exportProviders = ["claude-ai", "chatgpt", "gemini-apps"];
export async function readConversationExport(path: string, provider: string, workspace: string, signal?: AbortSignal): Promise<HistorySession[]> {
  if (!exportProviders.includes(provider)) throw new HistoryFormatError("Unsupported conversation export");
  const files=await exportFiles(path,provider,signal);
  const results:HistorySession[]=[];
  for(const bytes of files)results.push(...parseExport(bytes,provider,workspace,signal));
  const ids=new Set<string>();for(const result of results){if(ids.has(result.id))throw new HistoryFormatError("Duplicate conversation identity in export");ids.add(result.id);}
  return results;
}
function parseExport(bytes:Buffer,provider:string,workspace:string,signal?:AbortSignal):HistorySession[]{
  if(provider === "gemini-apps")return parseGeminiAppsHTML(bytes.toString("utf8"),workspace);
  let data: unknown;
  try { data=JSON.parse(bytes.toString("utf8")); }
  catch { throw new HistoryFormatError("Invalid conversation export JSON"); }
  if (!Array.isArray(data)) throw new HistoryFormatError("Conversation export must be an array");
  const results = data.map((value) => {
    signal?.throwIfAborted();
    const row=record(value);
    if (provider === "claude-ai") {
      if (!Array.isArray(row.chat_messages)) throw new HistoryFormatError("Claude.ai chat_messages is missing");
      return session(provider,row.uuid,workspace,array(row.chat_messages).map((m,i)=>message(m,i,{
        key:string(m.uuid) || String(i),role:m.sender === "human" ? "user" : string(m.sender),content:{content:m.content,text:m.text,attachments:m.attachments,files:m.files},
      })),{title:row.name,createdAt:row.created_at,updatedAt:row.updated_at,attribution:"explicit-import"});
    }
    const mapping=record(row.mapping), nodes=Object.values(mapping).map(record);
    let current=string(row.current_node);
    if (!current) {
      const leaves=nodes.filter(n=>!Array.isArray(n.children) || !n.children.length);
      leaves.sort((a,b)=>Number(record(b.message).create_time || 0)-Number(record(a.message).create_time || 0));
      current=string(leaves[0]?.id);
    }
    const ordered: Record<string,unknown>[] = [],seen=new Set<string>();
    while (current) {
      if (seen.has(current)) throw new HistoryFormatError("ChatGPT conversation ancestry cycle");
      seen.add(current);
      const node=record(mapping[current]);
      if (!Object.keys(node).length) throw new HistoryFormatError("ChatGPT conversation ancestry is missing");
      if (node.message) ordered.unshift(record(node.message));
      current=string(node.parent);
    }
    if (!nodes.length) throw new HistoryFormatError("ChatGPT mapping is missing");
    return session(provider,row.conversation_id || row.id,workspace,ordered.map((m,i)=>message({...m,timestamp:typeof m.create_time === "number" ? m.create_time*1000 : undefined},i,{
      role:string(record(m.author).role),model:string(record(m.metadata).model_slug) || undefined,
    })),{title:row.title,createdAt:row.create_time,updatedAt:row.update_time,attribution:"explicit-import"});
  });
  const ids=new Set<string>();
  for (const result of results) {
    if(ids.has(result.id)) throw new HistoryFormatError("Duplicate conversation identity in export");
    ids.add(result.id);
    result.metadata={...result.metadata,exportFingerprint:createHash("sha256").update(bytes).digest("hex")};
  }
  return results;
}
