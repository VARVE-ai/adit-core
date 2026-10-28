import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { LocalStateError, canonicalDirectory, type LocalWorkspace, type PrScope, publicationDigest } from "@varveai/adit-core";
const exec = promisify(execFile);
async function git(repository: string, args: string[]) {
  try { return (await exec("git", ["-C", repository, ...args], { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim(); }
  catch { throw new LocalStateError("Cannot read this Git range. Check local refs and available commit objects."); }
}
function repositoryOf(w: LocalWorkspace, input: string) {
  let repository: string;
  try { repository = canonicalDirectory(input); } catch { throw new LocalStateError("Repository not found", 404); }
  if (!w.repositories.some(p => canonicalDirectory(p) === repository)) throw new LocalStateError("Repository is outside this workspace", 404);
  return repository;
}
export async function prRepositoryRefs(w: LocalWorkspace, input: string) {
  const repository = repositoryOf(w, input);
  const refs = (await git(repository, ["for-each-ref", "--format=%(refname:short)%09%(symref)", "refs/heads", "refs/remotes"])).split("\n").filter(Boolean).filter(v => !v.split("\t")[1]).map(v => v.split("\t")[0]);
  let current: string | null = null;
  try { current = await git(repository, ["symbolic-ref", "--short", "HEAD"]); } catch { /* Detached HEAD needs an explicit selection. */ }
  return { repository, refs, current };
}
export async function resolvePrScope(w: LocalWorkspace, input: { repository: string; head?: string; base?: string; commits?: string[] }): Promise<PrScope> {
  const repository = repositoryOf(w, input.repository);
  const explicit = input.commits !== undefined;
  if (explicit && (input.head || input.base)) throw new LocalStateError("Choose branches or an explicit commit list, not both");
  const resolveRef = async (ref: string) => {
    if (typeof ref !== "string" || !ref.trim() || ref.length > 500 || /[\x00-\x20]/.test(ref)) throw new LocalStateError("Invalid Git reference");
    const sha = await git(repository, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"]);
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new LocalStateError("Invalid commit object");
    return sha;
  };
  let headSha: string | null = null, baseSha: string | null = null, mergeBase: string | null = null, shas: string[];
  if (explicit) {
    if (!Array.isArray(input.commits) || !input.commits.length || input.commits.length > 5000 || input.commits.some(s => typeof s !== "string" || !/^[a-f0-9]{7,64}$/i.test(s))) throw new LocalStateError("Provide a list of valid commit SHAs");
    shas = [];
    for (const s of input.commits) shas.push(await resolveRef(s));
    shas = [...new Set(shas)];
  } else {
    headSha = await resolveRef(input.head || ""); baseSha = await resolveRef(input.base || "");
    mergeBase = await git(repository, ["merge-base", headSha, baseSha]);
    shas = (await git(repository, ["rev-list", "--reverse", "--topo-order", `${baseSha}..${headSha}`])).split("\n").filter(Boolean);
    if (shas.length > 5000) throw new LocalStateError("Select a smaller range (at most 5,000 commits)");
  }
  let author: string;
  try { author = (await git(repository, ["config", "--get", "user.email"])).toLowerCase(); }
  catch { throw new LocalStateError("Configure Git user.email for this repository first"); }
  if (!author) throw new LocalStateError("Configure Git user.email for this repository first");
  const rows = new Map<string, { parents: string[]; email: string; subject: string }>();
  for (let start = 0; start < shas.length; start += 100) {
    const data = await git(repository, ["show", "--no-patch", "--format=%H%x00%P%x00%ae%x00%s%x00", "--end-of-options", ...shas.slice(start, start + 100)]);
    const parts = data.split("\0");
    for (let i = 0; i + 3 < parts.length; i += 4) rows.set(parts[i].trim(), { parents: parts[i + 1].split(" ").filter(Boolean), email: parts[i + 2].trim().toLowerCase(), subject: parts[i + 3] });
  }
  const scope: Omit<PrScope, "digest"> = { repository, kind: explicit ? "commits" : "branches", head: explicit ? null : input.head!, base: explicit ? null : input.base!, headSha, baseSha, mergeBase, author,
    commits: shas.map(sha => {
      const row = rows.get(sha); if (!row) throw new LocalStateError("Commit objects changed while reading the range");
      const reason = row.parents.length > 1 ? "merge" as const : row.email !== author ? "other-author" as const : null;
      return { sha, subject: row.subject, included: reason === null, reason };
    }) };
  return { ...scope, digest: publicationDigest(JSON.stringify(scope)) };
}
export async function readPrTemplate(repository: string, input?: string) {
  const candidates = input ? [input] : [join(repository, ".github", "PULL_REQUEST_TEMPLATE.md"), join(repository, "PULL_REQUEST_TEMPLATE.md"), join(repository, "docs", "pull_request_template.md")];
  for (const path of candidates) {
    try {
      const resolved = await realpath(path), info = await stat(resolved);
      if (!info.isFile() || info.size > 64 * 1024) throw new LocalStateError("Choose a Markdown template smaller than 64 KB");
      const text = await readFile(resolved, "utf8");
      return { path: resolved, text, digest: publicationDigest(text) };
    } catch (e) { if (input || e instanceof LocalStateError) throw new LocalStateError("Cannot read the selected Markdown template"); }
  }
  throw new LocalStateError("Select a project Markdown template");
}
