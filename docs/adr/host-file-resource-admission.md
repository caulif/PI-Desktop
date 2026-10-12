# Host file resource admission

- Status: Implemented candidate (fork experiment, stage B)
- Date: 2026-10-12

## Context

ToolBudget bounds tool execution but does not distinguish two sessions accessing
one file from sessions accessing independent files. Sidecar path queues do not
provide authoritative coordination across clients. File tools run on the blocking
pool; cancellation of an RPC waiter must not advertise that their work stopped.

## Decision

Extend the existing bounded ToolBudget queue with shared/exclusive resource keys.
Capacity and all resources are granted atomically under the same short bookkeeping
mutex. A blocked request owns neither capacity nor files. Earlier conflicting
pending writers prevent newer readers from bypassing them; unrelated files may
use spare capacity. A move reserves source and destination together. Named Edit
registers use one exclusive key per actual Host session. Parse uses the existing
Hashline parser without consuming or changing registers.

A registration is an RAII ordering reservation. It can be updated while inactive
and activated after permission; dropping it withdraws the reservation, including
the grant-before-poll race. It counts toward the existing 64 waiting limit and
holds no execution slots. This internal API prepares for a later ticket protocol;
this stage adds no new wire methods and does not promise source batch ordering.

Plans use the permission-aware workspace resolver, canonical directory-entry
keys (Windows conservatively case-folded), and existing file identities (Unix
volume/inode, Windows volume/file index). This coordinates existing hardlinks as
well as canonical aliases. Missing leaves use their resolved existing ancestor.
After admission, canonical paths must be unchanged. Identity keys may be refreshed
atomically if they do not conflict with another active permit or overtake a queued
alias writer; otherwise the call fails with FILE_RESOURCE_CHANGED. This supports a queued read after creation
without unlocking and losing its place. Planning never reads file contents or
creates directories; approved external paths use the same resolver as execution.

Permissions stay before admission. Read/Glob/Grep/Write/Edit join the existing
call-ID cancellation registry. Approval and queue waits may be cancelled; an
admitted blocking body is drained through Hashline commits, review finalization
and audit before the permit drops. The production RPC server owns these file
request tasks in its JoinSet. This change ignores explicit timeoutMs for file
request budgets (the baseline forwarded it and could abandon spawn_blocking),
and drains them after shutdown cancellation. Do not race their execution future against a
Stop signal or add a request timeout that drops it: that would release a permit
before spawn_blocking finished. Grep cancellation drains its current process;
this change does not promise immediate termination of that process.

Rollback resolves its trusted snapshot target before admission, waits without
holding AppState, revalidates, and holds the same exclusive resources through
rollback and durable message state. It remains a bounded Edit-class mutation.

## Consequences and limits

- Write/Edit remain sequential in the sidecar; mutation limits remain global 2,
  per session 1. Resource coordination does not itself enable parallel writes.
- Glob/Grep have no directory-tree lock or snapshot guarantee.
- Bash, external editors, other Host processes and unregistered plugins are not
  covered. This is coordination, not a sandbox or a general filesystem transaction.
- Windows case-sensitive directories may be over-coordinated. Unix aliases on
  case-insensitive filesystems and directory replacement by external processes
  remain platform limitations; canonicalization is not an OS-handle TOCTOU fix.
- New hardlinks created externally during execution are not retroactively locked.
  Existing file-identity lookup may fail when metadata-handle access is denied;
  execution fails closed instead of silently omitting that identity key.
- Existing review snapshots are single-path in this fork baseline, even though
  the current domain spec describes compound MV rollback. This stage coordinates
  the actual rollback target and does not implement missing compound snapshots.
- Whole-file Write has no expected-version check. Serialization does not prevent
  a later stale whole-file overwrite; Hashline's existing Edit checks remain.
