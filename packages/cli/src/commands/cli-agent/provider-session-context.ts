import type {
  AppendSessionContextInput,
  AppendSessionContextResult,
} from "./types.js";
import type {
  AppliedSessionContextEntry,
  SessionContextClaim,
  SessionContextStore,
  StoredSessionContextEntry,
} from "./session-context-store.js";

type EmitEvent = (type: string, payload: Record<string, unknown>) => void;
type DebugLog = (message: string) => void;
type StoreFactory = () => SessionContextStore;

export class ProviderSessionContext {
  private store: SessionContextStore | null = null;
  private closed = false;

  constructor(
    private readonly storeFactory: StoreFactory,
    private readonly format: (entries: StoredSessionContextEntry[]) => string | null,
    private readonly emitEvent: EmitEvent,
    private readonly debug: DebugLog,
  ) {}

  async append(input: AppendSessionContextInput): Promise<AppendSessionContextResult> {
    const normalized = {
      ...input,
      sessionId: input.sessionId.trim(),
      contextEntryId: input.contextEntryId.trim(),
      requestId: input.requestId.trim(),
      content: input.content.trim(),
    };
    if (!normalized.sessionId || !normalized.contextEntryId || !normalized.requestId) {
      throw new Error("Session, context entry, and collaboration request are required");
    }
    if (!normalized.content) throw new Error("Collaboration context content is required");

    const result = await this.getStore().append(normalized);
    this.emitEvent("context.appended", {
      ...result,
      requestId: input.requestId,
      kind: input.kind,
      createdAt: Date.now(),
    });
    if (result.alreadyApplied) {
      this.emitEvent("context.applied", {
        sessionId: input.sessionId,
        contextEntryId: input.contextEntryId,
        requestId: input.requestId,
        kind: input.kind,
        createdAt: Date.now(),
      });
    }
    return result;
  }

  async claim(
    sessionId: string,
    required: boolean,
  ): Promise<{ claim: SessionContextClaim | null; text: string | null }> {
    try {
      const claim = await this.getStore().claimPending(sessionId);
      return { claim, text: this.format(claim?.entries ?? []) };
    } catch (error) {
      if (required) throw error;
      this.debug(
        `session context load failed; continuing without it: ${errorMessage(error)}`,
      );
      return { claim: null, text: null };
    }
  }

  async commit(claim: SessionContextClaim | null, providerRunId?: string | null): Promise<void> {
    if (!claim) return;
    const store = this.store;
    if (!store) return;
    try {
      const applied = await store.commitClaim(claim.claimId);
      for (const entry of applied) this.emitApplied(entry, providerRunId);
    } catch (error) {
      this.debug(`session context commit failed after prompt start: ${errorMessage(error)}`);
    }
  }

  async release(claim: SessionContextClaim | null): Promise<void> {
    if (!claim) return;
    const store = this.store;
    if (!store) return;
    try {
      await store.releaseClaim(claim.claimId);
    } catch (error) {
      this.debug(`session context claim release failed: ${errorMessage(error)}`);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.store?.close();
    this.store = null;
  }

  private getStore(): SessionContextStore {
    if (this.closed) throw new Error("Session context store is closed");
    this.store ??= this.storeFactory();
    return this.store;
  }

  private emitApplied(entry: AppliedSessionContextEntry, providerRunId?: string | null): void {
    this.emitEvent("context.applied", {
      ...entry,
      ...(providerRunId ? { providerRunId } : {}),
      createdAt: Date.now(),
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
