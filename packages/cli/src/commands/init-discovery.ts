import { relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { LocalWorkspace } from "@varveai/adit-core";
import type { CollectionJob, Provider, Repository } from "../local/collector.js";
import { localRequest } from "./local-api.js";
import { printLine, printTransient } from "./cli-style.js";
import type { InitChoice } from "./init-selection.js";

export function repositoryChoices(root: string, repositories: Repository[], selected?: string[]): InitChoice[] {
  return repositories.map(r => ({ id: r.path, label: relative(root, r.path) || ".",
    detail: r.skipReason === "missing-git-email" ? "Missing Git user.email; commit collection will be skipped" : r.error || `${r.count ?? "Unknown"} own commits`,
    checked: selected ? selected.includes(r.path) : !r.error && !r.skipReason,
  }));
}

export function sourceChoices(providers: Provider[], job: CollectionJob, old?: LocalWorkspace, requested?: string): InitChoice[] {
  const selected = new Set([...(old?.providers || []), ...(requested ? [requested] : [])]);
  return providers.map(p => {
    const count = job.providers?.[p.id] || 0, pending = !!job.pending?.[p.id];
    return { id: p.id, label: p.name,
      detail: !p.supported ? "Not supported" : !p.enabled ? "Disabled in Settings" : count
        ? `${count} sessions${pending ? "; more records awaiting directory confirmation" : ""}`
        : pending ? "Records found; directory will be confirmed when organizing" : "No sessions found in this directory",
      checked: old || requested ? selected.has(p.id) : p.enabled && count > 0,
      disabled: !p.supported || !p.enabled,
    };
  }).sort((a, b) => Number((job.providers?.[b.id] || 0) > 0) - Number((job.providers?.[a.id] || 0) > 0)
    || Number(!!job.pending?.[b.id]) - Number(!!job.pending?.[a.id]) || Number(b.checked) - Number(a.checked));
}

export function initJobProgress(job: CollectionJob): string {
  if (job.status === "queued") return job.kind === "discover" ? "Waiting to check session metadata…" : "Organizing: queued…";
  if (job.kind === "discover") return `Checking session metadata${job.progress ? ` · ${job.progress.files} files checked` : "…"}`;
  const stages = { sessions: "reading sessions", git: "reading Git commits", inspection: "checking sensitive information", analysis: "matching commit sources", achievements: "updating overview and achievements" };
  const sources = Object.values(job.sourceProgress || {});
  const complete = sources.reduce((n, p) => n + p.completed, 0);
  const total = sources.length && sources.every(p => p.total !== null) ? sources.reduce((n, p) => n + (p.total || 0), 0) : null;
  const commits = Object.values(job.repositoryProgress || {}).reduce((n, p) => n + p.completed, 0);
  return `Organizing: ${job.phase ? stages[job.phase] : "starting"}${job.phase === "sessions" ? ` · ${complete}${total === null ? "" : `/${total}`} sessions` : ""}${job.phase === "analysis" ? ` · ${commits} commits analyzed` : ""}`;
}

export async function waitForInitJob(initial: CollectionJob): Promise<CollectionJob> {
  let job = initial, previous = "";
  while (["queued", "running"].includes(job.status)) {
    const progress = initJobProgress(job);
    if (progress !== previous) { printTransient(progress, { keepInPlain: true }); previous = progress; }
    await delay(500);
    job = await localRequest<CollectionJob>(`/jobs/${encodeURIComponent(job.id)}`);
  }
  if (!["done", "partial"].includes(job.status)) throw new Error(job.error || "Organizing was interrupted. Run adit init again to retry.");
  printLine(job.kind === "discover" ? "Session metadata checked." : job.status === "done" ? "Organizing complete." : "Organizing finished; some records could not be read.");
  if (job.error) printLine(job.error);
  return job;
}
