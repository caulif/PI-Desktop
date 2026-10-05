import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir } from "node:fs/promises";
import { APP_VERSION, BOT_NODE_DESKTOP_OPERATIONS } from "@pi-desktop/shared";
import {
  RacpClient,
  wsClientTransport,
  isLoopbackAddress,
} from "@pi-desktop/racp";
import type {
  PluginTool,
  TrustedPluginConfig,
  WebPrincipal,
  PluginConsent,
} from "./trusted-plugin.js";

export type RemotePluginConfig = {
  /** Fixed private WSS endpoint, or loopback WS for local testing. */
  url: string;
  deviceToken: string;
  /** Central-only data path. The node never opens the Bot domain store. */
  dataDir: string;
  manifest: TrustedPluginConfig["manifest"];
  settings?: Record<string, unknown>;
  /** Expected stable Host identity; required when reconnecting saved environments. */
  hostId?: string;
  /** Keep the central chat available when a previously paired node is unreachable. */
  allowOfflineStartup?: boolean;
  log?: (message: string) => void;
};
const error = (message: string, code = "PERMISSION_DENIED") =>
  Object.assign(new Error(message), { code, errorCode: code });
const wireByOperation = new Map(
  Object.entries(BOT_NODE_DESKTOP_OPERATIONS).map(([wire, operation]) => [
    operation as string,
    wire,
  ]),
);

export function validateBotNodeEndpoint(value: string): void {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "wss:" &&
      !(
        url.protocol === "ws:" &&
        (isLoopbackAddress(url.hostname) || url.hostname === "localhost")
      ))
  )
    throw error(
      "Use a fixed WSS endpoint or local loopback WS, without URL credentials or query",
      "INVALID_ARGUMENT",
    );
}

