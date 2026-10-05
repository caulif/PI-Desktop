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
