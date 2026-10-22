import { basename, dirname, join } from "node:path";
import { readSource, timestamp } from "./source-io.js";
import {
  HistoryFormatError,
  jsonLines,
  record,
  string,
  type HistoryMessage,
  type HistorySession,
} from "./types.js";
import { insideDirectory } from "./sources.js";

export const piProviders = ["pi", "omp", "omo", "prime-agent", "stepcode"];

function usage(value: unknown): Record<string, unknown> | undefined {
  const data = record(value),
    cache = record(data.cache);
  const fields = {
    input_tokens: data.input,
    output_tokens: data.output,
    cache_read_input_tokens: cache.read ?? data.cacheRead,
    cache_creation_input_tokens:
      cache.write ?? data.cacheCreation ?? data.cacheWrite,
  };
  const present = Object.entries(fields).filter(([, v]) => v !== undefined);
  return present.length ? Object.fromEntries(present) : undefined;
}

export async function readPi(
  path: string,
  provider: string,
  root: string,
  signal?: AbortSignal,
): Promise<HistorySession[]> {
  const records = jsonLines((await readSource(path, signal)).toString("utf8"));
  const header = records.find((r) => r.type !== "title");
  if (!header || header.type !== "session") return [];
  const session: HistorySession = {
    id: string(header.id) || basename(path, ".jsonl"),
    provider,
    cwd: string(header.cwd),
    messages: [],
  };
  if (!session.cwd)
    throw new HistoryFormatError("Pi session workspace is missing");
  const readHeaderID = async (candidate: string): Promise<string> => {
    if (!insideDirectory(root, candidate) || candidate === path) return "";
    try {
      return string(
        jsonLines((await readSource(candidate, signal)).toString("utf8")).find(
          (r) => r.type === "session",
        )?.id,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  };
  const persisted = string(header.branchedFrom) || string(header.parentSession);
  if (persisted) {
    const file = persisted.replace(/\\/g, "/").split("/").pop()!;
    session.parentId =
      (await readHeaderID(join(dirname(path), file))) ||
      file.replace(/\.jsonl$/, "");
    session.relationship = "fork";
  } else {
    const candidates =
      provider === "omp"
        ? [dirname(path) + ".jsonl"]
        : ["pi", "omo"].includes(provider) && basename(path) === "session.jsonl"
          ? [dirname(dirname(dirname(path))) + ".jsonl"]
          : [];
    for (const candidate of candidates) {
      const id = await readHeaderID(candidate);
      if (id) {
        session.parentId = id;
        session.relationship = "subagent";
        break;
      }
    }
  }
  let model = "";
  const ancestors = new Map<string, string>();
  const positions = new Map<string, number>();
  for (const row of records) {
    signal?.throwIfAborted();
    const id = string(row.id),
      parent = ancestors.get(string(row.parentId));
    if (row.type === "model_change") model = string(row.modelId) || model;
    if (row.type === "child_usage_attributed" && provider === "prime-agent") {
      const target = positions.get(string(row.targetId));
      if (target !== undefined)
        session.messages[target].usage = usage(row.aggregateUsage);
    }
    let message: HistoryMessage | undefined;
    if (row.type === "message") {
      const m = record(row.message),
        role = string(m.role);
      if (["user", "assistant", "toolResult"].includes(role)) {
        if (role === "assistant") model = string(m.model) || model;
        message = {
          key: id || String(session.messages.length),
          role: role === "toolResult" ? "tool" : role,
          content: m.content,
          model: role === "assistant" ? model || undefined : undefined,
          timestamp: timestamp(m.timestamp ?? row.timestamp),
          parentKey: parent,
          usage: role === "assistant" ? usage(m.usage) : undefined,
          raw: row,
        };
      }
    } else if (row.type === "compaction") {
      message = {
        key: id || String(session.messages.length),
        role: "system",
        content: row.summary,
        timestamp: timestamp(row.timestamp),
        parentKey: parent,
        raw: row,
      };
    }
    if (message) {
      const existing = id ? positions.get(id) : undefined;
      if (existing === undefined) {
        if (id) positions.set(id, session.messages.length);
        session.messages.push(message);
      } else session.messages[existing] = message;
      if (id) ancestors.set(id, id);
    } else if (id) ancestors.set(id, parent || "");
  }
  return [session];
}
