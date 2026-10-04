# ADR 0314: Immutable scoped tool policy for Bot sessions

## Status

Implemented candidate; independent phase verification remains separate evidence.

## Context

pi-bot applies conversation, project and operation permissions in its workbench
tool. A Bot session with the ordinary Read, Bash or Task catalog could bypass
those decisions. Filtering the model catalog alone does not protect Host RPC
execution, and restoring an unrelated assignment's messages or compaction can
disclose another conversation even when its tools are unavailable.

## Decision

Persist `unrestricted` or `plugin-bot-scoped` as an immutable session policy.
Ordinary sessions keep unrestricted behavior. Sessions owned by `local.pi-bot`
are tightened during owner registration, schema upgrade and startup repair.
Forks and collaboration children inherit the restriction; configuration cannot
relax it. Invalid stored policies fail closed.

Scoped runtime catalogs expose only workbench and local tool search. Tool search
uses that same filtered catalog. Host tools.execute separately refuses generic
native tools for scoped sessions. Assignment admission builds a fresh runtime,
skips old message/compaction restore and does not load trusted extensions.
Project instructions and configured project memory remain trusted context; this
policy does not claim a new OS sandbox or remove explicitly configured context.

## Alternatives and Consequences

Prompt-only instructions and catalog-only filtering leave an executable bypass.
A separate execution engine would duplicate existing task and lifecycle code.
The policy reuses those engines and narrows their inputs instead. Schema 23 uses
the normal upgrade backup and preserves existing unrestricted non-Bot sessions.

Original experimental changes are reviewed selectively; unrelated worktree
changes remain in their original checkout. Fixtures, Host RPC acceptance and
native/model acceptance remain distinct evidence categories.
