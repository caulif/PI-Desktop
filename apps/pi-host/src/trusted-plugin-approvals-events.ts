import type { AgentHost } from "@pi-desktop/agent-host";
import type { TrustedPluginDeps } from "./trusted-plugin-contracts.js";

type Dependencies = Pick<TrustedPluginDeps, "getHost" | "log"> & {
  agentHost: Pick<AgentHost, "onSessionEvent">;
  pluginId: string;
  emit: (event: "host.changed", payload: { sessionId: string; reason: "approvals" }) => void;
};

/** Native events only invalidate the authenticated broker's approval snapshot. */
export function subscribeNativeApprovalChanges(deps: Dependencies): () => void {
  let stopped = false;
  const expiry = new Map<string, ReturnType<typeof setTimeout>>();
  const refresh = async (sessionId: string) => {
    if (stopped) return false;
    const currentHost = deps.getHost();
    if (!currentHost) return false;
    const ownership = await currentHost.call<{ state: string }>(
      "scheduled.pluginSessionOwnership", { pluginId: deps.pluginId, sessionId },
    );
    if (stopped || deps.getHost() !== currentHost || ownership.state !== "own") return false;
    // Never forward raw approval contents or turn provenance as Web authority.
    deps.emit("host.changed", { sessionId, reason: "approvals" });
    return true;
  };
  let events = Promise.resolve();
  const detach = deps.agentHost.onSessionEvent((event) => {
    if (stopped || !event.sessionId ||
      !["approval.requested", "approval.resolved"].includes(event.kind)) return;
    events = events.then(async () => {
      if (stopped) return;
      const payload = event.payload as { id?: string; approvalId?: string; expiresAt?: string };
      const id = payload.id ?? payload.approvalId;
      if (id) { clearTimeout(expiry.get(id)); expiry.delete(id); }
      if (!await refresh(event.sessionId!) || stopped) return;
      if (event.kind !== "approval.requested" || !id || !payload.expiresAt) return;
      const remaining = Date.parse(payload.expiresAt) - Date.now();
      if (!Number.isFinite(remaining) || remaining < 0) return;
      const timer = setTimeout(() => {
        expiry.delete(id);
        void refresh(event.sessionId!).catch(() => deps.log("warn", "Native approval expiry refresh failed"));
      }, Math.min(remaining + 1, 2_147_483_647));
      timer.unref();
      expiry.set(id, timer);
    }).catch(() => deps.log("warn", "Native approval refresh failed"));
  });
  return () => {
    if (stopped) return;
    stopped = true;
    detach();
    for (const timer of expiry.values()) clearTimeout(timer);
    expiry.clear();
  };
}
