import type { ParentScanTiming } from "./attribution-parent-lines.js";

type Stage = "prepare" | "submissions" | "evidence" | "commits" | "publish";
type Operation = "gitDiff" | "parentScan" | "evidenceLookup";
type CommitStage = "prepare" | "gitDiff" | "parsePatch" | "parentScan" | "fileEvidence" | "matchLines" | "classifyLines" | "inputRevision" | "persist";
export type CommitTiming = {
  type: "commit";
  repository: string;
  sha: string;
  status: "done" | "failed" | "deferred" | "cancelled";
  totalMs: number;
  stages: Partial<Record<CommitStage, number>>;
  counts: Record<string, number>;
  candidateLookupMs: number;
  git: { operation: "changedFiles" | "treeSizes" | "patch" | "other"; durationMs: number; outputBytes: number; status: "done" | "failed" }[];
  parent?: ParentScanTiming;
};
const rounded = (value: number) => Math.round(value * 100) / 100;
export type AttributionTiming =
  | CommitTiming
  | { type: "stage"; stage: Stage; durationMs: number }
  | {
      type: "summary";
      status: "done" | "unchanged" | "failed" | "cancelled";
      totalMs: number;
      stages: Partial<Record<Stage, number>>;
      operations: Partial<Record<Operation, { count: number; durationMs: number }>>;
    };

/** Phase/summary logs by default; commit diagnostics must be explicitly enabled. */
export class AttributionTimer {
  private started = performance.now();
  private phaseStarted = this.started;
  private stage: Stage = "prepare";
  private stages: Partial<Record<Stage, number>> = {};
  private operations: Partial<Record<Operation, { count: number; durationMs: number }>> = {};

  constructor(private report?: (event: AttributionTiming) => void, private traceCommits = false) {}

  commit(repository: string, sha: string) {
    return this.traceCommits && this.report
      ? new AttributionCommitTimer(repository, sha, event => this.emit(event)) : undefined;
  }

  private emit(event: AttributionTiming) {
    // Diagnostics must not turn a completed analysis into a failed batch.
    try {
      this.report?.(event);
    } catch {
      /* best-effort logging */
    }
  }

  private endPhase(now: number) {
    const durationMs = Math.round((now - this.phaseStarted) * 100) / 100;
    this.stages[this.stage] = durationMs;
    this.emit({ type: "stage", stage: this.stage, durationMs });
  }

  phase(stage: Stage) {
    const now = performance.now();
    this.endPhase(now);
    this.stage = stage;
    this.phaseStarted = now;
  }

  add(operation: Operation, started: number) {
    const value = (this.operations[operation] ??= { count: 0, durationMs: 0 });
    value.count++;
    value.durationMs += performance.now() - started;
  }

  async measure<T>(operation: Operation, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await work();
    } finally {
      this.add(operation, started);
    }
  }

  finish(status: Extract<AttributionTiming, { type: "summary" }>["status"]) {
    const now = performance.now();
    this.endPhase(now);
    for (const value of Object.values(this.operations))
      value.durationMs = Math.round(value.durationMs * 100) / 100;
    this.emit({
      type: "summary",
      status,
      totalMs: Math.round((now - this.started) * 100) / 100,
      stages: this.stages,
      operations: this.operations,
    });
  }
}

/** One bounded record per commit, containing counters rather than source/tool text.
 * Candidate lookup is a subset of matchLines; Git/parent details are nested costs. */
export class AttributionCommitTimer {
  private started = performance.now();
  private phaseStarted = this.started;
  private stage: CommitStage = "prepare";
  private stages: CommitTiming["stages"] = {};
  private counts: CommitTiming["counts"] = {};
  private commands: CommitTiming["git"] = [];
  private candidateLookupMs = 0;
  private parent?: ParentScanTiming;

  constructor(private repository: string, private sha: string, private report: (event: CommitTiming) => void) {}

  phase(stage: CommitStage) {
    const now = performance.now();
    this.stages[this.stage] = (this.stages[this.stage] || 0) + now - this.phaseStarted;
    this.stage = stage;
    this.phaseStarted = now;
  }

  count(name: string, value = 1) { this.counts[name] = (this.counts[name] || 0) + value; }
  lookup(started: number) { this.candidateLookupMs += performance.now() - started; }
  parentScan(timing: ParentScanTiming) { this.parent = timing; }

  async git(args: string[], work: () => Promise<string>) {
    const started = performance.now();
    let outputBytes = 0, status: "done" | "failed" = "failed";
    try {
      const output = await work();
      outputBytes = Buffer.byteLength(output);
      status = "done";
      return output;
    } finally {
      this.commands.push({ operation: args[0] === "ls-tree" ? "treeSizes"
        : args.includes("--raw") ? "changedFiles" : args.includes("--unified=0") ? "patch" : "other",
        durationMs: rounded(performance.now() - started), outputBytes, status });
    }
  }

  finish(status: CommitTiming["status"]) {
    const now = performance.now();
    this.stages[this.stage] = (this.stages[this.stage] || 0) + now - this.phaseStarted;
    try {
      this.report({ type: "commit", repository: this.repository, sha: this.sha, status,
        totalMs: rounded(now - this.started),
        stages: Object.fromEntries(Object.entries(this.stages).map(([name, value]) => [name, rounded(value)])),
        counts: this.counts, candidateLookupMs: rounded(this.candidateLookupMs), git: this.commands, parent: this.parent });
    } catch { /* Diagnostics cannot fail the analysis. */ }
  }
}
