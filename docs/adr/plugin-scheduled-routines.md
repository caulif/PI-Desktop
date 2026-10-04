# Plugin-owned scheduled Routines

The isolated native development RPC `scheduled.devCalendarPreview` (ADR 0312)
projects an exact owned stored revision with the production calendar algorithm.
It is not a plugin service and never enables a binding or creates occurrences.
See the plugin Host-service specification for its strict temporary-profile guard
and bounded explicit-time request. Calendar prediction does not establish actual
timer delivery, authorized Work execution, or human review.

The desktop scheduler persists plugin bindings under `(pluginId, externalKey)`.
`pluginId` comes from `PluginRuntime`, never from the plugin's argument object.
The internal operations are hidden from the external MCP catalog:

| Operation | Argument | Result |
| --- | --- | --- |
| `scheduled/pluginUpsert` | `{externalKey,title,definitionRevision,enabled,timezone,cadence,schedule,sessionId,goalHash,promptTemplateHash}` | Binding, or `{consentRequired:true}` without mutation |
| `scheduled/pluginGet` | `{externalKey}` | `{binding: binding \| null}` |
| `scheduled/pluginDisable` | `{externalKey}` | `{disabled,schedulerTaskId?}` |
| `scheduled/pluginStart` | `{routineId,trigger,requestIntentId,sessionId,content,manualToken?}` | `{accepted,turnId,detail,code?}` |
| `scheduled/pluginLookup` | `{requestIntentId}` | `accepted`, `rejected` with code, `not_started`, or `unknown` |
| `scheduled/pluginSessionOwner` | `{sessionId}` | `{state:'own'\|'other'\|'unowned'\|'missing'}` |
| `scheduled/pluginSkip` | `{schedulerTaskId,occurrenceId,scheduledFor,definitionRevision,reason}` | `{skipped:true,reason,occurrenceId}` |
| `scheduled/pluginRetry` | `{schedulerTaskId,occurrenceId,scheduledFor,definitionRevision,requestIntentId,reason}` | `{state:'deferred'|'skipped',retryAt,retryCount,deadlineAt,reason?}` |

`timezone` is an IANA name. `cadence` is `hourly`, `hourly_at`, `daily`, `weekly`, or `interval`.
`schedule` requires `hour` (0-23), `minute` (0-59), and `weekday` (Monday=0 through
Sunday=6). Weekly can supply `weekdays` with unique values 0-6. Interval requires
`intervalMinutes` from 1 to 10080. Hourly and interval use elapsed time; daily
and weekly use the registered timezone. `hourly_at` uses the specified minute
in that timezone, and ignores the second instance of a repeated DST hour.
A changed schedule must increment
`definitionRevision`. A same-revision enable/disable preserves `nextRunAt`.

Enabling a new or changed schedule requires native user consent through the
panel-only `scheduled.authorizeSchedule({definition})` bridge. The consent
record binds the exact definition, plugin-owned session, goal hash and prompt
template hash. Background `pluginUpsert` cannot forge native authorization; it
returns `consentRequired` without writing an enabled task. A same-definition
reconciliation while the task remains enabled is idempotent. Disable or plugin
unload clears authorization, so reenable requires fresh consent. The v21 to
v22 migration disables old plugin schedules lacking this authorization and
preserves their bindings and occurrence history.

The host polls pending occurrences and sends only the owning loaded plugin
`pi.events.on('scheduled:pluginDue', (event) => ...)`, where `event` contains
`pluginId`, `schedulerTaskId`, `externalKey`, `occurrenceId`, `scheduledFor`, and
`definitionRevision`. Pending events are redelivered after restart with the same
ID. The host chooses at most the latest missed occurrence; it is pending when
within 24 hours and otherwise recorded as skipped. The next time retains the
original interval phase. Unload disables every plan; reload reports that a
new panel authorization is required before reenabling.
The plugin can explicitly skip an exact owned pending occurrence for `overlap`,
`no_data`, `stale_definition`, or `owner_unavailable`; the reason remains in
the occurrence history. A skipped occurrence is not redelivered.

