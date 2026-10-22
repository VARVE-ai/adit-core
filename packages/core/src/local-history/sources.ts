import { readdir, readFile, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, isAbsolute, sep, basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import { record, string } from "./types.js";
import { directoryEntries } from "./source-io.js";
import { trackSource } from "./source-checkpoints.js";
import { additionalSourceDefinitions, additionalSourceFile } from "./additional-sources.js";

export interface SourceDefinition {
  id: string;
  name: string;
  paths: string[];
  homesSupported: boolean;
  supported: boolean;
  format: string;
}

export function sourceDefinitions(
  home = homedir(),
  env = process.env,
): SourceDefinition[] {
  return [
    ...additionalSourceDefinitions(home, env),
    {
      id: "claude",
      name: "Claude Code",
      paths: [
        env.CLAUDE_PROJECTS_DIR ||
          join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects"),
      ],
      supported: true,
      format: "JSONL",
    },
    {
      id: "codex",
      name: "Codex",
      paths: env.CODEX_SESSIONS_DIR
        ? [env.CODEX_SESSIONS_DIR]
        : [
            join(env.CODEX_HOME || join(home, ".codex"), "sessions"),
            join(env.CODEX_HOME || join(home, ".codex"), "archived_sessions"),
          ],
      supported: true,
      format: "JSONL",
    },
    {
      id: "openclaude", name: "OpenClaude",
      paths: [env.OPENCLAUDE_PROJECTS_DIR || join(env.OPENCLAUDE_CONFIG_DIR || join(home, ".openclaude"), "projects")],
      supported: true, format: "JSONL",
    },
    {
      id: "qwen", name: "Qwen Code",
      paths: [env.QWEN_PROJECTS_DIR || join(home, ".qwen/projects")],
      supported: true, format: "JSONL",
    },
    {
      id: "commandcode", name: "Command Code",
      paths: [env.COMMANDCODE_PROJECTS_DIR || join(home, ".commandcode/projects")],
      supported: true, format: "JSONL / metadata",
    },
    {
      id: "mimocode", name: "MiMoCode",
      paths: [env.MIMOCODE_DIR || join(env.XDG_DATA_HOME || join(home, ".local/share"), "mimocode")],
      supported: true, format: "SQLite / JSON",
    },
    {
      id: "cline", name: "Cline",
      paths: [env.CLINE_DIR || join(home, ".cline")],
      supported: true, format: "JSON / metadata",
    },
    {
      id: "vibe", name: "Mistral Vibe",
      paths: [env.VIBE_SESSIONS_DIR || join(home, ".vibe/logs/session")],
      supported: true, format: "JSONL / metadata",
    },
    {
      id: "icodemate", name: "IcodeMate",
      paths: env.ICODEMATE_DIR ? [env.ICODEMATE_DIR] : [join(env.XDG_DATA_HOME || join(home, ".local/share"), "icodemate"), join(home, ".icodemate/cli/projects")],
      supported: true, format: "SQLite / JSON / JSONL",
    },
    {
      id: "zencoder", name: "Zencoder",
      paths: [env.ZENCODER_DIR || join(home, ".zencoder/sessions")],
      supported: true, format: "JSONL",
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      paths: [env.GEMINI_DIR || join(home, ".gemini")],
      supported: true,
      format: "JSON",
    },
    {
      id: "deepseek-tui",
      name: "DeepSeek TUI",
      paths: env.DEEPSEEK_TUI_SESSIONS_DIR
        ? [env.DEEPSEEK_TUI_SESSIONS_DIR]
        : [
            join(home, ".codewhale", "sessions"),
            join(home, ".deepseek", "sessions"),
          ],
      supported: true,
      format: "JSON",
    },
    {
      id: "deepseek-harness",
      name: "DeepSeek Harness",
      paths: [
        env.DEEPSEEK_HARNESS_SESSIONS_DIR ||
          join(env.DSH_HOME || join(home, ".dsh"), "sessions"),
      ],
      supported: true,
      format: "JSONL / Zstandard",
    },
    {
      id: "cursor",
      name: "Cursor CLI",
      paths: [env.CURSOR_PROJECTS_DIR || join(home, ".cursor/projects")],
      supported: true,
      format: "JSONL / Text",
    },
    {
      id: "cursor-ide",
      name: "Cursor IDE",
      paths: env.CURSOR_IDE_DIR
        ? [env.CURSOR_IDE_DIR]
        : [
            join(home, "AppData/Roaming/Cursor/User/globalStorage"),
            join(home, "Library/Application Support/Cursor/User/globalStorage"),
            join(home, ".config/Cursor/User/globalStorage"),
          ],
      supported: true,
      format: "SQLite",
    },
    {
      id: "opencode",
      name: "OpenCode",
      paths: [
        env.OPENCODE_DIR ||
          join(env.XDG_DATA_HOME || join(home, ".local/share"), "opencode"),
      ],
      supported: true,
      format: "SQLite / JSON",
    },
    {
      id: "kilo",
      name: "Kilo",
      paths: [
        env.KILO_DIR ||
          join(env.XDG_DATA_HOME || join(home, ".local/share"), "kilo"),
      ],
      supported: true,
      format: "SQLite / JSON",
    },
    {
      id: "traex",
      name: "TraeX",
      paths: env.TRAEX_SESSIONS_DIR
        ? [env.TRAEX_SESSIONS_DIR]
        : [
            join(home, ".trae/cli/sessions"),
            join(home, ".trae/cli/archived_sessions"),
          ],
      supported: true,
      format: "JSONL",
    },
    {
      id: "augure-code",
      name: "Augure Code",
      paths: [env.AUGURE_CODE_SESSIONS_DIR || join(home, ".augure/sessions")],
      supported: true,
      format: "JSONL",
    },
    {
      id: "pi",
      name: "Pi",
      paths: [
        env.PI_DIR ||
          env.PI_CODING_AGENT_SESSION_DIR ||
          join(env.PI_CODING_AGENT_DIR || join(home, ".pi/agent"), "sessions"),
      ],
      supported: true,
      format: "JSONL",
    },
    {
      id: "omp",
      name: "OhMyPi",
      paths: [env.OMP_DIR || join(home, ".omp/agent/sessions")],
      supported: true,
      format: "JSONL",
    },
    {
      id: "omo",
      name: "OMO",
      paths: [env.OMO_DIR || join(home, ".omo/agent/sessions")],
      supported: true,
      format: "JSONL",
    },
    {
      id: "prime-agent",
      name: "Prime Agent",
      paths: [
        env.PRIME_AGENT_SESSION_DIR || join(home, ".prime/agent/sessions"),
      ],
      supported: true,
      format: "JSONL",
    },
    {
      id: "stepcode",
      name: "StepCode",
      paths: [
        env.STEPCODE_DIR ||
          env.STEP_CODING_AGENT_SESSION_DIR ||
          join(
            env.STEP_CODING_AGENT_DIR || join(home, ".stepcode/agent"),
            "sessions",
          ),
      ],
      supported: true,
      format: "JSONL",
    },
  ].map((p) => ({ ...p, homesSupported: ["claude","codex","junie","pi"].includes(p.id) }));
}

export function sourceHomePaths(provider:string,home:string):string[]{
  const suffixes:Record<string,string[]>={claude:["projects"],codex:["sessions","archived_sessions"],junie:["sessions"],pi:["sessions"]};
  return (suffixes[provider]||[]).map(suffix=>join(home,suffix));
}

export function insideDirectory(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

export async function* sourceFiles(
  provider: string,
  root: string,
  signal?: AbortSignal,
  depth = 0,
): AsyncGenerator<string> {
  signal?.throwIfAborted();
  if (depth > 10)
    throw new Error("Source directory nesting exceeds supported depth");
  if (provider === "cursor" && depth === 0) {
    yield* cursorFiles(root, signal);
    return;
  }
  if(provider==="cursor-ide"&&depth===0){
    try{
      const info=await lstat(root);if(info.isSymbolicLink())return;
      if(info.isFile()){if(basename(root)==="state.vscdb")yield root;return;}
      for(const entry of await directoryEntries(root))if(entry.isFile()&&entry.name==="state.vscdb")yield join(root,entry.name);
    }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    return;
  }
  if (depth === 0) {
    try {
      const stat = await lstat(root);
      if (stat.isSymbolicLink()) return;
      if (stat.isFile()) {
        if (additionalSourceFile(provider, root) || (provider === "crush" && basename(root) === "projects.json")) yield root;
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    signal?.throwIfAborted();
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (provider === "aider" && (depth>=4 || [".git","node_modules","target","vendor","dist","build",".cache"].includes(entry.name))) continue;
      if (provider === "gemini" && depth === 0 && entry.name !== "tmp")
        continue;
      yield* sourceFiles(provider, path, signal, depth + 1);
    } else if (entry.isFile()) {
      if (["vscode-copilot","positron"].includes(provider) && entry.name.endsWith(".json") && entries.some(candidate=>candidate.name===`${entry.name.slice(0,-5)}.jsonl` && candidate.isFile())) continue;
      if (provider === "crush" && entry.name === "projects.json") yield path;
      if (additionalSourceFile(provider, path)) yield path;
      if (provider === "cline" && entry.name === `${basename(root)}.json`) yield path;
      if (provider === "vibe" && entry.name === "meta.json") yield path;
      if (
        ["codex", "traex", "augure-code"].includes(provider) &&
        /^rollout-.*\.jsonl$/.test(entry.name)
      )
        yield path;
      if (["claude", "openclaude", "icodemate", "zencoder"].includes(provider) && entry.name.endsWith(".jsonl")) yield path;
      if (provider === "qwen" && basename(root) === "chats" && entry.name.endsWith(".jsonl")) yield path;
      if (provider === "commandcode" && entry.name.endsWith(".jsonl") && !/\.(checkpoints|prompts)\.jsonl$/.test(entry.name)) yield path;
      if (
        provider === "gemini" &&
        basename(root) === "chats" &&
        /^session-.*\.jsonl?$/.test(entry.name)
      )
        yield path;
      if (
        provider === "deepseek-tui" &&
        entry.name.endsWith(".json") &&
        !["latest.json", "offline_queue.json"].includes(entry.name)
      )
        yield path;
      if (
        provider === "deepseek-harness" &&
        /\.jsonl(?:\.zstd)?$/.test(entry.name)
      )
        yield path;
      if (
        ["pi", "omp", "omo", "prime-agent", "stepcode"].includes(provider) &&
        entry.name.endsWith(".jsonl")
      )
        yield path;
      if (provider === "cursor-ide" && entry.name === "state.vscdb") yield path;
      if (
        ["opencode", "kilo", "mimocode", "icodemate"].includes(provider) &&
        (entry.name === `${provider}.db` ||
          (entry.name.endsWith(".json") &&
            ["session", ...(["mimocode", "icodemate"].includes(provider) ? ["session_diff"] : [])].includes(basename(dirname(root))) &&
            basename(dirname(dirname(root))) === "storage"))
      )
        yield path;
    }
  }
}

async function* cursorFiles(
  root: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  for (const project of await directoryEntries(root)) {
    signal?.throwIfAborted();
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    const dir = join(root, project.name, "agent-transcripts");
    const parents = new Map<string, string>();
    const children = new Map<string, string>();
    const choose = (map: Map<string, string>, path: string) => {
      const id = basename(path).replace(/\.(jsonl|txt)$/, ""),
        old = map.get(id);
      if (!old || (old.endsWith(".txt") && path.endsWith(".jsonl")))
        map.set(id, path);
    };
    for (const entry of await directoryEntries(dir)) {
      if (entry.isFile() && /\.(jsonl|txt)$/.test(entry.name))
        choose(parents, join(dir, entry.name));
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const nested = join(dir, entry.name);
      for (const file of await directoryEntries(nested)) {
        if (
          file.isFile() &&
          [entry.name + ".jsonl", entry.name + ".txt"].includes(file.name)
        )
          choose(parents, join(nested, file.name));
      }
      for (const file of await directoryEntries(join(nested, "subagents")))
        if (file.isFile() && /\.(jsonl|txt)$/.test(file.name))
          choose(children, join(nested, "subagents", file.name));
    }
    yield* parents.values();
    for (const [id, path] of children) if (!parents.has(id)) yield path;
  }
}

export async function geminiWorkspace(
  root: string,
  file: string,
): Promise<string> {
  const key = basename(dirname(dirname(file)));
  const candidates = new Map<string, Set<string>>();
  const add = (path: string, alias?: string) => {
    if (!isAbsolute(path)) return;
    for (const value of [
      createHash("sha256").update(path).digest("hex"),
      alias,
    ].filter(Boolean) as string[]) {
      const paths = candidates.get(value) ?? new Set<string>();
      paths.add(path);
      candidates.set(value, paths);
    }
  };
  for (const name of ["projects.json", "trustedFolders.json"]) {
    let data;
    try {
      trackSource(join(root, name));
      data = record(JSON.parse(await readFile(join(root, name), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Unable to read Gemini project metadata");
    }
    for (const [path, alias] of Object.entries(record(data.projects)))
      add(path, string(alias));
    if (Array.isArray(data.trustedFolders))
      for (const path of data.trustedFolders) add(string(path));
  }
  const paths = candidates.get(key);
  return paths?.size === 1 ? [...paths][0] : "";
}
