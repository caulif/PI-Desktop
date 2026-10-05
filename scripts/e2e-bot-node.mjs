// Protocol-fixture model only: actual Rust, sidecar, RACP, Bot domain and files.
// This proves execution wiring and durable receipts, not real-model quality.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Host } from "./e2e/host.mjs";
import { DatabaseSync } from "node:sqlite";
import {
  FileCredentialStore,
  startPiHost,
  createRemotePluginApi,
  pairBotNode,
} from "../apps/pi-host/dist-bundle/service.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary =
  process.env.PI_DESKTOP_HOST_BIN ??
  join(
    repo,
    ".task-runtime",
    process.platform === "win32"
      ? "pi-desktop-host-core.exe"
      : "pi-desktop-host-core",
  );
const sidecar =
  process.env.PI_HOST_SIDECAR ??
  join(repo, "packages/agent-runtime/dist-bundle/sidecar.js");
const botRoot = process.env.PI_BOT_TEST_ROOT;
if (!botRoot)
  throw new Error("PI_BOT_TEST_ROOT must name the actual pi-bot checkout");
const { createBotRuntime } = await import(
  pathToFileURL(join(botRoot, "release/main.js")).href
);
const manifest = JSON.parse(
  await readFile(join(botRoot, "manifest.json"), "utf8"),
);
const root = await mkdtemp(join(tmpdir(), "pi-real-bot-node-"));
const report = {
  platform: process.platform,
  startedAt: new Date().toISOString(),
  fixture: "local deterministic OpenAI SSE; no paid calls",
  root,
  checks: [],
  providerRequests: 0,
};
report.runtimeHashes={};
for(const [name,file]of Object.entries({core:binary,sidecar,hostModule:join(repo,"apps/pi-host/dist-bundle/service.mjs"),botDomain:join(botRoot,"release/main.js"),gateway:join(botRoot,"release/server/gateway.cjs")}))report.runtimeHashes[name]=createHash("sha256").update(await readFile(file)).digest("hex");
if(process.getuid){report.uid=process.getuid();assert.notEqual(report.uid,0,"Acceptance must run without root privileges");}
const proof =
  "# Actual remote Work\n\nWritten through native Host-approved bot_workbench over authenticated RACP.\n";
