import type { AttributionGitObjects, GitTreeFile } from "./attribution-git-objects.js";

/** Large files are associated by write path, never loaded for line attribution. */
export const ATTRIBUTION_FILE_LIMIT = 8 * 1024 * 1024;
type Git = (repository: string, args: string[], signal?: AbortSignal) => Promise<string>;
export type FileOnlyChange = { path: string; additions: number | null; deletions: number | null; reason: "file_size" | "file_patch_size" };
export type PatchContext = { parents: string[]; parentFiles: Map<string, GitTreeFile>; parentPaths: string[] };
type Change = { path: string; additions: number | null; deletions: number | null };
const literal = (path: string) => `:(top,literal)${path}`;
const show = ["-c", "core.quotePath=false", "show", "--no-show-signature", "--first-parent",
  "--diff-merges=first-parent", "--no-ext-diff", "--no-textconv", "--no-renames"];
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const rawChange = /^\n?:\d+ \d+ [a-f0-9]+ [a-f0-9]+ [A-Z]\d*$/;

/** Consume raw records before looking for the next header: a filename may itself
 * be a SHA, contain newlines, or look like a raw change record. */
function batchMetadata(output: string, requested: Set<string>) {
  const records = output.split("\0"), result = new Map<string, string>();
  let cursor = 0;
  while (cursor < records.length) {
    if (!records[cursor].trim()) { cursor++; continue; }
    const sha = records[cursor++].trim(), parents = records[cursor++];
    if (!objectId.test(sha) || parents === undefined ||
      (parents.trim() && !parents.trim().split(/\s+/).every(parent => objectId.test(parent))))
      throw new Error("Unexpected Git batch metadata header");
    const start = cursor;
    while (cursor < records.length) {
      if (!records[cursor].trim()) { cursor++; continue; }
      if (!rawChange.test(records[cursor])) break;
      if (!records[cursor + 1]) throw new Error("Git batch change is missing a path");
      cursor += 2;
    }
    if (requested.has(sha)) result.set(sha, parents + "\0" + records.slice(start, cursor).join("\0") + "\0");
  }
  return result;
}

export class AttributionDiffReader {
  private trees = new Map<string, Map<string, GitTreeFile>>();
  private metadataScope = "";
  private metadata = new Map<string, string>();
  private attempted = new Set<string>();
  constructor(private git: Git, private objects?: AttributionGitObjects) {}

  private async changes(repository: string, sha: string, sourcePaths: string[], signal?: AbortSignal, upcoming: string[] = []) {
    const scope = JSON.stringify([repository, sourcePaths]);
    if (scope !== this.metadataScope) {
      this.metadataScope = scope;
      this.metadata.clear(); this.attempted.clear();
    }
    if (!this.attempted.has(sha)) {
      // Bound both retained output and argv. Only immutable full IDs are eligible.
      const batch = [...new Set([sha, ...upcoming])].slice(0, 16);
      if (batch.length > 1 && batch.every(id => objectId.test(id))) {
        this.metadata.clear(); this.attempted = new Set(batch);
        try {
          const output = await this.git(repository, [...show, "--format=%H%x00%P%x00", "--raw", "--no-abbrev", "-z",
            "--no-walk=unsorted", ...batch, "--", ...sourcePaths], signal);
          this.metadata = batchMetadata(output, this.attempted);
        } catch {
          // One unavailable object, output limit, or unsupported batch response
          // cannot poison other commits. The original query reports per-SHA errors.
          signal?.throwIfAborted();
        }
      }
    }
    const saved = this.metadata.get(sha);
    this.metadata.delete(sha);
    return saved ?? this.git(repository, [...show, "--format=%P%x00", "--raw", "--no-abbrev", "-z", sha, "--", ...sourcePaths], signal);
  }

