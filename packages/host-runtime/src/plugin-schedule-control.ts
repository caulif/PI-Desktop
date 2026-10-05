import type { McpControlInvokeInput, McpControlOperation } from "./plugin-control-types.js";
import { IPC } from "@pi-desktop/shared";
import { createHash } from "node:crypto";

export const PLUGIN_SCHEDULE_OPERATIONS: McpControlOperation[] = [
  { id: "scheduled/pluginUpsert", channel: "internal:plugin-schedule", risk: "write", pluginOnly: true,
    description: "Register or update a schedule owned by this plugin.", argumentShape: ["definition"] },
  { id: "scheduled/pluginGet", channel: "internal:plugin-schedule", risk: "read", pluginOnly: true,
    description: "Read this plugin's schedule binding and occurrences.", argumentShape: ["{externalKey}"] },
  { id: "scheduled/pluginDisable", channel: "internal:plugin-schedule", risk: "write", pluginOnly: true,
    description: "Disable this plugin's schedule.", argumentShape: ["{externalKey}"] },
  { id: "scheduled/pluginStart", channel: "internal:plugin-schedule", risk: "write", pluginOnly: true,
    description: "Start a verified occurrence in this plugin's session.", argumentShape: ["request"] },
  { id: "scheduled/pluginLookup", channel: "internal:plugin-schedule", risk: "read", pluginOnly: true,
    description: "Look up a stable automatic turn intent.", argumentShape: ["{requestIntentId}"] },
  { id: "scheduled/pluginAdoptSession", channel: "internal:plugin-schedule", risk: "write", pluginOnly: true,
    description: "Register a legacy Bot session after native user consent.", argumentShape: ["{sessionId}"] },
  { id: "scheduled/pluginSessionOwner", channel: "internal:plugin-schedule", risk: "read", pluginOnly: true,
    description: "Check whether this plugin owns a Bot session.", argumentShape: ["{sessionId}"] },
  { id: "scheduled/pluginSkip", channel: "internal:plugin-schedule", risk: "write", pluginOnly: true,
    description: "Skip one exact owned occurrence with a reason.", argumentShape: ["{schedulerTaskId,occurrenceId,scheduledFor,definitionRevision,reason}"] },
  { id: "scheduled/pluginRetry", channel: "internal:plugin-schedule", risk: "write", pluginOnly: true,
    description: "Defer one exact owned occurrence with an idempotent retry intent.", argumentShape: ["{schedulerTaskId,occurrenceId,scheduledFor,definitionRevision,requestIntentId,reason}"] },
];

const METHODS: Readonly<Record<string, string>> = {
  "scheduled/pluginUpsert": "scheduled.pluginUpsert",
  "scheduled/pluginGet": "scheduled.pluginGet",
  "scheduled/pluginDisable": "scheduled.pluginDisable",
  "scheduled/pluginLookup": "scheduled.pluginLookupStart",
  "scheduled/pluginAdoptSession": "scheduled.pluginRegisterCreatedSession",
  "scheduled/pluginSessionOwner": "scheduled.pluginSessionOwnership",
  "scheduled/pluginSkip": "scheduled.pluginSkip",
  "scheduled/pluginRetry": "scheduled.pluginRetry",
};

