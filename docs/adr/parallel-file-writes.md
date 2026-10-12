# ADR: Enable coordinated parallel Write calls

- Status: Implemented candidate (fork)
- Date: 2026-10-12

## Context

Host resource admission and ordered tickets now coordinate participating file
calls independently of approval/arrival order. Keeping every Write sequential
and per-session mutation capacity at one prevents independent file writes from
using the two existing global mutation slots.

## Decision

Enable Write in the internal parallel batch policy and raise per-session
mutation capacity from one to two. Keep global mutation capacity at two, all
other capacities unchanged, and Edit/Bash/unknown tools sequential. A batch may
fan out only when every member is Read/Glob/Grep/Write/Task. Any Edit, Bash or
other sequential member preserves whole-batch sequential execution.

Use the existing Host tickets and atomic file-resource admission: same-file
Write/Read conflicts preserve preparation order; independent paths can occupy
both mutation slots. Waiting on a file reserves neither execution capacity nor
unrelated files. Legacy direct calls retain conservative PathMutex bookkeeping.
The mutex is not stacked on ticketed calls.

## Why Edit stays sequential

Host filesystem order does not order responses at the sidecar. An earlier Edit
failure and a later successful Edit on the same owner/path can reach sidecar
bookkeeping in reverse order; the success could clear strikes before the earlier
failure is counted. Already-launched parallel calls also cannot be withdrawn by
the current response-side recovery budget. This PR does not invent an additional
acknowledgement/commit protocol to change that contract.

Sequential Edit preserves response-processing order. Existing pi termination
is a batch-boundary hint, not a guarantee that the third failure immediately
prevents remaining tools in the same batch. This PR makes no stronger claim.

## Consequences

- Write has no expected-version CAS. Ordered writes can still overwrite changes
  with stale whole-file content; serialization is not optimistic concurrency.
- Glob/Grep have no directory-tree snapshot lock. Bash and external/plugin
  writes are outside the participating file-resource protocol.
- Cross-agent Shell conflict is unchanged; Bash sequential is per-agent batch.
- Edit may be enabled later only after ordered recovery/termination evidence.

## Validation

Runtime barrier tests show independent Write execute entries overlap, with
reverse response order still yielding source-order model results and deterministic
path instructions. A gated Edit failure/success regression proves sequential
response processing preserves counter updates. Host budget tests prove two
different-file permits can coexist within one session, a third writer remains
queued under the unchanged global cap, and same-file conflicts do not consume
the spare slot. Real Host ordered-file and admission harnesses validate protocol,
approval, actual file contents and cleanup. None of these asserts a throughput
multiplier or a full desktop visual E2E pass.
