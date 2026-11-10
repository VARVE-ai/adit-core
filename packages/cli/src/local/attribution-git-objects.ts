import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import Database from "better-sqlite3";

/** A bounded, sequential protocol connection; no shell and no source in errors. */
class GitPipe {
  private child: ChildProcessWithoutNullStreams;
  private iterator: AsyncIterator<Buffer>;
  private pending: Buffer = Buffer.alloc(0);
  private failure?: Error;
  private exited: Promise<void>;
  get available() {
    return !this.failure && this.child.exitCode === null && !this.child.killed;
  }
  constructor(repository: string, args: string[]) {
    this.child = spawn("git", args, { cwd: repository, windowsHide: true, stdio: "pipe" });
    this.child.stderr.resume();
    this.child.on("error", (error) => {
      this.failure = error;
    });
    this.child.stdin.on("error", (error) => {
      this.failure = error;
    });
    this.iterator = this.child.stdout[Symbol.asyncIterator]();
    this.exited = new Promise((resolve) => this.child.once("close", () => resolve()));
  }
  async request<T>(input: string, read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.failure || this.child.exitCode !== null || this.child.killed)
      throw new Error("Git object reader is unavailable");
    const abort = () => {
      this.child.kill();
      this.child.stdout.destroy(new Error("Git object read cancelled"));
    };
    const timeout = setTimeout(() => {
      this.failure = new Error("Git object read timed out");
      this.child.kill();
      this.child.stdout.destroy(this.failure);
    }, 60000);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      this.child.stdin.write(input);
      return await read();
    } catch (error) {
      this.child.kill();
      signal?.throwIfAborted();
      throw this.failure || error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
  private async more() {
    const item = await this.iterator.next();
    if (item.done) throw new Error("Git object response ended unexpectedly");
    this.pending = this.pending.length ? Buffer.concat([this.pending, item.value]) : item.value;
  }
  async field(delimiter = 10, limit = 1024 * 1024): Promise<string> {
    for (;;) {
      const end = this.pending.indexOf(delimiter);
      if (end >= 0) {
        if (end > limit) throw new Error("Git object header exceeds the analysis size limit");
        const text = this.pending.subarray(0, end).toString("utf8");
        this.pending = this.pending.subarray(end + 1);
        return text;
      }
      if (this.pending.length > limit)
        throw new Error("Git object header exceeds the analysis size limit");
      await this.more();
    }
  }
  async bytes(size: number): Promise<Buffer> {
    const result = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      if (!this.pending.length) await this.more();
      const count = Math.min(this.pending.length, size - offset);
      this.pending.copy(result, offset, 0, count);
      this.pending = this.pending.subarray(count);
      offset += count;
    }
    return result;
  }
  async close() {
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.kill();
    await this.exited;
  }
}

export type GitTreeFile = { oid: string; size: number; mode: string };
type ObjectRow = { type: string; size: number; body: Buffer | null };

