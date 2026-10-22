import { basename, dirname, join } from "node:path";
import { readSource, readSourceJSON, directoryEntries } from "./source-io.js";
import { first, message, session } from "./provider-common.js";
import { HistoryFormatError, jsonLines, record, string, type HistoryMessage } from "./types.js";

export const eventDirectoryProviders = ["fx", "openhands"];
export async function readEventDirectory(path: string, provider: string, signal?: AbortSignal) {
  const root = dirname(path);
  const metadata = await readSourceJSON(provider === "fx" ? join(root,"session.json") : path,signal);
  const messages: HistoryMessage[] = [];
  if (provider === "fx") {
    if (metadata.schema_version !== 4) throw new HistoryFormatError("Unsupported fx session schema");
    const rows = jsonLines((await readSource(path,signal)).toString("utf8"));
    for (const row of rows) {
      signal?.throwIfAborted();
      if (typeof row.schema_version !== "number" || row.schema_version < 1 || row.schema_version > 3) throw new HistoryFormatError("Unsupported fx event schema");
      const event = record(row.event), keys = Object.keys(event);
      if (keys.length !== 1) throw new HistoryFormatError("Ambiguous fx event");
      const kind = keys[0], data = record(event[kind]);
      if (kind === "turn_completed") continue;
      const role = ["user","steering"].includes(kind) ? "user" : ["assistant","tool_call","interrupted"].includes(kind) ? "assistant" : kind === "tool_result" ? "tool" : "system";
      messages.push(message({...row,timestamp:row.timestamp_ms},messages.length,{role,content:event,model:first(data,"provider_replay.source.model") || undefined,usage:undefined}));
    }
    const result = session(provider,basename(root),metadata.workspace_root,messages,{title:metadata.title});
    try {
      const owner = await readSourceJSON(join(root,"subagent/owner.json"),signal);
      if (string(owner.parent_id)) {result.parentId=string(owner.parent_id);result.relationship="subagent";}
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return [result];
  }
  let cwd = first(metadata,"workspace.cwd","workspace.path","workspace.mount_path","workspace.root","workspace.repo_path","workspace.repo_root","workspace.working_dir");
  const model = first(metadata,"agent.llm.model","llm.model","model");
  for (const entry of await directoryEntries(join(root,"events"))) {
    signal?.throwIfAborted();
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const event = await readSourceJSON(join(root,"events",entry.name),signal);
    if (event.kind === "MessageEvent") {
      const wire = record(event.llm_message);
      if (!["user","assistant"].includes(string(wire.role))) continue;
      messages.push(message({...wire,timestamp:event.timestamp},messages.length,{key:string(event.id) || entry.name,model:wire.role === "assistant" ? model || undefined : undefined,raw:event}));
    } else if (event.kind === "ActionEvent") {
      messages.push(message(event,messages.length,{key:string(event.id) || entry.name,role:"assistant",content:{action:event.action,tool_call_id:event.tool_call_id,thought:event.thought},model:model || undefined}));
    } else if (event.kind === "ObservationEvent") {
      cwd ||= first(event,"observation.metadata.working_dir");
      messages.push(message(event,messages.length,{key:string(event.id) || entry.name,role:"tool",content:{observation:event.observation,tool_call_id:event.tool_call_id}}));
    }
  }
  return [session(provider,first(metadata,"id","conversation_id") || basename(root),cwd,messages,{baseState:metadata})];
}
