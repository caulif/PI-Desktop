/**
 * Orders the calls of one parallel pi batch by the resources they claim.
 *
 * pi prepares every call of a parallel batch in source order and then starts
 * them all at once. Each prepared call registers its claims here; at execution
 * it waits only for earlier calls of the same batch whose claims conflict, so
 * unrelated reads and writes overlap while same-file work keeps source order.
 *
 * Batch-local only: the parent and its delegates still meet in `PathMutex` and
 * host-core admission.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ResourceClaim } from "./tool-execution-policy.js";

type PlannedCall = {
  claims: ResourceClaim[];
  /** Earlier calls of the same batch that conflict; fixed at registration. */
  deps: PlannedCall[];
  settled: Promise<void>;
  resolve: () => void;
};

/**
 * True for two keys that may name one file: the same key, or the same file
 * name. The basename fallback is deliberately conservative — it also catches
 * aliases a lexical key cannot see (absolute vs. relative spellings of a
 * delegate worktree, symlinked directories) because host-core writes are not
 * atomic. Same-name files in different directories only lose overlap.
 */
export function sameFile(left: string, right: string): boolean {
  return left === right || left.slice(left.lastIndexOf("/") + 1) === right.slice(right.lastIndexOf("/") + 1);
}

function claimConflicts(left: ResourceClaim, right: ResourceClaim): boolean {
  if (left.access === "shared" && right.access === "shared") return false;
  if (left.kind === "tree" || right.kind === "tree") return true;
  return sameFile(left.key, right.key);
}

export function claimsConflict(left: readonly ResourceClaim[], right: readonly ResourceClaim[]): boolean {
  return left.some((a) => right.some((b) => claimConflicts(a, b)));
}

export class BatchPlanner {
  /** Keyed by the assistant message, so a finished batch is collected with it. */
  private batches = new WeakMap<object, PlannedCall[]>();
  /** Keyed by the args object pi passes to `execute` (see `preparedPathToolArgs`). */
  private byArgs = new WeakMap<object, PlannedCall>();

  /** Called during preparation, which pi runs in source order. */
  register(batchKey: object, argsKey: object, claims: ResourceClaim[]): void {
    let batch = this.batches.get(batchKey);
    if (!batch) {
      batch = [];
      this.batches.set(batchKey, batch);
    }
    let resolve!: () => void;
    const settled = new Promise<void>((done) => { resolve = done; });
    const call: PlannedCall = {
      claims,
      deps: batch.filter((prior) => claimsConflict(prior.claims, claims)),
      settled,
      resolve,
    };
    batch.push(call);
    this.byArgs.set(argsKey, call);
  }

  /**
   * Waits until every conflicting predecessor settles, or `signal` aborts; the
   * caller's own abort check then fails the call. Returns at once for a call
   * that was never registered (a direct, non-pi invocation). No timeout: every
   * wait ends at a call that really runs or at the batch's abort signal.
   */
  async waitForTurn(argsKey: object, signal?: AbortSignal): Promise<void> {
    const call = this.byArgs.get(argsKey);
    if (!call || call.deps.length === 0 || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const onAbort = () => resolve();
      signal?.addEventListener("abort", onAbort, { once: true });
      void Promise.all(call.deps.map((dep) => dep.settled)).then(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }

  /** Releases the calls ordered behind this one. Idempotent. */
  settle(argsKey: object): void {
    const call = this.byArgs.get(argsKey);
    if (!call) return;
    this.byArgs.delete(argsKey);
    call.resolve();
  }

  /**
   * Batch-end backstop: settles whatever the batch still holds, such as a call
   * pi prepared but never started because the run aborted. It cannot replace
   * {@link withBatchTurn}, because pi only ends a batch after every started
   * call has returned.
   */
  settleBatch(batchKey: unknown): void {
    if (typeof batchKey !== "object" || batchKey === null) return;
    for (const call of this.batches.get(batchKey) ?? []) call.resolve();
    this.batches.delete(batchKey);
  }
}

/**
 * The catalog layer pi calls (a delegate's scoping wrapper calls it in turn).
 * Waiting and releasing live here, outside every check the tool makes (argument
 * validation, the mode guard), so a call that throws, rejects or aborts before
 * reaching the Host still releases its successors.
 */
export function withBatchTurn(tool: AgentTool, planner: BatchPlanner): AgentTool {
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const key = args as object;
      try {
        await planner.waitForTurn(key, signal);
        return await tool.execute(toolCallId, args, signal, onUpdate);
      } finally {
        planner.settle(key);
      }
    },
  };
}
