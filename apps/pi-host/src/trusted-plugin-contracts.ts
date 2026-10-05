import type {
  AgentSidecar,
  HostProcess,
  RuntimeService,
  LaunchResolver,
} from "@pi-desktop/host-runtime";
import type { AgentHost } from "@pi-desktop/agent-host";
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
export const fail = (message: string, code = "PERMISSION_DENIED"): never => {
  throw Object.assign(new Error(message), { code, errorCode: code });
};
export const READS = [
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
export const WRITES = [
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
