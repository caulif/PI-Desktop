import { createHash, randomUUID } from "node:crypto";
import { IPC } from "@pi-desktop/shared";
import type { McpControlInvokeInput, McpControlOperation } from "./plugin-control-types.js";
import { trustedPluginPromptRequest } from "./trusted-plugin-prompt.js";

const processEpoch = randomUUID();

export const PLUGIN_PROMPT_LOOKUP: McpControlOperation = {
  id: "agent/promptLookup", channel: "internal:plugin-prompt", risk: "read", pluginOnly: true,
  description: "Look up a durable plugin prompt request.", argumentShape: ["{requestIntentId}"],
};

export const PLUGIN_PROMPT_INVALIDATE: McpControlOperation = {
  id: "agent/promptInvalidate", channel: "internal:plugin-prompt", risk: "write", pluginOnly: true,
  description: "Invalidate a plugin prompt whose source request changed before the turn started.",
  argumentShape: ["{requestIntentId}"],
};

export const PLUGIN_STEER: McpControlOperation = {
  id: "agent/steer", channel: "internal:plugin-prompt", risk: "write", pluginOnly: true,
  description: "Steer a live turn in a session owned by this plugin from its panel.",
  argumentShape: ["{sessionId, expectedTurnId, content, requestIntentId}"],
};

