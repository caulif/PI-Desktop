#!/usr/bin/env node
/** Real Host transport, temporary data, no external provider or global registry. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveHostBinary } from "./e2e/host.mjs";
import { withScenario } from "./e2e/fixture.mjs";
import { configureSession, createSession } from "./e2e/session.mjs";
import { waitFor } from "./e2e/wait.mjs";

const tempRoot = await mkdtemp(join(tmpdir(), "pi-ordered-files-"));
try {
  await withScenario("E2E-ORDERED-FILE-CALLS", async ({ host, workspace, scenarioRoot }) => {
    const session = await createSession(host, workspace, "Ordered files");
    await configureSession(host, session, "agent", "ask");
    const prepare = async (id, toolName, args) => ({
      sessionId: session.id, toolCallId: id, toolName, args, mode: "agent",
      fileAdmissionTicket: (await host.call("tools.prepareFileCall", {
        sessionId: session.id, toolCallId: id, toolName, args,
      })).ticket,
    });
    const queue = async (count) => waitFor(async () => {
      const health = await host.call("app.health");
      return health.toolBudget.queued === count && health.toolBudget.active === 0;
    }, 5_000, `queue=${count}, active=0`);
    const target = join(workspace, "ordered.txt");
    await writeFile(target, "original");
    const first = await prepare("first", "Write", { path: "ordered.txt", content: "first" });
    const second = await prepare("second", "Write", { path: "ordered.txt", content: "second" });
    await queue(2);
    host.clearNotifications();
    // Execute and approve the later call first. Neither can acquire a file
    // until its permission is granted and its earlier conflict is resolved.
    const p2 = host.call("tools.execute", second);
    const p1 = host.call("tools.execute", first);
    void p1.catch(() => {}); void p2.catch(() => {});
    await waitFor(() => host.matchingNotifications("permissions.request").length === 2,
      5_000, "two independent approvals");
    // Claimed tickets stay bound throughout approval and execution, even though
    // they have left the unclaimed-ticket map. A legacy retry must not steal
    // the call ID and run outside the registered order.
    await assert.rejects(host.call("tools.execute", { ...first, fileAdmissionTicket: undefined }),
      e => e.errorCode === "FILE_CALL_TICKET_REQUIRED");
    const requests = host.matchingNotifications("permissions.request");
    const approval = (id) => requests.find((n) => n.params.toolCallId === id).params.requestId;
    await host.call("permissions.resolve", { requestId: approval("second"), decision: "allow-once" });
    await queue(2);
    assert.equal(await readFile(target, "utf8"), "original");
    await host.call("permissions.resolve", { requestId: approval("first"), decision: "allow-once" });
    assert.equal((await p1).ok, true);
    assert.equal((await p2).ok, true);
    assert.equal(await readFile(target, "utf8"), "second");
    await queue(0);
    await assert.rejects(host.call("tools.execute", first), e => e.errorCode === "FILE_CALL_TICKET_INVALID");

    // Register on an absent leaf. The later Read must observe the preceding
    // create even if it enters tools.execute first and the file gains an inode.
    await configureSession(host, session, "agent", "auto");
    const create = await prepare("create", "Write", { path: "created.txt", content: "created-value" });
    const read = await prepare("read-created", "Read", { path: "created.txt" });
    const laterRead = host.call("tools.execute", read);
    assert.equal((await host.call("tools.execute", create)).ok, true);
    const readResult = await laterRead;
    assert.equal(readResult.ok, true, JSON.stringify(readResult));
    assert.match(JSON.stringify(readResult.content), /created-value/);

    const changed = await prepare("changed", "Write", { path: "ordered.txt", content: "bad" });
    await assert.rejects(host.call("tools.execute", { ...changed, args: { path: "other.txt", content: "bad" } }),
      e => e.errorCode === "FILE_CALL_TICKET_MISMATCH");
    await assert.rejects(host.call("tools.execute", { ...changed, fileAdmissionTicket: undefined }),
      e => e.errorCode === "FILE_CALL_TICKET_REQUIRED");
    await host.call("tools.cancelPreparedFileCalls", { sessionId: session.id, toolCallIds: ["changed"] });
    await queue(0);

    // Preparing outside the workspace does not grant access or write content.
    await configureSession(host, session, "agent", "ask");
    const outside = join(scenarioRoot, "outside.txt");
    await writeFile(outside, "outside-original");
    const external = await prepare("outside", "Write", { path: outside, content: "must-not-land" });
    host.clearNotifications();
    const deniedCall = host.call("tools.execute", external);
    await waitFor(() => host.matchingNotifications("permissions.request").length === 1,
      5_000, "external permission after preparation");
    const deniedRequest = host.matchingNotifications("permissions.request")[0].params;
    await host.call("permissions.resolve", { requestId: deniedRequest.requestId, decision: "deny" });
    assert.equal((await deniedCall).denied, true);
    assert.equal(await readFile(outside, "utf8"), "outside-original");
    await queue(0);

    const cancelled = await prepare("cancelled-before-execute", "Read", { path: "ordered.txt" });
    assert.equal((await host.call("tools.abort", { sessionId: session.id, toolCallId: cancelled.toolCallId })).aborted, true);
    await assert.rejects(host.call("tools.execute", cancelled), e => e.errorCode === "FILE_CALL_TICKET_INVALID");
    await queue(0);
    console.log("PASS ordered files: reverse approvals, claimed retry, create/read, binding/replay, external denial, cancel, zero capacity");
  }, resolveHostBinary(), tempRoot);
} finally {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
