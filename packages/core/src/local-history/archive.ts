import { isDeepStrictEqual } from "node:util";
import {createHistorySchema} from "./schema.js";
import {StructuredHistory} from "./structured-store.js";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import {
  parseClaude,
  parseDeepseek,
  parseGemini,
} from "./parsers.js";
import { geminiWorkspace, insideDirectory, sourceFiles } from "./sources.js";
import type { HistorySession } from "./types.js";
import { readOpenCodeDatabase, readOpenCodeStorage } from "./opencode.js";
import { cursorWorkspace, parseCursor, readCursorIDE } from "./cursor.js";
import { decodeHarness, parseHarness } from "./deepseek-harness.js";
import { piProviders, readPi } from "./pi.js";
import { parseProjectJSONL } from "./project-jsonl.js";
import { readSourceJSON } from "./source-io.js";
import { sidecarProviders, readSidecarSession } from "./sidecar-sessions.js";
import { parseZencoder } from "./zencoder.js";
import { additionalProviders, readAdditionalSource } from "./additional-sources.js";
import { readConversationExport } from "./export-import.js";
import {readCodexSession} from "./codex-file.js";

const PARSER_VERSION = 5;
export interface ScanSource {
  id: string;
  paths: string[];
}
export interface ScanResult {
  counts: Record<string, number>;
  errors: string[];
  scanned: number;
  updated: number;
}

export class LocalHistory {
  constructor(readonly db: Database.Database) {
    createHistorySchema(db);
  }

  counts(workspace: string, providers?: string[]): Record<string, number> {
    const result: Record<string, number> = {};
    const rows = this.db
      .prepare(
        "SELECT s.provider,CASE WHEN s.cwd='' THEN coalesce(a.workspace,'') ELSE s.cwd END AS cwd FROM adit_history_sessions s LEFT JOIN adit_history_assignments a ON a.provider=s.provider AND a.session_id=s.id WHERE s.parent_id IS NULL OR s.relationship='fork'",
      )
      .all() as { provider: string; cwd: string }[];
    for (const row of rows)
      if (
        (!providers || providers.includes(row.provider) || ["claude-ai", "chatgpt", "gemini-apps"].includes(row.provider)) &&
        !!row.cwd && insideDirectory(workspace, row.cwd)
      )
        result[row.provider] = (result[row.provider] || 0) + 1;
    return result;
  }

  session(provider: string, id: string): HistorySession | undefined {
    return new StructuredHistory(this.db).read(provider,id);
  }

