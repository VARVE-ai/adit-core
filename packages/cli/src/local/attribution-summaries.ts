import type { LocalStore } from "@varveai/adit-core";

export type AttributionLine = {
  id: string; path: string; tier: string;
  provider: string | null; session: string | null; evidence: string | null;
};
export type AttributionCandidate = { line: string; provider: string; session: string; selected: number };
type Evidence = { provider: string; sessionId: string; turnId: string | null };
type Counts = { certain: number; likely: number; possible: number };
const counts = (): Counts => ({ certain: 0, likely: 0, possible: 0 });
const identity = (...parts: string[]) => JSON.stringify(parts);

/** Matching stays in memory. Persist only the projections used by existing readers. */
export function saveAttributionSummaries(
  db: LocalStore["db"], run: string, repository: string, sha: string,
  lines: readonly AttributionLine[], candidates: readonly AttributionCandidate[], evidence: ReadonlyMap<string, Evidence>,
): void {
  const writers = new Map<string, Counts & { provider: string; session: string; path: string }>();
  const alternatives = new Map<string, Counts & { writerProvider: string; writerSession: string; provider: string; session: string }>();
  const turns = new Map<string, Evidence>();
  const byLine = new Map(lines.map(line => [line.id, line]));
  const increment = (value: Counts, tier: string) => {
    if (tier === "certain" || tier === "likely" || tier === "possible") value[tier]++;
  };
  for (const line of lines) {
    if (line.provider && line.session) {
      const key = identity(line.provider, line.session, line.path);
      const summary = writers.get(key) ?? { provider: line.provider, session: line.session, path: line.path, ...counts() };
      increment(summary, line.tier);
      writers.set(key, summary);
    }
    if (line.evidence) {
      const source = evidence.get(line.evidence);
      if (!source) throw new Error("Missing selected attribution evidence");
      // Preserve the original session/turn, even when the selected writer is a
      // temporary analysis group representative. Native sessions remain separate.
      turns.set(identity(source.provider, source.sessionId, source.turnId ?? ""), source);
    }
  }
  for (const candidate of candidates) {
    if (candidate.selected) continue;
    const line = byLine.get(candidate.line);
    if (!line?.provider || !line.session) throw new Error("Missing selected attribution writer");
    const key = identity(line.provider, line.session, candidate.provider, candidate.session);
    const summary = alternatives.get(key) ?? {
      writerProvider: line.provider, writerSession: line.session,
      provider: candidate.provider, session: candidate.session, ...counts(),
    };
    increment(summary, line.tier);
    alternatives.set(key, summary);
  }
  const writer = db.prepare("INSERT INTO adit_attribution_writers VALUES (?,?,?,?,?,?,?,?,?)");
  for (const w of writers.values()) writer.run(run, repository, sha, w.provider, w.session, w.path, w.certain, w.likely, w.possible);
  const alternative = db.prepare("INSERT INTO adit_attribution_alternatives VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (const a of alternatives.values()) alternative.run(run, repository, sha, a.writerProvider, a.writerSession, a.provider, a.session, a.certain, a.likely, a.possible);
  const turn = db.prepare("INSERT INTO adit_attribution_turns VALUES (?,?,?,?,?,?)");
  for (const t of turns.values()) turn.run(run, repository, sha, t.provider, t.sessionId, t.turnId ?? "");
}
