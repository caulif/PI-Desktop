import type { ResourceClaim } from "./tool-execution-policy.js";

type PlannedCall = {
  claims: ResourceClaim[];
  /** Registered earlier in the same message with a conflicting claim. */
  deps: PlannedCall[];
  settled: Promise<void>;
  resolve: () => void;
};

/**
 * Two claims cannot run at the same time.
 *
 * A whole-tree claim covers every path, so an exclusive one conflicts with
 * anything; two shared claims never conflict. Two path claims conflict when
 * they name the same file, and {@link sameFile} is deliberately generous about
 * what "same file" means.
 */
export function claimsConflict(a: ResourceClaim, b: ResourceClaim): boolean {
  if (a.kind === "tree" && a.access === "exclusive") return true;
  if (b.kind === "tree" && b.access === "exclusive") return true;
  if (a.kind === "tree" && b.kind === "tree") return false;
  if (a.kind === "tree") return b.access === "exclusive";
  if (b.kind === "tree") return a.access === "exclusive";
  if (a.access === "shared" && b.access === "shared") return false;
  return sameFile(a.key, b.key);
}

/**
 * Equal keys are the same file. Beyond that, equal file names count as the same
 * file too: absolute and relative spellings, symlinked directories and a
 * delegate's worktree alias all reach the host as different keys, and guessing
 * wrong would let a read race a write. The cost is an occasional extra wait
 * between two same-named files in different directories, which only costs
 * parallelism.
 */
function sameFile(a: string, b: string): boolean {
  if (a === b) return true;
  return basename(a).toLowerCase() === basename(b).toLowerCase();
}

function basename(key: string): string {
  const separator = key.lastIndexOf("/");
  return separator < 0 ? key : key.slice(separator + 1);
}

/**
 * Order the calls of one parallel batch by the resources they claim.
 *
 * pi prepares every call of a parallel batch in source order and then starts
 * all of them at once. Preparation is the last point where the model's order is
 * still visible, and `execute` is where it has to be restored: host-core admits
 * one mutation per session but does not order mutations against reads, so a
 * read that overlaps a write of the same file can observe a write that has not
 * finished. Waiting on conflicting predecessors here keeps every other pair of
 * calls overlapping.
 *
 * Batch policy only: this does not grant permissions and it is not a
 * cross-agent lock. Same-path protection between a parent and its delegates
 * stays in `PathMutex`.
 */
export class BatchPlanner {
  /** One list per assistant message, so the message's lifetime frees the list. */
  private batches = new WeakMap<object, PlannedCall[]>();
  /**
   * Keyed by the args object pi passes to `execute`. That is the same object
   * preparation validated, which is what makes a call findable without
   * retaining tool call ids.
   */
  private byArgs = new WeakMap<object, PlannedCall>();

  /**
   * Record one prepared call. Preparation is sequential, so every predecessor
   * that can conflict with it is already registered.
   */
  register(batchKey: object, argsKey: object, claims: ResourceClaim[]): void {
    let batch = this.batches.get(batchKey);
    if (!batch) {
      batch = [];
      this.batches.set(batchKey, batch);
    }
    let resolve!: () => void;
    const settled = new Promise<void>((done) => {
      resolve = done;
    });
    const call: PlannedCall = {
      claims,
      deps: batch.filter((earlier) =>
        claims.some((claim) =>
          earlier.claims.some((other) => claimsConflict(claim, other)),
        ),
      ),
      settled,
      resolve,
    };
    batch.push(call);
    this.byArgs.set(argsKey, call);
  }

  /**
   * Wait for every conflicting predecessor to settle.
   *
   * An abort resolves the wait rather than rejecting it: pi checks the signal
   * right after preparation and before `execute`, so a call that was registered
   * but never started cannot hold its successors past the existing
   * `TOOL_ABORTED` path. A predecessor that failed still settles, so one
   * failure never cancels the calls ordered behind it.
   */
  async waitForTurn(argsKey: object, signal?: AbortSignal): Promise<void> {
    const call = this.byArgs.get(argsKey);
    if (!call || call.deps.length === 0) return;
    const predecessors = Promise.all(call.deps.map((dep) => dep.settled)).then(() => undefined);
    if (!signal) return predecessors;
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const onAbort = () => resolve();
      signal.addEventListener("abort", onAbort, { once: true });
      void predecessors.finally(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }

  /**
   * Release the calls waiting on this one. Idempotent, and a no-op for a call
   * that was never registered — a direct invocation outside pi's batch.
   */
  settle(argsKey: object): void {
    const call = this.byArgs.get(argsKey);
    if (!call) return;
    this.byArgs.delete(argsKey);
    call.resolve();
  }
}
