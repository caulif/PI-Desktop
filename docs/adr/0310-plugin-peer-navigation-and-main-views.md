# ADR 0310: Plugin peer navigation and isolated main views

- Status: Accepted for implementation
- Date: 2026-10-04
- Supersedes: none; extends ADR 0104

## Context

Persistent companion conversations need an entry beside Projects rather than a
second application shell inside the work panel. A companion identity is not a
Desktop Session ID, and navigation must not grant execution in another project.
The work-panel compositor already provides bounded, sandboxed plugin surfaces.

## Decision

Add optional `contributes.views[].placement` (`workpanel` by default, or `main`)
and `contributes.sidebarSections`. A section references one declared main view
and a plugin-owned panel-invoke channel returning pure summary items. The host
renders these summaries as peer sections below Projects. No plugin React,
HTML, executable callback, persistence or agent scheduling enters the host tree.

The independent `pluginTarget` navigation route carries plugin/section/item/view
identity. Host Sessions keep their existing IDs and semantics. Navigation history
and durable last-selection identity do not dispatch work; opaque subjects are
reloaded from a fresh permission/scope-filtered provider projection after restart.

Reuse `PluginViewHost` and `PluginViewTab`. Main and work-panel placements use
separate declared view IDs when a plugin wants both surfaces. Only one compositor
view is visible; the existing four-entry LRU and per-plugin partition, sandbox,
egress allowlist, sender attribution, zoom conversion and overlay hiding remain.
`getViewContext()` exposes host-authored placement and latest subject/appearance.
`view:context` publishes activation without reload; `view:open` remains compatible.

Permission/scope is checked before listing, after asynchronous provider completion,
when opening and before showing. The host never switches project scope to satisfy
a navigation request. Dynamic results have count/text/payload bounds and a
two-second UI timeout; at most one request per section remains in flight.
Missing/malformed providers show an unavailable diagnostic.

## Alternatives

Keeping only a work-panel picker preserves old-host compatibility but cannot
provide peer navigation. Importing plugin React into AppShell would remove the
existing trust boundary. Encoding companion IDs into Session IDs would corrupt
the host's routing and execution identity. None meets both UX and isolation needs.

## Consequences

Older manifests remain work-panel views. Plugins targeting older hosts retain
their existing workbench and use capability detection rather than fake sidebars.
Main placement is a navigation capability, not a global permission or session
source. Project-scoped plugins remain scoped; global plugins can publish a global
roster while their execution APIs continue enforcing their original scope.
No Rust protocol, database schema or host-owned history migration is introduced.
