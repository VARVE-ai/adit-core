import {
  SessionContextStore,
  formatSessionContext,
  type StoredSessionContextEntry,
} from "../session-context-store.js";

export class ClaudeSessionContextStore extends SessionContextStore {
  constructor(dataDir: string) {
    super({
      dataDir,
      provider: "claude-code",
    });
  }
}

export function formatClaudeSessionContext(
  entries: StoredSessionContextEntry[],
): string | null {
  return formatSessionContext(entries);
}
