# ADR 0324: Headless first-party Bot runtime

- Status: Accepted for implementation
- Date: 2026-10-05

## Context

The headless Host already owns execution, durable transcripts, native permissions,
queues and recovery. It did not expose trusted plugin tools or deliver plugin
scheduler due events. A browser proxy cannot replace these responsibilities.

## Decision

The explicitly enabled library option `startPiHost(config, {trustedPlugin})`
installs one administrator-selected `local.pi-bot` API broker. It does not load
arbitrary packages, expose Electron IPC or make a second Bot-data writer. The
caller owns the actual pi-bot lifecycle and must unload it before stopping Host.
Default CLI and library startup keep plugin capability disabled.

Pure plugin invocation provenance, durable prompt admission, schedule operations,
verification operations and scheduler polling are extracted into host-runtime;
desktop adapters re-export them. File scope policy is extracted into shared and
re-exported from plugin-sdk. Existing desktop decisions stay unchanged.

Host-core permission/Plan restrictions and execution budgets run before emitting
`plugins.execute`. The broker verifies the current turn, creates an expiring
AsyncLocalStorage invocation and returns through `plugins.resolveExecution`.
It never accepts plugin identity or a tool origin from an HTTP payload.

Authenticated Gateway operations use `runAsWebUser({userId:'owner',deviceId},fn)`.
Dangerous configure, enabling a Routine and fixed-check registration require an
exact expiring approval. Native runtime approvals remain in AgentHost. Scheduled
occurrences have their own scoped context and Host-owned occurrence authorization;
no fabricated user principal is used for automatic execution.

An explicitly enabled execution node exposes a fixed owner-only RACP catalog.
It holds no Bot domain writer. The central adapter qualifies sessions by pinned
Host identity and sends tool results through the native active-invocation token.
The node device principal authenticates the machine connection; automatic Routine
authority remains the durable Host occurrence and its frozen definition, not an
HTTP flag or a newly fabricated human approval. Native risk approvals remain
required where the installed tool policy requires them.

Registered canonical roots, the installed manifest scope and protected-file
policy constrain file reads/writes. Reads check an opened descriptor identity
before reading. Linux atomic writes anchor both temporary and destination names
to an opened directory descriptor. Windows checks canonical parent and descriptor
identity but lacks Node's Linux directory-fd path; OS isolation must prevent
same-user adversarial directory rename. The trusted module is first-party code,
not an untrusted Node sandbox. Registered project code must not share the service
account's unrestricted credentials; deployments run a separate non-root account.

## Consequences

The application is responsible for TLS/auth/CSRF, durable command receipts,
single-writer locking, Bot-owned object access and artifact version downloads.
No generic shell, arbitrary TCP proxy, desktop screen or Electron window exists.
The library bundle `service.mjs` can be imported without starting any process.

Required predecessor changes are explicitly included in this branch: reviewed
plugin prompts/schedules, scoped completion capabilities and their migration
extractions. They are not assumed to be released on upstream main.

## Integration with current main

Upstream schemas 20 (voice queue identity) and 21 (Todo checklist) collided with
the earlier development Bot schema numbering. The combined schema is 25:
upstream migrations retain 19→20→21; Bot bindings, retry ledger, frozen
authorization and tool policy occupy 21→22→23→24→25. The final migration also
applies upstream idempotent voice/Todo additions for old development profiles
20–23. Table/column validation preserves existing ownership and fails incomplete
retry/authorization layouts. Each step takes a readable migration backup.
Real official-21 and development-23 fixtures preserve session/artifact data,
ownership ceilings, integrity/foreign keys and survive reopening. Production
profiles are never used by this acceptance work.
