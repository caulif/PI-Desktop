# ADR: Ordered preparation and parallel file batches

- Status: Proposed
- Date: 2026-10-12
- Amended: 2026-10-28 by `perf(agent-runtime): order parallel tool batches by
  resource conflicts` (Write/Edit join parallel batches, ordered by resource
  claims)

## Context

The runtime globally permits parallel execution but overrides every tool except
Task to sequential. pi consequently serializes independent Read/Glob/Grep calls.
Simply changing those flags is unsafe: file preflight currently changes the
parent prompt, including when invoked through delegated tool closures.

## Decision

Use pi-agent-core's ordered preparation / concurrent execution /
ordered result submission contract. Centralize the Read/Glob/Grep candidate
allowlist and the batch rule that keeps Task mixed with those reads sequential;
unknown tools default to sequential. Keep existing Host permission and capacity
ownership. Do not introduce another batch executor.

Amendment (2026-10-28): Write and Edit join the candidates. The allowlist
becomes one execution spec table in `tool-execution-policy.ts`: each candidate
declares its pi mode and, for file tools, the resources one call claims (a
shared or exclusive claim on a lexical path key or on the whole workspace). A
batch-local planner orders a parallel batch by those claims: each call waits
only for earlier calls of the same assistant message whose claims conflict.
Claims are registered at the end of the runtime's `beforeToolCall`; waiting and
releasing wrap the catalog executor outside the mode guard and every argument
check (a delegate's scoping wrapper calls that same executor), so a call that
throws, is rejected or aborts still releases its successors. A Task mixed
with any file tool, including Write and Edit, keeps the whole batch sequential.
Host-core, `PathMutex`, Bash/Task semantics and the delegate completion barrier
for reads are unchanged.

Move parent file preflight after mode and extension checks in beforeToolCall.
Use a weak argument-identity map to bind canonical parameters to the validated
call; unused records are collectible after cancellation or rejection. Direct
invocations still run preflight. Delegate preparation has an explicit prompt
sink, and AsyncLocalStorage preserves that sink for direct delegated executions
without sharing mutable current-agent state. Delegate prompt updates use the
same chronological system transcript sections as the parent.

## Consequences

Independent reads/searches overlap without changing writes or Bash policy.
Task-only batches retain fan-out, while a mixed Task/read batch is kept
sequential: a read ordered before `Task` finishes before the delegate starts, and
a read ordered after a writable `Task` in the same batch waits for that delegate
to settle before dispatching to Host, while `Task` itself still returns its ADR
0089 started notice immediately. Per-path shared-read / exclusive-write
locking in `PathMutex` also prevents a parent `Read` from overlapping an
in-flight shared-workspace delegate `Write` or `Edit` on the same file.
Regression tests pin both model orders (read then `Task`, and `Task` then read),
Task-only fan-out, read-only batches, same-path `Edit` vs `Read` serialization,
and a failed delegate that still lets the parent read proceed. Delegate path
rules now follow their own ordered calls instead of mutating the parent.
Instruction resolution claims remain immutable, per-prompt cached promises;
shared caching does not share the prompt mutation sink. Source-order results
still come from pi.

Existing running file RPCs drain on Stop; finer cancellation and Host-owned
file resource leases belong to separate changes.

With the amendment, a read and an unrelated write in one batch overlap, and
same-file work keeps source order (for example `[Read a, Edit a, Read b, Write
c]` holds only Edit a behind Read a). The rules are conservative: Glob and Grep
claim the whole workspace, so they keep source order against every write in the
batch; an Edit with `MV`, `REM` or a named `@register` (kept per session by
host-core) claims the whole workspace exclusively; two
paths with the same file name are treated as one file, because host-core writes
are not atomic and a lexical key cannot see every alias. Host still admits one
mutation per session, so several non-conflicting writes of one batch queue in
Host, may run out of source order and are subject to its 30-second admission
timeout; results still reach the model in source order. Bash, TodoWrite,
plugin/MCP and unknown tools keep their batch sequential. A Rust-side mirror of
the claim table and Host resource leases are deferred to the Host change that
would consume them.

## Alternatives

- Parallelize execute while retaining prompt updates there: completion order
  would select sibling rules and delegates would still overwrite parent state.
- Serialize all reads behind a prompt mutex: would preserve the bottleneck.
- Fork pi's batch executor: duplicates an already-supported contract.
- Keep Write/Edit sequential and rely on `PathMutex`: any write still
  serializes its whole batch, including unrelated reads.
- Wait and release inside the builtin executor: argument validation and the
  mode guard can fail before that code runs, leaving successors waiting forever.
