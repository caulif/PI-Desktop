# Headless first-party Bot broker

An administrator may explicitly compose the pi-bot service with pi-host using the
library option `trustedPlugin`. Absence of that option leaves behavior unchanged.
Only installed manifest identity `local.pi-bot` is supported. The private Bot
metadata directory is separate from the Host database and registered projects.

The Gateway supplies a trusted single-user principal outside payloads; tool origins
come only from active Host-attributed callbacks. Mutations never derive authority
from `confirm`, payload pluginId or panelAuthorized. Exact configure/manual
Routine/check approvals expire after five minutes; consumed manual Routine tokens
expire after one minute and bind intent, Routine, session and prompt hash.

Files retain installed manifest scopes and protected-name denial. Reads are bounded
to 512 KiB per operation, UTF-8 text decoding is strict, listings are capped at
1,000 entries, write replacement is atomic and GUI opening is unavailable. Public
navigation filters registered roots and propagates unexpected Host/filesystem
errors. Native sessions are read-only projections in this broker.

Startup/shutdown, turn end and Host restart detach listeners, cancel invocation
contexts, reject pending consent and stop scheduler timers. Durable prompt claims
bind `plugin.promptBeginTurn` atomically. A missing callback or transport receipt
never implies a Work result or grants permission to retry a completed operation.

## Remote execution node

`startBotNode` composes Host and this installed broker without starting the Bot
domain. The central service remains the only Bot metadata writer. Pairing uses a
single-use RACP ticket and saves the owner device credential in an administrator
selected private file. `createRemotePluginApi` attaches one authenticated central
writer to a node; another simultaneous writer receives `CONFLICT`.

The optional standalone Host `bot-node.mjs start|pair` bootstrap supports POSIX
credential files only. It validates regular non-linked input files owned by the
current user with no group/other permissions, refuses shared output parents and
existing outputs, and creates only a new dedicated owner-only parent. On Windows
it fails before credential I/O; use the managed pi-bot service CLI, whose Windows
DACL validation protects the profile, pairing ticket and device token. The
in-memory `pairBotNode` and Host library composition remain cross-platform.

Only the reviewed `botNode/*` catalog is available. There is no arbitrary Host
RPC, plugin identity, shell bridge or authority flag endpoint. Native tools keep
Host permissions, budgets and plans, then invoke the central Bot callback through
an opaque token bound to the active native invocation and attached connection.
Turn end, disconnect and device revocation invalidate that token. Revocation is
checked on every frame of an already-open RACP connection. Revoking a device
also immediately disconnects its idle connections and prevents further
server-initiated requests. Revocation removes connection authority; it does not
abort a turn that has already been admitted. Cancel that exact turn separately.

Session addresses are `node:<actual-host-id>:<native-session-id>`. Conversion is
restricted to session fields and the fixed catalog's explicit positional session
arguments; free text, file bodies and model answers are preserved. Initial and
reconnected Host identities must match the saved pin. Commands are never replayed
because a receipt was lost.

With `allowOfflineStartup:true` and an existing pinned `hostId`, a network-only
failure produces an honest disconnected adapter. Calls fail `HOST_DISCONNECTED`,
tool registration is retained, and bounded exponential reconnect reattaches the
same Host before declaring readiness. Authentication, identity and schema errors
never become successful offline startup. `stop()` cancels reconnection timers.

Native approvals require the exact session, approval ID, revision and allowed
decision. Revision zero is valid. `agent/abort` returns `{ok:true,aborted:true}`
only for the exact active turn; an expired turn returns `{ok:false,aborted:false}`.
Automatic Routine due events still require Host-owned occurrence authorization.
An unattended medium-risk write may wait for native permission; the service does
not lower tool risk to manufacture autonomous success.

## Finite execution acceptance

`scripts/e2e-bot-node.mjs` uses two actual isolated Host processes, real Rust and
sidecar execution, authenticated RACP, actual pi-bot domain persistence and the
actual HTTP Gateway. Its deterministic local SSE provider costs no model calls
and proves protocol wiring, not real-model judgment or quality.

The probe checks HTTP pairing/CSRF, real Bot creation and qualified routing,
native approval with stale-revision refusal, physical remote file generation and
exact artifact download hashes, busy queue/cancel/stop, actual scheduled due with
the browser absent, completion after exact permission, cold offline recovery,
one occurrence across node/central restart and connected device revocation.
Only the isolated test database clock is advanced to avoid waiting fifteen
minutes; scheduler dispatch, admission, tool execution and Work receipts remain
the production paths. Reports and runtime binaries are local artifacts, not
committed credentials or claims of full product acceptance.
