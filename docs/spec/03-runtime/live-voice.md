# Live Voice v1

## Scope

Live Voice is an optional, app-owned real-time audio path. It is separate
from local Dictation and Host Speech, and is disabled by default. v1 supports
three explicit bindings:

| Adapter | Credential owner | Transport |
|---|---|---|
| Codex Live | Existing Codex Provider row through `VendorOAuth.resolveAuth` | Renderer WebRTC, Main-process SDP negotiation |
| Gemini Live | Google Generative AI API-key Provider | Main WebSocket and renderer PCM port |
| OpenAI Realtime | API-key Provider with a configured endpoint | Main WebSocket and renderer PCM port; GA and compat-v1 are separate profiles |

The public settings value is `liveVoice: { enabled, selectedBindingId?,
bindings }`. It contains provider IDs, model/voice choices and protocol
profile only; it never stores credentials. Existing `voice` and `speech`
settings retain their prior meaning. Host Core owns the persisted settings
JSON and merges the Live value with unrelated settings.

The voice-only Live profile does not create an Agent turn, call AgentHost or
MCP, access workspace files, execute model-generated functions, store
recordings, or persist transcripts. Transcripts stay in a bounded renderer
memory buffer for the current call. Provider delegation/function-call requests
are rejected or cause a protocol error unless the user explicitly starts a
separately scoped Live Work call; its execution and permission contract is
defined in [Live Voice Work Session Integration](live-work-session.md).

## Ownership and security

Electron Main owns the one-call slot, selected account, credential resolution,
provider invalidation, capture lease, cancellation, protocol adapters, network
transport and terminal cleanup. Renderer owns user interaction, WebRTC/PCM
media and transient transcript display. IPC derives ownership from the invoking
trusted main frame; payloads cannot provide an owner identity. Live events are
sent only to the frame that owns the call.

OAuth tokens and API keys remain in Main. SDP, audio and transcript content are
not logged. Main WebSocket endpoints are validated before connection and use
the configured desktop network proxy. Unsupported proxy routes fail closed.
The PCM port exists for one prepared call, has bounded frame sizes and credits,
and carries no credentials.

Live and Dictation share a Main-process microphone lease. Local mute gates
capture before the IPC request; Main independently rejects muted or stale
capture epochs. Ending, renderer loss, window hide/navigation/crash, system
suspend/lock, provider change, disable and app quit stop media and close the
adapter. If renderer media release is not confirmed, Main quarantines the
microphone lease instead of reusing it blindly.

## Calls and media

The call state is `preparing → acquiring-mic → negotiating/connecting →
connected → closing → ended|failed`. A request ID makes prepare idempotent and
allows cancellation before a call ID arrives. Every startup, handshake,
heartbeat, interruption acknowledgement and release wait is bounded. There is
one active call per desktop instance; a later call is an explicit user action,
with no automatic provider, model or billing fallback.

Codex Live uses its dedicated Codex OAuth endpoint and WebRTC answer exchange;
its browser data channel only handles normalized protocol events and the
unsupported-delegation response. It does not use public GPT-Live session
events. Gemini Live waits for `setupComplete` before sending 16 kHz mono
PCM16. Realtime waits for `session.updated`, sends 24 kHz mono PCM16, and
selects an explicit GA or compat-v1 wire profile. The supported models and
voices are editable per binding; defaults are candidates, not claims of
account access or service availability.

PCM capture uses an AudioWorklet with the actual `AudioContext.sampleRate`, a
stateful anti-aliasing resampler and bounded 20 ms worklet frames. PCM output is
queued in a separate playback path with per-item played cursors; interruption
advances a playback epoch and drops stale queued audio. If browser playback is
blocked, the call panel offers a user gesture to resume it. Input never loops
back to local speakers.

Mute, barge-in and end are distinct actions. Mute gates only new input and
keeps provider output available. Codex uses its provider-native full-duplex
media behavior; Gemini interruption resets its local output queue; Realtime
uses the played cursor to cancel and truncate its current response. Ending
stops all local tracks, playback and ports before releasing the lease.

## Settings and compatibility

The Voice settings destination exposes only Live Voice: users can bind an
existing compatible Provider, choose the next-call binding, and set model, voice
and Realtime profile. A currently active binding cannot be rewritten while its
call is running. Turning Live Voice off ends the call. Provider credentials stay
in the existing Provider/secret or VendorOAuth systems. Legacy local Dictation
settings and its Composer entry are hidden; existing `voice` values and the
underlying Dictation capability remain unchanged and are not deleted or rewritten
by the UI. Old settings with no `liveVoice` value read as disabled with no
bindings.

Live DTOs and IPC contracts live in `packages/shared`. Pure wire parsing and
PCM math are exported only from `@pi-desktop/voice-runtime/live`; they do not
enter the old local transcription runtime. Electron Main remains an
orchestrator and does not transfer credential or storage ownership.

## Verification and limits

Automated coverage exercises PCM encoding/resampling, provider message
parsing, owner checks, prepare/connect/mute/end, request cancellation,
active-binding write protection, transcript bounds, reject-only delegation,
and mutual exclusion with Dictation. Desktop UI tests and targeted Electron
process tests cover the user path when available. A green fixture suite does
not certify real provider access or account entitlement.

Codex endpoint/model/voice details follow the referenced Piwin snapshot and
are not a public API stability promise. Gemini and OpenAI Realtime require a
compatible model, account and endpoint. Real-account calls, microphone
permission prompts and hardware playback must be reported separately from
automated fixture results; they may incur provider usage and require explicit
user authorization.
