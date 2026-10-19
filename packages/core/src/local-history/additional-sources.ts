import { basename, dirname, join, isAbsolute, resolve } from "node:path";
import { readSourceJSON } from "./source-io.js";
import { record, string } from "./types.js";
import type { SourceDefinition } from "./sources.js";
import { databaseProviders, readDatabaseProvider } from "./database-providers.js";
import { semanticProviders, readSemanticSession } from "./semantic-jsonl.js";
import { eventDirectoryProviders, readEventDirectory } from "./event-directories.js";
import { nativeMessageProviders, readNativeMessages } from "./native-messages.js";
import {projectRecordProviders,readProjectRecords} from "./project-records.js";
import {copilotPawProviders,readCopilotPaw} from "./copilot-paw.js";
import {claudeLineageProviders,readClaudeLineage} from "./claude-lineage.js";
import {vscodeChatProviders,readVSCodeChat} from "./vscode-chat.js";
import {companionChatProviders,readCompanionChat} from "./companion-chats.js";
import {kiroProviders,readKiro} from "./kiro.js";
import {desktopDatabaseProviders,readDesktopDatabase} from "./desktop-databases.js";
import {runtimeEventProviders,readRuntimeEvents} from "./runtime-events.js";
import {readAider} from "./aider.js";
import {legacyExtensionProviders,readLegacyExtension} from "./legacy-extensions.js";
import {reviewEventProviders,readReviewEvents} from "./review-events.js";
import {profileStoreProviders,readProfileStore} from "./profile-stores.js";
import {readVisualStudio,visualStudioSource} from "./visualstudio.js";
import {antigravitySource,readAntigravity} from "./antigravity.js";
import {readHermesTranscript} from "./hermes-transcripts.js";

