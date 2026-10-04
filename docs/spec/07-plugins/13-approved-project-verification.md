# Approved project verification

The plugin-only reviewed operations are verification/approveCheck, snapshot,
runApprovedCheck, lookupExecution, cancelExecution and revokeCheck. External MCP
cannot invoke them. Main supplies plugin identity from the loaded process.
Plugin arguments cannot carry approval tokens, claims or authorization flags.

Approval is a native Main dialog for a Host-produced immutable definition. It
shows canonical executable, fixed argv, executable/script hashes, project,
plugin-owned session, digest, limits and expiry. Dismissal refuses approval.
The challenge token is Main-private and single-use. A caller's acknowledgement
is not native consent. Fixed commands run with OS account permissions, not an OS
sandbox; transitive code and mutable Unix inputs are documented limitations.

Snapshot binds approved command identity, Git HEAD, tracked/unignored working
tree content and the actual allowlisted execution environment. Input changes,
foreign sessions/projects, expiry and revocation refuse new admission.

Execution first saves an exact request digest and a durable claim. Concurrent
identical requests return the existing receipt. Unknown responses and cold
restart query the original execution and never start it again. Startup changes
orphaned executing receipts to unknown and invalidates their coordinator claim.
Existing executions remain queryable and cancellable after approval revocation
or input drift. Lookup validates the saved exact request and live owned scope.

Host owns process creation, environment clearing, bounded output, timeout,
process-tree ownership and cancellation. Cancellation intent is not a success
receipt. Completion requires measured output and after-snapshot; cleanup failure,
timeout, truncation, cancellation or missing measurements stays incomplete.
Execution exit success is not editorial or engineering human review.

Bot sessions have the immutable scoped tool policy described in ADR 0314.
File calls use their invoking session's project; a missing project cannot borrow
the visible window workspace. Directory lists apply realpath containment to the
directory and every returned child.
