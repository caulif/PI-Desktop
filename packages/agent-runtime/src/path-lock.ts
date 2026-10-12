/**
 * Serialize legacy direct mutating calls that target the same file.
 *
 * Prepared pi calls use Host-owned ordering registrations and bypass this
 * mutex: layering the two queues could invert their order. Direct/internal
 * callers without a ticket retain this legacy bookkeeping guard.
 *
 * The parent agent and its subagents run in one sidecar process but issue
 * `tools.execute` calls independently. Host resource admission excludes
 * conflicting participating file accesses; ticketed calls also preserve their
 * registration order. Direct legacy calls have no source-order ticket, and
 * the sidecar's per-path bookkeeping still needs one. The edit-recovery contract allows three
 * counted failures per path before terminating the prompt, which only means
 * "read fresh content and try again" if the attempts were ordered.
 * With subagents able to fan out (ADR 0062) they no longer are, so the
 * sidecar queues same-path mutations before they reach the host.
 *
 * Different paths never wait on each other, which is the point: fan-out stays
 * parallel except where the order matters.
 */

/** Compare-equal spelling of a path: forward slashes, no `./` prefix. */
export function normalizeLockPath(path: unknown): string {
  return String(path ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export class PathMutex {
  /** Per path: the tail of the queue, and how many holders are still in it. */
  private queues = new Map<string, { tail: Promise<void>; holders: number }>();

  /** Run `task` once every earlier task for `key` has settled. */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const path = normalizeLockPath(key);
    if (!path) return task();
    const entry = this.queues.get(path);
    const previous = entry?.tail;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A failed predecessor must not poison the queue; only ordering matters.
    const tail = previous
      ? previous.then(
          () => held,
          () => held,
        )
      : held;
    if (entry) {
      entry.tail = tail;
      entry.holders += 1;
    } else {
      this.queues.set(path, { tail, holders: 1 });
    }
    if (previous) await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      // Drop the entry once the last holder leaves, so a long session does not
      // accumulate one promise per file it ever touched.
      const current = this.queues.get(path);
      if (current) {
        current.holders -= 1;
        if (current.holders <= 0) this.queues.delete(path);
      }
    }
  }

  /** True while any path still has a queued or running holder. */
  get busy(): boolean {
    return this.queues.size > 0;
  }
}