`pluginRetry` keeps a pending occurrence in the Host's queue. `owner_busy`
defers delivery by 30 seconds without consuming the transient retry budget;
`transient_rejection` requires a persisted, explicitly rejected start intent with
code `TRANSIENT` and permits two further deliveries after 30 seconds and two
minutes. The Host ends a pending occurrence after a 15-minute admission window
(`deadline`) or exhausted retries (`retry_exhausted`). Each distinct deferral
needs a stable `requestIntentId`; repeating the same ID returns the original
receipt without advancing `retryAt` or `retryCount`. A new ID denotes a new
deferral cycle. Permanent `AGENT_REJECTED`, permission failures, and unknown
admission outcomes cannot be relabeled as transient retries.

Scheduled `pluginStart` verifies the occurrence, current definition revision,
plugin ownership, persistent schedule authorization, and the exact authorized
plugin-owned session and Routine ID. It replaces only the 64-hex Work ID in
the fixed terminal `Work ID` sentence with zeros, hashes the resulting prompt,
and requires it to match the approved template hash. A role, memory, Skill or
other prompt change therefore requires a new native approval. The host writes a stable
request intent before invoking the ordinary Agent prompt path. A lost reply
stays `unknown` and is never automatically launched a second time. Successful
admission stores the turn ID and accepts the occurrence.
An explicit Agent rejection is recorded as `rejected` with a stable `code`.
`AGENT_BUSY` is a confirmed busy refusal; a generic `AGENT_REJECTED` is not
retryable. The Host permits a new intent for the same occurrence only after a
confirmed rejection and an elapsed retry deferral. `pluginLookup` reports the
rejection code for reconciliation.

Manual runs use the same intent and prompt path. The plugin panel requests
`pluginBridge.invoke('scheduled.authorizeManual',
{requestIntentId,routineId,sessionId,contentHash,title})`; the host
asks for native consent and returns a one-use `manualToken` valid for 60 seconds,
bound to those exact fields. `pluginStart` rehashes the actual prompt before
consuming the token, so a different Routine, session or content is refused.
The plugin passes that token to `scheduled/pluginStart` with a `manual` trigger
containing its durable click request ID. Background plugin code cannot mint the
token. Manual runs do not depend on `nextRunAt` or reenable a paused plan.

Sessions created by a plugin through `session/create` are registered to that
plugin as part of the desktop control callback. A Bot session created before
this ownership record existed needs explicit adoption from the plugin panel:
`pluginBridge.invoke('scheduled.adoptSession', {sessionId})`. Native consent
names the session; the host refuses to replace an existing different owner.

Lifecycle acceptance: `plugin_scheduled::tests::disabling_schedule_or_plugin_blocks_new_admission_but_keeps_inflight_history`
uses an isolated SQLite profile for both a single Routine pause and the
`pluginDisableAll` path used by plugin unload. It reserves a due Run and opens
its turn before disabling, then verifies no later due event or new admission,
while the in-flight turn can still be recorded as accepted. After reopening
the profile, the disabled binding, accepted occurrence, and original turn ID
remain queryable; new admissions stay blocked. Electron's unload hook invokes
`scheduled.pluginDisableAll`, whereas application shutdown leaves schedules
enabled for the documented restart catch-up behavior.
If Host is unavailable during unload, Electron first persists the plugin ID in
`plugin-schedule-disable-outbox.json`. It drains that file after the next Host
handshake and before ordinary startup work; a failed disable remains queued and
fails Host startup closed. The isolated Electron acceptance also clicked the
Routine Disable button after a timed file-producing Run, restarted the desktop,
and invoked desktop Uninstall. Host queries after each transition found no due
occurrences and retained the accepted occurrence history.

For collaboration callbacks, `session/collaboration/lookup` accepts the stable
outgoing `{messageId}` and verifies the plugin owner. It returns the outgoing
status, result and turn ID plus `replyToMessageId`, `completionMessageId`,
`completionStatus`, `completionTurnId`, and `completionSessionId` when a callback
exists. A queued callback has no turn ID yet. This query remains available
after restart and lets a plugin reconcile without starting a second wake.
