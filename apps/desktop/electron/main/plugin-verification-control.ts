import type { McpControlInvokeInput, McpControlOperation } from "./mcp-control";

export const PLUGIN_VERIFICATION_OPERATIONS: McpControlOperation[] = [
  { id: "verification/approveCheck", channel: "internal:plugin-verification", risk: "write", pluginOnly: true,
    description: "Request native approval for an exact fixed project check.", argumentShape: ["definition"] },
  ...["snapshot", "lookupExecution", "runApprovedCheck", "cancelExecution", "revokeCheck"].map((name): McpControlOperation => ({
    id: `verification/${name}`, channel: "internal:plugin-verification", risk: name === "snapshot" || name === "lookupExecution" ? "read" : "write",
    pluginOnly: true, description: `Host-owned approved verification: ${name}.`, argumentShape: ["request"],
  })),
];

/** Only trusted Main sees the approval challenge. Plugin arguments cannot supply consent. */
export async function invokePluginVerification(
  input: McpControlInvokeInput,
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  confirm: (check: unknown) => Promise<boolean>,
): Promise<unknown> {
  const pluginId = input.pluginContext?.pluginId;
  if (input.source !== "plugin" || !pluginId) {
    throw Object.assign(new Error("authenticated plugin context required"), { code: "PERMISSION_DENIED" });
  }
  if (!Array.isArray(input.args) || input.args.length !== 1 || !input.args[0] ||
      typeof input.args[0] !== "object" || Array.isArray(input.args[0])) {
    throw Object.assign(new Error("one verification request object required"), { code: "INVALID_PARAMS" });
  }
  const params = input.args[0] as Record<string, unknown>;
  if (["token", "claimToken", "authorized", "nativeAuthorized", "pluginId"].some((key) => Object.hasOwn(params, key))) {
    throw Object.assign(new Error("trusted verification fields are not plugin arguments"), { code: "PERMISSION_DENIED" });
  }
  if (input.operation === "verification/approveCheck") {
    const challenge = await call("plugin.verification.beginApproval", { ...params, pluginId }) as { token: string; check: unknown };
    if (!await confirm(challenge.check)) {
      throw Object.assign(new Error("fixed check approval declined"), { code: "PERMISSION_DENIED" });
    }
    return call("plugin.verification.approveCheck", { token: challenge.token });
  }
  const methods: Record<string, string> = {
    "verification/snapshot": "snapshot", "verification/lookupExecution": "lookupExecution",
    "verification/runApprovedCheck": "runApprovedCheck", "verification/cancelExecution": "cancelExecution",
    "verification/revokeCheck": "revokeCheck",
  };
  const method = methods[input.operation];
  if (!method) throw Object.assign(new Error("unknown verification operation"), { code: "NOT_FOUND" });
  return call(`plugin.verification.${method}`, { ...params, pluginId });
}
