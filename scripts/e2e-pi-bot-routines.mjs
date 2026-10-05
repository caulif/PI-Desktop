#!/usr/bin/env node
// Real Electron/plugin/Host integration with an isolated profile and a local model.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { resolveElectronBinary } from "./e2e/boot.mjs";
import { waitFor } from "./e2e/wait.mjs";

const pluginPath = resolve(process.env.PI_BOT_RELEASE ?? "C:/blog/grokbot分析/pi-bot/release");
const manifest = JSON.parse(readFileSync(join(pluginPath, "manifest.json"), "utf8"));
assert.equal(manifest.id, "local.pi-bot");
const pluginBundle = readFileSync(join(pluginPath, "main.js"));
console.log("pi-bot bundle", JSON.stringify({ bytes: pluginBundle.length,
  sha256: createHash("sha256").update(pluginBundle).digest("hex") }));
const root = mkdtempSync(join(tmpdir(), "pi-bot-electron-e2e-"));
const dataDir = join(root, "data");
const project = join(root, "project");
mkdirSync(project);
const multiBot = process.env.PI_BOT_MULTI === "1";
const archiveInflight = process.env.PI_BOT_ARCHIVE_INFLIGHT === "1";
const legacyRoutine = process.env.PI_BOT_LEGACY_ROUTINE === "1";
let releaseHeldModel;
let heldModel = false;
let targetBotId;
let childBotId;
let modelStep = 0;
let activeUserMessage;
let pendingTool;
let artifactId;
const toolResults = [];
const multiSteps = new Map();
const multiPending = new Map();
const model = createServer(async (req, res) => {
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "fixture", object: "model" }] }));
    return;
  }
  let body = "";
  for await (const part of req) body += part;
  const request = JSON.parse(body);
  if (archiveInflight && !heldModel && JSON.stringify(request.messages?.filter(
    (message) => message.role === "user").at(-1)?.content).includes("Work ID: work_")) {
    heldModel = true;
    await new Promise((done) => { releaseHeldModel = done; });
  }
  if (multiBot) {
    const latest = JSON.stringify(request.messages?.filter((message) => message.role === "user").at(-1)?.content);
    const role = latest.includes("Delegate fixture child:") ? "child" :
      latest.includes("Work ID: work_") ? "owner-initial" : "owner-resume";
    for (const message of request.messages ?? []) {
      if (message.role !== "tool") continue;
      const pending = multiPending.get(message.tool_call_id);
      if (!pending) continue;
      const text = typeof message.content === "string" ? message.content :
        message.content.map((item) => item.text ?? "").join("");
      toolResults.push({ name: pending.name, role: pending.role, text });
      if (pending.action !== "ToolSearch") {
        assert.ok(!text.includes('"ok":false'), `${pending.role} ${pending.name}: ${text}`);
      }
      if (pending.action === "write_file_artifact") {
        const match = /"artifactId"\s*:\s*"([^"]+)"/.exec(text);
        assert.ok(match, `child file artifact: ${text}`);
        artifactId = match[1];
      }
      if (pending.action !== "ToolSearch") multiSteps.set(pending.role, (multiSteps.get(pending.role) ?? 0) + 1);
      multiPending.delete(message.tool_call_id);
    }
    const step = multiSteps.get(role) ?? 0;
    const workbench = (request.tools ?? []).find((tool) => tool.function?.name?.endsWith("_bot_workbench"))?.function.name;
    const action = !workbench ? "ToolSearch" : role === "owner-initial" ?
      (step === 0 ? "send_work" : step === 1 && artifactId ? "record_result" : null) : role === "child" ?
        (step === 0 ? "write_file_artifact" : step === 1 ? "record_result" : null) :
        (step === 0 ? "record_result" : null);
    const args = action === "ToolSearch" ? { query: "bot_workbench" } :
      action === "send_work" ? { action, botId: childBotId, requestKind: "task",
        content: "Delegate fixture child: write the shared status file and report its Artifact ID." } :
      action === "write_file_artifact" ? { action, title: "Delegated status",
        content: "# Delegated status\nChild Bot wrote this file.\n",
        relativePath: "pi-bot/delegated-status.md", format: "markdown" } :
      action === "record_result" && role === "child" ? { action, botId: childBotId,
        resultKind: "result", summary: "Child Bot delivered the shared status file.",
        artifactRefs: [artifactId] } :
      action === "record_result" ? { action, botId: targetBotId,
        resultKind: "result", summary: "Owner Bot confirmed the delegated report.",
        artifactRefs: [artifactId] } : null;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: `pi-bot-multi-${role}-${step}`, object: "chat.completion.chunk", created: 1, model: "fixture" };
    const emit = (delta, finish_reason = null) =>
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (action) {
      const name = action === "ToolSearch" ? "ToolSearch" : workbench;
      const id = `multi-${role}-${Date.now()}-${Math.random()}`;
      multiPending.set(id, { action, name, role });
      emit({ role: "assistant", tool_calls: [{ index: 0, id, type: "function",
        function: { name, arguments: JSON.stringify(args) } }] });
      emit({}, "tool_calls");
    } else {
      emit({ role: "assistant", content: role === "child" ? "Shared file written." :
        "Delegated report confirmed." });
      emit({}, "stop");
    }
    res.end("data: [DONE]\n\n");
    return;
  }
  const latestUserMessage = JSON.stringify(request.messages?.filter((message) => message.role === "user").at(-1)?.content);
  if (latestUserMessage !== activeUserMessage) {
    activeUserMessage = latestUserMessage;
    modelStep = 0;
  }
  if (pendingTool) {
    const toolMessage = request.messages?.find((message) => message.role === "tool" &&
      message.tool_call_id === pendingTool.id);
    assert.ok(toolMessage, `model received ${pendingTool.name} result`);
    const text = typeof toolMessage.content === "string" ? toolMessage.content :
      toolMessage.content.map((item) => item.text ?? "").join("");
    toolResults.push({ name: pendingTool.name, text });
    if (pendingTool.name.endsWith("_bot_workbench")) {
      assert.ok(!text.includes('"ok":false'), text);
      if (modelStep === 0) {
        const match = /"artifactId"\s*:\s*"([^"]+)"/.exec(text);
        assert.ok(match, `write_file_artifact returned artifactId: ${text}`);
        artifactId = match[1];
      }
      modelStep += 1;
    }
    pendingTool = undefined;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: `pi-bot-fixture-${modelStep}`, object: "chat.completion.chunk", created: 1, model: "fixture" };
  const emit = (delta, finish_reason = null) =>
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (modelStep < 2) {
    const toolName = (request.tools ?? []).find((tool) => tool.function?.name?.endsWith("_bot_workbench"))
      ?.function.name ?? "ToolSearch";
    const args = toolName === "ToolSearch" ? { query: "bot_workbench" } : modelStep === 0
      ? { action: "write_file_artifact", title: "Routine status", content: "# Status\nFixture report completed.\n",
        relativePath: "pi-bot/status.md", format: "markdown" }
      : { action: "record_result", botId: targetBotId, resultKind: "result",
        summary: "Fixture status report delivered.", artifactRefs: [artifactId] };
    assert.ok((request.tools ?? []).some((tool) => tool.function?.name === toolName), `${toolName} is exposed`);
    pendingTool = { name: toolName, id: `pi-bot-call-${Date.now()}` };
    emit({ role: "assistant", tool_calls: [{ index: 0, id: pendingTool.id, type: "function",
      function: { name: toolName, arguments: JSON.stringify(args) } }] });
    emit({}, "tool_calls");
  } else {
    emit({ role: "assistant", content: "Routine fixture completed." });
    emit({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((done) => model.listen(0, "127.0.0.1", done));

const host = new Host(resolveHostBinary(), dataDir);
let child;
let output = "";
const sockets = [];
async function connect(url) {
  const ws = new WebSocket(url);
  sockets.push(ws);
  await once(ws, "open");
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolveCall, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve: resolveCall, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await send("Page.enable");
  return { send, evaluate };
}

async function approveNativeConsent(processId) {
  if (process.platform !== "win32") throw new Error("native consent automation requires Windows");
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class NativeClick {
  [DllImport("user32.dll")] public static extern System.IntPtr SendMessage(System.IntPtr hwnd, uint message, System.IntPtr wParam, System.IntPtr lParam);
}
'@
$root = [System.Windows.Automation.AutomationElement]::RootElement
$name = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Allow once')
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while ([DateTime]::UtcNow -lt $deadline) {
  $buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $name)
  foreach ($button in $buttons) {
    if ($button.Current.ProcessId -ne ${processId} -or -not $button.Current.IsEnabled) { continue }
    $handle = $button.Current.NativeWindowHandle
    if ($handle -eq 0) { continue }
    [void][NativeClick]::SendMessage([System.IntPtr]$handle, 245, [System.IntPtr]::Zero, [System.IntPtr]::Zero)
    exit 0
  }
  Start-Sleep -Milliseconds 100
}
exit 2`;
  const approver = spawn("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true });
  let stderr = "";
  approver.stderr.on("data", (data) => { stderr += data; });
  const [code] = await once(approver, "exit");
  assert.equal(code, 0, `Native consent button not found/invoked: ${stderr}`);
}

async function authorizedResponse(promise) {
  return Promise.race([promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("native consent response timed out")), 15_000))]);
}

try {
  await host.start();
  await host.call("workspace.set", { path: project });
  const { provider } = await host.call("providers.create", {
    name: "pi-bot fixture", vendorKey: "custom", type: "openai_compatible",
    protocol: "openai_compatible", baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
    authKind: "none", defaultModelId: "fixture", apiStyle: "chat_completions",
  });
  await host.call("settings.set", { language: "en", defaultProviderId: provider.id,
    defaultModelId: "fixture", defaultMode: "agent", defaultPermissionMode: "auto" });
  const installed = await host.call("plugins.installFromPath", { path: pluginPath, enable: true });
  assert.equal(installed.result.plugin.id, manifest.id);
  await host.stop();

  const { appDir, electronBinary } = resolveElectronBinary();
  const port = Number(process.env.PI_BOT_CDP_PORT ?? 9382);
  const env = { ...process.env, PI_DESKTOP_DATA_DIR: dataDir,
    PI_DESKTOP_START_MAXIMIZED: "0", ELECTRON_RENDERER_URL: "" };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electronBinary,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${join(root, "profile")}`, "."],
    { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
  let mainTarget;
  await waitFor(async () => {
    try {
      mainTarget = (await targets()).find((target) => target.type === "page" &&
        target.url.includes("out/renderer/index.html"));
      return !!mainTarget;
    } catch { return false; }
  }, 30_000, "desktop target");
  const main = await connect(mainTarget.webSocketDebuggerUrl);
  await waitFor(() => main.evaluate("!document.querySelector('.startup-splash')"), 30_000, "desktop ready");
  const loaded = await main.evaluate(`(async () => { const r=await window.piDesktop.invoke(window.piDesktop.channels.invoke.pluginList); return r; })()`);
  assert.ok(loaded.ok && loaded.data.plugins.some((plugin) => plugin.id === manifest.id), JSON.stringify(loaded));
  let search;
  await waitFor(async () => {
    search = await main.evaluate(`(async () => window.piDesktop.invoke(window.piDesktop.channels.invoke.commandPaletteSearch, 'pi-bot'))()`);
    return search.ok && search.data.commands?.some((command) => command.id === "pi-bot.openWorkbench");
  }, 30_000, "pi-bot command registration").catch(async (error) => {
    console.error("Plugin list:", JSON.stringify(await main.evaluate(`(async () => window.piDesktop.invoke(window.piDesktop.channels.invoke.pluginList))()`)));
    console.error("Command search:", JSON.stringify(search));
    throw error;
  });
  const opened = await main.evaluate(`(async () => { const r=await window.piDesktop.invoke(window.piDesktop.channels.invoke.commandPaletteExecute, 'pi-bot.openWorkbench'); return r; })()`);
  assert.ok(opened.ok, JSON.stringify(opened));
  let panelTarget;
  await waitFor(async () => {
    panelTarget = (await targets()).find((target) => target.type === "page" &&
      target.url.includes("local.pi-bot") && target.url.includes("renderer/index.html") && target.id !== mainTarget.id);
    return !!panelTarget;
  }, 15_000, "pi-bot panel target");
  const panel = await connect(panelTarget.webSocketDebuggerUrl);
  await waitFor(() => panel.evaluate("!!window.pluginBridge && !!document.body"), 15_000, "pi-bot panel bridge").catch(async (error) => {
    console.error("CDP targets:", JSON.stringify(await targets()));
    console.error("Panel state:", JSON.stringify(await panel.evaluate("({url:location.href,title:document.title,text:document.body?.innerText.slice(0,300),bridge:!!window.pluginBridge})")));
    throw error;
  });
  const call = (channel, payload = {}) => panel.evaluate(
    `(async () => window.pluginBridge.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)}))()`);
  const authorizeSchedule = async (created) => {
    const definition = created.data?.scheduleAuthorization;
    assert.ok(definition, `Routine creation requires native schedule authorization: ${JSON.stringify(created)}`);
    const authorization = call("scheduled.authorizeSchedule", { definition });
    await approveNativeConsent(child.pid);
    const binding = await authorizedResponse(authorization);
    assert.equal(binding.externalKey, created.data.routineId, JSON.stringify(binding));
    console.log("PASS native-authorized schedule", binding.externalKey);
  };
  const bootstrap = await call("panel.bootstrap");
  assert.equal(bootstrap.ok, true, JSON.stringify(bootstrap));
  console.log("PASS installed pi-bot in Electron with a working panel bridge");
  const skill = await call("skill.create", { title: "Fixture method", description: "Local fixture",
    sourceWorkId: null, content: "Write a short status report and identify its source.",
    inputSpec: "Project status", outputSpec: "One status report file",
    failurePolicy: "Report failure", noDataPolicy: "Request input" });
  assert.equal(skill.ok, true, JSON.stringify(skill));
  const skillRef = `skill:${skill.data.definition.skillId}@${skill.data.revision.revision}:${skill.data.revision.contentHash}`;
  console.log("PASS created pinned Skill", skillRef);
  const bot = await call("bot.create", { name: "Fixture Bot", description: "Runs a recurring report",
    workspacePath: project, providerId: provider.id, modelId: "fixture", skillRefs: [skillRef],
    permissionCeiling: "ask", createdByBotId: null });
  assert.equal(bot.ok, true, JSON.stringify(bot));
  assert.equal(bot.data.bot.lifecycle, "ready", JSON.stringify(bot));
  targetBotId = bot.data.bot.botId;
  console.log("PASS created Bot", bot.data.bot.botId);
  let resultConversationId = null;
  if (multiBot) {
    const peer = await call("bot.create", { name: "Delegated File Bot",
      description: "Writes the scheduled shared file", workspacePath: project,
      providerId: provider.id, modelId: "fixture", skillRefs: [],
      permissionCeiling: "ask", createdByBotId: null });
    assert.equal(peer.ok, true, JSON.stringify(peer));
    childBotId = peer.data.bot.botId;
    const room = await call("conversation.create", { kind: "group", title: "Scheduled reports",
      memberBotIds: [targetBotId, childBotId] });
    assert.equal(room.ok, true, JSON.stringify(room));
    resultConversationId = room.data.conversationId;
    console.log("PASS created delegate Bot and result conversation", JSON.stringify({ childBotId, resultConversationId }));
  }
  const routine = await call("routine.create", { title: "Fixture Routine", goal: "Write the report",
    ownerBotId: bot.data.bot.botId, cadence: "custom", hour: null, minute: 0,
    weekday: null, intervalMinutes: 1, skillRef, timezone: "UTC", resultConversationId });
  assert.equal(routine.ok, true, JSON.stringify(routine));
  await authorizeSchedule(routine);
  console.log("PASS registered Routine", JSON.stringify(routine.data));
  const routineId = routine.data.routineId;
  const listed = await call("routine.list");
  assert.equal(listed.ok, true, JSON.stringify(listed));
  console.log("Routine list:", JSON.stringify(listed.data));
  if (archiveInflight) {
    await waitFor(async () => {
      const runs = await call("routine.runs", { routineId });
      return heldModel && runs.ok && runs.data.runs.some((row) => row.state === "running");
    }, 135_000, "in-flight scheduled Routine", 500);
    await panel.evaluate(`([...document.querySelectorAll('button')].find(e => e.textContent.trim() === 'Bots'))?.click()`);
    await panel.evaluate(`([...document.querySelectorAll('button')]
      .find(e => e.textContent.trim() === 'Refresh'))?.click()`);
    await waitFor(() => panel.evaluate(`!![...document.querySelectorAll('button')]
      .find(e => e.getAttribute('aria-label') === 'Archive Fixture Bot')`),
    15_000, "Bot Archive button");
    await panel.evaluate(`([...document.querySelectorAll('button')]
      .find(e => e.getAttribute('aria-label') === 'Archive Fixture Bot'))?.click()`);
    await waitFor(() => panel.evaluate(`!![...document.querySelectorAll('button')]
      .find(e => e.textContent.trim() === 'Archive Bot')`),
    15_000, "Bot Archive confirmation");
    await panel.evaluate(`([...document.querySelectorAll('button')]
      .find(e => e.textContent.trim() === 'Archive Bot'))?.click()`);
    await waitFor(async () => (await call("bot.list")).data.bots.find(
      (item) => item.botId === targetBotId)?.lifecycle === "archived",
    15_000, "Bot archived from GUI", 250);
    const inFlight = await call("routine.runs", { routineId });
    assert.ok(inFlight.data.runs.some((row) => row.state === "running"), JSON.stringify(inFlight));
    releaseHeldModel();
    console.log("PASS GUI Archive preserved in-flight scheduled Run");
  }
  if (process.env.PI_BOT_NATIVE_CONSENT === "1") {
  const manualRoutine = await call("routine.create", { title: "Manual Fixture Routine", goal: "Write a manual report",
    ownerBotId: bot.data.bot.botId, cadence: "custom", hour: null, minute: 0,
    weekday: null, intervalMinutes: 10080, skillRef, timezone: "UTC", resultConversationId: null });
  assert.equal(manualRoutine.ok, true, JSON.stringify(manualRoutine));
  await authorizeSchedule(manualRoutine);
  const manualId = manualRoutine.data.routineId;
  const manualRow = (await call("routine.list")).data.routines.find((row) => row.routineId === manualId);
  const clickKey = crypto.randomUUID();
  const intent = await call("routine.manualIntent", { routineId: manualId,
    expectedRevision: manualRow.recordRevision, clickKey });
  assert.equal(intent.ok, true, JSON.stringify(intent));
  const authorization = call("scheduled.authorizeManual", intent.data);
  await approveNativeConsent(child.pid);
  const authorized = await authorizedResponse(authorization);
  assert.equal(typeof authorized.manualToken, "string", JSON.stringify(authorized));
  const manualRun = await call("routine.runNow", { routineId: manualId,
    expectedRevision: manualRow.recordRevision, clickKey, manualToken: authorized.manualToken });
  assert.equal(manualRun.ok, true, JSON.stringify(manualRun));
  assert.equal(manualRun.data.trigger.kind, "manual");
  console.log("PASS native-authorized runNow", JSON.stringify(manualRun.data));
  let manualHistory;
  await waitFor(async () => {
    manualHistory = await call("routine.runs", { routineId: manualId });
    return manualHistory.ok && manualHistory.data.runs?.some((row) =>
      row.runId === manualRun.data.runId && row.state === "succeeded");
  }, 30_000, "manual Routine completion", 500);
  const completedManual = manualHistory.data.runs.find((row) => row.runId === manualRun.data.runId);
  assert.ok(completedManual.rootWorkId && completedManual.resultArtifactIds.length > 0,
    JSON.stringify(completedManual));
  assert.equal(readFileSync(join(project, "pi-bot", "status.md"), "utf8"),
    "# Status\nFixture report completed.\n");
  console.log("PASS native-authorized manual Work and file", JSON.stringify({
    runId: completedManual.runId, workId: completedManual.rootWorkId,
    artifactIds: completedManual.resultArtifactIds }));
  }
  let history;
  await waitFor(async () => {
    history = await call("routine.runs", { routineId });
    return history.ok && history.data.runs?.some((run) => run.trigger?.kind === "schedule" &&
      ["succeeded", "failed", "needs_input", "outcome_unknown"].includes(run.state));
  }, 135_000, "automatic Routine Run", 1000).catch((error) => {
    console.error("Last Run history:", JSON.stringify(history));
    console.error("Model tool results:", JSON.stringify(toolResults.slice(-6)));
    throw error;
  });
  const run = history.data.runs.find((row) => row.trigger?.kind === "schedule");
  console.log("Host-triggered Routine Run:", JSON.stringify(run));
  console.log("Model tool results:", JSON.stringify(toolResults));
  assert.equal(run.state, "succeeded", JSON.stringify(run));
  assert.ok(run.rootWorkId, JSON.stringify(run));
  assert.ok(artifactId && run.resultArtifactIds.includes(artifactId), JSON.stringify(run));
  const work = await call("work.list");
  assert.equal(work.ok, true, JSON.stringify(work));
  assert.ok(JSON.stringify(work.data).includes(run.rootWorkId) && JSON.stringify(work.data).includes("succeeded"), JSON.stringify(work));
  const file = join(project, "pi-bot", multiBot ? "delegated-status.md" : "status.md");
  assert.ok(existsSync(file), `file missing: ${file}`);
  assert.equal(readFileSync(file, "utf8"), multiBot ?
    "# Delegated status\nChild Bot wrote this file.\n" : "# Status\nFixture report completed.\n");
  const fileStatus = await call("artifact.fileStatus", { artifactId });
  assert.equal(fileStatus.ok, true, JSON.stringify(fileStatus));
  assert.ok(JSON.stringify(fileStatus.data).includes("generated"), JSON.stringify(fileStatus));
  if (multiBot) {
    const childWork = work.data.work.find((item) => item.ownerBotId === childBotId &&
      item.originWorkId === run.rootWorkId);
    assert.ok(childWork, `Run has no delegated child Work: ${JSON.stringify(work.data)}`);
    assert.equal(childWork.state, "succeeded", JSON.stringify(childWork));
    const rootWork = await call("work.detail", { workId: run.rootWorkId });
    assert.equal(rootWork.data.work.result?.artifactRefs?.includes(artifactId), true,
      `owner did not explicitly share the child file: ${JSON.stringify(rootWork.data.work)}`);
    assert.equal(fileStatus.data.artifact.ownerBotId, childBotId);
    assert.equal(fileStatus.data.revision.producedBy.botId, childBotId);
    const receipt = await call("conversation.messages", { conversationId: resultConversationId });
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.ok(receipt.data.messages.some((message) => message.references?.includes(artifactId) &&
      message.content.includes("Owner Bot confirmed")),
      `original conversation has no shared file reference: ${JSON.stringify(receipt.data)}`);
    console.log("PASS child Work file explicitly shared by owner into Run and original conversation",
      JSON.stringify({ childWorkId: childWork.workId, artifactId, conversationId: resultConversationId }));
  }
  console.log("PASS host-triggered Routine, Work, Artifact and file", JSON.stringify({
    runId: run.runId, workId: run.rootWorkId, artifactId, file, fileStatus: fileStatus.data }));
  if (archiveInflight) {
    const binding = (await call("routine.list")).data.routines.find((item) => item.routineId === routineId);
    assert.equal(binding.enabled, false, JSON.stringify(binding));
    assert.equal(binding.hostBinding.enabled, false, JSON.stringify(binding));
    const db = new DatabaseSync(join(dataDir, "pi.sqlite"));
    try {
      const before = db.prepare("SELECT COUNT(*) AS count FROM plugin_schedule_occurrences WHERE task_id=?")
        .get(binding.hostBinding.schedulerTaskId).count;
      db.prepare("UPDATE scheduled_tasks SET config_json=json_set(config_json,'$.nextRunAt',CAST(? AS INTEGER)) WHERE id=?")
        .run(Date.now() - 60_000, binding.hostBinding.schedulerTaskId);
      await new Promise((done) => setTimeout(done, 2_500));
      const after = db.prepare("SELECT COUNT(*) AS count FROM plugin_schedule_occurrences WHERE task_id=?")
        .get(binding.hostBinding.schedulerTaskId).count;
      assert.equal(after, before, "disabled binding generated another occurrence");
    } finally { db.close(); }
    const afterArchive = await call("routine.runs", { routineId });
    assert.equal(afterArchive.data.runs.filter((row) => row.trigger?.kind === "schedule").length, 1,
      JSON.stringify(afterArchive));
    console.log("PASS archived Bot retained completed Run and disabled future Host occurrences");
  }
  if (!archiveInflight) {
  await panel.evaluate(`([...document.querySelectorAll('button')].find(e => e.textContent.trim() === 'Routines'))?.click()`);
  await waitFor(() => panel.evaluate(`!![...document.querySelectorAll('.row')].find(row =>
    row.textContent.includes(${JSON.stringify(routineId)}) &&
    [...row.querySelectorAll('button')].some(button => button.textContent.trim() === 'Disable'))`),
  15_000, "Routine Disable button");
  const clickedDisable = await panel.evaluate(`(() => { const row = [...document.querySelectorAll('.row')]
    .find(row => row.textContent.includes(${JSON.stringify(routineId)}));
    const button = [...row.querySelectorAll('button')].find(button => button.textContent.trim() === 'Disable');
    button.click(); return true; })()`);
  assert.equal(clickedDisable, true);
  await waitFor(async () => {
    const result = await call("routine.list");
    return result.ok && result.data.routines.find((item) => item.routineId === routineId)?.enabled === false;
  }, 15_000, "Routine disabled from panel", 250);
  console.log("PASS panel Disable blocked future Routine triggers");
  const shot = await panel.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(root, "routine-panel.png"), Buffer.from(shot.data, "base64"));
  console.log("Panel screenshot:", join(root, "routine-panel.png"));
  for (const ws of sockets) ws.close();
  child.kill();
  await once(child, "exit");
  await host.start();
  const pausedBinding = (await host.call("scheduled.pluginGet", {
    pluginId: manifest.id, externalKey: routineId })).binding;
  assert.equal(pausedBinding.task.enabled, false);
  assert.ok(pausedBinding.occurrences.some((item) => item.state === "accepted"));
  assert.deepEqual((await host.call("scheduled.pluginDue")).occurrences, []);
  await host.stop();
  console.log("PASS paused Host binding and Run history survived Electron shutdown");
  if (legacyRoutine) {
    const file = join(dataDir, "plugins", "data", manifest.id, "collections", "routines.json");
    const document = JSON.parse(readFileSync(file, "utf8"));
    const row = document.records?.[routineId];
    assert.ok(row?.value, `isolated profile has no Routine ${routineId}`);
    delete row.value.skillRef;
    delete row.value.timezone;
    writeFileSync(file, JSON.stringify(document));
  }
  child = spawn(electronBinary,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${join(root, "profile")}`, "."],
    { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  let restartedMainTarget;
  await waitFor(async () => {
    try {
      restartedMainTarget = (await targets()).find((target) => target.type === "page" &&
        target.url.includes("out/renderer/index.html"));
      return !!restartedMainTarget;
    } catch { return false; }
  }, 30_000, "restarted desktop target");
  const restartedMain = await connect(restartedMainTarget.webSocketDebuggerUrl);
  await waitFor(() => restartedMain.evaluate("!document.querySelector('.startup-splash')"),
    30_000, "restarted desktop ready");
  await waitFor(async () => {
    const result = await restartedMain.evaluate(`(async () => window.piDesktop.invoke(
      window.piDesktop.channels.invoke.commandPaletteSearch, 'pi-bot'))()`);
    return result.ok && result.data.commands?.some((command) => command.id === "pi-bot.openWorkbench");
  }, 30_000, "restarted pi-bot command registration");
  const reopened = await restartedMain.evaluate(`(async () => window.piDesktop.invoke(
    window.piDesktop.channels.invoke.commandPaletteExecute, 'pi-bot.openWorkbench'))()`);
  assert.ok(reopened.ok, JSON.stringify(reopened));
  let restartedPanelTarget;
  await waitFor(async () => {
    restartedPanelTarget = (await targets()).find((target) => target.type === "page" &&
      target.url.includes("local.pi-bot") && target.url.includes("renderer/index.html") &&
      target.id !== restartedMainTarget.id);
    return !!restartedPanelTarget;
  }, 15_000, "restarted pi-bot panel target");
  const restartedPanel = await connect(restartedPanelTarget.webSocketDebuggerUrl);
  await waitFor(() => restartedPanel.evaluate("!!window.pluginBridge"), 15_000, "restarted panel bridge");
  const restored = await restartedPanel.evaluate(`(async () => window.pluginBridge.invoke(
    'routine.runs', ${JSON.stringify({ routineId })}))()`);
  assert.equal(restored.ok, true, JSON.stringify(restored));
  const restoredRun = restored.data.runs.find((row) => row.runId === run.runId);
  assert.equal(restoredRun?.state, "succeeded", JSON.stringify(restored));
  assert.ok(restoredRun.resultArtifactIds.includes(artifactId), JSON.stringify(restoredRun));
  console.log("PASS Run and Artifact survived Electron restart", JSON.stringify({ runId: run.runId, artifactId }));
  if (legacyRoutine) {
    const legacyList = await restartedPanel.evaluate(`(async () => window.pluginBridge.invoke('routine.list'))()`);
    assert.equal(legacyList.ok, true, JSON.stringify(legacyList));
    const legacyRow = legacyList.data.routines.find((item) => item.routineId === routineId);
    assert.equal(legacyRow?.skillRef ?? null, null);
    assert.equal(legacyRow?.timezone ?? null, null);
    assert.equal(legacyRow?.enabled, false);
    const refused = await restartedPanel.evaluate(`(async () => window.pluginBridge.invoke(
      'routine.manualIntent', ${JSON.stringify({ routineId, expectedRevision: 2, clickKey: "legacy-replay" })}))()`);
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.error.code, "CONFLICT", JSON.stringify(refused));
    await restartedPanel.evaluate(`([...document.querySelectorAll('button')]
      .find(e => e.textContent.trim() === 'Routines'))?.click()`);
    await waitFor(() => restartedPanel.evaluate(`(() => { const row = [...document.querySelectorAll('.row')]
      .find(e => e.textContent.includes(${JSON.stringify(routineId)}));
      return !!row && row.textContent.includes('Needs configuration') &&
        row.textContent.includes('Recent runs') && row.textContent.includes('succeeded') &&
        row.textContent.includes('1 file(s)'); })()`),
    15_000, "legacy Routine history in GUI");
    await restartedPanel.evaluate(`([...document.querySelectorAll('button')]
      .find(e => e.textContent.trim() === 'Artifacts'))?.click()`);
    await waitFor(() => restartedPanel.evaluate(`!![...document.querySelectorAll('.row')]
      .find(e => e.textContent.includes(${JSON.stringify(artifactId)}))`),
    15_000, "legacy Run Artifact in GUI");
    const openedArtifact = await restartedPanel.evaluate(`(() => { const row = [...document.querySelectorAll('.row')]
      .find(e => e.textContent.includes(${JSON.stringify(artifactId)}));
      const button = row?.querySelector('button[aria-label^="Open "]');
      if (!button) return false; button.click(); return true; })()`);
    assert.equal(openedArtifact, true, "saved Artifact cannot be opened from GUI");
    await waitFor(() => restartedPanel.evaluate(`document.body.textContent.includes('Revision chain') &&
      document.body.textContent.includes(${JSON.stringify(artifactId)}) &&
      document.body.textContent.includes('r1')`),
    15_000, "legacy Run Artifact revision in GUI");
    console.log("PASS legacy Routine history and Artifact revision reachable in GUI");
  }
  const uninstalled = await restartedMain.evaluate(`(async () => window.piDesktop.invoke(
    window.piDesktop.channels.invoke.pluginUninstall, ${JSON.stringify(manifest.id)}))()`);
  assert.equal(uninstalled.ok, true, JSON.stringify(uninstalled));
  child.kill();
  await once(child, "exit");
  child = null;
  await host.start();
  const uninstalledBinding = (await host.call("scheduled.pluginGet", {
    pluginId: manifest.id, externalKey: routineId })).binding;
  assert.equal(uninstalledBinding.task.enabled, false);
  assert.ok(uninstalledBinding.occurrences.some((item) => item.state === "accepted"));
  assert.deepEqual((await host.call("scheduled.pluginDue")).occurrences, []);
  console.log("PASS plugin uninstall retained history and left no runnable schedule");
  }
} catch (error) {
  console.error("E2E failed:", error);
  console.error("Electron output:", output.slice(-12000));
  throw error;
} finally {
  for (const ws of sockets) ws.close();
  if (child && child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
  try { await host.stop(); } catch { /* Host may already have stopped. */ }
  await new Promise((done) => model.close(done));
  if (process.env.PI_BOT_KEEP_PROFILE) console.log(`Profile kept: ${root}`);
  else try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  catch (error) { console.warn(`Temporary profile cleanup deferred: ${error.message}`); }
  if (output && process.env.PI_BOT_E2E_LOG) console.log(output.slice(-12000));
}
