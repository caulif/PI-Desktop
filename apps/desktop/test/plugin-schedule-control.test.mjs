import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { invokePluginSchedule } = await import("../electron/main/plugin-schedule-control.ts");

const scheduled = {
  source: "plugin", operation: "scheduled/pluginStart",
  pluginContext: { pluginId: "pi-bot" },
  args: [{ routineId: "r1", requestIntentId: "routine:run-1", sessionId: "bot-session",
    content: "Run the method", trigger: { kind: "schedule", schedulerTaskId: "task-1",
      occurrenceId: "occ-1", scheduledFor: "2026-09-27T00:00:00Z" } }],
};

test("schedule start records one accepted turn and returns replay without a second prompt", async () => {
  const calls = [];
  let prompts = 0;
  const call = async (method, params) => {
    calls.push({ method, params });
    if (method === "scheduled.pluginPrepareStart") {
      return calls.filter((entry) => entry.method === method).length === 1
        ? { start: true } : { start: false, kind: "accepted", turnId: "turn-1" };
    }
    return { kind: "accepted", turnId: "turn-1" };
  };
  const invoke = async () => { prompts += 1; return { accepted: true, turnId: "turn-1" }; };
  const first = await invokePluginSchedule(scheduled, call, invoke, () => false);
  const replay = await invokePluginSchedule(scheduled, call, invoke, () => false);
  assert.deepEqual(first, { accepted: true, turnId: "turn-1", detail: null });
  assert.deepEqual(replay, first);
  assert.equal(prompts, 1);
  assert.equal(calls.find((entry) => entry.method === "scheduled.pluginPrepareStart").params.pluginId, "pi-bot");
});

test("manual start requires a consumed native authorization", async () => {
  const request = structuredClone(scheduled);
  request.args[0].trigger = { kind: "manual", requestIntentId: "click-1" };
  request.args[0].manualToken = "one-time-token";
  await assert.rejects(() => invokePluginSchedule(request, async () => ({ start: true }),
    async () => ({ accepted: true, turnId: "turn-2" }), () => false), /native manual Routine authorization required/);
  let seen;
  await invokePluginSchedule(request, async (method, params) => {
    if (method === "scheduled.pluginPrepareStart") seen = params;
    return { start: true };
  }, async () => ({ accepted: true, turnId: "turn-2" }),
  (pluginId, intentId, token, routineId, sessionId, contentHash) =>
    pluginId === "pi-bot" && intentId === "routine:run-1" && token === "one-time-token" &&
    routineId === "r1" && sessionId === "bot-session" &&
    contentHash === createHash("sha256").update("Run the method").digest("hex"));
  assert.equal(seen.manualAuthorized, true);
  assert.equal("manualToken" in seen, false);
  const expectedHash = createHash("sha256").update("Run the method").digest("hex");
  for (const replacement of [{ routineId: "other" }, { sessionId: "other-session" },
    { content: "Replaced method" }]) {
    const changed = structuredClone(request);
    Object.assign(changed.args[0], replacement);
    await assert.rejects(() => invokePluginSchedule(changed, async () => ({ start: true }),
      async () => ({ accepted: true, turnId: "turn-3" }),
      (_pluginId, _intentId, _token, routineId, sessionId, contentHash) =>
        routineId === "r1" && sessionId === "bot-session" && contentHash === expectedHash),
    /native manual Routine authorization required/);
  }
});

test("failed prompt records unknown intent before surfacing the error", async () => {
  const methods = [];
  await assert.rejects(() => invokePluginSchedule(scheduled,
    async (method) => { methods.push(method); return { start: true }; },
    async () => { throw new Error("transport lost"); }, () => false), /transport lost/);
  assert.deepEqual(methods, ["scheduled.pluginPrepareStart", "scheduled.pluginRecordStart"]);
});

test("known busy admission is rejected with a stable code", async () => {
  const methods = [];
  const result = await invokePluginSchedule(scheduled,
    async (method) => { methods.push(method); return { start: true }; },
    async () => { throw Object.assign(new Error("session busy"), { errorCode: "AGENT_BUSY" }); },
    () => false);
  assert.deepEqual(result, { accepted: false, turnId: null, detail: "Agent session is busy", code: "AGENT_BUSY" });
  assert.deepEqual(methods, ["scheduled.pluginPrepareStart", "scheduled.pluginRecordRejected"]);
});

test("unclassified explicit rejection is permanent and recorded", async () => {
  const methods = [];
  const result = await invokePluginSchedule(scheduled,
    async (method) => { methods.push(method); return { start: true }; },
    async () => ({ accepted: false }), () => false);
  assert.equal(result.code, "AGENT_REJECTED");
  assert.deepEqual(methods, ["scheduled.pluginPrepareStart", "scheduled.pluginRecordRejected"]);
});

test("retry operation takes plugin identity from the runtime", async () => {
  let captured;
  const request = { source: "plugin", operation: "scheduled/pluginRetry",
    pluginContext: { pluginId: "pi-bot" }, args: [{ ...scheduled.args[0].trigger,
      definitionRevision: 1, requestIntentId: "retry-1", reason: "owner_busy", pluginId: "forged" }] };
  await invokePluginSchedule(request, async (method, params) => {
    captured = { method, params }; return { state: "deferred" };
  }, async () => undefined, () => false);
  assert.equal(captured.method, "scheduled.pluginRetry");
  assert.equal(captured.params.pluginId, "pi-bot");
});

test("schedule authorization comes only from the native panel path", async () => {
  const request = { source: "plugin", operation: "scheduled/pluginUpsert",
    pluginContext: { pluginId: "pi-bot" }, args: [{ externalKey: "r1", nativeAuthorized: true }] };
  let passed;
  await invokePluginSchedule(request, async (_method, params) => { passed = params; return {}; },
    async () => undefined, () => false);
  assert.equal(passed.nativeAuthorized, false);
  request.pluginContext.panelAuthorized = true;
  await invokePluginSchedule(request, async (_method, params) => { passed = params; return {}; },
    async () => undefined, () => false);
  assert.equal(passed.nativeAuthorized, true);
  assert.equal(passed.pluginId, "pi-bot");
});

test("legacy session adoption requires a host-authenticated panel consent", async () => {
  const request = { source: "plugin", operation: "scheduled/pluginAdoptSession",
    pluginContext: { pluginId: "pi-bot" }, args: [{ sessionId: "legacy-bot" }] };
  await assert.rejects(() => invokePluginSchedule(request, async () => ({ ok: true }),
    async () => undefined, () => false), /native consent required/);
  request.pluginContext.panelAuthorized = true;
  let captured;
  await invokePluginSchedule(request, async (method, params) => {
    captured = { method, params }; return { ok: true };
  }, async () => undefined, () => false);
  assert.equal(captured.method, "scheduled.pluginRegisterCreatedSession");
  assert.deepEqual(captured.params, { sessionId: "legacy-bot", pluginId: "pi-bot" });
});
