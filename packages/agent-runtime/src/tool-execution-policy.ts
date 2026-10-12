/** Internal scheduling metadata, never a permission or plugin capability declaration. */
export type ToolPolicyOrigin = "builtin" | "plugin" | "extension";
export type ToolExecutionOwner = "host" | "runtime" | "electron" | "runtime-network" | "host-electron-bridge" | "extension" | "unknown";
export type ToolLifecycle =
  | "blocking-file-drain" | "process-cancel" | "host-state-commit"
  | "desktop-local" | "desktop-authorized-network" | "provider-signal"
  | "runtime-state" | "user-answer-wait" | "delegation-lifecycle"
  | "host-dispatch-timeout" | "extension-owned" | "executor-owned";
export type ToolExecutionPolicy = Readonly<{
  executionMode: "parallel" | "sequential";
  owner: ToolExecutionOwner;
  lifecycle: ToolLifecycle;
}>;

function policy(executionMode: ToolExecutionPolicy["executionMode"], owner: ToolExecutionOwner, lifecycle: ToolLifecycle): ToolExecutionPolicy {
  return Object.freeze({ executionMode, owner, lifecycle });
}

// Lifecycle names describe existing ownership, not newly guaranteed cancellation.
// See docs/adr/tool-policy-registry.md for the actual executor and cleanup paths.
export const BUILTIN_TOOL_POLICIES = Object.freeze({
  Read: policy("parallel", "host", "blocking-file-drain"),
  Glob: policy("parallel", "host", "blocking-file-drain"),
  Grep: policy("parallel", "host", "blocking-file-drain"),
  Write: policy("parallel", "host", "blocking-file-drain"),
  Edit: policy("sequential", "host", "blocking-file-drain"),
  Bash: policy("sequential", "host", "process-cancel"),
  TodoWrite: policy("sequential", "host", "host-state-commit"),
  ScheduledTaskList: policy("sequential", "host", "host-state-commit"),
  ScheduledTaskCreate: policy("sequential", "host", "host-state-commit"),
  ScheduledTaskUpdate: policy("sequential", "host", "host-state-commit"),
  ScheduledTaskDelete: policy("sequential", "host", "host-state-commit"),
  PluginCheck: policy("sequential", "electron", "desktop-local"),
  PluginScaffold: policy("sequential", "electron", "desktop-local"),
  PluginPack: policy("sequential", "electron", "desktop-local"),
  BrowserPreview: policy("sequential", "electron", "desktop-local"),
  Skill: policy("sequential", "electron", "desktop-local"),
  GenerateImages: policy("sequential", "host-electron-bridge", "desktop-authorized-network"),
  JevClassify: policy("sequential", "runtime-network", "provider-signal"),
  ToolSearch: policy("sequential", "runtime", "runtime-state"),
  new_context: policy("sequential", "runtime", "runtime-state"),
  asktool: policy("sequential", "runtime", "user-answer-wait"),
  EnterPlanMode: policy("sequential", "runtime", "host-state-commit"),
  EnterGoalMode: policy("sequential", "runtime", "host-state-commit"),
  SubmitPlan: policy("sequential", "runtime", "host-state-commit"),
  SubmitGoal: policy("sequential", "runtime", "host-state-commit"),
  Task: policy("parallel", "runtime", "delegation-lifecycle"),
  TaskWait: policy("sequential", "runtime", "delegation-lifecycle"),
  TaskList: policy("sequential", "runtime", "runtime-state"),
  TaskStop: policy("sequential", "runtime", "delegation-lifecycle"),
} satisfies Record<string, ToolExecutionPolicy>);

export function builtinToolPolicy(name: string): ToolExecutionPolicy | undefined {
  return Object.hasOwn(BUILTIN_TOOL_POLICIES, name)
    ? BUILTIN_TOOL_POLICIES[name as keyof typeof BUILTIN_TOOL_POLICIES]
    : undefined;
}

export function requireBuiltinToolPolicy(name: string): ToolExecutionPolicy {
  const registered = builtinToolPolicy(name);
  if (!registered) throw new Error(`Builtin tool ${name} requires an explicit execution policy`);
  return registered;
}

const pluginFallback = policy("sequential", "host-electron-bridge", "host-dispatch-timeout");
const extensionFallback = policy("sequential", "extension", "extension-owned");
const unknownFallback = policy("sequential", "unknown", "executor-owned");

export function toolExecutionPolicy(name: string, origin: ToolPolicyOrigin = "builtin"): ToolExecutionPolicy {
  // Provenance wins over a name: dynamic tools cannot borrow Read's policy.
  if (origin === "extension") return extensionFallback;
  if (origin === "plugin" || name.startsWith("plugin_") || name.startsWith("mcp_")) return pluginFallback;
  return builtinToolPolicy(name) ?? unknownFallback;
}

/** Batch policy only: this does not grant permissions or coordinate other agents. */
export function toolExecutionMode(name: string, origin: ToolPolicyOrigin = "builtin"): "parallel" | "sequential" {
  return toolExecutionPolicy(name, origin).executionMode;
}