let app, second, remote, runtime, gateway, origin, cookie, csrf;
let workToolResults = [];
const server = createServer(async (req, res) => {
  try {
    let text = "";
    for await (const part of req) text += part;
    const input = JSON.parse(text);
    report.providerRequests++;
    if (
      JSON.stringify(
        input.messages.findLast((m) => m.role === "user")?.content,
      ).includes("HOLD_FOR_STOP")
    ) {
      report.heldRequests = (report.heldRequests ?? 0) + 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      await new Promise((done) => res.once("close", done));
      return;
    }
    const lastUser = input.messages.findLastIndex((m) => m.role === "user");
    const results = input.messages
      .slice(lastUser + 1)
      .filter((m) => m.role === "tool" && /^\s*\{/.test(m.content));
    workToolResults = results.map((m) => m.content);
    const base = {
      id: randomUUID(),
      object: "chat.completion.chunk",
      created: 1,
      model: "bot-node-fixture",
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      res.write(
        "data: " +
          JSON.stringify({
            ...base,
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          "\n\n",
      );
    if (!input.tools?.length) {
      send({
        role: "assistant",
        content: "node: these words are literal text",
      });
      send({}, "stop");
    } else if (
      !input.tools.some((t) => t.function.name.endsWith("bot_workbench"))
    ) {
      const name = input.tools.find((t) => t.function.name === "ToolSearch")
        ?.function.name;
      assert.ok(name, "Native scoped tool catalog must offer ToolSearch");
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_search",
            type: "function",
            function: {
              name,
              arguments: JSON.stringify({
                query: "plugin_local_pi_bot_bot_workbench",
              }),
            },
          },
        ],
      });
      send({}, "tool_calls");
    } else if (results.length < 2) {
      let args;
      if (!results.length) {
        report.generatedFiles = (report.generatedFiles ?? 0) + 1;
        args = {
          action: "write_file_artifact",
          title: "Actual RACP proof",
          content: proof,
          relativePath:
            report.generatedFiles === 1
              ? "pi-bot/remote-proof.md"
              : `pi-bot/remote-proof-${report.generatedFiles}.md`,
          artifactKind: "document",
        };
      } else {
        const first = JSON.parse(results[0].content);
        assert.equal(
          first.ok,
          true,
          "Actual file tool refused: " + results[0].content,
        );
        args = {
          action: "record_result",
          resultKind: "result",
          summary:
            "The requested proof file exists on the selected execution node.",
          artifactRefs: [first.data.artifactId + "@" + first.data.revision],
        };
      }
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_" + randomUUID().replaceAll("-", ""),
            type: "function",
            function: {
              name: input.tools.find((t) =>
                t.function.name.endsWith("bot_workbench"),
              ).function.name,
              arguments: JSON.stringify(args),
            },
          },
        ],
      });
      send({}, "tool_calls");
    } else {
      send({
        role: "assistant",
        content: "Proof file generated and exact Work result recorded.",
      });
      send({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  } catch (error) {
    report.fixtureFailure = String(error);
    res.end("data: [DONE]\n\n");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const modelPort = server.address().port;
const record = (name, detail = {}) => {
  report.checks.push({ name, passed: true, ...detail });
  process.stdout.write("PASS " + name + "\n");
};
const config = (name, port = 0) => ({
  dataDir: join(root, name, "host"),
  host: "127.0.0.1",
  port,
  hostCoreBinary: resolve(binary),
  sidecarEntry: resolve(sidecar),
  nodeBinary: process.execPath,
  pair: false,
  pairingLifetimeMs: 600000,
  browseRoot: join(root, name, "workspace"),
  logLevel: "error",
});
async function bootstrap(cfg) {
  await mkdir(cfg.browseRoot, { recursive: true });
  const h = new Host(binary, cfg.dataDir);
  await h.start();
  try {
    const { provider } = await h.call("providers.create", {
      name: "Deterministic protocol fixture",
      type: "custom",
      protocol: "openai",
      baseUrl: `http://127.0.0.1:${modelPort}/v1`,
      authKind: "none",
      apiStyle: "openai-chat",
      models: [
        {
          id: "bot-node-fixture",
          availableForSubagents: true,
          thinkingLevels: ["off"],
        },
      ],
      defaultModelId: "bot-node-fixture",
    });
    return provider.id;
  } finally {
    await h.stop();
  }
}
const cfg = config("node-a");
const cfg2 = config("node-b");
const pluginConfig = (cfg) => ({
  manifest,
  dataDir: join(cfg.dataDir, "plugin-broker"),
  workspaceRoots: [cfg.browseRoot],
});
const user = { userId: "owner", deviceId: "central-fixture-user" };
const request = (path, options = {}) =>
  fetch(origin + path, {
    ...options,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie, "X-CSRF-Token": csrf } : {}),
      ...options.headers,
    },
  });
