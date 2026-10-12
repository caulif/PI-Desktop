#!/usr/bin/env node
/** Real Host transport coverage for the fork's file admission foundation.
 * Admission order/overlap use deterministic Rust queue tests; this harness
 * checks real files, Hashline/register/review integration and cleanup over RPC.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { assert, assertToolSuccess, assertToolFailure, shortJson } from "./e2e/assert.mjs";
import { withScenario } from "./e2e/fixture.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";
import { configureSession, createSession } from "./e2e/session.mjs";
import { waitFor } from "./e2e/wait.mjs";

async function main() {
  const root = await mkdtemp(join(tmpdir(), "pi-file-admission-e2e-"));
  try {
    await withScenario("file-admission", async ({ host, workspace }) => {
      const first = await createSession(host, workspace, "File foundation A");
      const second = await createSession(host, workspace, "File foundation B");
      for (const session of [first, second]) await configureSession(host, session, "agent", "auto");
      let next = 0;
      async function tool(session, toolName, args, extra = {}) {
        const toolCallId = `file-foundation-${next++}`;
        const result = await host.call("tools.execute", {
          sessionId: session.id, toolCallId, toolName, args, mode: "agent", ...extra,
        });
        assertToolSuccess(result, toolCallId);
        return result;
      }
      const write = await tool(first, "Write", { path: "source.txt", content: "alpha\nbeta\n" }, { timeoutMs: 1 });
      assert(write.content.tag, "Write did not create Hashline evidence");
      const read = await tool(first, "Read", { path: "source.txt" });
      const cut = await tool(first, "Edit", { path: "source.txt", tag: read.content.tag, ops: "CUT 1.=1 @saved\n" });
      assert(await readFile(join(workspace, "source.txt"), "utf8") === "beta\n", "register CUT bytes mismatch");
      const target = await tool(first, "Write", { path: "target.txt", content: "tail\n" });
      const pasted = await tool(first, "Edit", { path: "target.txt", tag: target.content.tag, ops: "PUT <1 @saved\n" });
      assert(await readFile(join(workspace, "target.txt"), "utf8") === "alpha\ntail\n", "register paste bytes mismatch");
      const moved = await tool(first, "Edit", { path: "target.txt", tag: pasted.content.tag, ops: "MV moved.txt\n" });
      assert(!existsSync(join(workspace, "target.txt")), "MV source remains");
      assert(await readFile(join(workspace, "moved.txt"), "utf8") === "alpha\ntail\n", "MV destination bytes mismatch");
      const removed = await tool(first, "Edit", { path: "moved.txt", tag: moved.content.tag, ops: "REM\n" });
      assert(!existsSync(join(workspace, "moved.txt")), "REM failed to remove file");
      assert(removed.content.review?.snapshotId, "REM lacks review snapshot: " + shortJson(removed));
      const restored = await host.call("review.rollback", { sessionId: first.id, snapshotId: removed.content.review.snapshotId });
      assert(restored.status === "rolledBack", "REM rollback failed: " + shortJson(restored));
      assert(await readFile(join(workspace, "moved.txt"), "utf8") === "alpha\ntail\n", "REM rollback bytes mismatch");
      // A cross-session stale range edit must retain the existing version guard.
      const stale = await tool(second, "Read", { path: "source.txt" });
      await tool(first, "Edit", { path: "source.txt", tag: cut.content.tag, ops: "PUT 1.=1:\n+changed\n" });
      const rejected = await host.call("tools.execute", {
        sessionId: second.id, toolCallId: "stale-range", toolName: "Edit", mode: "agent",
        args: { path: "source.txt", tag: stale.content.tag, ops: "PUT 1.=1:\n+stale overwrite\n" },
      });
      assertToolFailure(rejected, "EDIT_TAG_MISMATCH");
      assert(await readFile(join(workspace, "source.txt"), "utf8") === "changed\n", "stale edit overwrote file");
      // Independent RPC calls exercise real blocking runners; timing/parallel
      // admission is intentionally not inferred from this functional assertion.
      await Promise.all(Array.from({ length: 8 }, (_, index) => tool(index % 2 ? first : second, "Write", {
        path: `independent-${index}.txt`, content: `file ${index}\n`,
      })));
      for (let index = 0; index < 8; index++) {
        assert(await readFile(join(workspace, `independent-${index}.txt`), "utf8") === `file ${index}\n`, "independent write bytes mismatch");
      }
      await configureSession(host, second, "agent", "ask");
      const pending = host.call("tools.execute", { sessionId: second.id, toolCallId: "cancel-approval", toolName: "Write", args: { path: "cancelled.txt", content: "must not land" }, mode: "agent" }).then((result) => ({ result }), (error) => ({ error }));
      await waitFor(() => host.matchingNotifications("permissions.request", (note) => note.params.toolCallId === "cancel-approval").length === 1, 5_000, "file approval request");
      const beforeCancel = (await host.call("app.health")).toolBudget;
      assert(beforeCancel.active === 0 && beforeCancel.queued === 0, "approval held capacity: " + shortJson(beforeCancel));
      await host.call("tools.abort", { sessionId: second.id, toolCallId: "cancel-approval" });
      const cancelled = await pending;
      if (cancelled.error) throw cancelled.error;
      assertToolFailure(cancelled.result, "TOOL_ABORTED");
      assert(!existsSync(join(workspace, "cancelled.txt")), "cancelled approval wrote bytes");
      const idle = (await host.call("app.health")).toolBudget;
      assert(["active", "queued", "shell", "reads", "mutations", "plugins"].every((key) => idle[key] === 0), "resource capacity leaked: " + shortJson(idle));
      // EOF exercises the real server's shutdown cancellation/drain path for an
      // approval waiter. It is not proof of an admitted blocking-body overlap.
      const stopping = host.call("tools.execute", { sessionId: second.id, toolCallId: "shutdown-approval", toolName: "Write", args: { path: "shutdown.txt", content: "must not land" }, mode: "agent" }).then((result) => ({ result }), (error) => ({ error }));
      await waitFor(() => host.matchingNotifications("permissions.request", (note) => note.params.toolCallId === "shutdown-approval").length === 1, 5_000, "shutdown file approval");
      host.child.stdin.end();
      const exited = await Promise.race([host.exitPromise, new Promise((_, reject) => { setTimeout(() => reject(new Error("graceful EOF shutdown did not drain")), 10_000).unref(); })]);
      await stopping;
      assert(exited.code === 0, "Host graceful shutdown failed: " + shortJson(exited));
      assert(!existsSync(join(workspace, "shutdown.txt")), "shutdown approval wrote bytes");
      console.log("PASS file-resource foundation: real RPC Read/Write/Edit/register/MV/REM/rollback/stale guard/cancel/EOF cleanup");
    }, resolveHostBinary(), root, PROTOCOL_VERSION);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error("FAIL file-resource foundation: " + (error?.stack || String(error))); process.exitCode = 1; });
