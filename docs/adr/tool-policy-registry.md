# ADR: Complete internal tool execution policy registry

- Status: Fork experiment
- Date: 2026-10-12

## Context

Read parallelism needs a policy that remains correct when tools are activated,
restored or contributed dynamically. Tool names, low-risk declarations and
read-only-looking schemas do not prove absence of shared state. Tools also run
in several components; moving all of them into a Host file scheduler would
incorrectly claim ownership of Electron, runtime or external service state.

## Decision

Use one typed internal registry for built-in batch mode, execution owner and
lifecycle classification. Built-in construction requires an explicit entry.
Registration does not grant permission, implement cancellation or move execution.
Runtime catalog rebuilding applies policy after schema normalization and mode
filtering. Activation and restoration select the existing policy-bearing catalog
objects; they never trust provider schemas or persisted concurrency hints.

Track built-in/plugin/extension provenance on construction with weak object
identity. Plugin/MCP and trusted extension tools stay sequential even if their
name collides with a parallel builtin or they declare low risk. The delegate
loop retains conservative sequential modes selected by its parent's catalog.
Unknown names fail closed; a newly added builtin must register explicitly.
No public schema or Plugin SDK field is added.

## Existing execution and lifecycle contracts

| Tools | Actual owner and existing lifecycle path |
| --- | --- |
| Read, Glob, Grep, Write, Edit | Host `rpc/mod.rs` → `tools::run_file_tool` blocking pool; actual body must drain before capacity/resources release. Prepared file tickets preserve source order; Host admission grants capacity and file resources together, and cancellation drains started work before release. |
| Bash | Host permission/admission → shell process cancellation, kill and drain. Sequential is per-agent batch only. |
| TodoWrite | Host `todos::execute_write`: atomic checklist write and after-commit notification. |
| ScheduledTaskList/Create/Update/Delete | Host scheduled-tools handler and durable project state. Even List stays sequential pending candidate-specific evidence. |
| PluginCheck/Scaffold/Pack | Electron `main/plugin-dev-tools.ts` local handlers: workspace containment, package checks/files and plugin loading. No Host file lease is inferred. |
| BrowserPreview | Electron `main/runtime/sidecar.ts` local handler: resolves contained HTML and changes the shared panel. |
| Skill | Electron same local bridge: loads builtin/user/plugin skill bodies; the registry/prompt state is not made parallel here. |
| GenerateImages | Electron image runner plus Host authorization and existing external request/output lifecycle; not merely a Host-local computation. |
| JevClassify | Runtime direct provider request; inherited AbortSignal combined with a 45-second timeout in `jev-classifier-tool.ts`. |
| ToolSearch, new_context | Runtime activation and pending context state; effects must be visible at the next model boundary. |
| asktool | Runtime pending answer registry and existing resolve/Stop lifecycle. |
| EnterPlanMode/EnterGoalMode/SubmitPlan/SubmitGoal | Runtime orchestration and Host-confirmed durable mode/proposal state; transitions remain sole-call batches. |
| Task/TaskWait/TaskList/TaskStop | Runtime delegation registry, independent delegate loops and settlement; Task is parallel, other controls remain sequential. |
| plugin_*, mcp_* | Host normal permissions/budget followed by `plugins.execute` to Electron plugin/MCP services; existing bounded dispatch timeout, external side effects remain executor-owned. |
| Trusted extension tools | Trusted extension runner-owned execution/cleanup; sequential fallback does not imply global exclusion or forced cancellation. |

These labels describe the existing owners. A future candidate must prove its
shared-state isolation, actual completion/cancellation semantics and meaningful
benefit before changing its registry mode. The registry alone cannot protect
arbitrary Bash or plugin writes, and promises no all-tool global lock.

## Validation and integration

Tests enumerate actual catalogs across Agent/Plan/Goal with optional capabilities,
reject a missing builtin entry, and verify dynamic provenance through activation
and rebuilding. Existing HTTP/SSE fixed-tool tests now assert conservative modes
after activation and persisted restoration, including checkpoint restoration.
Read, Glob, Grep, coordinated Write and Task retain their integrated parallel
modes. Edit stays sequential because Host file coordination does not order
runtime recovery-state commits. This registry adds no further parallel switches.

## Consequences

Every built-in has a reviewable execution policy without extending public
contracts. Dynamic tools stay conservative, and lifecycle labels identify
existing owners rather than promising stronger cancellation or shared-state
isolation. Further parallel candidates require executor-specific evidence.