type PromptState = { start?: boolean; status: "not_started" | "unknown" | "accepted" | "rejected";
  turnId?: string | null; sessionId?: string | null; code?: string | null;
  claimId?: string; turnStatus?: string | null };

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
  if (input.operation === "agent/promptInvalidate") {
    return call("plugin.promptInvalidate", { pluginId, requestIntentId });
  }
  if (input.operation === "agent/steer") {
    const sessionId = request.sessionId;
    const expectedTurnId = request.expectedTurnId;
    const content = request.content;
    // panelAuthorized comes only from the live-panel main-process origin
    // validator. Plugin arguments cannot provide this authorization.
    if (input.pluginContext?.panelAuthorized !== true || typeof sessionId !== "string" ||
        !sessionId.trim() || sessionId.length > 256 || typeof expectedTurnId !== "string" ||
        !expectedTurnId.trim() || expectedTurnId.length > 256 ||
        typeof content !== "string" || !content.trim() || content.length > 16_384) {
      throw Object.assign(new Error("panel authorization, sessionId, expectedTurnId and content required"),
        { code: "PERMISSION_DENIED" });
    }
    const ownership = await call("scheduled.pluginSessionOwnership", { pluginId, sessionId }) as { state?: string };
    if (ownership.state !== "own") {
      throw Object.assign(new Error("target session is not owned by this plugin"), { code: "PERMISSION_DENIED" });
    }
    const steerIntentId = `steer:${requestIntentId}`;
    const contentHash = createHash("sha256").update(`${expectedTurnId}\0${content}`, "utf8").digest("hex");
    const base = { pluginId, requestIntentId: steerIntentId };
    const prepared = await call("plugin.promptPrepare", { ...base, sessionId, contentHash }) as PromptState;
    if (!prepared.start) return { status: prepared.status, accepted: prepared.status === "accepted"
      ? true : prepared.status === "rejected" ? false : null,
      turnId: prepared.turnId ?? null, sessionId: prepared.sessionId ?? null,
      code: prepared.code ?? null };
    try {
      const response = await invoke(IPC.invoke.agentSteer,
        [{ sessionId, expectedTurnId, content }]) as { accepted?: boolean; turnId?: string };
      if (response.accepted === true && response.turnId === expectedTurnId) {
        await call("plugin.promptSettle", { ...base, status: "accepted", turnId: expectedTurnId });
        return { status: "accepted", accepted: true, turnId: expectedTurnId, sessionId };
      }
      await call("plugin.promptSettle", { ...base, status: "rejected", code: "TURN_NOT_FOUND" });
      return { status: "rejected", accepted: false, turnId: null, sessionId, code: "TURN_NOT_FOUND" };
    } catch (error) {
      const code = (error as { code?: string; errorCode?: string })?.errorCode
        ?? (error as { code?: string; errorCode?: string })?.code;
      if (code === "TURN_NOT_FOUND") {
        await call("plugin.promptSettle", { ...base, status: "rejected", code });
        return { status: "rejected", accepted: false, turnId: null, sessionId, code };
      }
      return { status: "unknown", accepted: null, turnId: null, sessionId };
    }
  }
  if (input.operation !== "agent/prompt" || typeof request.sessionId !== "string"
      || !request.sessionId || typeof request.content !== "string" || !request.content.trim()) {
    throw Object.assign(new Error("sessionId and content required"), { code: "INVALID_PARAMS" });
  }
  // The durable identity covers the exact prompt that reaches Agent IPC.
  const contentHash = createHash("sha256").update(request.content, "utf8").digest("hex");
  const base = { pluginId, requestIntentId };
  const prepared = await call("plugin.promptPrepare", {
    ...base, sessionId: request.sessionId, contentHash, processEpoch,
  }) as PromptState;
  if (!prepared.start) return { status: prepared.status, accepted: prepared.status === "accepted"
    ? true : prepared.status === "rejected" ? false : null,
    turnId: prepared.turnId ?? null, sessionId: prepared.sessionId ?? null,
    code: prepared.code ?? null,
    ...(prepared.turnStatus != null ? { turnStatus: prepared.turnStatus } : {}) };
  try {
    const promptRequest = trustedPluginPromptRequest({
      sessionId: request.sessionId, content: request.content,
    }, { ...base, claimId: prepared.claimId ?? "" });
    const response = await invoke(IPC.invoke.agentPrompt, [promptRequest]) as { accepted?: boolean; turnId?: string };
    if (response.accepted === true && response.turnId) {
      await call("plugin.promptSettle", { ...base, status: "accepted", turnId: response.turnId });
      return { status: "accepted", accepted: true, turnId: response.turnId,
        sessionId: request.sessionId };
    }
    if (response.accepted === false) {
      const settled = await call("plugin.promptSettle", { ...base, status: "rejected",
        code: "AGENT_REJECTED" }) as PromptState;
      return { status: "rejected", accepted: false, turnId: settled.turnId ?? null,
        sessionId: request.sessionId, code: "AGENT_REJECTED" };
    }
    const state = await call("plugin.promptLookup", base) as PromptState;
    return { status: state.status, accepted: null, turnId: state.turnId ?? null,
      sessionId: request.sessionId, turnStatus: state.turnStatus ?? null };
  } catch (error) {
    const code = (error as { code?: string; errorCode?: string })?.errorCode
      ?? (error as { code?: string; errorCode?: string })?.code;
    if (code === "AGENT_BUSY") {
      await call("plugin.promptSettle", { ...base, status: "rejected", code });
      return { status: "rejected", accepted: false, turnId: null, sessionId: request.sessionId, code };
    }
    // A rejected transport promise can occur after the Agent accepted the turn.
    let state = await call("plugin.promptLookup", base) as PromptState;
    if (state.status === "unknown" && !state.turnId && prepared.claimId) {
      // Host revokes the old claim only while no turn is bound. A delayed
      // beginTurn with that claim then fails instead of racing the retry.
      try {
        await call("plugin.promptReleaseClaim", { ...base, claimId: prepared.claimId });
      } catch (releaseError) {
        state = await call("plugin.promptLookup", base) as PromptState;
        if (!state.turnId) throw releaseError;
      }
      state = await call("plugin.promptLookup", base) as PromptState;
    }
    return { status: state.status, accepted: state.status === "accepted" ? true : null,
      turnId: state.turnId ?? null, sessionId: request.sessionId,
      turnStatus: state.turnStatus ?? null };
  }
}
