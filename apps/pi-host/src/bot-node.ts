import { BOT_NODE_DESKTOP_OPERATIONS } from "@pi-desktop/shared";
import type { RacpHostOperations } from "@pi-desktop/racp";
import type { TrustedPlugin, WebPrincipal } from "./trusted-plugin.js";

const fail = (message: string, errorCode = "PERMISSION_DENIED"): never => {
  throw Object.assign(new Error(message), { code: errorCode, errorCode });
};
type Port = NonNullable<RacpHostOperations["botNode"]>;
type Peer = Parameters<Port["invoke"]>[2];
const forbidden = new Set([
  "pluginId",
  "pluginContext",
  "panelAuthorized",
  "nativeAuthorized",
  "sourceTurnId",
  "sourceSessionId",
  "invocationId",
]);
function rejectAuthority(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectAuthority);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (forbidden.has(key)) fail("Trusted context is not a node argument");
    rejectAuthority(nested);
  }
}

/** Exactly one central bot writer owns callbacks; the node owns native execution. */
export function createBotNodePort(
  plugin: TrustedPlugin,
  log: (message: string) => void,
): Port {
  let peer: Peer | undefined;
  const invocations = new Map<string, string>();
  const events = ["session:turnEnded", "scheduled:pluginDue", "web:consent"];
  const listeners = new Map<string, (payload: unknown) => void>();
  const principal = (p: Peer): WebPrincipal => ({
    userId: "owner",
    deviceId: p.principal.subject,
  });
  const requirePeer = (p: Peer) => {
    if (!peer || peer.connectionId !== p.connectionId || p.isClosed())
      fail("Attach this central writer first", "HOST_DISCONNECTED");
  };
  const release = (connectionId: string) => {
    if (peer?.connectionId !== connectionId) return;
    peer = undefined;
    for (const [event, listener] of listeners)
      plugin.api.events.off(event, listener);
    listeners.clear();
    invocations.clear();
    void plugin.api.agent.unregisterTool("bot_workbench");
  };
  return {
    release,
    async invoke(method, params, p) {
      if (method === "botNode/attach") {
        if (peer && !peer.isClosed() && peer.connectionId !== p.connectionId)
          fail("A central writer is already attached", "CONFLICT");
        release(peer?.connectionId ?? "");
        peer = p;
        await plugin.api.agent.registerTool({
          name: "bot_workbench",
          description: String(params.description),
          schema: params.schema,
          risk: "medium",
          // A remote client cannot declare extra unattended plan-safe actions.
          planSafeActions: [],
          execute: async (args, context) => {
            requirePeer(p);
            if (!context.invocationId)
              fail("Native invocation provenance missing");
            const id = context.invocationId!;
            invocations.set(id, p.connectionId);
            try {
              return await p.request(
                "botNode/toolExecute",
                {
                  args,
                  context: {
                    sessionId: context.sessionId,
                    turnId: context.turnId,
                    mode: context.mode,
                    invocationId: id,
                  },
                },
                30 * 60 * 1000,
              );
            } finally {
              invocations.delete(id);
            }
          },
        });
        for (const event of events) {
          const listener = (payload: unknown) => {
            if (peer !== p || p.isClosed()) return;
            void p
              .request("botNode/event", { event, payload }, 10000)
              .catch(() => log("Bot node event delivery failed: " + event));
          };
          listeners.set(event, listener);
          plugin.api.events.on(event, listener);
        }
        return { attached: true, pluginId: "local.pi-bot", protocol: 1 };
      }
      requirePeer(p);
      const id = params.invocationId;
      if (
        id !== undefined &&
        (typeof id !== "string" || invocations.get(id) !== p.connectionId)
      )
        fail("Invocation is expired or belongs to another connection");
      const operation = async () => {
        const desktop =
          BOT_NODE_DESKTOP_OPERATIONS[
            method as keyof typeof BOT_NODE_DESKTOP_OPERATIONS
          ];
        if (desktop) {
          rejectAuthority(params.args);
          return plugin.api.desktop.invoke({
            operation: desktop,
            args: params.args as unknown[],
            confirm: params.confirm === true,
          });
        }
        switch (method) {
          case "botNode/models":
            return plugin.api.models.list();
          case "botNode/complete":
            return plugin.api.agent.complete(
              params as Parameters<
                TrustedPlugin["api"]["agent"]["complete"]
              >[0],
            );
          case "botNode/navigation":
            return plugin.navigation();
          case "botNode/nativeSession":
            return plugin.nativeSession(String(params.sessionId));
          case "botNode/scheduleAuthorize":
            rejectAuthority(params.definition);
            return plugin.authorizeSchedule(
              params.definition as Record<string, unknown>,
            );
          case "botNode/sessionAdopt":
            return plugin.adoptSession(String(params.sessionId));
          case "botNode/pendingApprovals":
            return plugin.pendingNativeApprovals();
          case "botNode/consents":
            return plugin.pendingConsents();
          case "botNode/consentRespond":
            return (
              plugin.respondConsent(
                principal(p),
                String(params.id),
                String(params.hash),
                params.decision as "approve" | "deny",
              ) ?? { responded: true }
            );
          case "botNode/approvals":
            return plugin.approvals(String(params.sessionId));
          case "botNode/approvalRespond":
            return plugin.respondApproval(
              principal(p),
              params as Parameters<TrustedPlugin["respondApproval"]>[1],
            );
          case "botNode/manualAuthorize":
            return plugin.authorizeManualRoutine(
              params as Parameters<TrustedPlugin["authorizeManualRoutine"]>[0],
            );
          case "botNode/fileReadText":
            return plugin.api.fs.readText(String(params.path));
          case "botNode/fileReadRange": {
            const result = await plugin.api.fs.readRange(
              String(params.path),
              Number(params.offset),
              Number(params.length),
            );
            return {
              base64: Buffer.from(result.bytes).toString("base64"),
              totalSize: result.totalSize,
            };
          }
          case "botNode/fileStat":
            return plugin.api.fs.stat(String(params.path));
          case "botNode/fileList":
            return plugin.api.fs.list(String(params.path));
          case "botNode/fileWriteText":
            await plugin.api.fs.writeText(
              String(params.path),
              String(params.content),
            );
            return { written: true };
          default:
            fail("Unsupported fixed node operation", "UNSUPPORTED");
        }
      };
      return typeof id === "string"
        ? plugin.runAsInvocation(id, operation)
        : plugin.runAsWebUser(principal(p), operation);
    },
  };
}