export function additionalSourceDefinitions(home: string, env: NodeJS.ProcessEnv): SourceDefinition[] {
  const specs: [string, string, string, string[]][] = [
    ["antigravity","Antigravity","ANTIGRAVITY_DIR",[".gemini/antigravity",".gemini/antigravity-ide"]],
    ["antigravity-cli","Antigravity CLI","ANTIGRAVITY_CLI_DIR",[".gemini/antigravity-cli"]],
    ["visualstudio-copilot","Visual Studio Copilot","VISUALSTUDIO_COPILOT_DIR",["AppData/Local/Temp/VSGitHubCopilotLogs/traces","Library/Caches/VSGitHubCopilotLogs/traces",".cache/VSGitHubCopilotLogs/traces"]],
    ["windsurf","Windsurf","WINDSURF_DIR",[...['Windsurf','Windsurf - Next'].flatMap(name=>[`AppData/Roaming/${name}/User`,`Library/Application Support/${name}/User`,`.config/${name}/User`])]],
    ["trae","Trae","TRAE_DIR",[...['Trae','Trae CN','TRAE SOLO CN'].flatMap(name=>[`AppData/Roaming/${name}/User`,`Library/Application Support/${name}/User`,`.config/${name}/User`])]],
    ["devin","Devin","DEVIN_DIR",["Library/Application Support/devin",".local/share/devin"]],
    ["junie","Junie","JUNIE_DIR",[".junie/sessions"]],
    ["grok","Grok","GROK_DIR",[".grok/sessions"]],
    ["opencodereview","Open Code Review","OPENCODEREVIEW_DIR",[".opencodereview/sessions"]],
    ["cowork","Claude Cowork","COWORK_DIR",["Library/Application Support/Claude/local-agent-mode-sessions",".config/Claude/local-agent-mode-sessions","AppData/Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/local-agent-mode-sessions","AppData/Roaming/Claude/local-agent-mode-sessions"]],
    ["roocode","RooCode","ROOCODE_DIR",["Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline",".config/Code/User/globalStorage/rooveterinaryinc.roo-cline","AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline"]],
    ["kilo-legacy","Kilo (legacy)","KILO_LEGACY_DIR",["Library/Application Support/Code/User/globalStorage/kilocode.kilo-code",".config/Code/User/globalStorage/kilocode.kilo-code","AppData/Roaming/Code/User/globalStorage/kilocode.kilo-code"]],
    ["aider","Aider","AIDER_DIR",[]],
    ["kimi","Kimi","KIMI_DIR",[".kimi/sessions",".kimi-code/sessions"]],
    ["kimi-work","Kimi Work","KIMI_WORK_DIR",["Library/Application Support/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/sessions",".config/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/sessions",".local/share/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/sessions","AppData/Roaming/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/sessions"]],
    ["muse","Muse Code","MUSE_SESSIONS_DIR",[".local/share/muse/sessions"]],
    ["poolside","Poolside","POOLSIDE_DIR",["Library/Application Support/poolside",".local/state/poolside","AppData/Roaming/poolside"]],
    ["warp","Warp","WARP_DIR",["Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Stable",".local/state/warp-terminal","AppData/Local/warp/Warp/data"]],
    ["zed","Zed","ZED_DIR",["Library/Application Support/Zed",".local/share/zed","AppData/Local/Zed"]],
    ["omnigent","Omnigent","OMNIGENT_DIR",[".omnigent"]],
    ["piebald","Piebald","PIEBALD_DIR",[".local/share/piebald","Library/Application Support/piebald","AppData/Roaming/piebald"]],
    ["kiro","Kiro","KIRO_SESSIONS_DIR",[".kiro/sessions",".local/share/kiro-cli"]],
    ["kiro-ide","Kiro IDE","KIRO_IDE_DIR",["Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent","AppData/Roaming/Kiro/User/globalStorage/kiro.kiroagent",".config/Kiro/User/globalStorage/kiro.kiroagent"]],
    ["codebuff","Codebuff","CODEBUFF_DIR",[".config/manicode/projects"]],
    ["posit-assistant","Posit Assistant","POSIT_ASSISTANT_DIR",[".posit/assistant/workspaces"]],
    ["vscode-copilot","VSCode Copilot","VSCODE_COPILOT_DIR",[...['Code','Code - Insiders','VSCodium'].flatMap(name=>[`AppData/Roaming/${name}/User`,`Library/Application Support/${name}/User`,`.config/${name}/User`])]],
    ["positron","Positron Assistant","POSITRON_DIR",["Library/Application Support/Positron/User"]],
    ["iflow","iFlow","IFLOW_DIR",[".iflow/projects"]],
    ["qoder","Qoder","QODER_PROJECTS_DIR",[".qoder/projects",".qoderwork/projects",".qoder-cn/projects","Library/Application Support/Qoder/SharedClientCache/cli/projects",".config/Qoder/SharedClientCache/cli/projects","AppData/Roaming/Qoder/SharedClientCache/cli/projects"]],
    ["copilot","Copilot","COPILOT_DIR",[".copilot"]],
    ["qwenpaw","QwenPaw","QWENPAW_DIR",[".copaw/workspaces"]],
    ["reasonix","Reasonix","REASONIX_DIR",[".reasonix","AppData/Roaming/reasonix"]],
    ["workbuddy","WorkBuddy","WORKBUDDY_PROJECTS_DIR",[".workbuddy/projects"]],
    ["cortex","Cortex Code","CORTEX_DIR",[".snowflake/cortex/conversations"]],
    ["codebuddy","CodeBuddy","CODEBUDDY_DIR",["AppData/Local/CodeBuddyExtension/Data","Library/Application Support/CodeBuddyExtension/Data",".config/CodeBuddyExtension/Data"]],
    ["amp","Amp","AMP_DIR",[".local/share/amp/threads"]],
    ["gptme","gptme","GPTME_DIR",[".local/share/gptme/logs"]],
    ["openclaw","OpenClaw","OPENCLAW_DIR",[".openclaw/agents",".kimi_openclaw/agents"]],
    ["qclaw","QClaw","QCLAW_DIR",[".qclaw/agents"]],
    ["fx", "fx", "FX_SESSIONS_DIR", [".fx/sessions"]],
    ["openhands", "OpenHands CLI", "OPENHANDS_CONVERSATIONS_DIR", [".openhands/conversations"]],
    ["tau", "Tau", "TAU_SESSIONS_DIR", [".tau/sessions"]],
    ["evener", "Evener", "EVENER_DIR", [".local/state/evener"]],
    ["goose", "Goose", "GOOSE_PATH_ROOT", [".local/share/goose/sessions", "AppData/Roaming/Block/goose/data/sessions"]],
    ["hermes", "Hermes Agent", "HERMES_SESSIONS_DIR", [".hermes", "AppData/Local/hermes"]],
    ["augure-desktop", "Augure Desktop", "AUGURE_DESKTOP_DIR", [".augure-desktop", "AppData/Local/augure-desktop"]],
    ["forge", "Forge", "FORGE_DIR", [".forge"]],
    ["shelley", "Shelley", "SHELLEY_DIR", [".config/shelley"]],
    ["crush", "Charm Crush", "CRUSH_DIR", [".local/share/crush", "AppData/Local/crush"]],
    ["zcode", "ZCode", "ZCODE_DIR", [".zcode/cli/db", ".zcode/cli"]],
  ];
  const reroot:Record<string,[string,string]>={junie:["JUNIE_HOME","sessions"],codebuff:["FREEBUFF_CONFIG_DIR","projects"],muse:["XDG_DATA_HOME","muse/sessions"]};
  return specs.map(([id, name, variable, defaults]) => {
    const root=reroot[id];
    let paths=env[variable] ? [env[variable]!] : root&&env[root[0]] ? [join(env[root[0]]!,root[1])] : defaults.map(path => join(home, path));
    if(id==="hermes"&&env[variable]&&basename(env[variable]!)==="sessions")paths=[dirname(env[variable]!)];
    if(id==="goose"&&env[variable])paths=[join(env[variable]!,"data","sessions")];
    return { id, name, paths, homesSupported: id!=="aider", supported: true, format: [...databaseProviders,...desktopDatabaseProviders].includes(id) ? "SQLite" : "JSON / JSONL" };
  });
}

