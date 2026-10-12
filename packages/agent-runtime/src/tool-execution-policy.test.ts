import { describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { DesktopAgentRuntime } from "./runtime.js";
import { BUILTIN_TOOL_POLICIES, builtinToolPolicy, requireBuiltinToolPolicy, toolExecutionPolicy } from "./tool-execution-policy.js";

function runtime(mode: "agent" | "plan" | "goal") {
  return new DesktopAgentRuntime({
    sessionId: "policy-coverage", mode, thinkingLevel: "off",
    provider: { id: "local", name: "Local", modelId: "local-model", baseUrl: "http://127.0.0.1:1",
      apiKey: "", authKind: "none", supportsReasoning: false, supportedThinkingLevels: ["off"] },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    jevApiKey: "fixture-only", pluginSkills: [{ id: "fixture/skill", name: "Skill" }],
    subagents: [{ name: "reader", description: "Read", tools: ["Read"], prompt: "Read", source: "builtin" }],
    host: { call: vi.fn() } as never, onEvent: vi.fn(),
  });
}

describe("complete tool execution registry", () => {
  it("registers every built-in across modes and conditional capabilities", async () => {
    const found = new Set<string>();
    for (const mode of ["agent", "plan", "goal"] as const) {
      const instance = runtime(mode);
      try {
        for (const [name, tool] of (instance as any).toolCatalog) {
          found.add(name);
          const registered = requireBuiltinToolPolicy(name);
          expect(tool.executionMode).toBe(registered.executionMode);
          expect(registered.owner).toBeTruthy();
          expect(registered.lifecycle).toBeTruthy();
        }
      } finally { await instance.dispose(); }
    }
    expect([...found].sort()).toEqual(Object.keys(BUILTIN_TOOL_POLICIES).sort());
    expect(() => requireBuiltinToolPolicy("NewBuiltinWithoutPolicy")).toThrow("explicit execution policy");
    expect(builtinToolPolicy("toString")).toBeUndefined();
  });

  it("keeps plugin/MCP/extension and unknown tools sequential independent of risk or names", async () => {
    for (const name of ["plugin_query", "mcp_search", "future_tool"]) {
      expect(toolExecutionPolicy(name).executionMode).toBe("sequential");
    }
    expect(toolExecutionPolicy("Read", "plugin")).toMatchObject({ executionMode: "sequential", owner: "host-electron-bridge" });
    expect(toolExecutionPolicy("Read", "extension")).toMatchObject({ executionMode: "sequential", owner: "extension" });
    const instance = runtime("agent");
    const internal = instance as any;
    internal.pluginTools = [{ name: "plugin_query", risk: "low" }, { name: "mcp_search", risk: "low" }];
    internal.extensionRunner = { getAgentTools: () => [{ name: "Read", label: "extension", description: "extension",
      parameters: Type.Object({}), executionMode: "parallel", execute: async () => ({ content: [], details: {} }) }] };
    try {
      internal.rebuildToolCatalog();
      expect(internal.toolCatalog.get("Read").executionMode).toBe("sequential");
      internal.activateDeferredTools(["plugin_query", "mcp_search"]);
      for (const tool of internal.activeTools()) {
        if (["plugin_query", "mcp_search"].includes(tool.name)) expect(tool.executionMode).toBe("sequential");
      }
      internal.rebuildToolCatalog();
      expect(internal.toolCatalog.get("mcp_search").executionMode).toBe("sequential");
    } finally {
      internal.extensionRunner = undefined;
      await instance.dispose();
    }
  });
});
