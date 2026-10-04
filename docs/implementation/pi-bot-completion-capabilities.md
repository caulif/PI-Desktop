# pi-bot completion Host capabilities

## Scope and baseline

Task branch: `feat/pi-bot-completion-capabilities`, based on origin/main
`b684e661797996db3ac64c3c5bdf5764a38fd522`. Native navigation is reused from
PR #3. Scheduler/prompt committed groundwork is preserved by cherry-pick of
`1d2d1e4...` as `4ad11ed1519619b2b41f64ba121062be02c22078`.
Experimental worktree changes were inspected and selectively formalized; its
unrelated edits remain untouched. No production profile was opened.

This candidate supplies the Host dependencies for pi-bot A-G completion:
native-approved fixed checks, durable prompt claims/cancellation, immutable Bot
tool scope, isolated calendar preview, and explicit relay thinking transport.
ADRs 0311-0314 and plugin service specs define the contracts and limitations.

## Executed validation

- Initial JS workspace build passed. Final shared/runtime build and Desktop
  typecheck passed after affected integration repair.
- Host full test gate: 682 passed. Recovery fixes afterwards: four affected
  verification tests passed; source-only test extraction requires a final compile.
- Runtime focused gate: four files, 297 tests passed.
- Gateway/filesystem gate: 47 passed, one Windows file-symlink privilege skip.
  Additional filesystem run: 25 passed, one skip; actual directory-junction
  list escape coverage passed.
- Lint and formatting passed. Clippy passed with the existing scheduler tuple
  complexity warning; it is not a test failure.
- Real Host calendar acceptance passed, report in isolated
  `pi-bot-calendar-preview-5QTLvV/calendar-preview-report.json`; includes DST
  gap/fold, exact revision, ownership, profile guard and cold restart.
- Real Host engineering acceptance passed, isolated
  `pi-bot-verification-F2JOtT/approved-verification-report.json`; actual child
  execution/output hash, duplicate/replay, revoke/query/cancel, timeout/output
  bounds and crash recovery. Approval is explicitly a trusted Main RPC fixture,
  not a native click. Both harnesses used zero model calls.

The pre-commit reports bind binary/source manifests. Final candidate reports
must be rebound after the formatting/test extraction and latest navigation
dependency integration; historical successful reports are retained.

## Independent review and acceptance boundaries

Independent review found lookup/cancel blocked by revoked approvals, duplicate
execution registration before lookup, and missing cold executing maintenance.
All three were repaired; application adapter additionally validates execution ID,
before-snapshot and output hash. Latest-SHA review and CI are recorded separately.

Native computer-control initialization still fails before any UI action with
kernel asset path error (os error 3). Consequently native consent acceptance,
Routine/template consent and native GUI navigation are pending. Structural
approval fixtures do not satisfy those gates. Live relay thinking behavior,
Learning recall and collaboration quality remain separate paid model gates.
No human review is synthesized; no merge, production install or release occurs.
