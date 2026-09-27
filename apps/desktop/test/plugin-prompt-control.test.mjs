import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { invokePluginPrompt } = await import("../electron/main/plugin-prompt-control.ts");
const { createMcpControlController } = await import("../electron/main/mcp-control.ts");

const request = { source: "plugin", operation: "agent/prompt",
  pluginContext: { pluginId: "pi-bot" },
  args: [{ sessionId: "session-1", content: "wake", requestIntentId: "wake-1" }] };

test("plugin prompt accepts once and replays the persisted receipt", async () => {
  let record;
  let prompts = 0;
  const call = async (method, params) => {
    if (method === "plugin.promptPrepare") {
      assert.equal(params.pluginId, "pi-bot");
      assert.match(params.contentHash, /^[a-f0-9]{64}$/);
      return record ? { start: false, ...record } : { start: true };
    }
    if (method === "plugin.promptSettle") record = { status: params.status, turnId: params.turnId,
      sessionId: "session-1" };
    return record;
  };
  const invoke = async () => { prompts++; return { accepted: true, turnId: "turn-1" }; };
  assert.deepEqual(await invokePluginPrompt(request, call, invoke),
    { status: "accepted", accepted: true, turnId: "turn-1", sessionId: "session-1" });
  assert.deepEqual(await invokePluginPrompt(request, call, invoke),
    { status: "accepted", accepted: true, turnId: "turn-1", sessionId: "session-1", code: null });
  assert.equal(prompts, 1);
});

test("lost prompt receipt stays unknown and is never dispatched again", async () => {
  let prepared = false;
  let prompts = 0;
  const call = async (method) => {
    if (method === "plugin.promptPrepare") {
      if (prepared) return { start: false, status: "unknown", turnId: null };
      prepared = true;
      return { start: true };
    }
    return { status: "unknown", turnId: null };
  };
  const invoke = async () => { prompts++; throw new Error("reply lost"); };
  assert.equal((await invokePluginPrompt(request, call, invoke)).status, "unknown");
  assert.equal((await invokePluginPrompt(request, call, invoke)).status, "unknown");
  assert.equal(prompts, 1);
});

test("lookup is plugin-only and ordinary plugin prompt routes through the ledger", async () => {
  const seen = [];
  const controller = createMcpControlController({
    channels: { agentPrompt: "agent-prompt-ipc" },
    invoke: async () => { throw new Error("bypassed ledger"); },
    invokePluginPrompt: async (input) => { seen.push(input); return { status: "not_started", turnId: null }; },
  });
  await controller.invoke(request);
  await controller.invoke({ source: "plugin", operation: "agent/promptLookup",
    pluginContext: { pluginId: "pi-bot" }, args: [{ requestIntentId: "wake-1" }] });
  assert.equal(seen.length, 2);
  await controller.invoke({ ...request, args: [{ ...request.args[0], requestIntentId: null }] });
  assert.equal(seen.length, 3);
  await assert.rejects(() => invokePluginPrompt({ ...request, pluginContext: undefined },
    async () => ({}), async () => ({})), /authenticated plugin context/);
  await assert.rejects(() => invokePluginPrompt({ ...request,
    args: [{ ...request.args[0], requestIntentId: null }] },
    async () => ({}), async () => ({})), /requestIntentId required/);
});
