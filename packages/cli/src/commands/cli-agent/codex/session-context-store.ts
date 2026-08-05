import {
  SessionContextStore,
  formatSessionContext,
  type StoredSessionContextEntry,
} from "../session-context-store.js";

export class CodexSessionContextStore extends SessionContextStore {
  constructor(dataDir: string) {
    super({
      dataDir,
      provider: "codex",
    });
  }
}

export function formatCodexSessionContext(
  entries: StoredSessionContextEntry[],
): string | null {
  return formatSessionContext(entries);
}
