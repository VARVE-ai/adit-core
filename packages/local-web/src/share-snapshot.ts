import type { ShareSnapshot } from "../../core/src/local-history/sharing-types";

/** Treat a public Gist as untrusted input, including optional presentation fields. */
export function validateShareSnapshot(value: unknown): value is ShareSnapshot {
  const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
  const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === "string");
  const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  const nullableCount = (v: unknown) => v === null || count(v);
  const commit = (c: unknown) => object(c) && typeof c.sha === "string" && typeof c.subject === "string" && typeof c.repository === "string" && count(c.files) && [c.additions, c.deletions].every(nullableCount);
  if (!object(value)) return false;
  const v = value;
  return v.schemaVersion === 1 && typeof v.title === "string" && typeof v.agent === "string" && typeof v.provider === "string" && strings(v.models)
    && [v.promptCount, v.commitCount, v.commandCount].every(count)
    && (v.date === null || typeof v.date === "number" && Number.isFinite(v.date) && Math.abs(v.date) <= 8.64e15)
    && (v.costMicrousd === undefined || nullableCount(v.costMicrousd)) && (v.costIncomplete === undefined || typeof v.costIncomplete === "boolean")
    && Array.isArray(v.commits) && v.commits.every(commit)
    && Array.isArray(v.turns) && v.turns.every(t => object(t) && (t.prompt === undefined || typeof t.prompt === "string") && strings(t.models) && strings(t.efforts)
      && [t.input, t.output, t.cache].every(nullableCount) && Array.isArray(t.commits) && t.commits.every(commit)
      && Array.isArray(t.events) && t.events.every(e => object(e) && ["reply", "command", "thinking", "output"].includes(e.kind) && typeof e.text === "string"
        && [e.name, e.summary, e.icon].every(x => x === undefined || typeof x === "string")));
}
