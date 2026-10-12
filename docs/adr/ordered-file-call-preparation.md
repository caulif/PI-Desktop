# ADR: Ordered file call preparation

- Status: Implemented candidate (fork)
- Date: 2026-10-12

## Context

File mutual exclusion cannot preserve source order if later calls reach execution
first or receive approval first. Pi 1.0.1 prepares a parallel batch in source
order before starting its execution closures. Sidecar PathMutex acquisition can
invert a Host registration order if the two mechanisms are layered.

## Decision

Use additive internal `tools.prepareFileCall` and
`tools.cancelPreparedFileCalls` methods. Preparation creates a bounded inactive
ToolBudget registration, holding no file or execution slot. Single-use tickets
bind session, call ID, tool name, canonical JSON argument digest and permission
scope. `tools.execute` claims the ticket before its normal permission gate,
retains a call-identity guard through all handler exits to reject unticketed
duplicates while the claimed operation is alive,
updates the trusted resource plan after permission, and activates registration
in its original queue position. The admitted operation revalidates paths and
refreshes file identities atomically under the existing budget rules.

The Host owns in-flight preparation state before asynchronous metadata resolution.
Cancellation tombstones prevent a late response from recreating a cancelled call.
Unclaimed preparations expire after ten minutes and are swept every thirty
seconds by a cleanup task independent of remote configuration synchronization.
Expired tickets fail closed, rather than executing without their order.
Claimed calls retain the existing indefinite permission wait; expiry does not
reorder an approval already being awaited. Shutdown releases unclaimed tickets.

The runtime batches and serializes cleanup RPCs, with a ten-second timeout, and
awaits outstanding cleanup during Stop/disposal and delegate settlement. Cleanup
failure is reported explicitly. Failed identities remain reserved for a bounded
retry on a later drain; confirmed cleanup clears their failure state. Repeated
Stop/disposal can recover after Host availability returns without an unbounded
retry loop. Ticketed mutations bypass the sidecar PathMutex
to avoid inversion. Direct legacy invocations retain their original lock and
budget path. Edit remains sequential: Host filesystem order alone does not prove
ordered sidecar mutation-recovery outcomes.

## Consequences

No model schema, Plugin SDK, database migration or protocol version change is
needed for these additive private methods. Runtime preparation fails closed with
an older Host; callers without tickets retain the old execution API, but cannot
omit a ticket for a call that is already prepared. These registrations coordinate
participating operations in one Host, not arbitrary Shell/external processes.
Metadata preflight reads no file contents and does not grant external access.
