import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { invokePluginVerification } = await import("../electron/main/plugin-verification-control.ts");
const { createMcpControlController } = await import("../electron/main/mcp-control.ts");
const input = { source: "plugin", operation: "verification/approveCheck", pluginContext: { pluginId: "owner" },
  args: [{ sessionId: "session", projectPath: "project", definition: { program: "checker" } }] };

test("native refusal cannot consume approval; granted token never reaches the plugin", async () => {
  const calls = [];
  const check = { digest: "exact", definition: { program: "canonical-checker" } };
  const call = async (method, params) => {
    calls.push({ method, params });
    return method.endsWith("beginApproval") ? { token: "main-only", check } : check;
  };
  await assert.rejects(invokePluginVerification(input, call, async (shown) => {
    assert.deepEqual(shown, check); return false;
  }), (error) => error.code === "PERMISSION_DENIED");
  assert.equal(calls.length, 1);
  const approved = await invokePluginVerification(input, call, async () => true);
  assert.deepEqual(approved, check);
  assert.deepEqual(calls.at(-1), { method: "plugin.verification.approveCheck", params: { token: "main-only" } });
  assert.equal(JSON.stringify(approved).includes("main-only"), false);
});

test("MCP and plugin-authored consent or identity are refused before Host calls", async () => {
  let calls = 0;
  const call = async () => { calls++; };
  await assert.rejects(invokePluginVerification({ ...input, source: "mcp" }, call, async () => true));
  for (const field of ["token", "claimToken", "authorized", "nativeAuthorized", "pluginId"]) {
    await assert.rejects(invokePluginVerification({ ...input, args: [{ ...input.args[0], [field]: true }] }, call, async () => true));
  }
  assert.equal(calls, 0);
});

test("verification catalog is plugin-only and recovery dispatch never starts a check", async () => {
  const controller = createMcpControlController({ channels: {}, invoke: async () => {},
    invokePluginVerification: async (request) => request });
  assert.ok(controller.operations.filter((op) => op.id.startsWith("verification/")).every((op) => op.pluginOnly));
  const calls = [];
  const request = { ...input, operation: "verification/lookupExecution", args: [{ executionId: "execution" }] };
  await invokePluginVerification(request, async (method, params) => { calls.push({ method, params }); return { state: "unknown" }; }, async () => { throw new Error("no consent for lookup"); });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "plugin.verification.lookupExecution");
  assert.equal(calls[0].params.pluginId, "owner");
});
