import { describe, it, expect } from "vitest";
import {
  validateBotNodeEndpoint,
  createRemotePluginApi,
} from "./remote-plugin.js";
import { createBotNodePort } from "./bot-node.js";
import type { TrustedPlugin } from "./trusted-plugin.js";

describe("fixed bot-node trust boundary", () => {
  it("keeps an explicitly pinned offline node honest and stops its retry timer", async () => {
    const remote = await createRemotePluginApi({
      url: "ws://127.0.0.1:1/v1/racp/ws",
      deviceToken: "pdt1.test",
      hostId: "host_offline",
      allowOfflineStartup: true,
      dataDir: "unused",
      manifest: { id: "local.pi-bot" },
    });
    try {
      expect(remote.state).not.toBe("connected");
      await remote.api.agent.registerTool({
        name: "bot_workbench",
        description: "Offline descriptor",
        schema: { type: "object" },
        execute: async () => {
          throw new Error("Cannot execute while offline");
        },
      });
      await expect(remote.api.models.list()).rejects.toMatchObject({
        errorCode: "HOST_DISCONNECTED",
      });
      await expect(
        remote.api.desktop.invoke({
          operation: "agent/prompt",
          args: [
            {
              sessionId: remote.qualifySessionId("s1"),
              content: "No replay",
              requestIntentId: "intent",
            },
          ],
        }),
      ).rejects.toMatchObject({ errorCode: "HOST_DISCONNECTED" });
    } finally {
      await remote.stop();
    }
    await expect(
      createRemotePluginApi({
        url: "ws://127.0.0.1:1/v1/racp/ws",
        deviceToken: "pdt1.test",
        allowOfflineStartup: true,
        dataDir: "unused",
        manifest: { id: "local.pi-bot" },
      }),
    ).rejects.toMatchObject({ code: "REMOTE_CONNECTION_FAILED" });
  });
  it("rejects non-private plaintext endpoints and credential-bearing URLs", () => {
    for (const url of [
      "ws://100.98.15.15/v1/racp/ws",
      "wss://user:password@example.test/ws",
      "wss://example.test/ws?token=secret",
      "wss://example.test/ws#token",
    ])
      expect(() => validateBotNodeEndpoint(url)).toThrow();
    expect(() =>
      validateBotNodeEndpoint("ws://127.0.0.1:8765/v1/racp/ws"),
    ).not.toThrow();
    expect(() =>
      validateBotNodeEndpoint("wss://new-bot-2.example.ts.net/v1/racp/ws"),
    ).not.toThrow();
  });
  it("requires attached connection and native provenance for nested tool calls", async () => {
    let registered: any;
    const plugin = {
      api: {
        agent: {
          registerTool: async (tool: any) => {
            registered = tool;
          },
          unregisterTool: async () => {},
        },
        events: { on: () => {}, off: () => {} },
        desktop: {
          invoke: async () => {
            throw new Error("Must not reach a desktop operation");
          },
        },
      },
      runAsWebUser: async (
        _principal: unknown,
        operation: () => Promise<unknown>,
      ) => operation(),
      runAsInvocation: async () => {
        throw new Error("Must not reach an invocation");
      },
    } as unknown as TrustedPlugin;
    const port = createBotNodePort(plugin, () => {});
    const peer = (id: string) => ({
      connectionId: id,
      principal: { subject: "owner", roles: ["owner" as const] },
      request: async <T>() => ({}) as T,
      isClosed: () => false,
    });
    await expect(port.invoke("botNode/models", {}, peer("a"))).rejects.toThrow(
      "Attach",
    );
    await port.invoke(
      "botNode/attach",
      { description: "Tool", schema: {} },
      peer("a"),
    );
    expect(registered.risk).toBe("medium");
    expect(registered.planSafeActions).toEqual([]);
    await expect(
      port.invoke(
        "botNode/attach",
        { description: "Tool", schema: {} },
        peer("b"),
      ),
    ).rejects.toThrow("already attached");
    await expect(
      port.invoke(
        "botNode/workerSend",
        { args: [{}], invocationId: "invented" },
        peer("a"),
      ),
    ).rejects.toThrow("expired");
    await expect(
      port.invoke(
        "botNode/sessionCreate",
        { args: [{ projectPath: "root", panelAuthorized: true }] },
        peer("a"),
      ),
    ).rejects.toThrow("Trusted context");
    port.release("a");
    await expect(port.invoke("botNode/models", {}, peer("a"))).rejects.toThrow(
      "Attach",
    );
  });
});