async function openGateway() {
  const { createGateway } = await import(
    pathToFileURL(join(botRoot, "release/server/gateway.cjs")).href
  );
  const reservation = createServer();
  await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  origin = `http://127.0.0.1:${port}`;
  gateway = createGateway({
    dataDir: join(root, "web-gateway"),
    publicOrigin: origin,
    allowInsecureLoopback: true,
    runtime: {
      invoke: (channel, payload, principal, id) =>
        remote.runAsWebUser(principal, () =>
          runtime.invoke(channel, payload, id),
        ),
      navigation: () => remote.navigation(),
      nativeSession: (id) => remote.nativeSession(id),
      artifactDownload: (id, rev) => runtime.downloadArtifact(id, Number(rev)),
      pendingApprovals: async () => ({
        supported: true,
        approvals: [
          ...(await remote.pendingConsents()).map((x) => ({
            ...x,
            source: "plugin",
          })),
          ...(await remote.pendingNativeApprovals()).map((x) => ({
            ...x,
            source: "native",
          })),
        ],
      }),
      respondApproval: (id, input, principal) =>
        input.source === "native"
          ? remote.respondApproval(principal, {
              id,
              sessionId: input.sessionId,
              revision: input.revision,
              decision: input.decision,
              requestId: input.requestId,
            })
          : remote.respondConsent(
              principal,
              id,
              input.hash,
              input.approved ? "approve" : "deny",
            ),
    },
  });
  await new Promise((done) => gateway.server.listen(port, "127.0.0.1", done));
  const response = await request("/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket: gateway.issuePairingTicket() }),
  });
  assert.equal(response.status, 200);
  cookie = response.headers.get("set-cookie").split(";")[0];
  csrf = (await response.json()).csrfToken;
}
const pendingApprovals = async () => {
  const response = await request("/api/host-approvals");
  assert.equal(response.status, 200);
  return (await response.json()).approvals;
};
async function approveRow(row, revision = row.revision) {
  const response = await request("/api/host-approvals/" + row.id, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      row.source === "native"
        ? {
            source: "native",
            sessionId: row.sessionId,
            revision,
            decision: "allow-once",
            requestId: randomUUID(),
          }
        : {
            source: "plugin",
            hash: row.hash,
            approved: true,
            requestId: randomUUID(),
          },
    ),
  });
  return { status: response.status, value: await response.json() };
}
async function approveUntil(operation) {
  let done = false;
  let error;
  const result = operation()
    .finally(() => (done = true))
    .catch((e) => {
      error = e;
    });
  const deadline = Date.now() + 30000;
  while (!done && Date.now() < deadline) {
    for (const consent of await pendingApprovals())
      if (consent.source === "plugin")
        assert.equal((await approveRow(consent)).status, 200);
    await delay(200);
  }
  assert.ok(done, "Frozen user consent timed out");
  await result;
  if (error) throw error;
  return result;
}
const invoke = async (channel, payload = {}) => {
  const response = await request("/api/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, payload, requestId: randomUUID() }),
  });
  assert.equal(response.status, 200, channel + " HTTP");
  const receipt = await response.json();
  assert.equal(receipt.status, "completed", JSON.stringify(receipt));
  const result = receipt.result;
  assert.equal(result.ok, true, channel + ": " + JSON.stringify(result.error));
  return result.data;
};
try {
  const providerId = await bootstrap(cfg);
  await bootstrap(cfg2);
  app = await startPiHost(cfg, { trustedPlugin: pluginConfig(cfg) });
  second = await startPiHost(cfg2, { trustedPlugin: pluginConfig(cfg2) });
  cfg.port = app.address.port;
  const pairing = await app.issuePairingToken(600000);
  const url = `ws://127.0.0.1:${app.address.port}/v1/racp/ws`;
  const paired = await pairBotNode({
    url,
    pairingToken: pairing.token,
    expectedHostId: app.hostId,
  });
  await assert.rejects(
    () => pairBotNode({ url, pairingToken: pairing.token }),
    /pair|consum|expired|Unauthorized|401/i,
  );
  remote = await createRemotePluginApi({
    url,
    deviceToken: paired.deviceToken,
    hostId: paired.hostId,
    dataDir: join(root, "central-bot-domain"),
    manifest,
  });
  record("two-real-headless-hosts-and-single-use-device-pairing", {
    hostId: paired.hostId,
    otherHostId: second.hostId,
  });
  await assert.rejects(
    () =>
      remote.api.desktop.invoke({ operation: "providers/getSecret", args: [] }),
    /fixed|catalog/i,
  );
  await assert.rejects(
    () =>
      remote.runAsWebUser(user, () =>
        remote.api.desktop.invoke({
          operation: "session/create",
          args: [{ title: "escape", projectPath: cfg2.browseRoot }],
        }),
      ),
    /registered|outside/i,
  );
  const models = await remote.api.models.list();
  const complete = await remote.runAsWebUser(user, () =>
    remote.api.agent.complete({
      modelKey: models[0].key,
      system: "fixture",
      messages: [{ role: "user", content: "node:literal-free-text" }],
      includeSessionContext: false,
    }),
  );
  assert.equal(complete.text, "node: these words are literal text");
  record("fixed-catalog-cross-root-denial-and-real-independent-completion");
  runtime = await createBotRuntime({
    api: remote.api,
    panelOrigin: { kind: "panel", panelId: "pi-bot.web", userId: "owner" },
  });
  await openGateway();
  record("real-http-gateway-single-use-pairing-and-csrf");
  let bot;
  await approveUntil(async () => {
    bot = await invoke("bot.create", {
      name: "Remote fixture companion",
      description: "Actual domain callback",
      workspacePath: cfg.browseRoot,
      providerId,
      modelId: "bot-node-fixture",
      skillRefs: [],
      permissionCeiling: "ask",
      createdByBotId: null,
    });
  });
  assert.ok(bot.binding.sessionId.startsWith("node:" + paired.hostId + ":"));
  assert.throws(
    () =>
      remote.nativeSessionId(
        "node:" +
          second.hostId +
          ":" +
          remote.nativeSessionId(bot.binding.sessionId),
      ),
    /another/i,
  );
  record("qualified-session-bound-to-one-node-and-central-domain", {
    sessionId: bot.binding.sessionId,
  });
  const room = await invoke("conversation.create", {
    kind: "direct",
    title: "Actual remote fixture Work",
    memberBotIds: [bot.bot.botId],
    visibilityRefs: [],
  });
  const conversationId =
    room.conversationId ?? room.conversation?.conversationId;
  const sent = await invoke("conversation.send", {
    conversationId,
    content: "Generate a tiny markdown proof and record its result.",
    requestKey: "node-proof-message",
    addressing: { kind: "direct", botIds: [bot.bot.botId] },
    references: [],
    mentions: [],
    skillRefs: [],
    replyToMessageId: null,
    targetBotId: bot.bot.botId,
  });
  assert.ok(
    sent.turns?.[0]?.work,
    "Expected a durable Work record: " + JSON.stringify(sent),
  );
  const workId = sent.turns[0].work.workId;
  let approved = 0;
  let staleChecked = false;
  let detail;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    for (const approval of (await pendingApprovals()).filter(
      (x) => x.source === "native",
    )) {
      assert.equal(approval.kind, "tool");
      assert.ok(approval.allowedDecisions.includes("allow-once"));
      if (!staleChecked) {
        const stale = await approveRow(approval, approval.revision + 1);
        assert.ok(
          stale.status !== 200 ||
            stale.value?.result?.ok === false ||
            stale.value?.result?.error,
        );
        staleChecked = true;
      }
      const accepted = await approveRow(approval);
      assert.equal(accepted.status, 200);
      approved++;
    }
    detail = await invoke("work.detail", { workId });
    if (
      ["succeeded", "failed", "cancelled", "unverified"].includes(
        detail.work?.state,
      )
    )
      break;
    await delay(250);
  }
  assert.equal(
    detail.work.state,
    "succeeded",
    JSON.stringify({ detail, toolResults: workToolResults }),
  );
  assert.equal(
    await readFile(join(cfg.browseRoot, "pi-bot/remote-proof.md"), "utf8"),
    proof,
  );
  assert.ok(approved >= 2);
  assert.ok(staleChecked);
  const ref = detail.work.result.artifactRefs[0];
  const [artifactId, revision] = ref.split("@");
  const downloaded = await request(
    `/api/artifacts/${artifactId}/download?revision=${revision}`,
  );
  assert.equal(downloaded.status, 200);
  assert.equal(
    createHash("sha256")
      .update(Buffer.from(await downloaded.arrayBuffer()))
      .digest("hex"),
    createHash("sha256").update(proof).digest("hex"),
  );
  record("actual-native-approval-tool-callback-file-artifact-and-work-result", {
    workId,
    approvals: approved,
    artifactId,
    diskSha256:createHash("sha256").update(await readFile(join(cfg.browseRoot,"pi-bot/remote-proof.md"))).digest("hex"),
  });
  const sendMessage = (content) =>
    invoke("conversation.send", {
      conversationId,
      content,
      requestKey: randomUUID(),
      addressing: { kind: "direct", botIds: [bot.bot.botId] },
      references: [],
      mentions: [],
      skillRefs: [],
      replyToMessageId: null,
      targetBotId: bot.bot.botId,
    });
  const held = await sendMessage(
    "HOLD_FOR_STOP: wait until the user cancels this finite fixture turn.",
  );
  const heldId = held.turns[0].work.workId;
  const heldDeadline = Date.now() + 15000;
  while (!report.heldRequests && Date.now() < heldDeadline) await delay(100);
  assert.ok(report.heldRequests);
  const queued = await sendMessage(
    "Generate the next proof after the stopped request.",
  );
  assert.equal(queued.queued.length, 1, JSON.stringify(queued));
  record("actual-http-start-and-durable-queue-while-native-agent-busy", {
    workId: heldId,
    queueId: queued.queued[0].queueId,
  });
  await invoke("conversation.cancelQueue", { conversationId });
  record("actual-http-cancel-durable-queued-message-before-dispatch");
  const active = await invoke("work.detail", { workId: heldId });
  await invoke("work.cancel", {
    workId: heldId,
    expectedRevision: active.work.revision,
    reason: "Finite user stop test",
  });
  const stopDeadline = Date.now() + 15000;
  let stopped;
  while (Date.now() < stopDeadline) {
    stopped = await invoke("work.detail", { workId: heldId });
    if (stopped.work.state === "cancelled") break;
    await delay(200);
  }
  assert.equal(stopped.work.state, "cancelled");
  record("actual-http-stop-aborts-exact-native-work");
  const skill = await invoke("skill.create", {
    title: "Finite remote scheduled proof",
    description: "Fixture method",
    sourceWorkId: workId,
    content:
      "Generate a tiny markdown proof using write_file_artifact and record_result.",
    inputSpec: "No external inputs.",
    outputSpec: "One markdown proof and exact artifact result.",
    failurePolicy: "Report a failed Work; do not invent success.",
    noDataPolicy: "Use the fixed proof body.",
    sourceArtifactId: null,
    sourceArtifactRevision: null,
  });
  const skillRef = `skill:${skill.definition.skillId}@${skill.revision.revision}:${skill.revision.contentHash}`;
  let routine;
  await approveUntil(async () => {
    routine = await invoke("routine.create", {
      title: "Actual remote interval",
      goal: "Generate the remote markdown proof.",
      ownerBotId: bot.bot.botId,
      cadence: "custom",
      hour: null,
      minute: 0,
      weekday: null,
      intervalMinutes: 15,
      skillRef,
      timezone: "UTC",
      resultConversationId: conversationId,
      enabled: true,
    });
  });
  if (routine.scheduleAuthorization)
    await approveUntil(() =>
      remote.runAsWebUser(user, () =>
        remote.authorizeSchedule(
          routine.scheduleAuthorization.definition ??
            routine.scheduleAuthorization,
        ),
      ),
    );
  const binding = await remote.api.desktop.invoke({
    operation: "scheduled/pluginGet",
    args: [{ externalKey: routine.routineId }],
  });
  assert.ok(binding.binding?.schedulerTaskId, JSON.stringify(binding));
  // Isolated test clock injection, never a production schedule or permission bypass.
  const db = new DatabaseSync(join(cfg.dataDir, "pi.sqlite"));
  const changed = db
    .prepare(
      "UPDATE scheduled_tasks SET config_json=json_set(config_json,'$.nextRunAt',CAST(? AS INTEGER)) WHERE id=?",
    )
    .run(Date.now() - 60000, binding.binding.schedulerTaskId);
  db.close();
  assert.equal(Number(changed.changes), 1);
  const beforeDueRequests = report.providerRequests;
  let duePending = [];
  const dueDeadline = Date.now() + 65000;
  // No browser, HTTP request or domain invocation is present while the real node scheduler ticks.
  while (Date.now() < dueDeadline) {
    duePending = await remote.pendingNativeApprovals();
    if (duePending.length) break;
    await delay(500);
  }
  assert.ok(
    duePending.length,
    "Actual scheduled due never reached native approval",
  );
  assert.ok(report.providerRequests > beforeDueRequests);
  record(
    "actual-routine-due-starts-with-browser-absent-and-waits-native-approval",
  );
  let run;
  const finishDue = Date.now() + 90000;
  while (Date.now() < finishDue) {
    for (const row of (await pendingApprovals()).filter(
      (x) => x.source === "native",
    ))
      assert.equal((await approveRow(row)).status, 200);
    const runs = await invoke("routine.runs", { routineId: routine.routineId });
    assert.equal(runs.runs.length, 1, JSON.stringify(runs));
    run = runs.runs[0];
    const status = await invoke("work.detail", { workId: run.rootWorkId });
    if (status.work.state === "succeeded") break;
    assert.ok(
      !["failed", "cancelled", "unverified"].includes(status.work.state),
      JSON.stringify(status),
    );
    await delay(250);
  }
  assert.ok(run);
  assert.equal(
    (await invoke("work.detail", { workId: run.rootWorkId })).work.state,
    "succeeded",
  );
  record("actual-due-remote-tool-result-after-exact-native-approval", {
    routineId: routine.routineId,
    workId: run.rootWorkId,
  });
  const requestsBefore = report.providerRequests;
  await gateway.close();
  gateway = undefined;
  await runtime.shutdown();
  runtime = undefined;
  await remote.stop();
  await app.stop();
  remote = await createRemotePluginApi({
    url,
    deviceToken: paired.deviceToken,
    hostId: paired.hostId,
    allowOfflineStartup: true,
    dataDir: join(root, "central-bot-domain"),
    manifest,
  });
  assert.notEqual(remote.state, "connected");
  await assert.rejects(
    () => remote.api.models.list(),
    /disconnected|offline|connect/i,
  );
  record("actual-cold-offline-node-does-not-dispatch-or-fabricate-models");
  app = await startPiHost(cfg, { trustedPlugin: pluginConfig(cfg) });
  assert.equal(app.hostId, paired.hostId);
  const reconnectDeadline = Date.now() + 15000;
  while (remote.state !== "connected" && Date.now() < reconnectDeadline)
    await delay(100);
  assert.equal(remote.state, "connected");
  record("actual-offline-node-reconnect-pins-original-host-before-ready");
  runtime = await createBotRuntime({
    api: remote.api,
    panelOrigin: { kind: "panel", panelId: "pi-bot.web", userId: "owner" },
  });
  await openGateway();
  const recovered = await invoke("work.detail", { workId });
  assert.equal(recovered.work.state, "succeeded");
  assert.equal(report.providerRequests, requestsBefore);
  await delay(31000);
  const resumedRuns = await invoke("routine.runs", {
    routineId: routine.routineId,
  });
  assert.equal(resumedRuns.runs.length, 1);
  assert.equal(resumedRuns.runs[0].rootWorkId, run.rootWorkId);
  assert.equal(report.providerRequests, requestsBefore);
  record("actual-due-occurrence-once-across-node-central-restart");
  record("node-and-central-restart-preserve-result-without-reexecution");
  await invoke("routine.toggle", {routineId:routine.routineId,enabled:false,expectedRevision:routine.revision});
  const disabledDb=new DatabaseSync(join(cfg.dataDir,"pi.sqlite"));
  const disabledTask=disabledDb.prepare("SELECT enabled FROM scheduled_tasks WHERE id=?").get(binding.binding.schedulerTaskId);assert.equal(disabledTask.enabled,0);
  disabledDb.prepare("UPDATE scheduled_tasks SET config_json=json_set(config_json,'$.nextRunAt',CAST(? AS INTEGER)) WHERE id=?").run(Date.now()-60000,binding.binding.schedulerTaskId);
  const occurrenceCount=()=>disabledDb.prepare("SELECT COUNT(*) AS count FROM plugin_schedule_occurrences WHERE task_id=?").get(binding.binding.schedulerTaskId).count;
  const beforeDisabled=occurrenceCount();await delay(31000);assert.equal(occurrenceCount(),beforeDisabled);disabledDb.close();assert.equal(report.providerRequests,requestsBefore);
  assert.equal((await invoke("routine.runs",{routineId:routine.routineId})).runs.length,1);record("actual-disabled-routine-creates-no-occurrence-after-due-tick");
  await remote.revokeDevice(paired.deviceId);
  await assert.rejects(
    () => remote.api.models.list(),
    /connection|closed|disconnect|revok/i,
  );
  record("active-device-revocation-releases-node-writer");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = { name: error.name, message: error.message };
  throw error;
} finally {
  await gateway?.close();
  await runtime?.shutdown();
  await remote?.stop();
  await app?.stop();
  await second?.stop();
  await new Promise((done) => server.close(done));
  report.finishedAt = new Date().toISOString();
  const target =
    process.env.PI_BOT_NODE_REPORT ??
    join(repo, ".task-runtime", "bot-node-" + process.platform + ".json");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(report, null, 2));
  process.stdout.write("Report: " + target + "\n");
}
