# ADR 0320: Native-approved fixed-command engineering verification

## Status

Implemented candidate; native GUI acceptance pending.

## Context

Plugins need real engineering check receipts, rather than claims that a test
ran. An opaque command ID must not become a generic Bash capability. Receipts
must survive restart and ambiguous transport outcomes without rerunning checks.

## Decision

Rust host-core owns approval challenges, immutable command grants and execution
receipts in separate versioned KV namespaces. A plugin-owned live session and
its exact canonical Git project root bind every operation. Host profile roots,
production profile roots, traversal and symlink inputs are rejected.

Trusted Electron main obtains a short-lived single-use unpredictable challenge,
shows the exact program, arguments, script pins, limits, scope, expiry and
digest in native consent, and consumes it only on an affirmative user decision.
The plugin-facing API must never expose the challenge token or accept an
`authorized` boolean as proof. Only its SHA-256 lookup key is persisted.

A grant binds canonical absolute executable bytes, fixed bounded arguments,
explicit script SHA-256 pins, time/output ceilings and finite expiry. A changed
executable or pinned script requires a new native approval. Revocation and
reapproval never revive an old ID. The approved script and executable handles
remain held until settlement; Windows uses read-only sharing to deny writes
and deletes during execution. Unix read handles do not prevent writes by other
processes. This implementation does not claim Unix immutable launch semantics.

Before admission, the Host measures Git HEAD, tracked and nonignored untracked
regular-file contents (including deletion markers), and the exact allowlisted
environment plus approved executable/arguments/script-pin identity. Engineering
snapshots always specify their command ID. General snapshots may omit it but
cannot serve as an engineering command snapshot. Bounds fail closed.

The Host reserves the exact execution ID/request digest transactionally before
launch. Identical repeats return the existing receipt without launching;
conflicting requests fail. After cold restart, an executing receipt has unknown
process ownership and must only be looked up, never restarted. Only the trusted
Host runner can settle receipts using a private unpredictable claim token.
Cancellation records intent separately from actual tree termination. Timeout,
cancellation, output limiting, output-pipe failure and uncertain cleanup cannot
produce a completed receipt. Bounded captured bytes and their digest remain
available on incomplete outcomes. A completed receipt means execution finished;
its exit code and before/after identity still determine verification quality.

The runner reuses the existing hidden runner startup fence, Windows Job Object
and Unix process group. Ownership is established before the hidden runner is
given the program configuration. It invokes program/argv directly, clears the
environment and supplies only the exact Host allowlist whose digest was
measured. API keys, provider credentials, OAuth tokens, Node options and loader
injection variables are not inherited. Combined stdout/stderr bytes are captured
in pipe arrival order with a single bound. Cleanup uncertainty remains unknown.

## Trust and limitations

This is approved check execution, **not an OS sandbox**. A user-approved program
and all code it loads may produce side effects, use network access or spawn
children. Fixed argv prevents implicit shell construction; native consent must
not describe arbitrary test scripts as side-effect free. The approval UI must
show all arguments. A plugin's declarations are requests, not authorization.

Script pins bind explicitly named entry scripts, not every dependency loaded by
an interpreter. Git content snapshots detect ordinary workspace changes; they
do not freeze the entire workspace or global package/runtime dependencies.
Concurrent adversarial changes, external dependency resolution, Unix detached
processes, and filesystem rename races are outside these guarantees. Windows
guards narrow pinned-byte races but are not an OS-wide sandbox. Review and real
acceptance must report these boundaries rather than treating a hash check as an
atomic immutable launch proof.

The existing per-session/path policy remains authoritative. The Host must use
an isolated development profile for acceptance; this feature does not authorize
production database use, external publishing, human quality approval or a
default-on experimental companion mode.

## Validation

Phase-end validation must cover proof replay, expired/revoked grants, foreign
session/project access, changed pins, repeated and conflicting execution IDs,
cold lookup, cancellation and output/timeout cleanup. Real Host execution and
native consent are separate acceptance evidence from fixtures and module tests.
