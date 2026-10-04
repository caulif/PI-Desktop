import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { invokePluginPrompt } = await import("../electron/main/plugin-prompt-control.ts");
const { consumePluginPromptAdmission } = await import("../electron/main/trusted-plugin-prompt.ts");
const { createMcpControlController } = await import("../electron/main/mcp-control.ts");

const request = { source: "plugin", operation: "agent/prompt",
  pluginContext: { pluginId: "pi-bot" },
  args: [{ sessionId: "session-1", content: "wake", requestIntentId: "wake-1" }] };

test("plugin can invalidate an intent before Agent IPC receives the prompt", async () => {
  let invoked = false;
  const result = await invokePluginPrompt({ ...request, operation: "agent/promptInvalidate",
    args: [{ requestIntentId: "wake-1" }] }, async (method, params) => {
    assert.equal(method, "plugin.promptInvalidate");
    assert.equal(params.pluginId, "pi-bot");
    return { invalidated: true, turnId: null };
  }, async () => { invoked = true; });
  assert.deepEqual(result, { invalidated: true, turnId: null });
  assert.equal(invoked, false);
});

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

test("plugin admission is bound to the exact in-process request object", async () => {
  let captured;
  const call = async (method, params) => {
    if (method === "plugin.promptPrepare") return { start: true, claimId: "claim-1" };
    if (method === "plugin.promptLookup") return { status: "unknown", turnId: "turn-1",
      sessionId: "session-1", turnStatus: "running" };
  };
  const result = await invokePluginPrompt(request, call, async (_channel, args) => {
    captured = args[0];
    assert.deepEqual(consumePluginPromptAdmission(captured), {
      pluginId: "pi-bot", requestIntentId: "wake-1", claimId: "claim-1",
    });
    assert.equal(consumePluginPromptAdmission(captured), undefined);
    assert.equal(consumePluginPromptAdmission(structuredClone(captured)), undefined);
    throw new Error("reply lost");
  });
  assert.deepEqual(result, { status: "unknown", accepted: null, turnId: "turn-1",
    sessionId: "session-1", turnStatus: "running" });
  assert.deepEqual(captured, { sessionId: "session-1", content: "wake" });
});

test("same-process pre-turn failure revokes its claim before the original intent retries", async () => {
  let released = false;
  let settled = false;
  let attempts = 0;
  const call = async (method, params) => {
    if (method === "plugin.promptPrepare") return settled
      ? { start: false, status: "accepted", turnId: "turn-2", sessionId: "session-1" }
      : { start: true, claimId: released ? "claim-2" : "claim-1" };
    if (method === "plugin.promptLookup") return { status: settled ? "accepted" : "unknown",
      turnId: settled ? "turn-2" : null, sessionId: "session-1" };
    if (method === "plugin.promptReleaseClaim") {
      assert.equal(params.claimId, "claim-1");
      released = true;
      return { released: true };
    }
    if (method === "plugin.promptSettle") settled = true;
  };
  const invoke = async () => {
    attempts++;
    if (attempts === 1) throw new Error("pre-turn launch failed");
    return { accepted: true, turnId: "turn-2" };
  };
  assert.equal((await invokePluginPrompt(request, call, invoke)).status, "unknown");
  assert.equal(released, true);
  assert.equal((await invokePluginPrompt(request, call, invoke)).turnId, "turn-2");
  assert.equal(attempts, 2);
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
  await controller.invoke({ source: "plugin", operation: "agent/promptInvalidate",
    pluginContext: { pluginId: "pi-bot" }, args: [{ requestIntentId: "wake-1" }] });
  assert.equal(seen.length, 3);
  await assert.rejects(() => invokePluginPrompt({ source: "user", operation: "agent/promptInvalidate",
    args: [{ requestIntentId: "wake-1" }] }, async () => ({}), async () => ({})),
  /authenticated plugin context/);
  await controller.invoke({ ...request, args: [{ ...request.args[0], requestIntentId: null }] });
  assert.equal(seen.length, 4);
  await assert.rejects(() => invokePluginPrompt({ ...request, pluginContext: undefined },
    async () => ({}), async () => ({})), /authenticated plugin context/);
  await assert.rejects(() => invokePluginPrompt({ ...request,
    args: [{ ...request.args[0], requestIntentId: null }] },
    async () => ({}), async () => ({})), /requestIntentId required/);
});

