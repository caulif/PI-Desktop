# ADR 0321: Isolated development calendar preview

## Status

Accepted for the pi-bot completion development profile. Not a released Plugin
SDK capability or an authorization, occurrence, execution, or clock API.

## Context

Routine acceptance needs to inspect actual Host calendar semantics across DST
boundaries without changing the system clock, advancing live scheduling, or
creating artificial Work. Plugin-side fixture calculations cannot establish
that the Host uses the same stored definition and timezone.

## Decision

Add a bounded, read-only native calendar projection behind the Host's isolated
development-profile guard. The caller supplies trusted plugin identity, an
exact stored definition revision, an explicit RFC3339 `after`, and a count from
1 to 16. Plugin identity must never be taken from an untrusted plugin argument.
The entry point must remain absent from the public MCP/Plugin SDK catalog.

The native RPC is `scheduled.devCalendarPreview`. Explicit opt-in uses
`PI_DESKTOP_DEV_CALENDAR_PREVIEW_DIR`, an existing canonical OS temporary direct
child named `pi-bot-calendar-preview-*`. Startup rejects mismatched/default or
production paths and database redirects before opening SQLite; each diagnostic
RPC rechecks the actual `pragma_database_list` main file against that directory.
Normal launches without opt-in are unchanged and cannot use this RPC.

Resolve `(pluginId, externalKey)` through the existing plugin schedule repository
and call the same `Schedule.next_in` used by the production scheduler with the
stored cadence, schedule, and IANA timezone. Reject missing bindings, stale
revisions, invalid inputs, and unrepresentable instants. Normalize the input to
the scheduler's millisecond UTC precision; never use timestamp parsing with a
wall-clock fallback. Return identity, revision, stored calendar, enabled status,
normalized cursor, and UTC/local-offset pairs. No prompt or authorization data
is returned.

Disabled bindings are valid preview subjects. Preview neither approves nor
enables them and never invokes `due`, rescheduling, occurrence creation, Run
admission, or prompt execution. The diagnostic RPC caller owns profile gating
and its failure mapping. The profile guard must reject default/production data
directories before a diagnostic runner opens them.

## Alternatives and consequences

- Advancing the OS clock or invoking `due` changes real execution state and is
  rejected. A new virtual execution clock would create a second scheduler.
- Recomputing calendar semantics in the plugin duplicates DST and interval
  rules and proves fixture behavior only.
- Native projection establishes stored calendar semantics, including missing
  local times and one occurrence per repeated daily/weekly local time. It does
  not establish real timer delivery, authorized execution, restart admission,
  or human approval. Those require separate acceptance evidence.
- No schema migration, background process, dependency, or default behavior is
  added. The development entry point is not a promise of public API stability.

## Validation

Real isolated SQLite integration tests inspect stored disabled bindings across
the spring gap and autumn fold, exact revision/ownership rejection, malformed
input and count bounds, and SQLite `total_changes()` remaining unchanged.
The protocol/profile gate and actual diagnostic RPC are verified separately by
the stage owner. Test results must be recorded against the validated source
revision; this ADR is not itself evidence of passing acceptance.
