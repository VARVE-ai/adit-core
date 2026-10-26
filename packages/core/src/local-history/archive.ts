import { isDeepStrictEqual } from "node:util";
import {createHistorySchema} from "./schema.js";
import {StructuredHistory} from "./structured-store.js";
import {applyTranscriptEdits} from "./transcript-edits.js";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { parseClaude } from "./claude.js";
import { parseDeepseek } from "./deepseek-tui.js";
import { parseGemini } from "./gemini.js";
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
import {readCodexSession,refreshCodexContinuations,refreshCodexContexts,refreshCodexSources} from "./codex-file.js";
import {SourceCheckpoints, trackSourceReads} from "./source-checkpoints.js";
import {collectIncrementalJSONL} from "./incremental-jsonl.js";
import {discoverHistory} from "./discovery.js";
import {ScanProgressTracker, type SourceProgressListener, type SourceScanProgress} from "./scan-progress.js";
export type {SourceScanProgress,SourceProgressListener} from "./scan-progress.js";

const PARSER_VERSION = 6;
// Recollect existing archives once for native titles and blank-title normalization.
const parserVersion = (provider: string) => provider==="cursor-ide" ? 7 : provider==="qoder" ? 8 : ["codex", "traex", "augure-code"].includes(provider) ? 9 :
  ["claude","cowork","qoder","icodemate","opencode","kilo","mimocode","copilot","vscode-copilot","positron","roocode","kilo-legacy","junie","muse","poolside","visualstudio-copilot","kimi","kimi-work"].includes(provider)?7:PARSER_VERSION;
export interface ScanSource {
  id: string;
  paths: string[];
}
export interface ScanResult {
  counts: Record<string, number>;
  errors: string[];
  scanned: number;
  updated: number;
  /** Discovery files whose workspace/identity needs full collection to confirm. */
  pending?: Record<string, number>;
  cached?: number;
  sourceProgress?:Record<string,Record<string,SourceScanProgress>>;
}

export class LocalHistory {
  constructor(readonly db: Database.Database, options: {discovery?:boolean} = {}) {
    createHistorySchema(db);
    if(!options.discovery){refreshCodexSources(db);refreshCodexContinuations(db);new StructuredHistory(db).refreshCodexPromptSummaries();}
  }