/** Immutable Git metadata is kept on disk for this analysis only. */
export class AttributionGitObjects {
  readonly stats = {
    objectProcesses: 0,
    objectInfoQueries: 0,
    objectContentQueries: 0,
    objectContentBytes: 0,
    attributePaths: 0,
  };
  readonly db: Database.Database = new Database("");
  private pipes = new Map<string, GitPipe>();
  private retired: GitPipe[] = [];
  private get;
  private save;
  private attributes;
  private saveAttribute;
  constructor() {
    try {
      // A fixed page budget avoids random-index I/O without an unbounded JS cache.
      this.db.pragma("cache_size=-65536");
      this.db.pragma("journal_mode=OFF");
      this.db.pragma("synchronous=OFF");
      this.db
        .exec(`CREATE TABLE objects(repository TEXT,oid TEXT,type TEXT,size INTEGER,body BLOB,PRIMARY KEY(repository,oid));
      CREATE TABLE attributes(repository TEXT,path TEXT,value TEXT,PRIMARY KEY(repository,path));`);
      this.get = this.db.prepare("SELECT type,size,body FROM objects WHERE repository=? AND oid=?");
      this.save = this.db
        .prepare(`INSERT INTO objects VALUES (?,?,?,?,?) ON CONFLICT(repository,oid)
      DO UPDATE SET type=excluded.type,size=excluded.size,body=coalesce(excluded.body,objects.body)`);
      this.attributes = this.db.prepare(
        "SELECT value FROM attributes WHERE repository=? AND path=?",
      );
      this.saveAttribute = this.db.prepare("INSERT OR REPLACE INTO attributes VALUES (?,?,?)");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private pipe(repository: string, kind: "content" | "info" | "attributes") {
    const key = repository + "\0" + kind;
    let pipe = this.pipes.get(key);
    if (!pipe?.available) {
      if (pipe) this.retired.push(pipe);
      pipe = new GitPipe(
        repository,
        kind === "attributes"
          ? ["check-attr", "-z", "--stdin", "diff"]
          : ["cat-file", kind === "content" ? "--batch" : "--batch-check"],
      );
      this.pipes.set(key, pipe);
      this.stats.objectProcesses++;
    }
    return pipe;
  }
  private valid(oid: string) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))
      throw new Error("Invalid Git object identity");
  }
  private header(value: string) {
    const found = /^([a-f0-9]+) (blob|tree|commit|tag) (\d+)$/.exec(value);
    if (!found) throw new Error("Git object is missing or unreadable");
    const size = Number(found[3]);
    if (!Number.isSafeInteger(size)) throw new Error("Invalid Git object size");
    return { type: found[2], size };
  }
  async info(repository: string, oids: string[], signal?: AbortSignal) {
    const result = new Map<string, ObjectRow>();
    const missing: string[] = [];
    for (const oid of new Set(oids)) {
      this.valid(oid);
      const saved = this.get.get(repository, oid) as ObjectRow | undefined;
      if (saved) result.set(oid, saved);
      else missing.push(oid);
    }
    for (let i = 0; i < missing.length; i += 128) {
      const batch = missing.slice(i, i + 128),
        pipe = this.pipe(repository, "info");
      await pipe.request(
        batch.join("\n") + "\n",
        async () => {
          for (const oid of batch) {
            const row = { ...this.header(await pipe.field()), body: null };
            this.stats.objectInfoQueries++;
            this.save.run(repository, oid, row.type, row.size, null);
            result.set(oid, row);
          }
        },
        signal,
      );
    }
    return result;
  }
  async read(repository: string, oid: string, limit: number, signal?: AbortSignal) {
    this.valid(oid);
    const saved = this.get.get(repository, oid) as ObjectRow | undefined;
    if (saved?.body) {
      if (saved.size > limit) throw new Error("Git object exceeds the analysis size limit");
      return saved;
    }
    const pipe = this.pipe(repository, "content");
    return pipe.request(
      oid + "\n",
      async () => {
        const header = this.header(await pipe.field());
        if (header.size > limit) throw new Error("Git object exceeds the analysis size limit");
        const body = await pipe.bytes(header.size);
        this.stats.objectContentQueries++;
        this.stats.objectContentBytes += header.size;
        if ((await pipe.bytes(1))[0] !== 10) throw new Error("Invalid Git object framing");
        // Blob content belongs to the line index; retain only commit/tree metadata.
        this.save.run(
          repository,
          oid,
          header.type,
          header.size,
          header.type === "blob" ? null : body,
        );
        return { ...header, body };
      },
      signal,
    );
  }
  async tree(repository: string, commit: string, signal?: AbortSignal) {
    const object = await this.read(repository, commit, 8 * 1024 * 1024, signal);
    const root = /^tree ([a-f0-9]+)\n/.exec(object.body!.toString("utf8"))?.[1];
    if (object.type !== "commit" || !root) throw new Error("Git commit tree is unreadable");
    const files = new Map<string, GitTreeFile>();
    let pathBytes = 0;
    const walk = async (oid: string, prefix: string, depth: number) => {
      signal?.throwIfAborted();
      if (depth > 256) throw new Error("Git tree exceeds the analysis depth limit");
      const tree = await this.read(repository, oid, 8 * 1024 * 1024, signal);
      if (tree.type !== "tree") throw new Error("Invalid Git tree object");
      const body = tree.body!,
        hashBytes = oid.length / 2;
      let offset = 0;
      while (offset < body.length) {
        const space = body.indexOf(32, offset),
          zero = body.indexOf(0, space + 1);
        if (space < offset || zero < space || zero + 1 + hashBytes > body.length)
          throw new Error("Invalid Git tree entry");
        const mode = body.subarray(offset, space).toString(),
          name = body.subarray(space + 1, zero).toString("utf8");
        const child = body.subarray(zero + 1, zero + 1 + hashBytes).toString("hex");
        offset = zero + 1 + hashBytes;
        if (mode === "40000") await walk(child, prefix + name + "/", depth + 1);
        else if (mode !== "160000") {
          pathBytes += Buffer.byteLength(prefix + name) + child.length + 30;
          if (pathBytes > 8 * 1024 * 1024)
            throw new Error("Git tree exceeds the analysis size limit");
          files.set(prefix + name, { oid: child, mode, size: 0 });
        }
      }
    };
    await walk(root, "", 0);
    const sizes = await this.info(
      repository,
      [...files.values()].map((file) => file.oid),
      signal,
    );
    for (const file of files.values()) file.size = sizes.get(file.oid)!.size;
    return files;
  }
  async diffAttributes(repository: string, paths: string[], signal?: AbortSignal) {
    const result = new Map<string, string>(),
      missing: string[] = [];
    for (const path of paths) {
      const saved = this.attributes.get(repository, path) as { value: string } | undefined;
      if (saved) result.set(path, saved.value);
      else missing.push(path);
    }
    for (let i = 0; i < missing.length; i += 128) {
      const batch = missing.slice(i, i + 128),
        pipe = this.pipe(repository, "attributes");
      await pipe.request(
        batch.join("\0") + "\0",
        async () => {
          for (const path of batch) {
            if ((await pipe.field(0)) !== path || (await pipe.field(0)) !== "diff")
              throw new Error("Invalid Git attribute response");
            const value = await pipe.field(0);
            this.stats.attributePaths++;
            this.saveAttribute.run(repository, path, value);
            result.set(path, value);
          }
        },
        signal,
      );
    }
    return result;
  }
  async close() {
    await Promise.allSettled([...this.pipes.values(), ...this.retired].map((pipe) => pipe.close()));
    this.db.close();
  }
}
