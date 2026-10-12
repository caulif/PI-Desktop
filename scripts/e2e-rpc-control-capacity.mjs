#!/usr/bin/env node
/** Saturate real Host RPC with approval waits; cancellation must stay reachable. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveHostBinary } from "./e2e/host.mjs";
import { withScenario } from "./e2e/fixture.mjs";
import { configureSession, createSession } from "./e2e/session.mjs";
import { waitFor } from "./e2e/wait.mjs";

const tempRoot = await mkdtemp(join(tmpdir(), "pi-rpc-control-"));
try {
  await withScenario("E2E-RPC-CONTROL-CAPACITY", async ({ host, workspace }) => {
    const session = await createSession(host, workspace, "RPC control capacity");
    await configureSession(host, session, "agent", "ask");
    const shell = (await host.call("commandShells.list")).effective;
    assert.ok(shell?.available, "an available command shell is required");
    // Register inactive file work before ordinary RPC slots are exhausted.
    await host.call("tools.prepareFileCall", {
      sessionId: session.id, toolCallId: "prepared-read", toolName: "Read",
      args: { path: "pending.txt" },
    });
    const executions = [];
    const execute = (index) => host.call("tools.execute", {
      sessionId: session.id,
      toolCallId: `approval-${index}`,
      toolName: "Bash",
      args: { command: "echo must-not-execute" },
      expectedCommandShellId: shell.id,
      expectedCommandShellDialect: shell.dialect,
      mode: "agent",
    });
    const refill = async () => {
      host.clearNotifications();
      for (let index = 0; index < 32; index += 1) {
        // Handle failures immediately even if the fixture fails before awaiting
        // settlement. The original promise still reports failures below.
        const pending = execute(index);
        void pending.catch(() => {});
        executions.push(pending);
      }
      await waitFor(() => host.matchingNotifications("permissions.request").length === 32,
        10_000, "all 32 calls to enter approval without consuming tool capacity");
      await assert.rejects(host.call("session.get", { id: session.id }),
        (error) => error.errorCode === "HOST_OVERLOADED");
    };

    await refill();
    assert.equal((await host.call("tools.cancelPreparedFileCalls", {
      sessionId: session.id, toolCallIds: ["prepared-read"],
    }, 5_000)).cancelled, 1);
    // Reject an approval while every ordinary slot remains occupied. No process
    // is launched and no allow-session grant changes subsequent calls.
    const request = host.matchingNotifications("permissions.request")[0];
    assert.equal((await host.call("permissions.resolve", {
      requestId: request.params.requestId, decision: "deny",
    }, 5_000)).ok, true);
    const deniedIndex = Number(request.params.toolCallId.slice("approval-".length));
    assert.equal((await executions[deniedIndex]).denied, true);
    await waitFor(async () => {
      try {
        return Boolean((await host.call("session.get", { id: session.id })).session);
      } catch (error) {
        if (error.errorCode === "HOST_OVERLOADED") return false;
        throw error;
      }
    }, 5_000, "ordinary capacity after denied response");

    // Fill the released slot, then cancel an existing call through the reserved
    // control lane. This is the failure in the former shared 32-slot dispatcher.
    const extra = execute(32);
    void extra.catch(() => {});
    executions.push(extra);
    await waitFor(() => host.matchingNotifications("permissions.request").length === 33,
      5_000, "replacement approval");
    assert.equal((await host.call("tools.abort", {
      sessionId: session.id, toolCallId: "approval-32",
    }, 5_000)).aborted, true);

    // Drain every remaining wait, then prove normal traffic and permission
    // state recover. Sequential control calls stay within their bounded lane.
    for (let index = 0; index < 32; index += 1) {
      if (`approval-${index}` === request.params.toolCallId) continue;
      await host.call("tools.abort", {
        sessionId: session.id, toolCallId: `approval-${index}`,
      }, 5_000);
    }
    const results = await Promise.all(executions);
    assert.equal(results.length, 33);
    assert.ok(results.every((result) => result.isError === true));
    assert.ok((await host.call("session.get", { id: session.id })).session);
    const pending = await host.call("permissions.pending");
    assert.equal(pending.requests.length, 0);
    console.log("PASS E2E-RPC-CONTROL-CAPACITY: 32 approval waits, deny, abort, drain, recovery");
  }, resolveHostBinary(), tempRoot);
} finally {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
