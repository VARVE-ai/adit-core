import { Decompress } from "fzstd";
import {
  HistoryFormatError,
  jsonLines,
  record,
  string,
  type HistoryMessage,
  type HistorySession,
} from "./types.js";
import { timestamp } from "./source-io.js";

const controls = new Set(
  `agent-preset/selected agent/inbox/spliced approval/asked approval/decided approval/policy assistant/attempt command/done command/run compaction/end compaction/prune compaction/start deliverables/presented feedback/message-delete feedback/message-put feedback/record goal/change hook/invoked hook/result image/offload llm/retry llm/retry-started model/selection permission/preset plan/mode request/context sandbox/mode schedule/change session-log-deepseek/delivery-accepted session/title session/title-llm-request subagent/catalog subagent/descriptor subagent/model-selection-policy team/member team/message/delivered team/message/queued team/task todo/write tool-workflow/agent-end tool-workflow/agent-start tool-workflow/run-end tool-workflow/run-start tool/code-dispatch tool/code-dispatch-start tool/ptc-dispatch tool/ptc-dispatch-start web/deepseek-search-llm-request workspace/changes working-directory/change`.split(
    " ",
  ),
);
// v4 job lifecycle records refer to tool calls; their content is already kept
// through tool/call and tool/result, rather than added again as chat messages.
controls.add("job/registered");
controls.add("job/settled");

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new HistoryFormatError(`Invalid DeepSeek Harness ${label}`);
  return value;
}

export function decodeHarness(bytes: Buffer, compressed: boolean): string {
  if (!compressed) return bytes.toString("utf8");
  const chunks: Buffer[] = [];
  let length = 0;
  const decoder = new Decompress((chunk) => {
    length += chunk.length;
    if (length > 128 * 1024 * 1024)
      throw new HistoryFormatError("Decompressed DeepSeek log exceeds 128 MiB");
    chunks.push(Buffer.from(chunk));
  });
  decoder.push(bytes, true);
  return Buffer.concat(chunks).toString("utf8");
}

function expand(row: Record<string, unknown>): Record<string, unknown>[] {
  const type = string(row.type);
  if (!["text-chunks", "reasoning-chunks", "tool-call-chunks"].includes(type))
    return [row];
  const data = record(row.data);
  const texts = type === "tool-call-chunks" ? data.args : data.texts;
  const dt = data.dt;
  if (
    !Array.isArray(texts) ||
    !texts.length ||
    texts.some((t) => typeof t !== "string") ||
    !Array.isArray(dt) ||
    dt.length !== texts.length - 1
  )
    throw new HistoryFormatError("Invalid DeepSeek Harness packed chunks");
  const seq = integer(row.seq0, "packed sequence");
  let time = integer(row.time0, "packed time");
  return texts.map((text, index) => {
    if (index) time += integer(dt[index - 1], "chunk time delta");
    integer(seq + index, "expanded sequence");
    integer(time, "expanded time");
    const chunk =
      type === "tool-call-chunks"
        ? {
            type: "tool-call-delta",
            index: data.index,
            id: data.id,
            name: data.name,
            argumentsDelta: text,
          }
        : {
            type: type === "text-chunks" ? "text-delta" : "reasoning-delta",
            index: data.index,
            text,
          };
    return {
      type: "assistant/chunk",
      seq: seq + index,
      time,
      data: { turn: data.turn, step: data.step, chunk },
    };
  });
}

type Response = {
  seq: number;
  message: HistoryMessage;
  blocks: Map<number, Record<string, unknown>>;
  final: boolean;
};

