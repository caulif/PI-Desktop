export type McpControlRisk = "read" | "write" | "dangerous";

export type McpControlOperation = {
  id: string;
  channel: string;
  description: string;
  risk: McpControlRisk;
  argumentShape: string[] | string;
  /**
   * Operation requires an authenticated first-party plugin context, so it is
   * excluded from the external MCP surface (tools/list, pi_control_describe and
   * the pi_desktop_invoke enum) while staying callable by plugins.
   */
  pluginOnly?: boolean;
};

export type McpControlInvokeInput = {
  operation: string;
  args?: readonly unknown[];
  confirm?: boolean;
  /** Internal origin used to keep plugin background work from stealing focus. */
  source?: "mcp" | "plugin";
  /** Supplied only by PluginRuntime, never copied from plugin/MCP arguments. */
  pluginContext?: { pluginId: string; sessionId?: string; turnId?: string; invocationId?: string; panelAuthorized?: boolean };
  signal?: AbortSignal;
};

