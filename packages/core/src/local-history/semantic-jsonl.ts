import { basename,dirname,join } from "node:path";
import { readSource, readSourceJSON } from "./source-io.js";
import { HistoryFormatError, jsonLines, record, string, type HistoryMessage } from "./types.js";
import { message, session, type Row } from "./provider-common.js";

export const semanticProviders = ["tau", "evener"];

export async function readSemanticSession(path: string, provider: string, signal?: AbortSignal) {
  const text = (await readSource(path, signal)).toString("utf8");
  // These formats use complete semantic records. A partial tail must retain the previous snapshot.
  if (text.trim() && !text.endsWith("\n")) {
    try { JSON.parse(text.trim().split("\n").at(-1)!); }
    catch { throw new HistoryFormatError("Incomplete semantic transcript record"); }
  }
  const rows = jsonLines(text);
  if (provider === "tau") return [parseTau(rows, path)];
  let metadata: Row = {};
  try { metadata = await readSourceJSON(path.replace(/\.transcript\.jsonl$/, ".meta.json"), signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let skip=0;
  const parent=string(metadata.parent_session_id),count=Number(metadata.divergence_turn)-1;
  if(parent&&count>0&&count<rows.length&&!/[\\/]/.test(parent)){
    try{
      const parentText=(await readSource(join(dirname(path),`${parent}.transcript.jsonl`),signal)).toString("utf8");
      const parentRows=jsonLines(parentText);
      if(parentRows.length>count&&parentText.endsWith("\n")&&rows.slice(1,count+1).every((row,index)=>JSON.stringify(row)===JSON.stringify(parentRows[index+1])))skip=count;
    }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  }
  return [parseEvener(rows, path, metadata,skip)];
}

export function parseTau(rows: Row[], path: string) {
  const info = rows.filter(r => r.type === "session_info").at(-1);
  if (!info) throw new HistoryFormatError("Tau session_info is missing");
  const leaf = rows.filter(r => r.type === "leaf").at(-1);
  let selected = rows;
  if (leaf) {
    selected = [];
    let id = string(leaf.entry_id);
    const seen = new Set<string>();
    while (id) {
      if (seen.has(id)) throw new HistoryFormatError("Tau ancestry cycle");
      seen.add(id);
      const matches = rows.filter(r => r.id === id);
      if (matches.length !== 1) throw new HistoryFormatError("Tau ancestry is missing or ambiguous");
      selected.unshift(matches[0]);
      id = string(matches[0].parent_id);
    }
  }
  let model = "", title = string(info.title);
  const messages: HistoryMessage[] = [];
  const ancestors = new Map<string, string>();
  for (const row of selected) {
    const parentKey = ancestors.get(string(row.parent_id));
    if (row.type === "model_change") model = string(row.model);
    if (row.type === "label") title = string(row.label);
    const data = record(row.message);
    if (row.type === "message" && ["user", "assistant", "toolResult"].includes(string(data.role))) {
      messages.push(message(data, messages.length, {key:string(row.id) || String(messages.length), parentKey, role:data.role === "toolResult" ? "tool" : string(data.role), model:string(data.model) || model || undefined, raw:row}));
    } else if (["compaction", "branch_summary"].includes(string(row.type))) {
      messages.push(message(row, messages.length, {key:string(row.id),parentKey,role:"system",content:row.summary}));
    } else { if (row.id) ancestors.set(string(row.id), parentKey || ""); continue; }
    ancestors.set(string(row.id), messages.at(-1)!.key);
  }
  return session("tau", basename(path, ".jsonl"), info.cwd, messages, {title});
}

export function parseEvener(rows: Row[], path: string, metadata: Row = {},skip=0) {
  const header = rows[0];
  if (!header || header.format_version !== 2 || !string(header.session_id) || basename(path) !== `${header.session_id}.transcript.jsonl`) throw new HistoryFormatError("Evener requires an identified semantic v2 header");
  if ((metadata.id && metadata.id !== header.session_id) || (metadata.parent_session_id && header.parent_session_id && metadata.parent_session_id !== header.parent_session_id)) throw new HistoryFormatError("Evener metadata identity mismatch");
  const messages: HistoryMessage[] = [];
  for (const key of ["system_prompt", "task", "agent_tasks"]) {
    if (header[key] !== undefined && header[key] !== "") messages.push(message(header, messages.length, {key:`header:${key}`,role:"system",content:header[key],usage:undefined}));
  }
  let model = string(header.model);
  const roles: Record<string,string> = {USER_INPUT:"user",STEERING:"user",ASSISTANT:"assistant",TOOL:"tool",TOOL_RESULTS:"tool"};
  for (const [index,row] of rows.slice(1).entries()) {
    if (row.kind === "MODEL_SWITCH") model = string(record(row.model_switch).new_model);
    if(index<skip)continue;
    const role = roles[string(row.kind)] || "system";
    messages.push(message(row,messages.length,{key:string(row.stable_turn_id) || String(messages.length),role,content:record(row.message).content ?? row,model:role === "assistant" ? string(row.response_model) || model || undefined : undefined,usage:role === "assistant" && Object.keys(record(row.usage)).length ? record(row.usage) : undefined}));
  }
  const result = session("evener",header.session_id,header.working_dir,messages,{...metadata,header});
  const parent = string(metadata.parent_session_id) || string(header.parent_session_id);
  if (parent) {
    result.parentId = parent;
    result.relationship = Number(metadata.divergence_turn) > 0 ? "fork" : metadata.is_subagent || Number(header.depth) > 0 ? "subagent" : "fork";
  }
  return result;
}