const databases: Record<string, string[]> = {
  warp:["warp.sqlite"],zed:["threads.db"],omnigent:["chat.db"],piebald:["app.db"],
  goose: ["sessions.db"], hermes: ["state.db"], "augure-desktop": ["state.db"],
  forge: [".forge.db"], shelley: ["shelley.db"], crush: ["crush.db"], zcode: ["db.sqlite"],
};
export function additionalSourceFile(provider: string, path: string): boolean {
  if(provider==="hermes" && basename(dirname(path))==="sessions" && (/\.jsonl$/.test(path)||/^session_.*\.json$/.test(basename(path))))return true;
  if(["antigravity","antigravity-cli"].includes(provider))return antigravitySource(path);
  if(provider === "visualstudio-copilot")return visualStudioSource(path);
  if(provider==="trae" && basename(path)==="database.db" && path.split(/[\\/]/).includes("ModularData"))return true;
  if(["windsurf","trae"].includes(provider))return basename(path)==="state.vscdb";
  if(provider === "devin")return basename(path)==="sessions.db" && basename(dirname(path))==="cli";
  if(provider === "junie")return basename(path)==="events.jsonl";
  if(provider === "grok")return basename(path)==="summary.json";
  if(provider === "opencodereview")return path.endsWith(".jsonl");
  if(provider === "cowork")return path.endsWith(".jsonl") && path.split(/[\\/]/).includes("projects");
  if(["roocode","kilo-legacy"].includes(provider))return basename(path)==="ui_messages.json";
  if(provider === "aider")return basename(path)===".aider.chat.history.md";
  if(provider === "kimi")return basename(path)==="wire.jsonl";
  if(provider === "kimi-work")return basename(path)==="wire.jsonl" && path.split(/[\\/]/).some(part=>part.startsWith("conv-"));
  if(provider === "muse")return basename(path)==="session.jsonl";
  if(provider === "poolside")return /^trajectory-.*\.ndjson$/.test(basename(path));
  if(provider === "kiro")return basename(path) === "data.sqlite3" || path.endsWith(".jsonl");
  if(provider === "kiro-ide")return path.endsWith(".chat") || (path.split(/[\\/]/).includes("workspace-sessions") && path.endsWith(".json") && basename(path)!=="sessions.json");
  if(provider === "codebuff")return basename(path) === "chat-messages.json";
  if(provider === "posit-assistant")return basename(path) === "conversation.json";
  if(vscodeChatProviders.includes(provider))return basename(dirname(path)) === "chatSessions" && /\.jsonl?$/.test(path);
  if(provider === "qoder")return path.endsWith(".jsonl");
  if(provider === "iflow")return /^session-.*\.jsonl$/.test(basename(path));
  if(provider === "copilot")return basename(path) === "events.jsonl" && path.split(/[\\/]/).includes("session-state");
  if(provider === "qwenpaw")return path.endsWith(".json") && path.split(/[\\/]/).includes("sessions");
  if(["reasonix","workbuddy"].includes(provider))return path.endsWith(".jsonl");
  if(provider === "cortex")return path.endsWith(".json") && !/\.back\./.test(path);
  if(provider === "codebuddy")return basename(path) === "index.json" && path.split(/[\\/]/).includes("history");
  if(provider === "amp")return /^T-.*\.json$/.test(basename(path));
  if(provider === "gptme")return basename(path) === "conversation.jsonl";
  if(["openclaw","qclaw"].includes(provider))return basename(path) === "openclaw-agent.sqlite" || (basename(dirname(path)) === "sessions" && /\.jsonl(?:\.(?:deleted\..+|reset\..+|full\.bak))?$/.test(path));
  if (provider === "fx") return basename(path) === "events.jsonl";
  if (provider === "openhands") return basename(path) === "base_state.json";
  if (provider === "tau") return path.endsWith(".jsonl");
  if (provider === "evener") return path.endsWith(".transcript.jsonl");
  return databases[provider]?.includes(basename(path)) || false;
}
export const additionalProviders = [...databaseProviders, ...semanticProviders, ...eventDirectoryProviders,...nativeMessageProviders,...projectRecordProviders,...copilotPawProviders,...claudeLineageProviders,...vscodeChatProviders,...companionChatProviders,...kiroProviders,...desktopDatabaseProviders,...runtimeEventProviders,...legacyExtensionProviders,...reviewEventProviders,...profileStoreProviders,"aider","visualstudio-copilot","antigravity","antigravity-cli"];
export async function readAdditionalSource(path: string, provider: string, signal?: AbortSignal) {
  if(provider==="hermes" && /\.jsonl?$/.test(path))return readHermesTranscript(path,signal);
  if(["antigravity","antigravity-cli"].includes(provider))return readAntigravity(path,provider,signal);
  if(provider === "visualstudio-copilot")return readVisualStudio(path,signal);
  if(profileStoreProviders.includes(provider))return readProfileStore(path,provider,signal);
  if(reviewEventProviders.includes(provider))return readReviewEvents(path,provider,signal);
  if(legacyExtensionProviders.includes(provider))return readLegacyExtension(path,provider,signal);
  if(provider === "aider")return readAider(path,signal);
  if(runtimeEventProviders.includes(provider))return readRuntimeEvents(path,provider,signal);
  if(desktopDatabaseProviders.includes(provider))return readDesktopDatabase(path,provider,signal);
  if(kiroProviders.includes(provider))return readKiro(path,provider,signal);
  if(companionChatProviders.includes(provider))return readCompanionChat(path,provider,signal);
  if(vscodeChatProviders.includes(provider))return readVSCodeChat(path,provider,signal);
  if(claudeLineageProviders.includes(provider))return readClaudeLineage(path,provider,signal);
  if(copilotPawProviders.includes(provider))return readCopilotPaw(path,provider,signal);
  if(projectRecordProviders.includes(provider))return readProjectRecords(path,provider,signal);
  if(nativeMessageProviders.includes(provider))return readNativeMessages(path,provider,signal);
  if (eventDirectoryProviders.includes(provider)) return readEventDirectory(path,provider,signal);
  if (semanticProviders.includes(provider)) return readSemanticSession(path, provider, signal);
  if (provider !== "crush" || basename(path) !== "projects.json") return readDatabaseProvider(path, provider, signal);
  const registry = await readSourceJSON(path, signal);
  const projects = Array.isArray(registry.projects) ? registry.projects : [];
  const sessions = [];
  const visited = new Set<string>();
  for (const value of projects) {
    signal?.throwIfAborted();
    const project = record(value), dataDir = string(project.data_dir), cwd = string(project.path);
    if (!dataDir) continue;
    if (!isAbsolute(dataDir) || (cwd && !isAbsolute(cwd))) throw new Error("Crush registry paths must be absolute");
    const dbPath = resolve(dataDir, "crush.db");
    if (visited.has(dbPath)) continue;
    visited.add(dbPath);
    for (const session of readDatabaseProvider(dbPath, provider, signal)) {
      session.cwd = cwd || dirname(dataDir);
      sessions.push(session);
    }
  }
  return sessions;
}
