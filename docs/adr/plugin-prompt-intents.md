# Plugin prompt request identity

First-party plugins may add `requestIntentId` to `agent/prompt`. Electron main
binds the authenticated plugin identity, session ID, and SHA-256 of the exact
prompt in a durable Host ledger before invoking Agent IPC. A repeated ID with
the same input returns the saved result without dispatching another prompt;
a different session or content fails with `IDEMPOTENCY_CONFLICT`.

`agent/promptLookup` is plugin-only and accepts `{requestIntentId}`. It returns
`{status, turnId, sessionId, code, turnStatus}` where status is `not_started`, `unknown`, `accepted`,
or `rejected`. Prompt responses also include `status` and `accepted` alongside
`turnId`. `unknown` means a prompt may have been accepted: the caller must not
start a new request under another ID. Even `not_started` only permits retrying
with the original ID because an older request could still be in flight. An
accepted IPC result is persisted with its turn ID; a definitive busy rejection
is persisted as rejected. Transport errors remain unknown.

The ledger does not change the normal desktop prompt path or authorize a plugin
to send a prompt. Existing plugin permission and consent checks still apply.

## Atomic turn claims and recovery

New ordinary prompts reserve a Host-generated claim and an Electron-main
process epoch. A single-use WeakMap admission binds the authenticated plugin,
intent and claim to the exact in-process request object; serialized renderer
fields and cloned requests cannot impersonate that admission. The ordinary
desktop prompt path continues to use `session.beginTurn`.

For a plugin admission, `plugin.promptBeginTurn` inserts the durable turn and
binds it to the ledger in one SQLite transaction, before Agent dispatch. A
delayed or revoked claim cannot begin a turn. Repeated binding returns the
original turn with `start:false`. Lookup reads the actual SQLite turn status
even when the original accepted response was lost. Acceptance, execution state
and quality remain separate facts.

An unknown request is never blindly resent. If lookup shows no bound turn,
trusted main may atomically release a v2 claim before retrying the original ID.
A new process epoch may similarly reclaim only an unbound v2 claim, revoking
the old proof. A bound turn or a legacy unknown record without a claim can
never be reclaimed or dispatched again. `prepare`, release, binding,
invalidation and settlement perform transactional reads and writes.

`agent/promptInvalidate` records a rejection tombstone even before prepare. It
revokes an unbound claim; when a turn is already bound it instead returns that
turn so the caller can cancel the actual execution. It does not assert that
the process has stopped or that a delivered artifact disappeared.

## Live steering

`agent/steer` requires a server-derived, still-live plugin panel authorization
and a session owned by that plugin. The bounded input names the exact expected
turn. Agent IPC checks that the turn is dispatchable, and the runtime rechecks
after file and Host IO so a stale steering input cannot become a normal prompt
for the next turn. The steering receipt binds plugin, intent, session, turn and
content hash. Repeats return the saved receipt; uncertain steering outcomes
stay unknown without automatic replay. `panelAuthorized` is an internal main
process context fact, never a plugin-supplied request boolean.
