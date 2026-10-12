import type { RuntimeHost } from "./host-client.js";

type PendingCall = {
  owner: string;
  ticket?: string;
  cancelled: boolean;
  taken?: boolean;
};

/** Tracks ordering registrations which pi prepared but has not executed yet. */
export class FileCallPreparation {
  private pending = new Map<string, PendingCall>();
  private queuedCleanup = new Set<string>();
  private cleanupTail = Promise.resolve();
  private cleanupScheduled = false;
  private failedCleanup = new Set<string>();
  private unresolvedCleanup = new Set<string>();
  private cleanupPending = 0;

  constructor(
    private host: RuntimeHost,
    private sessionId: string,
    private onCleanupError: () => void,
  ) {}

  async prepare(
    toolCallId: string,
    toolName: string,
    args: unknown,
    owner: string,
    permissionScope: string | undefined,
    cancelled: () => boolean,
  ): Promise<void> {
    if (!["Read", "Write", "Edit"].includes(toolName)) return;
    if (cancelled()) throw new Error("Operation aborted before file preparation");
    const pending: PendingCall = { owner, cancelled: false };
    if (this.pending.has(toolCallId) || this.unresolvedCleanup.has(toolCallId)) {
      throw new Error("File call is already prepared or awaiting cleanup");
    }
    this.pending.set(toolCallId, pending);
    try {
      const result = await this.host.call<{ ticket: string }>("tools.prepareFileCall", {
        sessionId: this.sessionId, toolCallId, toolName, args,
        ...(permissionScope && permissionScope !== "inherit" && permissionScope !== "default" ? { permissionScope } : {}),
      });
      if (!result || typeof result.ticket !== "string" || !result.ticket) {
        throw new Error("Host did not return a file admission ticket");
      }
      pending.ticket = result.ticket;
      if (pending.cancelled || cancelled()) {
        await this.cancelCalls([toolCallId]);
        throw new Error("Operation aborted during file preparation");
      }
    } catch (error) {
      if (this.pending.get(toolCallId) === pending) this.pending.delete(toolCallId);
      // The transport may have failed after Host registered the call. Revoke by
      // call identity even when its ticket response never reached the runtime.
      this.enqueueCleanup([toolCallId]);
      throw error;
    }
  }

  /** Transfer ordering ownership to tools.execute, before any other async wait. */
  has(toolCallId: string): boolean {
    return this.pending.has(toolCallId);
  }

  take(toolCallId: string): string | undefined {
    const pending = this.pending.get(toolCallId);
    if (!pending || pending.taken) return undefined;
    if (!pending.ticket || pending.cancelled) throw new Error("File call is not ready to execute");
    pending.taken = true;
    return pending.ticket;
  }

  finish(toolCallId: string, transportFailed: boolean): void {
    if (!this.pending.delete(toolCallId)) return;
    if (transportFailed) this.enqueueCleanup([toolCallId]);
  }

  cancelCall(toolCallId: string): void {
    const pending = this.pending.get(toolCallId);
    if (!pending) return;
    pending.cancelled = true;
    if (pending.ticket) {
      this.pending.delete(toolCallId);
      this.enqueueCleanup([toolCallId]);
    }
  }

  cancelOwner(owner?: string): void {
    const calls: string[] = [];
    for (const [id, call] of this.pending) {
      if (owner !== undefined && call.owner !== owner) continue;
      call.cancelled = true;
      calls.push(id);
      if (call.ticket) {
        this.pending.delete(id);
      }
      // In-flight preparations remain marked until their response arrives.
    }
    if (calls.length) this.enqueueCleanup(calls);
  }

  private enqueueCleanup(calls: string[]): void {
    for (const id of calls) {
      this.queuedCleanup.add(id);
      this.unresolvedCleanup.add(id);
    }
    if (this.cleanupScheduled) return;
    this.cleanupScheduled = true;
    queueMicrotask(() => {
      this.cleanupScheduled = false;
      const ids = [...this.queuedCleanup];
      this.queuedCleanup.clear();
      this.cleanupPending += 1;
      this.cleanupTail = this.cleanupTail.then(async () => {
        for (let offset = 0; offset < ids.length; offset += 64) {
          const batch = ids.slice(offset, offset + 64);
          try {
            await this.cancelCalls(batch);
            for (const id of batch) {
              this.failedCleanup.delete(id);
              this.unresolvedCleanup.delete(id);
            }
          } catch {
            for (const id of batch) this.failedCleanup.add(id);
            this.onCleanupError();
          }
        }
      }).finally(() => {
        this.cleanupPending -= 1;
      });
    });
  }

  async drainCleanup(): Promise<void> {
    // Retry previously failed identities once per drain, never indefinitely
    // within a Stop/disposal request when the Host remains unavailable.
    if (this.failedCleanup.size) this.enqueueCleanup([...this.failedCleanup]);
    // A late preparation response or execution failure can append cleanup while
    // an earlier RPC is settling. Drain the current lifecycle, not one tail
    // snapshot; each RPC already carries its own bounded transport deadline.
    for (;;) {
      await Promise.resolve();
      const tail = this.cleanupTail;
      await tail;
      if (tail === this.cleanupTail && !this.cleanupScheduled && this.cleanupPending === 0) break;
    }
    if (this.failedCleanup.size) throw new Error("Prepared file call cleanup failed");
  }

  get hasCleanup(): boolean {
    return this.cleanupScheduled || this.cleanupPending > 0 || this.failedCleanup.size > 0;
  }

  private async cancelCalls(toolCallIds: string[]): Promise<void> {
    await this.host.call("tools.cancelPreparedFileCalls", { sessionId: this.sessionId, toolCallIds }, 10_000);
    for (const id of toolCallIds) this.pending.delete(id);
  }
}
