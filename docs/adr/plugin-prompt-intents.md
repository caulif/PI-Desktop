# Plugin prompt request identity

First-party plugins may add `requestIntentId` to `agent/prompt`. Electron main
binds the authenticated plugin identity, session ID, and SHA-256 of the exact
prompt in a durable Host ledger before invoking Agent IPC. A repeated ID with
the same input returns the saved result without dispatching another prompt;
a different session or content fails with `IDEMPOTENCY_CONFLICT`.

`agent/promptLookup` is plugin-only and accepts `{requestIntentId}`. It returns
`{status, turnId, sessionId, code}` where status is `not_started`, `unknown`, `accepted`,
or `rejected`. Prompt responses also include `status` and `accepted` alongside
`turnId`. `unknown` means a prompt may have been accepted: the caller must not
start a new request under another ID. Even `not_started` only permits retrying
with the original ID because an older request could still be in flight. An
accepted IPC result is persisted with its turn ID; a definitive busy rejection
is persisted as rejected. Transport errors remain unknown.

The ledger does not change the normal desktop prompt path or authorize a plugin
to send a prompt. Existing plugin permission and consent checks still apply.
