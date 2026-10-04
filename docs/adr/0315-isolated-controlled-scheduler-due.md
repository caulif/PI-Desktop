# ADR 0315: Isolated controlled scheduler due

## Status

Accepted for isolated development acceptance. Disabled by default; not a public
Plugin SDK or MCP API and not an execution authorization.

## Context

Calendar preview cannot establish occurrence persistence, duplicate due or cold
recovery across DST. Waiting for a physical DST transition is unnecessary for
checking the production due algorithm; a scoped controlled-time integration
entry can exercise it without changing the system clock or execution authority.

## Decision

Reuse production `plugin_scheduled::due(db, now)` through a native diagnostic
RPC with the existing calendar-preview exact Temp profile guard and a second
explicit profile opt-in. Only one already authorized enabled binding may exist.
Exact definition/timezone and bounded explicit time prevent accidental cross-case
writes. The first seed derives production nextRunAt and is allowed once before
any occurrence. A persisted clock cursor disallows backward diagnostics.

Seed, clock, due writes and returned binding commit atomically. Per-occurrence
savepoints support both ordinary due and the enclosing diagnostic transaction.
Failure leaves the prior state intact, including a retryable unconsumed seed;
write/commit/rollback errors are surfaced.

The acceptance runner freezes source/binary/plan, writes intents before mutation,
does not replay unknowns, and offers lookup-only recovery. A native observation
receipt is required to claim genuine authorization; a stored marker cannot make
fixture consent real. Unit fixtures remain explicitly synthetic.

## Consequences and validation

No global clock, migration, grant, schedule enabling, model admission or default
behavior changes. Other Host admission and plugin policy clocks are untouched.
Controlled due is not a full Routine model Run/Attempt acceptance.

Focused checks cover gap/fold, missed/deadline, duplicate due, persisted recovery,
strict timestamps/fields, stale identity and injected INSERT/UPDATE failures.
Native transport/profile boundaries and actual RPC are checked separately.
Stage results belong to exact source/runtime and are recorded in implementation
status; this document is not execution evidence.
