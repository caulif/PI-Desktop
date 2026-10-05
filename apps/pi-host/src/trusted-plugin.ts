import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { APP_VERSION, IPC, resolveFsAccess } from "@pi-desktop/shared";
import {
  listReadyPluginModels,
  type ListedProvider,
  PluginToolInvocations,
  createScheduledRunner,
  invokePluginPrompt,
  invokePluginSchedule,
  invokePluginVerification,
  PLUGIN_VERIFICATION_OPERATIONS,
  consumePluginPromptAdmission,
  trustedPluginPromptRequest,
  type AgentSidecar,
  type HostProcess,
  type RuntimeService,
  type McpControlInvokeInput,
  listPendingToolRequests,
} from "@pi-desktop/host-runtime";
import type { AgentHost } from "@pi-desktop/agent-host";
import { completeOneShot } from "@pi-desktop/agent-runtime";
import type { LaunchResolver } from "@pi-desktop/host-runtime";
import { createTrustedFiles } from "./trusted-plugin-files.js";
export type WebPrincipal = {
  userId: "owner";
  deviceId: string;
};
export type TrustedPluginConfig = {
  manifest: {
    id: string;
    version?: unknown;
    permissions?: string[];
    [key: string]: unknown;
  };
  dataDir: string;
  workspaceRoots: readonly string[];
  settings?: Record<string, unknown>;
};
export type PluginTool = {
  name: string;
  description: string;
  schema: unknown;
  risk?: string;
  planSafeActions?: string[];
  execute: (
    args: unknown,
    context: {
      sessionId: string;
      turnId: string;
      mode: string;
      signal?: AbortSignal;
      invocationId?: string;
      log?: (message: string) => void;
    },
  ) => Promise<unknown>;
};
export type PluginConsent = {
  id: string;
  operation: string;
  args: readonly unknown[];
  hash: string;
  expiresAt: string;
  principal: WebPrincipal;
};
export type TrustedPluginDeps = {
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  runtime: RuntimeService;
  agentHost: AgentHost;
  launch?: LaunchResolver;
  log: (
    level: "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>,
  ) => void;
};
const fail = (message: string, code = "PERMISSION_DENIED"): never => {
  throw Object.assign(new Error(message), { code, errorCode: code });
};
const READS = [
  "session/list",
  "session/get",
  "providers/list",
  "agent/getStatus",
  "agent/promptLookup",
  "scheduled/pluginGet",
  "scheduled/pluginLookup",
  "scheduled/pluginSessionOwner",
  "session/collaboration/status",
  "session/collaboration/list",
  "session/collaboration/result",
  "session/collaboration/lookup",
];
const WRITES = [
  "session/create",
  "agent/prompt",
  "agent/promptInvalidate",
  "agent/steer",
  "agent/abort",
  "scheduled/pluginUpsert",
  "scheduled/pluginDisable",
  "scheduled/pluginStart",
  "scheduled/pluginSkip",
  "scheduled/pluginRetry",
  "session/collaboration/spawn",
  "session/collaboration/send",
  "session/collaboration/cancel",
];
/** Fixed administrator-installed first-party module; this is not a general plugin loader. */
export function createTrustedPlugin(
  config: TrustedPluginConfig,
  deps: TrustedPluginDeps,
) {
  if (config.manifest.id !== "local.pi-bot")
    fail("Only the explicitly installed local.pi-bot module is supported");
  if (!config.workspaceRoots.length)
    fail(
      "At least one registered workspace root is required",
      "INVALID_ARGUMENT",
    );
  const grants = new Set(config.manifest.permissions ?? []);
  for (const permission of ["desktop.control", "agent.tool.register"])
    if (!grants.has(permission))
      fail("Missing manifest permission: " + permission);
  const users = new AsyncLocalStorage<WebPrincipal | undefined>();
  const due = new AsyncLocalStorage<boolean>();
  const invocations = new PluginToolInvocations();
  const owner = {};
  const tools = new Map<string, PluginTool>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const manual = new Map<
    string,
    {
      requestIntentId: string;
      routineId: string;
      sessionId: string;
      contentHash: string;
      expiresAt: number;
    }
  >();
  const pending = new Map<
    string,
    {
      request: PluginConsent;
      resolve: (allowed: boolean) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let stopped = false;
  const pluginId = config.manifest.id;
  let completions = 0;
  const complete = async (input: {
    modelKey: string;
    system?: string;
    messages?: { role: "user" | "assistant"; content: string }[];
    includeSessionContext?: boolean;
  }) => {
    requireAuthority();
    if (!grants.has("agent.complete") || !deps.launch)
      fail("Completion is not enabled", "UNSUPPORTED");
    if (
      !input ||
      input.includeSessionContext !== false ||
      typeof input.modelKey !== "string" ||
      !Array.isArray(input.messages) ||
      input.messages.some(
        (m) =>
          !["user", "assistant"].includes(m.role) ||
          typeof m.content !== "string",
      ) ||
      Buffer.byteLength(JSON.stringify(input)) > 24576
    )
      fail("Invalid bounded independent completion", "INVALID_ARGUMENT");
    const listed = await api.models.list();
    const model = listed.find((m) => m.key === input.modelKey);
    if (!model) fail("Completion model is not ready", "MODEL_NOT_CONFIGURED");
    if (completions >= 2)
      fail("Completion concurrency limit reached", "AGENT_BUSY");
    completions++;
    try {
      const settings = await host().call<Record<string, unknown>>(
        "settings.get",
        {},
      );
      const resolved = await deps.launch!.resolve(
        "plugin-complete",
        {
          providerId: model!.providerId,
          modelId: model!.modelId,
          mode: "agent",
          thinkingLevel: "off",
        },
        settings,
      );
      const result = await completeOneShot(
        resolved.sidecarParams.provider,
        {
          systemPrompt: input.system,
          messages: input.messages!.map((m) => ({
            role: "user" as const,
            content:
              m.role === "assistant"
                ? "### Assistant\n" + m.content
                : m.content,
            timestamp: Date.now(),
          })),
        },
        "off",
        { signal: AbortSignal.timeout(90000) },
      );
      if (Buffer.byteLength(result.text) > 24576)
        fail("Completion output exceeds the bound", "INVALID_ARGUMENT");
      return { ...result, modelKey: input.modelKey };
    } finally {
      completions--;
    }
  };
  const host = (): HostProcess => {
    if (stopped) fail("Plugin stopped", "ABORTED");
    const h = deps.getHost();
    if (!h) fail("Host unavailable", "HOST_UNAVAILABLE");
    return h!;
  };
  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  };
  const context = () => invocations.current(owner);
  const requireAuthority = () => {
    const user = users.getStore();
    const tool = context();
    if (!user && !tool && !due.getStore())
      fail("Trusted Web principal or live tool invocation required");
    return { user, tool };
  };
  const owned = async (sessionId: string) => {
    const result = await host().call<{
      state: string;
    }>("scheduled.pluginSessionOwnership", { pluginId, sessionId });
    if (result.state !== "own") fail("Session is not owned by this plugin");
  };
  const consent = async (operation: string, args: readonly unknown[]) => {
    const principal = users.getStore();
    if (!principal) fail("Authenticated user consent is required");
    const frozen = JSON.parse(JSON.stringify(args)) as unknown[];
    const request: PluginConsent = {
      id: randomUUID(),
      operation,
      args: frozen,
      hash: createHash("sha256")
        .update(JSON.stringify({ operation, args: frozen }))
        .digest("hex"),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      principal: { ...principal! },
    };
    const allowed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(request.id);
        resolve(false);
      }, 300000);
      timer.unref();
      pending.set(request.id, { request, resolve, timer });
      emit("web:consent", request);
    });
    if (!allowed) fail("Operation denied or expired");
  };
  const prompt = async (request: Record<string, unknown>) => {
    const sessionId = String(request.sessionId ?? "");
    await owned(sessionId);
    const input = {
      sessionId,
      content: String(request.content ?? ""),
      effectivePermissionMode: "ask" as const,
      principal: {
        subject: users.getStore()?.deviceId ?? "plugin:" + pluginId,
        roles: ["owner" as const],
      },
    };
    const admission = consumePluginPromptAdmission(request);
    if (admission) trustedPluginPromptRequest(input, admission);
    const result = await deps.runtime.prompt(input);
    return { accepted: true, turnId: result.turnId };
  };
  const invoke = async (raw: {
    operation: string;
    args?: unknown[];
    confirm?: boolean;
  }) => {
    const operation = raw.operation,
      args = raw.args ?? [];
    if (
      ![
        ...READS,
        ...WRITES,
        "session/configure",
        ...PLUGIN_VERIFICATION_OPERATIONS.map((o) => o.id),
      ].includes(operation)
    )
      fail("Operation is not in the headless catalog", "UNSUPPORTED");
    const { user, tool } = context()
      ? { user: undefined, tool: context() }
      : { user: users.getStore(), tool: undefined };
    if (
      (WRITES.includes(operation) &&
        !["scheduled/pluginUpsert", "scheduled/pluginDisable"].includes(
          operation,
        )) ||
      operation === "session/configure"
    )
      requireAuthority();
    if (
      due.getStore() &&
      !user &&
      !tool &&
      ![
        "scheduled/pluginStart",
        "scheduled/pluginSkip",
        "scheduled/pluginRetry",
      ].includes(operation) &&
      !READS.includes(operation)
    )
      fail("Scheduler cannot invoke unrelated writes");
    const input: McpControlInvokeInput = {
      operation,
      args,
      source: "plugin",
      pluginContext: {
        pluginId,
        ...(user ? { panelAuthorized: true } : {}),
        ...(tool
          ? {
              sessionId: tool.sessionId,
              turnId: tool.turnId,
              invocationId: tool.id,
            }
          : {}),
      },
      ...(tool ? { signal: tool.signal } : {}),
    };
    const call = (method: string, params: Record<string, unknown>) =>
      host().call(method, params);
    const transport = async (channel: string, values: readonly unknown[]) => {
      if (channel === IPC.invoke.agentPrompt)
        return prompt(values[0] as Record<string, unknown>);
      if (channel === IPC.invoke.agentSteer) {
        const r = values[0] as Record<string, unknown>;
        await owned(String(r.sessionId));
        return deps.runtime.steer({
          sessionId: String(r.sessionId),
          turnId: String(r.expectedTurnId ?? r.turnId),
          content: String(r.content),
          principal: { subject: user?.deviceId ?? "plugin", roles: ["owner"] },
        });
      }
      fail("Unsupported plugin transport", "UNSUPPORTED");
    };
    if (operation.startsWith("agent/prompt") || operation === "agent/steer")
      return invokePluginPrompt(input, call, transport);
    if (operation.startsWith("scheduled/")) {
      if (
        operation === "scheduled/pluginUpsert" &&
        user &&
        (args[0] as { enabled?: boolean })?.enabled === true
      )
        await consent(operation, args);
      return invokePluginSchedule(
        input,
        call,
        transport,
        (_plugin, id, token, routineId, sessionId, contentHash) => {
          const record = manual.get(token);
          if (
            !record ||
            record.requestIntentId !== id ||
            record.routineId !== routineId ||
            record.sessionId !== sessionId ||
            record.contentHash !== contentHash ||
            record.expiresAt < Date.now()
          )
            return false;
          manual.delete(token);
          return true;
        },
      );
    }
    if (operation.startsWith("verification/")) {
      await files.checkRoot(
        String((args[0] as { projectPath?: string })?.projectPath ?? ""),
      );
      if (operation === "verification/approveCheck") requireAuthority();
      return invokePluginVerification(input, call, async (check) => {
        await consent(operation, [check]);
        return true;
      });
    }
    if (operation === "session/create") {
      const requested = args[0] as Record<string, unknown>;
      if (!requested || typeof requested !== "object")
        fail("Session object required", "INVALID_ARGUMENT");
      const requestedPath = String(requested.projectPath ?? "");
      await files.checkRoot(requestedPath);
      if (
        requested.inheritPermissionFromSessionId !== undefined &&
        requested.inheritPermissionFromSessionId !== tool?.sessionId
      )
        fail("Inheritance must name this live tool session");
      const result = await host().call<{
        session: {
          id: string;
        };
      }>("session.create", { ...requested, toolPolicy: "plugin-bot-scoped" });
      await host().call("scheduled.pluginRegisterCreatedSession", {
        pluginId,
        sessionId: result.session.id,
      });
      return result;
    }
    if (operation === "session/configure") {
      const sessionId = String(args[0]);
      await owned(sessionId);
      if (raw.confirm !== true)
        fail("confirm=true required", "CONFIRMATION_REQUIRED");
      await consent(operation, args);
      return host().call("session.configure", {
        ...(args[1] as Record<string, unknown>),
        id: sessionId,
      });
    }
    if (operation === "session/list") return host().call("session.list", {});
    if (operation === "session/get")
      return host().call("session.get", args[0] as Record<string, unknown>);
    if (operation === "providers/list")
      return host().call("providers.list", {});
    if (operation === "agent/getStatus") {
      const sessionId = String(args[0]);
      await owned(sessionId);
      return (
        deps.getSidecar()?.call("agent.getStatus", { sessionId }) ??
        fail("Agent unavailable", "HOST_UNAVAILABLE")
      );
    }
    if (operation === "agent/abort") {
      const request = args[0] as Record<string, unknown>;
      await owned(String(request.sessionId));
      if (
        deps.runtime.activeTurnId(String(request.sessionId)) !==
        String(request.turnId)
      )
        return { ok: false, aborted: false };
      await deps.runtime.abort(
        String(request.sessionId),
        String(request.turnId),
      );
      return { ok: true, aborted: true };
    }
    if (operation.startsWith("session/collaboration/"))
      return collaboration(input);
    fail("Unsupported operation", "UNSUPPORTED");
  };
  const files = createTrustedFiles(
    config.workspaceRoots,
    async () => {
      const current = context();
      if (!current) return config.workspaceRoots[0]!;
      const result = await host().call<{
        session?: {
          projectPath?: string;
        };
      }>("session.get", { id: current.sessionId, messageLimit: 1 });
      return result.session?.projectPath ?? fail("Tool session has no project");
    },
    resolveFsAccess({
      permissions: config.manifest.permissions,
      fs: config.manifest.fs,
    }),
  );
  async function dispatch(message: {
    id: string;
    targetSessionId: string;
    content: string;
    status: string;
    turnId?: string;
  }) {
    if (message.status === "queued")
      await deps.agentHost.startTurn(
        { subject: "plugin:" + pluginId, roles: ["controller"] },
        {
          sessionId: message.targetSessionId,
          input: { text: message.content, sessionMessageId: message.id },
          admission: "queue",
          idempotencyKey: "session-message:" + message.id,
          context: { requestId: "session-message:" + message.id },
        },
      );
    const r = await host().call<{
      message: typeof message;
    }>("session.collaboration.message", { messageId: message.id });
    return {
      sessionId: r.message.targetSessionId,
      messageId: r.message.id,
      status: r.message.status,
      turnId: r.message.turnId,
    };
  }
  async function collaboration(input: McpControlInvokeInput) {
    const operation = input.operation.split("/").at(-1)!;
    const data = input.args?.[0] as Record<string, unknown>;
    if (!data || typeof data !== "object")
      fail("Collaboration object required", "INVALID_ARGUMENT");
    if (["status", "list", "result", "lookup"].includes(operation))
      return host().call("session.collaboration." + operation, {
        ...data,
        pluginId,
      });
    const tool = context();
    if (operation === "send" || operation === "spawn") {
      if (
        !tool?.turnId ||
        deps.runtime.activeTurnId(tool.sessionId) !== tool.turnId
      )
        fail("Sending requires a live Agent tool invocation");
      let model: { providerId: string; modelId: string } | undefined;
      if (operation === "spawn") {
        const [listed, settings] = await Promise.all([
          host().call<{ providers: ListedProvider[] }>("providers.list", {}),
          host().call<Record<string, unknown>>("settings.get", {}),
        ]);
        const models = listReadyPluginModels(listed.providers, settings);
        const chosen = data.modelKey
          ? models.find((m) => m.key === data.modelKey)
          : (models.find((m) => m.availableForSubagents) ??
            models.find((m) => m.isDefault));
        if (!chosen) fail("No configured worker model", "MODEL_NOT_CONFIGURED");
        if (
          data.modelKey &&
          !chosen!.isDefault &&
          !chosen!.availableForSubagents
        )
          fail("Model is not enabled for AI delegation");
        model = { providerId: chosen!.providerId, modelId: chosen!.modelId };
      }
      const r = await host().call<{
        message: {
          id: string;
          targetSessionId: string;
          content: string;
          status: string;
        };
      }>("session.collaboration." + operation, {
        ...data,
        ...(operation === "spawn" ? { ...model, content: data.task } : {}),
        pluginId,
        sourceSessionId: tool!.sessionId,
        sourceTurnId: tool!.turnId,
      });
      return dispatch(r.message);
    }
    if (operation === "cancel") {
      const r = await host().call<{
        sessionId: string;
        messageIds: string[];
        runningTurnIds: string[];
      }>("session.collaboration.cancel", {
        ...data,
        pluginId,
        ...(tool ? { sourceSessionId: tool.sessionId } : {}),
      });
      for (const turnId of r.runningTurnIds)
        if (deps.runtime.activeTurnId(r.sessionId) === turnId)
          await deps.runtime.abort(r.sessionId, turnId);
      return { sessionId: r.sessionId, cancelled: true, sessionRetained: true };
    }
    fail("Operation unavailable", "UNSUPPORTED");
  }
  const fullName = (name: string) =>
    "plugin_" +
    pluginId.replace(/[^a-zA-Z0-9_]/g, "_") +
    "_" +
    name.replace(/[^a-zA-Z0-9_]/g, "_");
  let detachHost: (() => void) | undefined;
  const attach = (currentHost: HostProcess) => {
    detachHost?.();
    detachHost = currentHost.onNotification((method, payload) => {
      if (method !== "plugins.execute") return;
      const input = payload as {
        executionId: string;
        toolName: string;
        sessionId: string;
        turnId: string;
        args: unknown;
        mode: string;
      };
      const tool = [...tools.values()].find(
        (t) => fullName(t.name) === input.toolName,
      );
      if (!tool) return;
      void (async () => {
        try {
          if (
            deps.getHost() !== currentHost ||
            deps.runtime.activeTurnId(input.sessionId) !== input.turnId
          )
            fail("Tool does not own the active turn");
          await owned(input.sessionId);
          const invocation = invocations.begin(owner, {
            pluginId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            toolName: tool.name,
          });
          try {
            const result = await invocations.run(owner, invocation.id, () =>
              Promise.resolve(
                tool.execute(input.args, {
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  mode: input.mode,
                  invocationId: invocation.id,
                  signal: invocation.signal,
                  log: (message) => deps.log("info", message),
                }),
              ),
            );
            await currentHost.call("plugins.resolveExecution", {
              executionId: input.executionId,
              ok: true,
              content: result,
            });
          } finally {
            invocations.finish(invocation);
          }
        } catch (error) {
          await currentHost
            .call("plugins.resolveExecution", {
              executionId: input.executionId,
              ok: false,
              errorCode:
                (
                  error as {
                    code?: string;
                  }
                ).code ?? "TOOL_FAILED",
              content: "Plugin execution failed",
            })
            .catch(() =>
              deps.log(
                "error",
                "Plugin execution failure could not be persisted to Host",
              ),
            );
        }
      })();
    });
  };
  const detach = deps.runtime.onTurnEnded((info) => {
    invocations.cancelSession(info.sessionId, "Turn ended");
    emit("session:turnEnded", info);
    if (info.settled)
      void host()
        .call("session.collaboration.settle", { turnId: info.turnId })
        .then(async () => {
          const pending = await host().call<{
            messages: Parameters<typeof dispatch>[0][];
          }>("session.collaboration.pending", {});
          for (const message of pending.messages) await dispatch(message);
        })
        .catch(() =>
          deps.log("warn", "plugin collaboration reconciliation failed"),
        );
  });
  const scheduler = createScheduledRunner({
    getHost: deps.getHost,
    execute: async () =>
      fail(
        "Native scheduled tasks are not registered by this plugin",
        "UNSUPPORTED",
      ),
    report: () => deps.log("warn", "headless plugin scheduler poll failed"),
    deliverPluginDue: (occurrence) => {
      if (occurrence.pluginId === pluginId)
        due.run(true, () => emit("scheduled:pluginDue", occurrence));
    },
  });
  const api = {
    models: {
      list: async () => {
        const [listed, settings] = await Promise.all([
          host().call<{ providers: ListedProvider[] }>("providers.list", {}),
          host().call<Record<string, unknown>>("settings.get", {}),
        ]);
        return listReadyPluginModels(listed.providers, settings);
      },
    },
    app: { getVersion: async () => APP_VERSION },
    plugin: {
      getId: () => pluginId,
      getManifest: () => config.manifest,
      getSettings: async () => config.settings ?? {},
      getDataPath: async () => {
        await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
        return config.dataDir;
      },
    },
    desktop: {
      invoke,
      listOperations: async () =>
        [
          ...READS,
          ...WRITES,
          "session/configure",
          ...PLUGIN_VERIFICATION_OPERATIONS.map((o) => o.id),
        ].map((id) => ({
          id,
          description: id,
          risk:
            id === "session/configure"
              ? "dangerous"
              : READS.includes(id)
                ? "read"
                : "write",
        })),
    },
    agent: {
      complete,
      registerTool: async (tool: PluginTool) => {
        if (tool.name !== "bot_workbench")
          fail("Undeclared headless plugin tool");
        tools.set(tool.name, tool);
        const current = deps.getHost();
        if (current) attach(current);
      },
      unregisterTool: async (name: string) => {
        tools.delete(name);
      },
    },
    fs: files.api,
    events: {
      on: (event: string, listener: (payload: unknown) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(listener);
      },
      off: (event: string, listener: (payload: unknown) => void) => {
        listeners.get(event)?.delete(listener);
      },
    },
    log: (message: string) => deps.log("info", message),
  };
  async function navigation() {
    const [p, s] = await Promise.all([
      host().call<{
        projects: {
          id: number;
          name: string;
          path: string;
        }[];
      }>("projects.list", {}),
      host().call<{
        sessions: {
          id: string;
          title: string;
          projectPath?: string;
        }[];
      }>("session.list", {}),
    ]);
    const projects = [] as {
      id: string;
      name: string;
      path: string;
    }[];
    for (const row of p.projects) {
      try {
        await files.checkRoot(row.path);
        projects.push({ id: String(row.id), name: row.name, path: row.path });
      } catch (error) {
        if ((error as { code?: string }).code !== "PERMISSION_DENIED")
          throw error;
      }
    }
    return {
      projects: projects.map(({ path, ...row }) => row),
      sessions: s.sessions
        .filter(
          (row) =>
            row.projectPath && projects.some((p) => p.path === row.projectPath),
        )
        .map((row) => ({
          id: row.id,
          title: row.title,
          projectId:
            projects.find((p) => p.path === row.projectPath)?.id ?? null,
        })),
    };
  }
  async function nativeSession(id: string) {
    const allowed = await navigation();
    if (!allowed.sessions.some((s) => s.id === id))
      fail("Session is outside registered projects");
    return host().call("session.get", { id, messageLimit: 100 });
  }
  async function authorizeManualRoutine(request: {
    requestIntentId: string;
    routineId: string;
    sessionId: string;
    contentHash: string;
    title: string;
  }) {
    requireAuthority();
    await owned(request.sessionId);
    if (
      !/^[a-f0-9]{64}$/.test(request.contentHash) ||
      !request.requestIntentId ||
      !request.routineId
    )
      fail("Invalid Routine authorization", "INVALID_ARGUMENT");
    await consent("scheduled/manualRun", [request]);
    const token = randomUUID();
    manual.set(token, { ...request, expiresAt: Date.now() + 60000 });
    return { manualToken: token };
  }
  async function approvals(sessionId: string) {
    await owned(sessionId);
    const snapshot = await deps.agentHost.snapshot(sessionId);
    const requests = await listPendingToolRequests(deps.getHost, sessionId);
    return snapshot.pendingApprovals.map((approval) => ({
      ...approval,
      args: requests.find((request) => request.requestId === approval.id)
        ?.argsPreview,
    }));
  }
  async function respondApproval(
    principal: WebPrincipal,
    input: {
      id: string;
      sessionId: string;
      revision: number;
      decision: "allow-once" | "deny" | "approve" | "reject";
      requestId: string;
    },
  ) {
    await owned(input.sessionId);
    const pending = await approvals(input.sessionId);
    if (!pending.some((a) => a.id === input.id))
      fail("Approval not in this session", "CONFLICT");
    return deps.agentHost.respondApproval(
      { subject: principal.deviceId, roles: ["approver"] },
      {
        approvalId: input.id,
        decision: input.decision,
        context: {
          requestId: input.requestId,
          expectedRevision: input.revision,
        },
      },
    );
  }
  async function pendingNativeApprovals() {
    const result = await host().call<{ sessions: { id: string }[] }>(
      "session.list",
      {},
    );
    const found = [];
    for (const session of result.sessions) {
      const ownership = await host().call<{ state: string }>(
        "scheduled.pluginSessionOwnership",
        { pluginId, sessionId: session.id },
      );
      if (ownership.state === "own")
        found.push(...(await approvals(session.id)));
    }
    return found;
  }
  return {
    authorizeSchedule: (definition: Record<string, unknown>) => {
      if (definition.enabled !== true)
        fail("Enabled definition required", "INVALID_ARGUMENT");
      return invoke({
        operation: "scheduled/pluginUpsert",
        args: [definition],
      });
    },
    adoptSession: async (sessionId: string) => {
      requireAuthority();
      const r = await host().call<{ session?: { projectPath?: string } }>(
        "session.get",
        { id: sessionId, messageLimit: 1 },
      );
      await files.checkRoot(r.session?.projectPath ?? "");
      await consent("scheduled/adoptSession", [{ sessionId }]);
      return invokePluginSchedule(
        {
          operation: "scheduled/pluginAdoptSession",
          args: [{ sessionId }],
          source: "plugin",
          pluginContext: { pluginId, panelAuthorized: true },
        },
        (method, params) => host().call(method, params),
        async () => fail("Unsupported", "UNSUPPORTED"),
        () => false,
      );
    },
    pendingNativeApprovals,
    runAsInvocation: <T>(id: string, operation: () => Promise<T>) =>
      invocations.run(owner, id, operation),
    api,
    attach,
    authorizeManualRoutine,
    approvals,
    respondApproval,
    navigation,
    nativeSession,
    readArtifactFile: files.read,
    toolCatalog: () =>
      [...tools.values()].map((t) => ({
        name: fullName(t.name),
        description: t.description,
        parameters: t.schema,
        risk: t.risk,
        planSafeActions: t.planSafeActions,
      })),
    start: () => scheduler.start(),
    runAsWebUser: <T>(principal: WebPrincipal, callback: () => Promise<T>) => {
      if (
        principal.userId !== "owner" ||
        !principal.deviceId ||
        principal.deviceId.length > 256
      )
        fail("Invalid trusted Web principal");
      return users.run({ ...principal }, callback);
    },
    pendingConsents: () => [...pending.values()].map((p) => p.request),
    respondConsent: (
      principal: WebPrincipal,
      id: string,
      hash: string,
      decision: "approve" | "deny",
    ) => {
      const p = pending.get(id);
      if (
        !p ||
        p.request.hash !== hash ||
        p.request.principal.userId !== principal.userId ||
        Date.parse(p.request.expiresAt) <= Date.now()
      )
        fail("Consent is unavailable or changed", "CONFLICT");
      pending.delete(id);
      clearTimeout(p!.timer);
      p!.resolve(decision === "approve");
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      scheduler.stop();
      detach();
      invocations.cancelOwner(owner, "Plugin stopped");
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.resolve(false);
      }
      pending.clear();
      detachHost?.();
      manual.clear();
      tools.clear();
      listeners.clear();
    },
  };
}
export type TrustedPlugin = ReturnType<typeof createTrustedPlugin>;
