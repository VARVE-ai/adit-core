import { Command } from "commander";
import { LocalHistoryReader, HistoryQueryError, historyError, clipTurn, clipEvent } from "../local/history-reader.js";
import type { LocalWorkspace, TranscriptMode } from "@varveai/adit-core";

type Args = Record<string, any>;
function integer(value: unknown, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new HistoryQueryError("INVALID_ARGUMENT", `Expected an integer between ${min} and ${max}.`);
  return number;
}
function date(value: string | undefined, end: boolean) {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HistoryQueryError("INVALID_DATE", "Dates must use YYYY-MM-DD in the machine's local timezone.");
  const [y, m, d] = value.split("-").map(Number), result = new Date(y, m - 1, d);
  if (result.getFullYear() !== y || result.getMonth() !== m - 1 || result.getDate() !== d) throw new HistoryQueryError("INVALID_DATE", "Invalid calendar date.");
  if (end) result.setHours(23, 59, 59, 999);
  return result.getTime();
}
function mode(value: string | undefined, fallback: TranscriptMode): TranscriptMode {
  if (value === undefined) return fallback;
  if (value !== "normal" && value !== "focused") throw new HistoryQueryError("INVALID_MODE", "Use normal or focused.");
  return value;
}
export function registerHistoryCommands(program: Command) {
  const history = program.command("history").description("Search collected local history across Agents; no Cloud login or service required");
  const common = (cmd: Command) => cmd.option("--workspace <id-or-path>", "Registered working directory ID, exact name, or path")
    .option("--json", "Return structured JSON for Agents");
  const session = (cmd: Command) => common(cmd).option("--provider <id>", "Optional Agent filter; searches all collected Agents by default");
  const offset = (cmd: Command) => cmd.option("--offset <n>", "Continue from nextOffset");
  const text = (cmd: Command) => offset(session(cmd)).option("--mode <mode>", "focused or normal")
    .option("--max-chars <n>", "Maximum characters per prompt/reply (100-16000)", "2000");
  const run = async (args: Args, action: (reader: LocalHistoryReader, w: LocalWorkspace) => unknown | Promise<unknown>, global = false) => {
    let reader: LocalHistoryReader | undefined;
    try {
      reader = new LocalHistoryReader();
      const w = global ? undefined : reader.workspace({ workspace: args.workspace });
      const result = await action(reader, w!);
      const value = { ok: true, schemaVersion: 1, source: "local", ...(w ? reader.metadata(w) : {}), ...result as object };
      // JSON is also the plain terminal representation: IDs and pagination remain copyable.
      console.log(JSON.stringify(value, null, 2));
    } catch (error) { console.log(JSON.stringify(historyError(error), null, 2)); process.exitCode = 1; }
    finally { reader?.close(); }
  };
  common(history.command("workspaces").description("List registered local working directories"))
    .action(args => run(args, reader => ({ workspaces: reader.workspaces() }), true));
  for (const search of [false, true]) {
    offset(session(history.command(search ? "search <query>" : "list").description(search ? "Search titles and collected transcript text" : "List collected conversations")))
      .option("--limit <n>", "Sessions per page (1-50)", "20").option("--from <date>", "Activity overlaps this local date or later")
      .option("--to <date>", "Activity overlaps this local date or earlier").option("--only-commits", "Only conversations with attributed submissions")
      .action((...values: any[]) => {
        const query = search ? values[0] as string : undefined, args = values[search ? 1 : 0] as Args;
        return run(args, (reader, w) => {
          if (search && (!query?.trim() || query.length > 300)) throw new HistoryQueryError("INVALID_QUERY", "Search text must contain 1 to 300 characters.");
          const from = date(args.from, false), to = date(args.to, true);
          if (from !== undefined && to !== undefined && from > to) throw new HistoryQueryError("INVALID_DATE", "--from must be on or before --to.");
          return { ...reader.browser.list(w, { provider: args.provider, query, from, to, onlyCommits: args.onlyCommits,
            offset: integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER), limit: integer(args.limit, 20, 1, 50) }), query: query ?? null, period: { from: from ?? null, to: to ?? null } };
        });
      });
  }
  text(history.command("show <session-id>").description("Read 8 turns per page; focused replies by default"))
    .option("--query <text>", "Jump to the first matching turn")
    .action((id, args) => run(args, (reader, w) => reader.show(w, id, { provider: args.provider, mode: mode(args.mode, "focused"),
      offset: args.offset === undefined ? undefined : integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER), query: args.query,
      maxChars: integer(args.maxChars, 2000, 100, 16000) })));
  text(history.command("turn <session-id> <turn-id>").description("Read a turn with original reply/tool evidence; 40 events per page"))
    .action((id, turnId, args) => run(args, (reader, w) => {
      const s = reader.session(w, id, args.provider);
      return { session: s, turn: clipTurn(reader.browser.turn(w, s.provider, id, turnId, mode(args.mode, "normal"), integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER)), integer(args.maxChars, 2000, 100, 16000)) };
    }));
  offset(session(history.command("context <session-id>").description("Read recorded setup/context outside turns; not user requests or final answers")))
    .action((id, args) => run(args, (reader, w) => {
      const s = reader.session(w, id, args.provider), result = reader.browser.context(w, s.provider, id, integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER));
      return { session: s, ...result, events: result.events.map(e => clipEvent(e, 2000)) };
    }));
  offset(session(history.command("content <session-id> <event-id>").description("Read a truncated block or tool input/output; 32000 characters per page")))
    .option("--kind <kind>", "text, tool-input, tool-output or tool", "text")
    .action((id, eventId, args) => run(args, (reader, w) => {
      if (!["text", "tool-input", "tool-output", "tool"].includes(args.kind)) throw new HistoryQueryError("INVALID_KIND", "Use text, tool-input, tool-output or tool.");
      const s = reader.session(w, id, args.provider);
      return { session: s, eventId, kind: args.kind, ...reader.browser.content(w, s.provider, id, eventId, args.kind, integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER)) };
    }));
  offset(session(history.command("commits").description("List collected commits, including unmatched commits")))
    .option("--session <id>", "Filter by submitting OR writing session").option("--repo <path>", "Registered repository path")
    .option("--limit <n>", "Commits per page (1-50)", "20")
    .action(args => run(args, (reader, w) => reader.commits(w, { session: args.session, provider: args.provider, repository: args.repo,
      limit: integer(args.limit, 20, 1, 50), offset: integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER) })));
  common(history.command("commit <sha>").description("Read saved submitter and code authorship separately; never reruns analysis"))
    .option("--repo <path>", "Registered repository path")
    .action((sha, args) => run(args, (reader, w) => reader.commit(w, sha, args.repo)));
}