  counts(workspace: string, providers?: string[]): Record<string, number> {
    const result: Record<string, number> = {};
    const counted=new Set<string>();
    const rows = this.db
      .prepare(
        "SELECT s.provider,CASE WHEN s.relationship='continuation' THEN s.parent_id ELSE s.id END AS conversation_id,CASE WHEN s.cwd='' THEN coalesce(a.workspace,'') ELSE s.cwd END AS cwd FROM adit_history_sessions s LEFT JOIN adit_history_assignments a ON a.provider=s.provider AND a.session_id=s.id WHERE s.parent_id IS NULL OR s.relationship IN ('fork','continuation')",
      )
      .all() as { provider: string; conversation_id:string; cwd: string }[];
    for (const row of rows)
      if (
        (!providers || providers.includes(row.provider) || ["claude-ai", "chatgpt", "gemini-apps"].includes(row.provider)) &&
        !!row.cwd && insideDirectory(workspace, row.cwd) && !counted.has(`${row.provider}\0${row.conversation_id}`)
      )
      {
        counted.add(`${row.provider}\0${row.conversation_id}`);
        result[row.provider] = (result[row.provider] || 0) + 1;
      }
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
      scopes?: { path: string; providers: string[] }[];
      signal?: AbortSignal;
      beforeSource?: (id: string) => void;
      progress?: (scanned: number, updated: number) => void;
      sourceProgress?: SourceProgressListener;
    } = {},
  ): Promise<ScanResult> {
    if(options.preview)return discoverHistory(this.db,workspace,sources,options);
    refreshCodexSources(this.db);
    const result: ScanResult = {
      counts: {},
      errors: [],
      scanned: 0,
      updated: 0,
    };
    const seenFiles = new Set<string>();
    const databaseSessions = new Set<string>();
    const sessions = new Map<string, Pick<HistorySession,"provider"|"id"|"cwd"|"parentId"|"relationship">>();
    const checkpoints = new SourceCheckpoints(this.db);
    for (const source of sources) {
      const version = parserVersion(source.id);
      const scopes = options.scopes?.filter(s => s.providers.includes(source.id)).map(s => s.path) ?? [workspace];
      if (!scopes.length) continue;
      const accepts = (cwd: string) => scopes.some(scope => insideDirectory(scope, cwd));
      options.signal?.throwIfAborted();
      options.beforeSource?.(source.id);
      refreshCodexContexts(this.db,{provider:source.id,scopes,signal:options.signal});
      const sourceErrors=result.errors.length;
      const detail=options.sourceProgress?new ScanProgressTracker(this.db,source,scopes,(scope,provider,progress)=>{
        result.sourceProgress ??= {};result.sourceProgress[scope] ??= {};result.sourceProgress[scope][provider]=progress;
        options.sourceProgress!(scope,provider,progress);
      }):undefined;
      await detail?.plan({signal:options.signal,beforeSource:options.beforeSource});
      if(detail)result.errors.push(...detail.errors);
      for (const root of source.paths) {
        try {
          for await (const path of detail ? detail.files.get(root)||[] : sourceFiles(
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
            const previousUpdated=result.updated;
            try {
              const scopeKey = JSON.stringify([resolve(root), [...scopes].sort()]);
              const cached = !options.preview ? checkpoints.unchanged(source.id, pathKey, scopeKey, version, insideDirectory) : undefined;
              if (cached) {
                if(path.endsWith(".db"))for(const [provider,id] of cached)databaseSessions.add(`${provider}:${id}`);
                result.scanned++;
                detail?.processed(cached);
                options.progress?.(result.scanned, result.updated);
                continue;
              }
              const references: [string, string][] = [];
              const writes: (() => void)[] = [];
              let retry = false;
              let commitCursor:(()=>void)|undefined;
              const captured = await trackSourceReads(path, async () => {
              if (
                (["codex","traex","augure-code","opencode", "kilo", "mimocode", "icodemate", "cursor-ide", ...piProviders, ...sidecarProviders, ...additionalProviders].includes(
                  source.id,
                ) && !(source.id === "icodemate" && path.endsWith(".jsonl")))
              ) {
                const failedMembers=new Set<string>();
                const collected=await collectIncrementalJSONL(this.db,source.id,path,scopeKey,version,async()=>["codex","traex","augure-code"].includes(source.id)
                  ? await readCodexSession(path,source.id,root,options.signal)
                  : additionalProviders.includes(source.id)
                  ? await readAdditionalSource(path, source.id, options.signal)
                  : sidecarProviders.includes(source.id)
                  ? await readSidecarSession(path, source.id, options.signal)
                  : piProviders.includes(source.id)
                  ? await readPi(path, source.id, root, options.signal)
                  : source.id === "cursor-ide"
                    ? readCursorIDE(path, scopes, options.signal,(id,error)=>{
                        failedMembers.add(id);
                        retry = true;
                        result.errors.push(`cursor-ide: ${error instanceof Error?error.message:"Session could not be read"}`);
                      },id=>new StructuredHistory(this.db).read("cursor-ide",id))
                    : path.endsWith(".db")
                      ? readOpenCodeDatabase(
                          path,
                          source.id,
                          scopes,
                          options.signal,
                        )
                      : await readOpenCodeStorage(
                          path,
                          source.id,
                          scopes,
                          options.signal,
                        ),options.signal);
                const snapshots=collected.sessions;commitCursor=collected.commit;
                // A container/sidecar can change without the primary file changing.
                // Check each logical session, using its own stable checkpoint.
                for (const session of snapshots) {
                  if (session.metadata?.lineageRetry) retry = true;
                  if (session.cwd && !accepts(session.cwd)) continue;
                  references.push([session.provider, session.id]);
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
                  if(options.preview)sessions.set(`${session.provider}:${session.id}`, {provider:session.provider,id:session.id,cwd:session.cwd,parentId:session.parentId,relationship:session.relationship});
                  options.signal?.throwIfAborted();
                  options.beforeSource?.(source.id);
                  if (
                    !options.preview &&
                    (old?.fingerprint !== fingerprint ||
                      old.parser_version !== version)
                  ) {
                    writes.push(() => { this.save(
                      session,
                      key,
                      fingerprint,
                      undefined,
                      path.endsWith(".db"),
                    );
                    result.updated++; });
                  }
                }
                if(!options.preview){
                  options.signal?.throwIfAborted();options.beforeSource?.(source.id);
                  const retained=new Set(snapshots.map(session=>`${pathKey}#${encodeURIComponent(session.id)}`));
                  for(const id of failedMembers)retained.add(`${pathKey}#${encodeURIComponent(id)}`);
                  writes.push(()=>{
                    const prefix=`${pathKey}#`;
                    const previous=this.db.prepare(`SELECT src.path,src.session_id,s.cwd FROM adit_history_sources src
                      JOIN adit_history_sessions s ON s.provider=src.provider AND s.id=src.session_id
                      WHERE src.provider=? AND substr(src.path,1,length(?))=?`).all(source.id,prefix,prefix) as {path:string;session_id:string;cwd:string}[];
                    for(const old of previous)if(!retained.has(old.path) && (!old.cwd || accepts(old.cwd))){
                      this.db.prepare("DELETE FROM adit_history_sources WHERE provider=? AND path=?").run(source.id,old.path);
                      this.db.prepare("DELETE FROM adit_history_sessions WHERE provider=? AND id=? AND NOT EXISTS(SELECT 1 FROM adit_history_sources WHERE provider=? AND session_id=?)").run(source.id,old.session_id,source.id,old.session_id);
                      result.updated++;
                    }
                  });
                }
                return;
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
              let cwdHint =
                source.id === "gemini"
                  ? await geminiWorkspace(root, path)
                  : "";
              if(source.id==="cursor"){
                const matches=[...new Set((await Promise.all(scopes.map(scope=>cursorWorkspace(root,path,scope,options.signal)))).filter(Boolean))];
                if(matches.length>1)throw new Error("Cursor project path cannot be resolved unambiguously");
                cwdHint=matches[0]||"";
              }
              if (source.id === "cursor" && !cwdHint) return;
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
                old.parser_version === version
              )
                session = this.session(source.id, old.session_id);
              if (!session) {
                const text = buffer.toString("utf8");
                switch (source.id) {
                  case "claude":
                    session = parseClaude(text, path);
                    break;
                  case "icodemate":
                    session = parseClaude(text, path, {compatibleTitles:true});
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
              if (session.cwd && !accepts(session.cwd)) return;
              references.push([session.provider, session.id]);
              if(options.preview)sessions.set(`${session.provider}:${session.id}`, {provider:session.provider,id:session.id,cwd:session.cwd,parentId:session.parentId,relationship:session.relationship});
              options.signal?.throwIfAborted();
              options.beforeSource?.(source.id);
              if (
                !options.preview &&
                (old?.fingerprint !== fingerprint ||
                  old.parser_version !== version)
              ) {
                const snapshot=session;
                writes.push(()=>{this.save(snapshot, pathKey, fingerprint, old?.session_id);result.updated++;});
              }
              });
              options.signal?.throwIfAborted();
              options.beforeSource?.(source.id);
              if(!captured.stable)throw new Error("Source changed while reading; retry on the next collection");
              if (!options.preview) this.db.transaction(()=>{
                for(const write of writes)write();
                if(!retry){checkpoints.save(source.id, pathKey, scopeKey, version, captured.manifest, references);commitCursor?.();}
              })();
              detail?.processed(references);
            } catch (error) {
              result.updated=previousUpdated;
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
      detail?.publish(result.errors.length>sourceErrors?"partial":"done");
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
      // Titles may change independently of identical transcript copies. All other
      // evidence must still agree, so an older copy cannot erase a newer transcript.
      const comparable=(value:HistorySession)=>{
        const copy=JSON.parse(JSON.stringify(value)) as HistorySession;
        if(copy.metadata){delete copy.metadata.title;if(!Object.keys(copy.metadata).length)delete copy.metadata;}
        return copy;
      };
      if (current && !isDeepStrictEqual(comparable(current),comparable(applyTranscriptEdits(this.db,session))))
        throw new Error(
          "Conflicting copies of the same session; existing archive retained",
        );
      new StructuredHistory(this.db).write(session);
      this.db
        .prepare(
          "INSERT INTO adit_history_sources VALUES (?,?,?,?,?) ON CONFLICT(provider,path) DO UPDATE SET session_id=excluded.session_id,fingerprint=excluded.fingerprint,parser_version=excluded.parser_version",
        )
        .run(session.provider, path, session.id, fingerprint, parserVersion(session.provider));
      if (previousId && previousId !== session.id)
        this.db
          .prepare(
            "DELETE FROM adit_history_sessions WHERE provider=? AND id=? AND NOT EXISTS (SELECT 1 FROM adit_history_sources WHERE provider=? AND session_id=?)",
          )
          .run(session.provider, previousId, session.provider, previousId);
    })();
  }
}