/** The caller's plugin identity is copied from PluginRuntime, never from args. */
export async function invokePluginSchedule(
  input: McpControlInvokeInput,
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  invoke: (channel: string, args: readonly unknown[]) => Promise<unknown>,
  consumeManualAuthorization: (pluginId: string, requestIntentId: string, token: string,
    routineId: string, sessionId: string, contentHash: string) => boolean,
): Promise<unknown> {
  const pluginId = input.pluginContext?.pluginId;
  if (input.source !== "plugin" || !pluginId) {
    throw Object.assign(new Error("authenticated plugin context required"), { code: "PERMISSION_DENIED" });
  }
  const method = METHODS[input.operation];
  if (!method && input.operation !== "scheduled/pluginStart") {
    throw Object.assign(new Error("unknown plugin schedule operation"), { code: "NOT_FOUND" });
  }
  const args = input.args;
  if (!Array.isArray(args) || args.length !== 1 || !args[0] || typeof args[0] !== "object" || Array.isArray(args[0])) {
    throw Object.assign(new Error("one schedule object required"), { code: "INVALID_PARAMS" });
  }
  const params = args[0] as Record<string, unknown>;
  if (input.operation === "scheduled/pluginUpsert") {
    return call(method, { ...params, pluginId,
      nativeAuthorized: input.pluginContext?.panelAuthorized === true });
  }
  if (input.operation === "scheduled/pluginAdoptSession" && input.pluginContext?.panelAuthorized !== true) {
    throw Object.assign(new Error("native consent required to adopt an existing session"), { code: "PERMISSION_DENIED" });
  }
  if (input.operation === "scheduled/pluginStart") {
    const trigger = params.trigger as { kind?: string } | undefined;
    let manualAuthorized = false;
    if (trigger?.kind === "manual") {
      const content = params.content;
      if (typeof content !== "string" || content.length === 0) {
        throw Object.assign(new Error("manual Routine content required"), { code: "INVALID_PARAMS" });
      }
      const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
      manualAuthorized = consumeManualAuthorization(pluginId, String(params.requestIntentId ?? ""),
        String(params.manualToken ?? ""), String(params.routineId ?? ""),
        String(params.sessionId ?? ""), contentHash);
      if (!manualAuthorized) {
        throw Object.assign(new Error("native manual Routine authorization required"), { code: "PERMISSION_DENIED" });
      }
    }
    const { manualToken: _manualToken, ...request } = params;
    const prepared = await call("scheduled.pluginPrepareStart", { ...request, pluginId, manualAuthorized }) as {
      start?: boolean; kind?: string; turnId?: string | null; code?: string | null;
    };
    if (!prepared.start) {
      return prepared.kind === "accepted"
        ? { accepted: true, turnId: prepared.turnId ?? null, detail: null }
        : prepared.kind === "rejected"
          ? { accepted: false, turnId: null, detail: "Agent did not accept the turn", code: prepared.code ?? "AGENT_REJECTED" }
        : { accepted: null, turnId: null, detail: "host outcome unknown" };
    }
    const requestIntentId = params.requestIntentId as string;
    let result: { accepted?: boolean; turnId?: string };
    try {
      result = await invoke(IPC.invoke.agentPrompt, [{
        sessionId: params.sessionId, content: params.content,
      }]) as { accepted?: boolean; turnId?: string };
    } catch (error) {
      const admissionCode = (error as { errorCode?: string; code?: string })?.errorCode
        ?? (error as { errorCode?: string; code?: string })?.code;
      if (admissionCode === "AGENT_BUSY") {
        await call("scheduled.pluginRecordRejected", { pluginId, requestIntentId, code: "AGENT_BUSY" });
        return { accepted: false, turnId: null, detail: "Agent session is busy", code: "AGENT_BUSY" };
      }
      try {
        await call("scheduled.pluginRecordStart", { pluginId, requestIntentId });
      } catch (recordError) {
        throw new AggregateError([error, recordError], "Automatic prompt failed and host outcome could not be recorded");
      }
      throw error;
    }
    if (result.accepted === false) {
      await call("scheduled.pluginRecordRejected", { pluginId, requestIntentId, code: "AGENT_REJECTED" });
      return { accepted: false, turnId: null, detail: "Agent did not accept the turn", code: "AGENT_REJECTED" };
    }
    if (!result.accepted || !result.turnId) {
      await call("scheduled.pluginRecordStart", { pluginId, requestIntentId });
      return { accepted: null, turnId: null, detail: "Agent prompt acceptance was not confirmed" };
    }
    await call("scheduled.pluginRecordStart", { pluginId, requestIntentId, turnId: result.turnId });
    return { accepted: true, turnId: result.turnId, detail: null };
  }
  return call(method, { ...params, pluginId });
}
