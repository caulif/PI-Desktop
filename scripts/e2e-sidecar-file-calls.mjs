#!/usr/bin/env node
/** Real ParentHostProxy -> AgentSidecar -> Host; no model or production data. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSidecar } from "../packages/host-runtime/dist/agent-sidecar.js";
import { resolveHostBinary } from "./e2e/host.mjs";
import { withScenario } from "./e2e/fixture.mjs";
import { configureSession, createSession } from "./e2e/session.mjs";
import { waitFor } from "./e2e/wait.mjs";

const proxyModule = new URL("../packages/agent-runtime/dist/parent-host-proxy.js", import.meta.url).href;
const child = `import {ParentHostProxy} from ${JSON.stringify(proxyModule)};
import {createInterface} from 'node:readline';
const host=new ParentHostProxy();
createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line); if(host.handleParentMessage(m))return;
 if(m.method!=='probe')return;
 try {const result=await host.call(m.params.method,m.params.params);
 console.log(JSON.stringify({id:m.id,result}));}
 catch(e){console.log(JSON.stringify({id:m.id,error:{code:e.code??-32000,message:e.message,data:e.data}}));}
});`;
const root = await mkdtemp(join(tmpdir(), "pi-sidecar-files-"));
try {
  await withScenario("E2E-SIDECAR-FILE-CALLS", async ({ host, workspace, scenarioRoot }) => {
    const sidecar = new AgentSidecar({
      launch: { command: process.execPath, args: ["--input-type=module", "-e", child] },
      onStderr: (text) => process.stderr.write(text),
    });
    sidecar.setHost({
      call: (method, params) => host.call(method, params),
      onNotification: () => () => {},
      onExit: () => () => {},
    });
    const proxy = (method, params) => sidecar.call("probe", { method, params });
    try {
      const session = await createSession(host, workspace, "Sidecar file calls");
      await configureSession(host, session, "agent", "auto");
      const prepare = async (toolCallId, toolName, args) => ({
        sessionId: session.id, toolCallId, toolName, args, mode: "agent",
        fileAdmissionTicket: (await proxy("tools.prepareFileCall", {
          sessionId: session.id, toolCallId, toolName, args,
        })).ticket,
      });
      const cancel = (toolCallIds) => proxy("tools.cancelPreparedFileCalls", { sessionId: session.id, toolCallIds });
      const emptyBudget = () => waitFor(async () => {
        const { toolBudget } = await host.call("app.health");
        return toolBudget.active === 0 && toolBudget.queued === 0;
      }, 5_000, "file calls released all capacity");

      // Register before execution and enter Read first: Host must preserve the
      // earlier Write even through both stdio hops and an absent target file.
      const write = await prepare("write", "Write", { path: "created.txt", content: "sidecar-value" });
      const read = await prepare("read", "Read", { path: "created.txt" });
      const reading = proxy("tools.execute", read);
      void reading.catch(() => {});
      assert.equal((await proxy("tools.execute", write)).ok, true);
      assert.match(JSON.stringify((await reading).content), /sidecar-value/);
      assert.equal(await readFile(join(workspace, "created.txt"), "utf8"), "sidecar-value");
      await assert.rejects(proxy("tools.execute", write), { errorCode: "FILE_CALL_TICKET_INVALID" });

      const unused = await prepare("unused", "Read", { path: "created.txt" });
      const other = await createSession(host, workspace, "Other cancellation owner");
      assert.equal((await proxy("tools.cancelPreparedFileCalls", {
        sessionId: other.id, toolCallIds: ["unused"],
      })).cancelled, 0);
      assert.equal((await cancel(["unused"])).cancelled, 1);
      await assert.rejects(proxy("tools.execute", unused), { errorCode: "FILE_CALL_TICKET_INVALID" });
      const changed = await prepare("changed", "Write", { path: "created.txt", content: "bad" });
      await assert.rejects(proxy("tools.execute", { ...changed, args: { path: "other.txt", content: "bad" } }),
        { errorCode: "FILE_CALL_TICKET_MISMATCH" });
      await cancel(["changed"]);
      await emptyBudget();

      const plan = await createSession(host, workspace, "Plan admission", "plan");
      await assert.rejects(proxy("tools.prepareFileCall", {
        sessionId: plan.id, toolCallId: "plan-write", toolName: "Write",
        args: { path: "plan.txt", content: "must-not-land" },
      }), { errorCode: "TOOL_DENIED" });

      // Preparation must not become an external file permission grant.
      await configureSession(host, session, "agent", "ask");
      const outside = join(scenarioRoot, "outside.txt");
      await writeFile(outside, "original");
      const external = await prepare("outside", "Write", { path: outside, content: "must-not-land" });
      host.clearNotifications();
      const executing = proxy("tools.execute", external);
      void executing.catch(() => {});
      await waitFor(() => host.matchingNotifications("permissions.request").length === 1,
        5_000, "external path still requires Host approval");
      const request = host.matchingNotifications("permissions.request")[0].params;
      await host.call("permissions.resolve", { requestId: request.requestId, decision: "deny" });
      assert.equal((await executing).denied, true);
      assert.equal(await readFile(outside, "utf8"), "original");
      await emptyBudget();

      await assert.rejects(proxy("secrets.getForRuntime", { secretRef: "must-not-reach-host" }), { code: -32601 });
      console.log("PASS sidecar file calls: ordered create/read, owner-scoped cancel, replay/mismatch, Plan/external denial, fail-closed allowlist");
    } finally {
      await sidecar.dispose();
    }
  }, resolveHostBinary(), root);
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
