import assert from "node:assert/strict";
import test from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const { IPC } = await import("@pi-desktop/shared");
const { sessionWorkspaceIdentity } = await import("@pi-desktop/host-runtime");
const { LIVE_WORK_TOOL_NAME, codexDelegationFeedback, codexWorkFeedbackMessage, parseCodexMessage } = await import("@pi-desktop/voice-runtime/live");

const sessionId = "live-work-production-session";
const callId = "live-work-production-call";
const projectId = "production-fixture-project";
const projectPath = "/tmp/pi-live-work-production-fixture";
const instruction = "Inspect the login flow and report verified findings.";

test("production Live WorkBridge reaches AgentHost admission, explicit queue, and exact terminal result", async (t) => {
  const server = await createServer({
    root: dirname(here),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { createAgentHostBridge, DESKTOP_PRINCIPAL } = await server.ssrLoadModule("/electron/main/agent-host-bridge.ts");
  const { createLiveWorkBridge } = await server.ssrLoadModule("/electron/main/live-voice/work-bridge.ts");
  const { registerAgentIpc } = await server.ssrLoadModule("/electron/main/ipc/agent-ipc.ts");
  const prompts = [];
  const persistedMessages = [];
  const invocationLog = [];
  const updates = [];
  const registeredHandlers = new Map();
  const activeTurns = new Map();
  let durableTurnSequence = 0;
  let runtimePromptSequence = 0;
  let agentHostBridge;
  let terminalSeen = false;
  let historyReadsAfterTerminal = 0;
  let resolveResult;
  const resultReceived = new Promise((resolve) => { resolveResult = resolve; });
  let resolveQueuedPrompt;
  const queuedPromptReceived = new Promise((resolve) => { resolveQueuedPrompt = resolve; });
  const finalMessage = {
    id: "assistant-final-1",
    turnId: "runtime-turn-1",
    role: "assistant",
    content: "The login flow correctly rejects expired credentials.",
    status: "complete",
    createdAt: "2026-09-29T00:00:05.000Z",
  };
  const sessionRecord = () => ({
    id: sessionId,
    title: "Production fixture",
    projectId,
    projectPath,
    mode: "agent",
    permissionMode: "ask",
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    messages: terminalSeen && historyReadsAfterTerminal >= 2 ? [finalMessage] : [],
  });
  const host = {
    async call(method, params) {
      if (method === "session.list") return { sessions: [{ ...sessionRecord(), source: "desktop" }] };
      if (method === "session.get") {
        if (terminalSeen) historyReadsAfterTerminal += 1;
        return { session: sessionRecord() };
      }
      if (method === "settings.get") return {};
      if (method === "session.beginTurn") return { turnId: `durable-turn-${++durableTurnSequence}` };
      if (method === "session.appendMessage") {
        persistedMessages.push(params.message);
        return {};
      }
      if (method === "session.queueList") return { entries: [] };
      if (method === "session.queuePush") return {};
      if (method === "session.queueRemove") return { removed: true };
      if (method === "session.queuePrioritize") return {};
      if (method === "session.queueReorder") return { moved: true };
      throw new Error(`unexpected Host RPC: ${method}`);
    },
  };
  const sidecar = {
    setProjectInstructionRoot() {},
    clearProjectInstructionRoot() {},
    clearVendorAuthBindings() {},
    async call(method, params) {
      if (method === "agent.prompt") {
        runtimePromptSequence += 1;
        return { accepted: true, turnId: `runtime-turn-${runtimePromptSequence}` };
      }
      if (method === "agent.abort") return { ok: true, aborted: true };
      throw new Error(`unexpected sidecar RPC: ${method}`);
    },
  };
  registerAgentIpc({
    registrar: { handle: (channel, handler) => registeredHandlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => sidecar,
    getAgentHostBridge: () => agentHostBridge ?? null,
    logger: { app() {} },
    vendorOAuth: { async resolveAuth() { throw new Error("OAuth is not used by this fixture"); } },
    agentExtensions: { cancelPrompts() {} },
    cancelSessionTools() {},
    persistenceOutbox: { async flush() {} },
    dataDir: "/tmp/pi-live-work-production-fixture-data",
    activeTurns,
    isTurnDispatchable: () => true,
    activeTurnUsages: new Map(),
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    async resolveAgentRuntimeLaunch(_id, session) {
      return {
        providerId: "fixture-provider",
        modelId: "fixture-model",
        projectPath: session.projectPath,
        sidecarParams: {
          provider: { modelConfig: { input: ["text"] } },
        },
      };
    },
    async acquireSessionOperation() { return () => {}; },
    async finishTurn() { throw new Error("unexpected turn finalization in prompt path"); },
    lockAbortReason() {},
    async finishApprovedExecution() {},
    async dispatchApprovedPlan() {},
    async dispatchExecutionForProposal() {},
    emitAgentEvent(event) { agentHostBridge?.ingest(event); },
    setNotificationViewingSessionId() {},
    async optionalWorkspaceRoot() { return null; },
    composerCommandService: { async buildComposerCommands() { return []; } },
    async loadComposerTemplatesCached() { return []; },
  });
  agentHostBridge = createAgentHostBridge({
    channels: IPC.invoke,
    getHost: () => host,
    isSessionBusy: () => false,
    log: () => undefined,
    async invoke(channel, args) {
      invocationLog.push({ channel, args });
      if (channel === IPC.invoke.agentPrompt) {
        const [request] = args;
        prompts.push(request);
        if (request.content === "Queue this as an independent follow-up.") resolveQueuedPrompt(request);
        const handler = registeredHandlers.get(channel);
        assert.equal(typeof handler, "function", "the real registered Main handler must receive the request");
        return handler(...args);
      }
      const handler = registeredHandlers.get(channel);
      assert.equal(typeof handler, "function", `expected a registered handler for ${channel}`);
      return handler(...args);
    },
  });
  const liveWorkBridge = createLiveWorkBridge({
    getHost: () => host,
    getAgentHostBridge: () => agentHostBridge,
    vendorOAuth: { async resolveAuth() { throw new Error("OAuth is not used by this fixture"); } },
    async navigateSession() {},
    async resolveAgentRuntimeLaunch(_id, session) {
      assert.equal("projectPath" in session, false, "private workspace paths must not enter classifier model setup");
      assert.equal("workspaceIdentity" in session, false, "private workspace fingerprints must not enter classifier model setup");
      return {
        providerId: "fixture-provider",
        sidecarParams: {
          provider: {
            id: "fixture-provider",
            name: "Fixture Provider",
            vendorKey: "openai",
            apiStyle: "chat_completions",
            baseUrl: "https://fixture.invalid/v1",
            modelId: "fixture-model",
            apiKey: "fixture-key",
            authKind: "api_key",
            supportsReasoning: false,
            supportedThinkingLevels: ["off"],
          },
        },
      };
    },
    async completeIntent(_provider, _context, _thinking, options) {
      assert.ok(options.signal instanceof AbortSignal, "the actual work classifier receives its cancellation signal");
      return {
        text: JSON.stringify({
          kind: "new-task",
          relationToActive: String(_context.messages[0]?.content).includes("independent follow-up") ? "independent" : "unspecified",
          explicitRepeat: false,
        }),
      };
    },
    waitForResultRetry: async () => {},
    onOperation(_call, update) {
      updates.push(update);
      if (update.operation.resultState === "available") resolveResult(update.operation);
    },
  });
  t.after(() => liveWorkBridge.closeCall(callId));

  liveWorkBridge.openCall({
    callId,
    workSessionId: sessionId,
    workBindingRevision: 3,
    label: "Production fixture",
    contextEnabled: false,
  }, sessionWorkspaceIdentity({ projectId, projectPath }));

  const [candidateEvent] = parseCodexMessage({
    type: "delegation.created",
    item: {
      type: "delegation",
      target: "client",
      id: "codex-production-request-1",
      content: [{ type: "input_text", text: instruction }],
    },
  });
  assert.equal(candidateEvent.kind, "delegation");
  const receiptWire = [];
  await liveWorkBridge.receiveCandidate({
    callId,
    workBindingRevision: 3,
    workSessionId: sessionId,
    providerRequestId: candidateEvent.delegationId,
    instruction: candidateEvent.instruction,
  }, async (receipt) => {
    receiptWire.push(codexDelegationFeedback(candidateEvent.delegationId, {
      operationId: receipt.operationId,
      status: "received",
    }));
    return { status: "sent", deliveryId: "codex-receipt-1" };
  });

  assert.equal(prompts.length, 1, "ordinary idle submit reaches the real AgentHost runtime port exactly once");
  assert.equal(prompts[0].content, instruction);
  assert.equal(prompts[0].voiceOrigin.callId, callId);
  assert.equal(typeof prompts[0].messageId, "string");
  assert.equal(persistedMessages[0].id, prompts[0].messageId);
  assert.equal(persistedMessages[0].content, instruction);
  assert.deepEqual(persistedMessages[0].voiceOrigin, prompts[0].voiceOrigin);
  assert.equal(receiptWire.length, 1);
  assert.equal(JSON.parse(receiptWire[0]).type, "delegation.context.append");
  assert.equal(updates.at(-1).operation.execution, "running");

  const [busyEvent] = parseCodexMessage({
    type: "delegation.created",
    item: {
      type: "delegation",
      target: "client",
      id: "codex-production-request-busy",
      content: [{ type: "input_text", text: "Add logging to the login flow." }],
    },
  });
  assert.equal(busyEvent.kind, "delegation");
  await liveWorkBridge.receiveCandidate({
    callId,
    workBindingRevision: 3,
    workSessionId: sessionId,
    providerRequestId: busyEvent.delegationId,
    instruction: busyEvent.instruction,
  }, async () => ({ status: "sent", deliveryId: "busy-receipt" }));
  assert.equal(prompts.length, 1, "an ordinary submit never silently falls back to Host queue when busy");
  assert.equal(updates.at(-1).operation.admission, "rejected");

  const [queueEvent] = parseCodexMessage({
    type: "delegation.created",
    item: {
      type: "delegation",
      target: "client",
      id: "codex-production-request-queue",
      content: [{ type: "input_text", text: "Queue this as an independent follow-up." }],
    },
  });
  assert.equal(queueEvent.kind, "delegation");
  await liveWorkBridge.receiveCandidate({
    callId,
    workBindingRevision: 3,
    workSessionId: sessionId,
    providerRequestId: queueEvent.delegationId,
    instruction: queueEvent.instruction,
  }, async () => ({ status: "sent", deliveryId: "queue-receipt" }));
  const queued = agentHostBridge.agentHost.queueEntries(sessionId);
  assert.equal(queued.length, 1, "explicit independent work is admitted through AgentHost queue");
  assert.equal(queued[0].content, queueEvent.instruction);
  assert.equal(queued[0].userMessageId, updates.at(-1).operation.userMessageId);
  assert.equal(queued[0].voiceOrigin.callId, callId);

  terminalSeen = true;
  agentHostBridge.agentHost.endTurn(sessionId, "runtime-turn-1", "completed");
  const terminal = await resultReceived;
  const deliveredQueuePrompt = await queuedPromptReceived;
  assert.equal(terminal.execution, "completed");
  assert.equal(terminal.resultState, "available");
  assert.equal(terminal.resultSummary, finalMessage.content);
  assert.ok(historyReadsAfterTerminal >= 2, "an empty first history read is retried before falling back");
  assert.equal(deliveredQueuePrompt.voiceOrigin.callId, callId);
  assert.equal(prompts.length, 2, "AgentHost drains explicitly queued work after the prior turn completes");
  assert.equal(agentHostBridge.agentHost.queueEntries(sessionId).length, 0);
  const resultWire = codexWorkFeedbackMessage(candidateEvent.delegationId, {
    feedbackId: "codex-production-result-1",
    callId,
    workBindingRevision: 3,
    operationId: terminal.operationId,
    kind: "result",
    delivery: "speak-when-idle",
    content: terminal.resultSummary,
  });
  assert.match(JSON.parse(resultWire).content[0].text, /The login flow correctly rejects expired credentials/u);

  assert.equal(invocationLog.filter((item) => item.channel === IPC.invoke.agentPrompt).length, 2);
  assert.equal(DESKTOP_PRINCIPAL.subject, "desktop");
});
