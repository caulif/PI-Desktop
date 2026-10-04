# ADR 0313: Explicit relay thinking transport

- Status: Accepted
- Date: 2026-10-04
- Related: ADR 0194, ADR 0295

## Context

Reasoning capability, a caller's thinking preference, and the endpoint's wire
format are separate facts. A custom Chat Completions relay may enable thinking
by default. Disabling reasoning in a local model binding does not necessarily
send an upstream disable field: pi-ai's DeepSeek serialization branch requires
`model.reasoning`, and automatic protocol detection does not recognize every
relay URL or provider row identity. DeepSeek reasoning-history replay flags do
not select its thinking request dialect.

Sessions and subagents already support `omit`. Plugin one-shot completion must
preserve that explicit selector instead of parsing it as canonical `off` before
transport translation. This does not change the existing capability/default
selection rules for callers that omit the selector.

## Decision

Expose optional `thinkingRequestProtocol: "deepseek"` on user-managed provider
configuration. Absence preserves existing adapter behavior. The host validates
the closed enum and persists it in the existing provider `config_json`
compatibility object; updating with null clears the override and an absent key
preserves it. No schema migration or arbitrary request-body configuration is
needed. Reject incompatible explicitly selected APIs rather than silently
claiming the override works there.

At the actual Chat Completions request boundary, the runtime applies a shared
`onPayload` translation only for this explicit dialect and these preferences:

- `off`: set `thinking: { type: "disabled" }` and remove `reasoning_effort`.
- `omit`: remove `thinking` and `reasoning_effort`.
- Enabled thinking levels: retain the existing adapter behavior.

The translation runs after any existing caller payload hook and remains active
through retry options, including output-limit repair. It neither sets reasoning
capability to true nor changes persisted session preferences. A malformed caller
payload replacement fails explicitly. Sessions, subagents, and plugin one-shot
completion use the same helper.

## Alternatives and consequences

Setting `supportsReasoning` or `model.reasoning` merely to enter a pi-ai branch
would misrepresent capability and affect UI/clamping. Globally detecting
DeepSeek-family models would also change unrelated endpoints. Patching the
dependency would create maintenance work for behavior already supported by its
public `onPayload` hook. Explicit endpoint opt-in avoids those changes, while
requiring the user to know the relay's supported request dialect.

Structural tests use the actual pi-ai adapter and a fake fetch to assert only
the thinking enum and effort-field presence. They prove request shape, not that
a real relay accepts the fields or disables its internal reasoning. A live
provider trial is a separate budgeted acceptance gate. Production logging must
not record payloads, headers, credentials, message text, or reasoning content.
