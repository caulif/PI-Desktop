# Isolated controlled due implementation and acceptance

Baseline Host PR4 is bdd21bb8c8e062f6a303100da216e3dbe9200638. This continuation
uses branch feat/isolated-dst-due-evidence and remains stacked, unmerged.

Implementation: scheduled/diagnostic_due.rs, scheduled_rpc native-only dispatch,
startup guard, and production plugin_scheduled::due occurrence savepoints.
Default behavior and actual OS time remain unchanged. The exact profile requires
both development opt-ins and the actual dedicated Temp SQLite file. The RPC
consumes an existing authorized binding; it creates no grant or model admission.

Independent review found seed/clock autocommit before due, missing write-ahead
unknown reporting, and ambiguous native provenance. All were fixed. The complete
seed/clock/due/readback now has one transaction, with production savepoints;
the runner fsyncs intents, never repeats an unknown, and accepts only definite
RPC refusals as rejection evidence. Missing native receipt remains incomplete.
ADR 0315 and both service-spec locales describe the contract.

Concentrated checks: 4 diagnostic tests and 15 affected plugin_scheduled tests
pass; build passes, formatted final source is rebuilt separately, docs locale
and structure checks pass (530 pages). Logs live under ignored artifacts/local/
remaining-controlled-due-{tests,build,final-build,docs}.log. Format check is
rerun after formatting the new dispatch branch. Existing nonfatal documentation
warnings are not suppressed.

Actual RPC smoke01 passed gap/fold/missed, duplicate due, multiple normal EOF
restarts and exact cold binding/SQLite checks, disable rejection, opt-in-off
rejection, and invalid profile refusal before SQLite creation. Smoke02 also
passed and binds the rebuilt formatted source. Both freeze parent SHA,
materialized dirty diff, key source
hashes, binary hash and examples hash. Original reports are preserved.

Both RPC smoke batches explicitly use SYNTHETIC native consent and zero model
calls. They establish real Host RPC and controlled-time occurrence persistence,
not genuine native approval, wall-clock DST crossing, plugin Run/Attempt or a
paid Routine result. No controlled timestamp is sent into ordinary execution
admission; its deadline and plugin policy clocks are unchanged.

The new approved-profile runner scripts/dev-scheduled-controlled-due.mjs is
ready but has not run with genuine native observation. Real wall-clock Routine
and that approval await the supported UI runtime; this is a separate acceptance
gate, not a reason to discard controlled Host evidence.

No production database, OS clock changes, default M2 enablement, release,
production installation or automatic GitHub merge. Recovery resumes from source,
binary, frozen plan, report and requested/unknown journal, with lookup before
replay. The original pi-bot user checkout remains untouched.