/** Reuses RACP authentication, permissions, reconnect and server request framing. */
export async function createRemotePluginApi(config: RemotePluginConfig) {
  validateBotNodeEndpoint(config.url);
  if (config.manifest.id !== "local.pi-bot")
    throw error("Only local.pi-bot can attach to a bot node");
  const context = new AsyncLocalStorage<string | undefined>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const controllers = new Map<
    string,
    { sessionId: string; controller: AbortController }
  >();
  let tool: PluginTool | undefined;
  let hostId = config.hostId ?? "";
  let descriptor = {
    description: "Installed pi-bot Workbench",
    schema: { type: "object" } as unknown,
  };
  let stopped = false;
  let ready = false;
  let retriesEnabled = false;
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const log = config.log ?? (() => undefined);
  const prefix = () => "node:" + hostId + ":";
  const qualifySessionId = (id: string) =>
    id.startsWith(prefix()) ? id : prefix() + id;
  const nativeSessionId = (id: string) => {
    if (!id.startsWith(prefix()) || id.length <= prefix().length)
      throw error("Session belongs to another execution node");
    return id.slice(prefix().length);
  };
  const sessionKeys = new Set([
    "sessionId",
    "targetSessionId",
    "sourceSessionId",
    "anchorSessionId",
    "inheritPermissionFromSessionId",
  ]);
  function map(
    value: unknown,
    direction: "in" | "out",
    key = "",
    parent = "",
  ): any {
    if (Array.isArray(value))
      return value.map((row) => map(row, direction, key, parent));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, row]) => [
          k,
          map(row, direction, k, key),
        ]),
      );
    if (typeof value !== "string" || !value) return value;
    const sessionField =
      sessionKeys.has(key) ||
      key === "sessionIds" ||
      (key === "id" && ["session", "sessions"].includes(parent));
    if (direction === "out" && sessionField) return qualifySessionId(value);
    if (direction === "in" && sessionField) return nativeSessionId(value);
    return value;
  }
  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  };
  const abortAll = (message: string) => {
    for (const { controller } of controllers.values())
      controller.abort(error(message, "HOST_DISCONNECTED"));
    controllers.clear();
  };
  const isNetworkError = (e: unknown) =>
    [
      "REMOTE_CONNECTION_FAILED",
      "HOST_DISCONNECTED",
      "AGENT_UNAVAILABLE",
    ].includes(
      String(
        (e as { code?: string; errorCode?: string })?.code ??
          (e as { errorCode?: string })?.errorCode,
      ),
    );
  const scheduleRetry = () => {
    if (!retriesEnabled || stopped || retryTimer || !config.hostId) return;
    retryTimer = setTimeout(
      () => {
        retryTimer = undefined;
        void connectAndAttach().catch((e) => {
          if (isNetworkError(e)) {
            retryAttempt++;
            scheduleRetry();
          } else {
            retriesEnabled = false;
            client.close();
            emit("node:state", {
              state: "error",
              hostId,
              code: (e as { code?: string }).code ?? "REMOTE_AUTH_FAILED",
            });
          }
        });
      },
      Math.min(10000, 500 * 2 ** Math.min(retryAttempt, 5)),
    );
    retryTimer.unref();
  };
  const client = new RacpClient({
    transport: wsClientTransport({
      url: config.url,
      token: config.deviceToken,
    }),
    client: { name: "pi-bot-central", version: APP_VERSION },
    requestTimeoutMs: 30 * 60 * 1000,
    reconnect: {
      enabled: true,
      baseDelayMs: 500,
      maxDelayMs: 10000,
      maxAttempts: 12,
    },
    log: (_level, message) => log(message),
    onStateChange: (state, cause) => {
      if (state !== "connected") {
        ready = false;
        abortAll("Node connection lost");
      }
      if (state === "error" && retriesEnabled) {
        if (isNetworkError(cause)) scheduleRetry();
        else retriesEnabled = false;
      }
      emit("node:state", { state, hostId });
    },
    onReconnected: async (active) => {
      if (active.initialized?.server.hostId !== hostId) {
        active.close();
        throw error("Node Host identity changed", "REMOTE_AUTH_FAILED");
      }
      await active.request("botNode/attach", descriptor);
      ready = true;
      emit("node:state", { state: "connected", hostId });
    },
    onServerRequest: async (method, raw) => {
      const packet = raw as {
        event?: string;
        payload?: unknown;
        args?: unknown;
        context?: {
          sessionId: string;
          turnId: string;
          mode: string;
          invocationId: string;
        };
      };
      if (method === "botNode/event") {
        const payload = map(packet.payload, "out");
        if (packet.event === "session:turnEnded") {
          const sid = (payload as { sessionId: string }).sessionId;
          for (const { sessionId, controller } of controllers.values())
            if (sessionId === sid)
              controller.abort(
                error("Native turn ended", "PLUGIN_TOOL_ABORTED"),
              );
        }
        emit(String(packet.event), payload);
        return { delivered: true };
      }
      if (
        method !== "botNode/toolExecute" ||
        !tool ||
        !packet.context?.invocationId
      )
        throw error("Unregistered server request", "UNSUPPORTED");
      const c = packet.context;
      const controller = new AbortController();
      const sessionId = qualifySessionId(c.sessionId);
      controllers.set(c.invocationId, { sessionId, controller });
      try {
        return await context.run(c.invocationId, () =>
          tool!.execute(map(packet.args, "out"), {
            sessionId,
            turnId: c.turnId,
            mode: c.mode,
            invocationId: c.invocationId,
            signal: controller.signal,
            log,
          }),
        );
      } finally {
        controllers.delete(c.invocationId);
      }
    },
  });
  async function connectAndAttach() {
    const initialized = await client.connect();
    const actual = initialized.server.hostId;
    if (!actual) {
      client.close();
      throw error(
        "Node did not return a stable Host identity",
        "PROTOCOL_MISMATCH",
      );
    }
    if (hostId && actual !== hostId) {
      client.close();
      throw error(
        "Node Host identity differs from the saved environment",
        "REMOTE_AUTH_FAILED",
      );
    }
    hostId = actual;
    await client.request("botNode/attach", descriptor);
    ready = true;
    retryAttempt = 0;
    emit("node:state", { state: "connected", hostId });
  }
  try {
    await connectAndAttach();
  } catch (e) {
    if (!config.allowOfflineStartup || !config.hostId || !isNetworkError(e)) {
      client.close();
      throw e;
    }
    retriesEnabled = true;
    scheduleRetry();
  }
  if (config.allowOfflineStartup && config.hostId && ready)
    retriesEnabled = true;
  const request = async (
    method: string,
    params: Record<string, unknown> = {},
    withContext = false,
  ): Promise<any> => {
    if (stopped) throw error("Remote node stopped", "HOST_DISCONNECTED");
    if (!ready)
      throw error(
        "Execution node is offline; no command was sent",
        "HOST_DISCONNECTED",
      );
    return map(
      await client.request(method, {
        ...map(params, "in"),
        ...(withContext && context.getStore()
          ? { invocationId: context.getStore() }
          : {}),
      }),
      "out",
    );
  };
  const api = {
    app: { getVersion: async () => APP_VERSION },
    plugin: {
      getId: () => "local.pi-bot",
      getManifest: () => config.manifest,
      getSettings: async () => config.settings ?? {},
      getDataPath: async () => {
        await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
        return config.dataDir;
      },
    },
    models: { list: () => request("botNode/models") },
    desktop: {
      listOperations: async () =>
        [...wireByOperation.keys()].map((id) => ({
          id,
          description: id,
          risk: id === "session/configure" ? "dangerous" : "write",
        })),
      invoke: async (input: {
        operation: string;
        args?: unknown[];
        confirm?: boolean;
      }) => {
        const wire = wireByOperation.get(input.operation);
        if (!wire)
          throw error(
            "Operation is not in the fixed bot-node catalog",
            "UNSUPPORTED",
          );
        let args = input.args ?? [];
        if (input.operation === "agent/getStatus")
          args = [nativeSessionId(String(args[0]))];
        if (input.operation === "session/configure")
          args = [nativeSessionId(String(args[0])), args[1]];
        // session/get uses {id}, whose outer position is not a session result.
        if (input.operation === "session/get") {
          const r = args[0] as Record<string, unknown>;
          args = [{ ...r, id: nativeSessionId(String(r.id)) }];
        }
        return request(
          wire,
          {
            args,
            ...(input.confirm !== undefined ? { confirm: input.confirm } : {}),
          },
          true,
        );
      },
    },
    agent: {
      complete: (
        input: Parameters<
          import("./trusted-plugin.js").TrustedPlugin["api"]["agent"]["complete"]
        >[0],
      ) => request("botNode/complete", input as Record<string, unknown>, true),
      registerTool: async (registered: PluginTool) => {
        if (registered.name !== "bot_workbench")
          throw error("Only bot_workbench is declared");
        tool = registered;
        descriptor = {
          description: registered.description,
          schema: registered.schema,
        };
        if (ready) await request("botNode/attach", descriptor);
      },
      unregisterTool: async (name: string) => {
        if (name === "bot_workbench") tool = undefined;
      },
    },
    fs: {
      readText: (path: string) =>
        request("botNode/fileReadText", { path }, true) as Promise<string>,
      stat: (path: string) => request("botNode/fileStat", { path }, true),
      list: (path: string) => request("botNode/fileList", { path }, true),
      writeText: async (path: string, content: string) => {
        await request("botNode/fileWriteText", { path, content }, true);
      },
      readRange: async (path: string, offset = 0, length = 524288) => {
        const result = await request(
          "botNode/fileReadRange",
          { path, offset, length },
          true,
        );
        return {
          bytes: new Uint8Array(Buffer.from(result.base64, "base64")),
          totalSize: Number(result.totalSize),
        };
      },
      openDefault: async () => {
        throw error(
          "Native file opening is not available on a bot node",
          "UNSUPPORTED",
        );
      },
    },
    events: {
      on: (event: string, listener: (payload: unknown) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(listener);
      },
      off: (event: string, listener: (payload: unknown) => void) => {
        listeners.get(event)?.delete(listener);
      },
    },
    log,
  };
  return {
    api,
    hostId,
    qualifySessionId,
    nativeSessionId,
    get state() {
      return ready
        ? "connected"
        : client.state === "connected"
          ? "connecting"
          : client.state;
    },
    navigation: () => request("botNode/navigation"),
    nativeSession: (sessionId: string) =>
      request("botNode/nativeSession", { sessionId }),
    authorizeSchedule: (definition: Record<string, unknown>) =>
      request("botNode/scheduleAuthorize", { definition }),
    adoptSession: (sessionId: string) =>
      request("botNode/sessionAdopt", { sessionId }),
    pendingNativeApprovals: () => request("botNode/pendingApprovals"),
    revokeDevice: (deviceId: string) => request("session/revoke", { deviceId }),
    pendingConsents: () =>
      request("botNode/consents") as Promise<PluginConsent[]>,
    approvals: (sessionId: string) =>
      request("botNode/approvals", { sessionId }),
    respondConsent: (
      _principal: WebPrincipal,
      id: string,
      hash: string,
      decision: "approve" | "deny",
    ) => request("botNode/consentRespond", { id, hash, decision }),
    respondApproval: (
      _principal: WebPrincipal,
      input: {
        id: string;
        sessionId: string;
        revision: number;
        decision: "allow-once" | "deny" | "approve" | "reject";
        requestId: string;
      },
    ) => request("botNode/approvalRespond", input),
    authorizeManualRoutine: (input: {
      requestIntentId: string;
      routineId: string;
      sessionId: string;
      contentHash: string;
      title: string;
    }) => request("botNode/manualAuthorize", input),
    runAsWebUser: <T>(principal: WebPrincipal, operation: () => Promise<T>) => {
      if (principal.userId !== "owner")
        throw error("Only the owner can control this node");
      return operation();
    },
    stop: async () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retriesEnabled = false;
      abortAll("Remote node stopped");
      client.close();
      listeners.clear();
      tool = undefined;
    },
  };
}
