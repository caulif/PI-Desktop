// Local provider -> production Runtime/pi -> real Host -> temporary files.
// A response barrier proves concurrent dispatch, not filesystem-body overlap.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopAgentRuntime } from "../packages/agent-runtime/dist/runtime.js";
import { SubagentRun } from "../packages/agent-runtime/dist/subagent.js";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { createSession, configureSession, beginTurn, endTurn } from "./e2e/session.mjs";

const scratch = await mkdtemp(join(tmpdir(), "pi-parallel-read-"));
const workspace = join(scratch, "workspace");
await mkdir(workspace);
await writeFile(join(workspace, "a.txt"), "alpha-marker\n");
await writeFile(join(workspace, "b.txt"), "beta-marker\n");
const calls = [
  { id: "read-a", name: "Read", arguments: { path: "a.txt" } },
  { id: "read-b", name: "Read", arguments: { path: "b.txt" } },
  { id: "glob", name: "Glob", arguments: { pattern: "*.txt" } },
  { id: "grep", name: "Grep", arguments: { pattern: "alpha-marker", path: "." } },
];
// One Write and two Reads: the unrelated Read must overlap the Write, the
// same-file Read must wait for it to return.
const conflictCalls = [
  { id: "rewrite-a", name: "Write", arguments: { path: "a.txt", content: "rewritten-marker\n" } },
  { id: "after-write-a", name: "Read", arguments: { path: "a.txt" } },
  { id: "other-b", name: "Read", arguments: { path: "b.txt" } },
];
const conflictIds = new Set(conflictCalls.map(call => call.id));
// The parent turn, the delegate's turn and the conflict turn, in request order.
const batches = [calls, calls, conflictCalls];
let servedBatches = 0;
const requests = [];
const server = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = (value, finish = null) => res.write(`data: ${JSON.stringify({
      id: `fixture-${requests.length}`, object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta: value, finish_reason: finish }],
    })}\n\n`);
    const batch = batches[servedBatches];
    const answered = batch?.some(call =>
      body.messages.some(message => message.role === "tool" && message.tool_call_id === call.id));
    if (batch && !answered) {
      delta({ role: "assistant", tool_calls: batch.map((call, index) => ({
        index, id: call.id, type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })) });
      delta({}, "tool_calls");
    } else {
      servedBatches += 1;
      delta({ role: "assistant", content: "parallel-read-complete" });
      delta({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const host = new Host(resolveHostBinary(), join(scratch, "data"));
let runtime, turnId;
const events = [];
const returnedReads = [];
let releaseReads;
let barrier = new Promise(resolve => { releaseReads = resolve; });
let barrierTimeout = setTimeout(releaseReads, 10_000);
// Conflict phase: the Write's Host result is held until the test has seen the
// unrelated Read overlap it.
const conflictDispatch = [];
let writeReturned;
const writeHeld = new Promise(resolve => { writeReturned = resolve; });
let releaseWrite;
const writeRelease = new Promise(resolve => { releaseWrite = resolve; });
async function until(predicate, label) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
try {
  await host.start(PROTOCOL_VERSION);
  const session = await createSession(host, workspace, "Parallel reads");
  await configureSession(host, session, "agent", "auto");
  turnId = await beginTurn(host, session.id);
  const call = host.call.bind(host);
  host.call = async (method, args, timeout) => {
    const result = await call(method, args, timeout);
    if (method === "tools.execute" && ["read-a", "read-b"].includes(args.toolCallId)) {
      returnedReads.push(args.toolCallId);
      if (returnedReads.length === 2) releaseReads();
      await barrier;
      assert.equal(returnedReads.length, 2, "second Read never dispatched before the first response was released");
    }
    if (method === "tools.execute" && conflictIds.has(args.toolCallId)) {
      conflictDispatch.push(args.toolCallId);
      if (args.toolCallId === "rewrite-a") {
        // The Write already ran in Host; holding its result keeps the batch from
        // ordering itself by Host admission alone.
        writeReturned();
        await writeRelease;
      }
    }
    return result;
  };
  runtime = new DesktopAgentRuntime({
    host, sessionId: session.id, turnId, mode: "agent", projectPath: workspace,
    provider: {
      id: "fixture", name: "Local fixture", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      modelId: "fixture", apiKey: "", authKind: "none", apiStyle: "chat_completions",
      supportsReasoning: false, supportedThinkingLevels: ["off"],
    },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    thinkingLevel: "off", onEvent: envelope => events.push(envelope.event),
  });
  await runtime.prompt("Read and search the fixture files.", "fixture-user", turnId);
  assert.equal(requests.length, 2);
  assert.deepEqual(returnedReads.slice().sort(), ["read-a", "read-b"]);
  const results = requests[1].messages.filter(message => message.role === "tool");
  assert.deepEqual(results.map(message => message.tool_call_id), calls.map(call => call.id));
  assert.match(JSON.stringify(results[0].content), /alpha-marker/);
  assert.match(JSON.stringify(results[1].content), /beta-marker/);
  assert.match(JSON.stringify(results[2].content), /a\.txt/);
  assert.match(JSON.stringify(results[3].content), /alpha-marker/);
  assert.equal(events.some(event => event.type === "error"), false);
  // Exercise the real delegate loop with the parent's scoped Host tool bridge.
  returnedReads.length = 0;
  clearTimeout(barrierTimeout);
  barrier = new Promise(resolve => { releaseReads = resolve; });
  barrierTimeout = setTimeout(releaseReads, 10_000);
  const definition = { name: "reader", description: "Read", tools: ["Read", "Glob", "Grep"], prompt: "Read", source: "builtin" };
  const names = new Set(definition.tools);
  const tools = [...runtime.toolCatalog.values()].filter(tool => names.has(tool.name));
  let child;
  const apply = instructions => child.setSystemPrompt(`Child rules: ${JSON.stringify(instructions)}`);
  const parentPrompt = runtime.agent.state.systemPrompt;
  child = new SubagentRun({
    definition, sessionId: session.id, turnId, parentToolCallId: "fixture-task",
    task: "Read and search the fixture files.", provider: runtime.provider,
    thinkingLevel: "off", systemPrompt: "Read the fixture files.",
    tools: runtime.scopeDelegateTools(tools, definition, "fixture-delegate", apply),
    beforeToolCall: context => runtime.preparePathToolCall(context, apply, names),
    onEvent: envelope => events.push(envelope.event),
  });
  const report = await child.run();
  assert.equal(report.status, "completed");
  assert.deepEqual(returnedReads.slice().sort(), ["read-a", "read-b"]);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[3].messages.filter(message => message.role === "tool").map(message => message.tool_call_id), calls.map(call => call.id));
  assert.equal(runtime.agent.state.systemPrompt, parentPrompt);
  // Conflict ordering inside one batch: a Write, a Read of the same file and a
  // Read of another file. Host admits the Write, the unrelated Read overlaps it,
  // and the same-file Read only starts once the Write returned.
  await endTurn(host, turnId);
  turnId = await beginTurn(host, session.id);
  const conflictTurn = runtime.prompt("Rewrite a.txt, then read it.", "fixture-user-2", turnId);
  await writeHeld;
  await until(() => conflictDispatch.includes("other-b"), "the unrelated Read to be dispatched");
  assert.equal(conflictDispatch.includes("after-write-a"), false,
    "the same-file Read was dispatched while the Write was still running");
  releaseWrite();
  await until(() => conflictDispatch.includes("after-write-a"), "the same-file Read to be dispatched");
  await conflictTurn;
  assert.equal(requests.length, 6);
  const conflictResults = requests[5].messages.filter(
    message => message.role === "tool" && conflictIds.has(message.tool_call_id));
  assert.deepEqual(conflictResults.map(message => message.tool_call_id),
    ["rewrite-a", "after-write-a", "other-b"]);
  // The waiting Read sees the finished Write instead of racing it.
  assert.match(JSON.stringify(conflictResults[1].content), /rewritten-marker/);
  assert.doesNotMatch(JSON.stringify(conflictResults[1].content), /alpha-marker/);
  assert.match(JSON.stringify(conflictResults[2].content), /beta-marker/);
  assert.equal(events.some(event => event.type === "error"), false);
  await endTurn(host, turnId);
  turnId = undefined;
  console.log("PASS parallel-read E2E: local HTTP provider, parent/delegate concurrent Read dispatch, real Read/Glob/Grep, source-order results, same-file Read ordered behind a Write, parent prompt isolation");
} finally {
  releaseReads();
  releaseWrite();
  clearTimeout(barrierTimeout);
  await runtime?.dispose();
  if (turnId) await endTurn(host, turnId, "error");
  await host.stop();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