  private async tree(repository: string, sha: string, signal?: AbortSignal) {
    const key = repository + "\0" + sha;
    const saved = this.trees.get(key);
    if (saved) return saved;
    // ls-tree reports blob sizes without loading their contents. NUL framing
    // preserves spaces, tabs, Unicode and literal pathspec characters in names.
    const sizes = this.objects ? await this.objects.tree(repository, sha, signal) : new Map<string, GitTreeFile>();
    if (!this.objects) {
      const output = await this.git(repository, ["ls-tree", "-r", "-l", "-z", sha], signal);
      for (const entry of output.split("\0")) {
        const match = /^(\d+) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]*)$/.exec(entry);
        if (match) sizes.set(match[4], { mode: match[1], oid: match[2], size: Number(match[3]) });
      }
    }
    if (this.trees.size >= 4) this.trees.delete(this.trees.keys().next().value!);
    this.trees.set(key, sizes);
    return sizes;
  }

  async read(repository: string, sha: string, sourcePaths: string[], signal?: AbortSignal, indexed: Change[] = [], upcoming: string[] = [],
    consume?: (patch: string, context: PatchContext) => Promise<void>) {
    // --raw inspects trees only. Unlike --numstat it does not ask Git to compute
    // textual diffs for the giant files we are about to skip.
    const metadata = await this.changes(repository, sha, sourcePaths, signal, upcoming);
    const separator = metadata.indexOf("\0");
    if (separator < 0 && metadata.trim()) throw new Error("Git commit output is missing parent metadata");
    const parents = separator < 0 ? [] : metadata.slice(0, separator).trim().split(/\s+/).filter(Boolean);
    const changes: Change[] = [];
    const records = metadata.slice(separator + 1).split("\0");
    const statistics = new Map(indexed.map(file => [file.path, file]));
    for (let i = 0; i < records.length; i++) {
      if (!rawChange.test(records[i])) continue;
      const path = records[++i];
      if (!path) throw new Error("Git change metadata is missing a file path");
      const counts = statistics.get(path);
      // Deleted files and deletion-only edits have no newly written content.
      // Exclude them before size checks: a large deletion must not fall back to
      // the historical writers of that path (or consume the patch budget).
      if (/ D$/.test(records[i - 1]) || counts?.additions === 0) continue;
      changes.push({ path, additions: counts?.additions ?? null, deletions: counts?.deletions ?? null });
    }
    if (!changes.length) return { parents, patch: "", fileOnly: [] as FileOnlyChange[], parentPaths: sourcePaths, parentFiles: new Map<string, GitTreeFile>() };
    const current = await this.tree(repository, sha, signal);
    const parent = parents.length ? await this.tree(repository, parents[0], signal) : new Map<string, GitTreeFile>();
    const fileOnly: FileOnlyChange[] = [];
    const regular: Change[] = [];
    for (const change of changes) {
      if (Math.max(current.get(change.path)?.size || 0, parent.get(change.path)?.size || 0) > ATTRIBUTION_FILE_LIMIT)
        fileOnly.push({ path: change.path, additions: change.additions, deletions: change.deletions, reason: "file_size" });
      else regular.push(change);
    }
    const parts: string[] = [];
    const context: PatchContext = { parents, parentFiles: parent,
      parentPaths: [...sourcePaths, ...[...parent].filter(([, file]) => file.size > ATTRIBUTION_FILE_LIMIT)
        .map(([path]) => `:(top,exclude,literal)${path}`)] };
    const split = async (files: Change[]) => {
      const half = Math.ceil(files.length / 2);
      await read(files.slice(0, half)); await read(files.slice(half));
    };
    const read = async (files: Change[]): Promise<void> => {
      signal?.throwIfAborted();
      if (!files.length) return;
      // Also bound argv on Windows. Most commits need just one patch query.
      if (files.reduce((size, file) => size + file.path.length + 20, 0) > 16000 && files.length > 1) {
        await split(files); return;
      }
      let patch: string | undefined;
      try {
        patch = await this.git(repository, [...show, "--format=", "--unified=0", sha, "--", ...files.map(file => literal(file.path))], signal);
      } catch (error) {
        if (signal?.aborted || (error as { code?: string }).code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error;
      }
      if (patch === undefined || Buffer.byteLength(patch) > ATTRIBUTION_FILE_LIMIT) {
        patch = undefined;
        // A batch overflow is never a reason to exclude its individual files.
        // Only an isolated file can be classified as having an oversized patch.
        if (files.length > 1) await split(files);
        else fileOnly.push({ ...files[0], reason: "file_patch_size" });
        return;
      }
      // Production consumes each bounded batch before reading the next one.
      // Keep consumer errors outside the Git overflow handler.
      if (consume) await consume(patch, context);
      else parts.push(patch);
    };
    await read(regular);
    return { ...context, patch: parts.join("\n"), fileOnly };
  }
}