test("panel steering is scoped to the exact plugin-owned live turn and replayed by intent", async () => {
  const input = { ...request, operation: "agent/steer",
    pluginContext: { pluginId: "pi-bot", panelAuthorized: true },
    args: [{ sessionId: "session-1", expectedTurnId: "turn-1",
      content: "Add the verified facts", requestIntentId: "follow-up-1" }] };
  const calls = [];
  let settled;
  const call = async (method, params) => {
    calls.push([method, params]);
    if (method === "scheduled.pluginSessionOwnership") return { state: "own" };
    if (method === "plugin.promptPrepare") return settled
      ? { start: false, ...settled } : { start: true };
    if (method === "plugin.promptSettle") settled = { status: params.status,
      turnId: params.turnId, sessionId: "session-1" };
    return settled;
  };
  let steers = 0;
  const invoke = async (channel, args) => {
    steers++;
    assert.equal(args[0].expectedTurnId, "turn-1");
    return { accepted: true, turnId: "turn-1" };
  };
  assert.equal((await invokePluginPrompt(input, call, invoke)).accepted, true);
  assert.equal((await invokePluginPrompt(input, call, invoke)).accepted, true);
  assert.equal(steers, 1);
  assert.equal(calls.filter(([method]) => method === "plugin.promptPrepare").length, 2);

  await assert.rejects(() => invokePluginPrompt({ ...input,
    pluginContext: { pluginId: "pi-bot" } }, call, invoke),
  /panel authorization/);
  await assert.rejects(() => invokePluginPrompt(input,
    async (method) => method === "scheduled.pluginSessionOwnership" ? { state: "other" } : {}, invoke),
  /not owned/);
  const controller = createMcpControlController({ channels: {}, invoke: async () => null,
    invokePluginPrompt: (value) => invokePluginPrompt(value, call, invoke) });
  assert.ok(controller.operations.some((operation) => operation.id === "agent/steer"));
  await assert.rejects(() => controller.invoke({ ...input, source: "mcp" }),
    /authenticated plugin context/);
});

test("steering rejects an ended turn without retrying it", async () => {
  const input = { ...request, operation: "agent/steer",
    pluginContext: { pluginId: "pi-bot", panelAuthorized: true },
    args: [{ sessionId: "session-1", expectedTurnId: "ended",
      content: "late", requestIntentId: "late-1" }] };
  let settles = 0;
  const call = async (method) => {
    if (method === "scheduled.pluginSessionOwnership") return { state: "own" };
    if (method === "plugin.promptPrepare") return { start: true };
    if (method === "plugin.promptSettle") settles++;
  };
  const result = await invokePluginPrompt(input, call, async () => {
    throw Object.assign(new Error("ended"), { errorCode: "TURN_NOT_FOUND" });
  });
  assert.deepEqual(result, { status: "rejected", accepted: false, turnId: null,
    sessionId: "session-1", code: "TURN_NOT_FOUND" });
  assert.equal(settles, 1);
});

test("steering requires a stable bounded intent and binds changed turn or content", async () => {
  const input = { ...request, operation: "agent/steer",
    pluginContext: { pluginId: "pi-bot", panelAuthorized: true },
    args: [{ sessionId: "session-1", expectedTurnId: "turn-1",
      content: "first", requestIntentId: "intent-1" }] };
  let firstHash;
  const call = async (method, params) => {
    if (method === "scheduled.pluginSessionOwnership") return { state: "own" };
    if (method === "plugin.promptPrepare") {
      if (firstHash && firstHash !== params.contentHash) {
        throw Object.assign(new Error("intent changed"), { code: "IDEMPOTENCY_CONFLICT" });
      }
      firstHash = params.contentHash;
      return { start: true };
    }
  };
  await assert.rejects(() => invokePluginPrompt({ ...input,
    args: [{ ...input.args[0], requestIntentId: " " }] }, call, async () => ({})),
  /requestIntentId required/);
  await assert.rejects(() => invokePluginPrompt({ ...input,
    args: [{ ...input.args[0], requestIntentId: "x".repeat(257) }] }, call, async () => ({})),
  /requestIntentId required/);
  await invokePluginPrompt(input, call, async () => ({ accepted: true, turnId: "turn-1" }));
  await assert.rejects(() => invokePluginPrompt({ ...input,
    args: [{ ...input.args[0], content: "changed" }] }, call, async () => ({})),
  /intent changed/);
  await assert.rejects(() => invokePluginPrompt({ ...input,
    args: [{ ...input.args[0], expectedTurnId: "turn-2" }] }, call, async () => ({})),
  /intent changed/);
});
