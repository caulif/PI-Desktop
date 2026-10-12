# ADR: Reserve bounded RPC capacity for cancellation and approvals

- Status: Accepted for fork experiment
- Date: 2026-10-12

## Context

The stdio dispatcher previously gave every RPC the same 32 in-flight slots.
Long-running tool and approval waits could occupy all slots. `tools.abort` and
`permissions.resolve` then received `HOST_OVERLOADED`, preventing the actions
needed to release those very waits. Increasing tool parallelism makes this
existing lifecycle failure easier to reach.

## Decision

Keep 32 ordinary request slots and add four independent bounded slots exclusively
for `tools.abort`, `permissions.resolve`, and `plans.abort`. Dispatch through the
same handlers and deadlines; release each owned permit only when its handler and
durable transcript writes settle. Excess traffic in either lane fails with the
existing overload contract. Controls do not consume or bypass tool execution
capacity. The explicit method list does not include queries or arbitrary plugins.

Bash remains sequential within a model-issued batch, with the existing Host
shell execution limit. This change creates no cross-agent shell filesystem lock.

## Consequences

At most 36 request tasks run, with at most four reserved for controls. Ordinary
traffic cannot starve cancellation at the transport-admission boundary. A control
flood is still bounded. Shared-state lock contention remains governed by existing
handler deadlines; reserved dispatch capacity is not a priority mutex.

The real Host saturation harness verifies denial, abort, drain and recovery.
Controlled Pi-loop tests verify ordering and Stop settlement without wall-clock
performance assumptions. Existing real-process tests remain the authority for
shell descendant cleanup and timeout behavior.

## Alternatives

An unbounded control bypass permits uncontrolled task fan-out. Increasing the
ordinary cap merely moves the same starvation threshold. Reserving tool permits
for controls addresses the wrong layer because these operations release work
without running a tool.