  async importExport(path: string, provider: string, workspace: string, signal?: AbortSignal) {
    const snapshots = await readConversationExport(path,provider,workspace,signal);
    // Validate the whole export before writing any of it; repeat imports replace the same identities.
    this.db.transaction(() => {
      for (const snapshot of snapshots) {
        signal?.throwIfAborted();
        const key=`import:${provider}:${encodeURIComponent(snapshot.id)}`;
        this.save(snapshot,key,createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"));
      }
    })();
    return { imported:snapshots.length, counts:this.counts(workspace) };
  }

  unassigned() {
    return this.db.prepare("SELECT s.provider,s.id,coalesce(s.title,s.id) AS title,s.message_count AS messages FROM adit_history_sessions s LEFT JOIN adit_history_assignments a ON a.provider=s.provider AND a.session_id=s.id WHERE s.cwd='' AND a.session_id IS NULL ORDER BY s.provider,s.id").all();
  }

  assign(provider: string,id: string,workspace: string) {
    const value=this.session(provider,id);
    if(!value)throw new Error("Archived session was not found");
    if(value.cwd)throw new Error("This session already has a recorded working directory");
    this.db.prepare("INSERT INTO adit_history_assignments VALUES (?,?,?) ON CONFLICT(provider,session_id) DO UPDATE SET workspace=excluded.workspace").run(provider,id,workspace);
    return {provider,id,workspace};
  }

  async scan(
    workspace: string,
    sources: ScanSource[],
    options: {
      preview?: boolean;
      signal?: AbortSignal;
      beforeSource?: (id: string) => void;
      progress?: (scanned: number, updated: number) => void;
    } = {},
  ): Promise<ScanResult> {
    const result: ScanResult = {
      counts: {},
      errors: [],
      scanned: 0,
      updated: 0,
    };
    const seenFiles = new Set<string>();
    const databaseSessions = new Set<string>();
    const sessions = new Map<string, HistorySession>();
    for (const source of sources) {
      options.signal?.throwIfAborted();
      options.beforeSource?.(source.id);
      for (const root of source.paths) {
        try {
          for await (const path of sourceFiles(
            source.id,
            root,
            options.signal,
          )) {
            options.signal?.throwIfAborted();
            options.beforeSource?.(source.id);
            const pathKey =
              process.platform === "win32"
                ? resolve(path).toLowerCase()
                : resolve(path);
            const fileKey = `${source.id}:${pathKey}`;
            if (seenFiles.has(fileKey)) continue;
            seenFiles.add(fileKey);
            try {
              if (
                (["codex","traex","augure-code","opencode", "kilo", "mimocode", "icodemate", "cursor-ide", ...piProviders, ...sidecarProviders, ...additionalProviders].includes(
                  source.id,
                ) && !(source.id === "icodemate" && path.endsWith(".jsonl")))
              ) {
                const failedMembers=new Set<string>();
                const snapshots = ["codex","traex","augure-code"].includes(source.id)
                  ? await readCodexSession(path,source.id,root,options.signal)
                  : additionalProviders.includes(source.id)
                  ? await readAdditionalSource(path, source.id, options.signal)
                  : sidecarProviders.includes(source.id)
                  ? await readSidecarSession(path, source.id, options.signal)
                  : piProviders.includes(source.id)
                  ? await readPi(path, source.id, root, options.signal)
                  : source.id === "cursor-ide"
                    ? readCursorIDE(path, workspace, options.signal,(id,error)=>{
                        failedMembers.add(id);
                        result.errors.push(`cursor-ide: ${error instanceof Error?error.message:"Session could not be read"}`);
                      })
                    : path.endsWith(".db")
                      ? readOpenCodeDatabase(
                          path,
                          source.id,
                          workspace,
                          options.signal,
                        )
                      : await readOpenCodeStorage(
                          path,
                          source.id,
                          workspace,
                          options.signal,
                        );
                // A container/sidecar can change without the primary file changing.
                // Check each logical session, using its own stable checkpoint.
                for (const session of snapshots) {
                  if (session.cwd && !insideDirectory(workspace, session.cwd)) continue;
                  const sessionKey = `${session.provider}:${session.id}`;
                  if (["opencode", "kilo", "mimocode", "icodemate"].includes(source.id)) {
                    if (path.endsWith(".db")) databaseSessions.add(sessionKey);
                    else if (databaseSessions.has(sessionKey)) continue;
                  }
                  const key = `${pathKey}#${encodeURIComponent(session.id)}`;
                  const fingerprint = createHash("sha256")
                    .update(JSON.stringify(session))
                    .digest("hex");
                  const old = this.db
                    .prepare(
                      "SELECT fingerprint,parser_version FROM adit_history_sources WHERE provider=? AND path=?",
                    )
                    .get(source.id, key) as
                    | { fingerprint: string; parser_version: number }
                    | undefined;
                  sessions.set(`${session.provider}:${session.id}`, session);
                  options.signal?.throwIfAborted();
                  options.beforeSource?.(source.id);
                  if (
                    !options.preview &&
                    (old?.fingerprint !== fingerprint ||
                      old.parser_version !== PARSER_VERSION)
                  ) {
                    this.save(
                      session,
                      key,
                      fingerprint,
                      undefined,
                      path.endsWith(".db"),
                    );
                    result.updated++;
                  }
                }
                if(!options.preview){
                  options.signal?.throwIfAborted();options.beforeSource?.(source.id);
                  const retained=new Set(snapshots.map(session=>`${pathKey}#${encodeURIComponent(session.id)}`));
                  for(const id of failedMembers)retained.add(`${pathKey}#${encodeURIComponent(id)}`);
                  this.db.transaction(()=>{
                    const prefix=`${pathKey}#`;
                    const previous=this.db.prepare("SELECT path,session_id FROM adit_history_sources WHERE provider=? AND substr(path,1,length(?))=?").all(source.id,prefix,prefix) as {path:string;session_id:string}[];
                    for(const old of previous)if(!retained.has(old.path)){
                      this.db.prepare("DELETE FROM adit_history_sources WHERE provider=? AND path=?").run(source.id,old.path);
                      this.db.prepare("DELETE FROM adit_history_sessions WHERE provider=? AND id=? AND NOT EXISTS(SELECT 1 FROM adit_history_sources WHERE provider=? AND session_id=?)").run(source.id,old.session_id,source.id,old.session_id);
                      result.updated++;
                    }
                  })();
                }
                result.scanned++;
                options.progress?.(result.scanned, result.updated);
                continue;
              }
              const before = await stat(path);
              if (before.size > 128 * 1024 * 1024)
                throw new Error("Source exceeds the 128 MiB snapshot limit");
              const buffer = await readFile(path, { signal: options.signal });
              const after = await stat(path);
              if (
                before.size !== after.size ||
                before.mtimeMs !== after.mtimeMs ||
                before.ino !== after.ino
              )
                throw new Error(
                  "Source changed while reading; retry on the next collection",
                );
              const cwdHint =
                source.id === "gemini"
                  ? await geminiWorkspace(root, path)
                  : source.id === "cursor"
                    ? await cursorWorkspace(
                        root,
                        path,
                        workspace,
                        options.signal,
                      )
                    : "";
              if (source.id === "cursor" && !cwdHint) continue;
              let metadata: Record<string, unknown> = {};
              if (source.id === "commandcode") {
                try { metadata = await readSourceJSON(path.replace(/\.jsonl$/, ".meta.json"), options.signal); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
              }
              const fingerprint = createHash("sha256")
                .update(buffer)
                .update(cwdHint)
                .update(JSON.stringify(metadata))
                .digest("hex");
              const old = this.db
                .prepare(
                  "SELECT session_id,fingerprint,parser_version FROM adit_history_sources WHERE provider=? AND path=?",
                )
                .get(source.id, pathKey) as
                | {
                    session_id: string;
                    fingerprint: string;
                    parser_version: number;
                  }
                | undefined;
              let session: HistorySession | undefined;
              if (
                old?.fingerprint === fingerprint &&
                old.parser_version === PARSER_VERSION
              )
                session = this.session(source.id, old.session_id);
              if (!session) {
                const text = buffer.toString("utf8");
                switch (source.id) {
                  case "claude":
                    session = parseClaude(text, path);
                    break;
                  case "icodemate":
                    session = parseClaude(text, path);
                    session.provider = source.id;
                    break;
                  case "zencoder":
                    session = parseZencoder(text);
                    break;
                  case "openclaude":
                  case "qwen":
                  case "commandcode":
                    session = parseProjectJSONL(text, source.id, path, metadata);
                    break;
                  case "gemini":
                    session = parseGemini(text, cwdHint);
                    break;
                  case "deepseek-tui":
                    session = parseDeepseek(text);
                    break;
                  case "deepseek-harness":
                    session = parseHarness(
                      decodeHarness(buffer, path.endsWith(".zstd")),
                    );
                    break;
                  case "cursor":
                    session = parseCursor(text, path, cwdHint);
                    break;
                  default:
                    throw new Error("Source parser is not implemented");
                }
              }
              if (session.cwd && !insideDirectory(workspace, session.cwd)) continue;
              sessions.set(`${session.provider}:${session.id}`, session);
              options.signal?.throwIfAborted();
              options.beforeSource?.(source.id);
              if (
                !options.preview &&
                (old?.fingerprint !== fingerprint ||
                  old.parser_version !== PARSER_VERSION)
              ) {
                this.save(session, pathKey, fingerprint, old?.session_id);
                result.updated++;
              }
            } catch (error) {
              options.signal?.throwIfAborted();
              result.errors.push(
                `${source.id}: ${error instanceof Error ? error.message : "Source could not be read"}`,
              );
            }
            result.scanned++;
            options.progress?.(result.scanned, result.updated);
          }
        } catch (error) {
          options.signal?.throwIfAborted();
          result.errors.push(
            `${source.id}: ${error instanceof Error ? error.message : "Source directory could not be read"}`,
          );
        }
      }
    }
    for (const session of sessions.values()) {
      const assignment = !session.cwd ? this.db.prepare("SELECT workspace FROM adit_history_assignments WHERE provider=? AND session_id=?").get(session.provider,session.id) as {workspace:string}|undefined : undefined;
      const cwd=session.cwd || assignment?.workspace;
      if (cwd && insideDirectory(workspace,cwd) && (!session.parentId || session.relationship === "fork"))
        result.counts[session.provider] =
          (result.counts[session.provider] || 0) + 1;
    }
    if (!options.preview)
      result.counts = this.counts(
        workspace,
        sources.map((s) => s.id),
      );
    return result;
  }

  private save(
    session: HistorySession,
    path: string,
    fingerprint: string,
    previousId?: string,
    authoritativeDatabase = false,
  ): void {
    this.db.transaction(() => {
      if(["codex","traex","augure-code"].includes(session.provider)&&path.includes("#"))
        this.db.prepare("DELETE FROM adit_history_sources WHERE provider=? AND path=?").run(session.provider,path.slice(0,path.lastIndexOf("#")));
      if (
        authoritativeDatabase &&
        ["opencode", "kilo", "mimocode", "icodemate"].includes(session.provider)
      )
        this.db
          .prepare(
            "DELETE FROM adit_history_sources WHERE provider=? AND session_id=? AND path LIKE '%.json#%'",
          )
          .run(session.provider, session.id);
      if (session.provider === "cursor" && path.endsWith(".jsonl"))
        this.db
          .prepare(
            "DELETE FROM adit_history_sources WHERE provider=? AND session_id=? AND path LIKE '%.txt'",
          )
          .run(session.provider, session.id);
      if (["vscode-copilot","positron"].includes(session.provider) && path.includes(".jsonl#"))
        this.db.prepare("DELETE FROM adit_history_sources WHERE provider=? AND session_id=? AND path LIKE '%.json#%'").run(session.provider,session.id);
      if (["openclaw","qclaw"].includes(session.provider) && path.includes("openclaw-agent.sqlite#"))
        this.db.prepare("DELETE FROM adit_history_sources WHERE provider=? AND session_id=? AND path NOT LIKE '%openclaw-agent.sqlite#%'").run(session.provider,session.id);
      if(session.provider==="hermes" && path.includes("state.db#"))
        this.db.prepare("DELETE FROM adit_history_sources WHERE provider=? AND session_id=? AND path NOT LIKE '%state.db#%'").run(session.provider,session.id);
      const other = this.db
        .prepare(
          "SELECT path FROM adit_history_sources WHERE provider=? AND session_id=? AND path<>? LIMIT 1",
        )
        .get(session.provider, session.id, path);
      const current = other
        ? this.session(session.provider, session.id)
        : undefined;
      // Copies of the same source may coexist; never let an older copy erase a newer transcript.
      if (current && !isDeepStrictEqual(JSON.parse(JSON.stringify(current)),JSON.parse(JSON.stringify(session))))
        throw new Error(
          "Conflicting copies of the same session; existing archive retained",
        );
      new StructuredHistory(this.db).write(session);
      this.db
        .prepare(
          "INSERT INTO adit_history_sources VALUES (?,?,?,?,?) ON CONFLICT(provider,path) DO UPDATE SET session_id=excluded.session_id,fingerprint=excluded.fingerprint,parser_version=excluded.parser_version",
        )
        .run(session.provider, path, session.id, fingerprint, PARSER_VERSION);
      if (previousId && previousId !== session.id)
        this.db
          .prepare(
            "DELETE FROM adit_history_sessions WHERE provider=? AND id=? AND NOT EXISTS (SELECT 1 FROM adit_history_sources WHERE provider=? AND session_id=?)",
          )
          .run(session.provider, previousId, session.provider, previousId);
    })();
  }
}