export function parseHarness(text: string): HistorySession {
  const [header, ...records] = jsonLines(text);
  if (
    !header ||
    header.type !== "session" ||
    !string(header.id) ||
    !string(header.cwd)
  )
    throw new HistoryFormatError("DeepSeek Harness session header is missing");
  const version = integer(header.version, "version");
  if (version > 4)
    throw new HistoryFormatError("Unsupported DeepSeek Harness log generation");
  const seed =
    header.seedLength === undefined
      ? 0
      : integer(header.seedLength, "seed length");
  const events = records.flatMap(expand);
  if (seed > events.length)
    throw new HistoryFormatError("DeepSeek seed exceeds event count");
  let cut = -1;
  if (version >= 2 && header.isSeeded)
    events.forEach((e, index) => {
      if (e.type === "session/end-seed" && record(e.data).inherited === true)
        cut = index;
    });
  const messages: { seq: number; message: HistoryMessage }[] = [];
  const responses = new Map<string, Response>();
  let title = "";
  let model = "",
    turn = 0,
    step = 0,
    nextTurn = 1,
    nextStep = 1;
  let inboxRestart = false;
  const pending = new Set<string>();
  const response = (
    data: Record<string, unknown>,
    event: Record<string, unknown>,
  ) => {
    if (data.turn !== turn || data.step !== step || !step)
      throw new HistoryFormatError(
        "DeepSeek response does not match the open step",
      );
    const key = `${turn}:${step}`;
    let value = responses.get(key);
    if (!value) {
      value = {
        seq: Number(event.seq),
        message: {
          key: `response:${key}`,
          role: "assistant",
          model: model || undefined,
          timestamp: timestamp(event.time),
          content: [],
          raw: {},
        },
        blocks: new Map(),
        final: false,
      };
      responses.set(key, value);
    }
    return value;
  };
  for (let index = 0; index < events.length; index++) {
    const e = events[index];
    if (integer(e.seq, "event sequence") !== index)
      throw new HistoryFormatError("DeepSeek Harness event sequence has a gap");
    integer(e.time, "event time");
    const data = record(e.data),
      type = string(e.type);
    if (type === "session/title" && string(data.title).trim()) title = string(data.title).trim();
    const owned = index >= seed && index > cut;
    const restart = inboxRestart;
    inboxRestart =
      type === "agent/inbox/spliced" &&
      data.target === "next-turn" &&
      Array.isArray(data.inserted) &&
      data.inserted.length > 0;
    if (type === "turn/start") {
      if (restart && turn && !step && data.turn === turn + 1) {
        nextTurn = turn + 1;
        turn = 0;
        pending.clear();
      }
      if (turn || integer(data.turn, "turn") !== nextTurn)
        throw new HistoryFormatError("DeepSeek turn lifecycle is invalid");
      turn = nextTurn;
      nextStep = 1;
    } else if (type === "step/start") {
      if (!turn || step || data.turn !== turn || data.step !== nextStep)
        throw new HistoryFormatError("DeepSeek step lifecycle is invalid");
      step = nextStep;
    } else if (type === "step/end") {
      if (!step || data.turn !== turn || data.step !== step)
        throw new HistoryFormatError("DeepSeek step end is invalid");
      step = 0;
      nextStep++;
      pending.clear();
    } else if (type === "turn/end") {
      if (!turn || step || data.turn !== turn)
        throw new HistoryFormatError("DeepSeek turn end is invalid");
      turn = 0;
      nextTurn++;
    } else if (type === "request/header") {
      model = string(record(record(data.header).config).model);
      if (step && owned)
        response(
          data.turn === undefined ? { ...data, turn, step } : data,
          e,
        ).message.model = model || undefined;
    } else if (type === "assistant/chunk") {
      if (!owned) continue;
      const r = response(data, e),
        chunk = record(data.chunk),
        kind = string(chunk.type);
      if (kind === "usage") r.message.usage = record(chunk.usage);
      else if (kind !== "finish") {
        const blockIndex = integer(chunk.index, "block index");
        const block = r.blocks.get(blockIndex) || {};
        if (kind === "block-start") block.type = chunk.blockType;
        else if (kind === "block-end") {
          r.blocks.set(blockIndex, record(chunk.block));
          continue;
        } else if (kind === "text-delta" || kind === "reasoning-delta") {
          block.type = kind === "text-delta" ? "text" : "reasoning";
          block.text = string(block.text) + string(chunk.text);
        } else if (kind === "tool-call-delta") {
          block.type = "tool-call";
          block.id = chunk.id;
          block.name = chunk.name ?? block.name;
          block.arguments =
            string(block.arguments) + string(chunk.argumentsDelta);
        } else
          throw new HistoryFormatError(
            `Unsupported DeepSeek stream chunk: ${kind}`,
          );
        r.blocks.set(blockIndex, block);
      }
    } else if (
      [
        "user/message",
        "system/message",
        "developer/message",
        "assistant/message",
        "tool/result",
      ].includes(type)
    ) {
      if (e.surfaceOp !== "append") {
        if (record(e.surfaceOp).op !== "replace")
          throw new HistoryFormatError("Invalid DeepSeek surface operation");
        continue;
      }
      if (!owned) continue;
      // Only user/message carries its envelope directly in data. System and
      // developer messages use data.message, just like assistant/tool messages.
      const m = type === "user/message" ? data : record(data.message);
      if (!Array.isArray(m.content))
        throw new HistoryFormatError("DeepSeek message content is missing");
      const msg: HistoryMessage = {
        key: `event:${e.seq}`,
        role: type === "tool/result" ? "tool" : type.split("/")[0],
        content: m.content,
        timestamp: timestamp(e.time),
        model: string(record(m.source).model) || undefined,
        raw: e,
      };
      if (type === "assistant/message") {
        const r = response(data, e);
        let embeddedUsage: Record<string, unknown> | undefined;
        if (Array.isArray(data.stream))
          for (const item of data.stream) {
            const chunk = record(record(item).chunk);
            if (chunk.type === "usage") embeddedUsage = record(chunk.usage);
          }
        r.message = {
          ...msg,
          key: r.message.key,
          model: msg.model || r.message.model,
          usage: data.usage
            ? record(data.usage)
            : embeddedUsage || r.message.usage,
        };
        r.seq = index;
        r.final = true;
      } else {
        if (type === "tool/result") {
          const callId = string(record(m.source).callId);
          if (!pending.has(callId))
            throw new HistoryFormatError(
              "DeepSeek tool result has no matching call",
            );
          pending.delete(callId);
        }
        messages.push({ seq: index, message: msg });
      }
    } else if (type === "tool/call") {
      if (owned) {
        response(data, e);
        pending.add(string(data.callId));
      }
    } else if (type === "compaction/summary") {
      if (owned && data.usage)
        messages.push({
          seq: index,
          message: {
            key: `compaction:${index}`,
            role: "system",
            content: [],
            usage: record(data.usage),
            model: string(data.model) || undefined,
            timestamp: timestamp(e.time),
            raw: e,
          },
        });
    } else if (
      type !== "session/end-seed" &&
      !controls.has(type) &&
      e.ignorable !== true
    ) {
      throw new HistoryFormatError(`Unknown required DeepSeek event: ${type}`);
    }
  }
  for (const r of responses.values()) {
    if (!r.final) {
      r.message.content = [...r.blocks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, block]) => block);
      r.message.raw = { type: "partial", content: r.message.content };
    }
    if (r.final || r.blocks.size || r.message.usage)
      messages.push({ seq: r.seq, message: r.message });
  }
  return {
    id: string(header.id),
    provider: "deepseek-harness",
    cwd: string(header.cwd),
    metadata: { title },
    parentId: string(header.parentSession) || undefined,
    relationship: header.parentSession
      ? header.origin === "subagent"
        ? "subagent"
        : "fork"
      : undefined,
    messages: messages.sort((a, b) => a.seq - b.seq).map((m) => m.message),
  };
}
