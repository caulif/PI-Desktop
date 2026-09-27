import { createHash } from "node:crypto";
import { IPC } from "@pi-desktop/shared";
import type { McpControlInvokeInput, McpControlOperation } from "./mcp-control";

export const PLUGIN_PROMPT_LOOKUP: McpControlOperation = {
  id: "agent/promptLookup", channel: "internal:plugin-prompt", risk: "read", pluginOnly: true,
  description: "Look up a durable plugin prompt request.", argumentShape: ["{requestIntentId}"],
};

type PromptState = { start?: boolean; status: "not_started" | "unknown" | "accepted" | "rejected";
  turnId?: string | null; sessionId?: string | null; code?: string | null };

export async function invokePluginPrompt(
  input: McpControlInvokeInput,
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  invoke: (channel: string, args: readonly unknown[]) => Promise<unknown>,
): Promise<unknown> {
  const pluginId = input.pluginContext?.pluginId;
  if (input.source !== "plugin" || !pluginId) {
    throw Object.assign(new Error("authenticated plugin context required"), { code: "PERMISSION_DENIED" });
  }
  if (!Array.isArray(input.args) || input.args.length !== 1 || !input.args[0]
      || typeof input.args[0] !== "object" || Array.isArray(input.args[0])) {
    throw Object.assign(new Error("one prompt object required"), { code: "INVALID_PARAMS" });
  }
  const request = input.args[0] as Record<string, unknown>;
  const requestIntentId = request.requestIntentId;
  if (typeof requestIntentId !== "string" || !requestIntentId.trim()
      || requestIntentId.length > 256) {
    throw Object.assign(new Error("requestIntentId required"), { code: "INVALID_PARAMS" });
  }
  if (input.operation === "agent/promptLookup") {
    return call("plugin.promptLookup", { pluginId, requestIntentId });
  }
  if (input.operation !== "agent/prompt" || typeof request.sessionId !== "string"
      || !request.sessionId || typeof request.content !== "string" || !request.content.trim()) {
    throw Object.assign(new Error("sessionId and content required"), { code: "INVALID_PARAMS" });
  }
  // The durable identity covers the exact prompt that reaches Agent IPC.
  const contentHash = createHash("sha256").update(request.content, "utf8").digest("hex");
  const base = { pluginId, requestIntentId };
  const prepared = await call("plugin.promptPrepare", {
    ...base, sessionId: request.sessionId, contentHash,
  }) as PromptState;
  if (!prepared.start) return { status: prepared.status, accepted: prepared.status === "accepted"
    ? true : prepared.status === "rejected" ? false : null,
    turnId: prepared.turnId ?? null, sessionId: prepared.sessionId ?? null,
    code: prepared.code ?? null };
  try {
    const response = await invoke(IPC.invoke.agentPrompt, [{
      sessionId: request.sessionId, content: request.content,
    }]) as { accepted?: boolean; turnId?: string };
    if (response.accepted === true && response.turnId) {
      await call("plugin.promptSettle", { ...base, status: "accepted", turnId: response.turnId });
      return { status: "accepted", accepted: true, turnId: response.turnId,
        sessionId: request.sessionId };
    }
    if (response.accepted === false) {
      await call("plugin.promptSettle", { ...base, status: "rejected", code: "AGENT_REJECTED" });
      return { status: "rejected", accepted: false, turnId: null,
        sessionId: request.sessionId, code: "AGENT_REJECTED" };
    }
    return { status: "unknown", accepted: null, turnId: null, sessionId: request.sessionId };
  } catch (error) {
    const code = (error as { code?: string; errorCode?: string })?.errorCode
      ?? (error as { code?: string; errorCode?: string })?.code;
    if (code === "AGENT_BUSY") {
      await call("plugin.promptSettle", { ...base, status: "rejected", code });
      return { status: "rejected", accepted: false, turnId: null, sessionId: request.sessionId, code };
    }
    // A rejected transport promise can occur after the Agent accepted the turn.
    return { status: "unknown", accepted: null, turnId: null, sessionId: request.sessionId };
  }
}
