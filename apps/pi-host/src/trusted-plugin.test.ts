import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTrustedPlugin,
  type TrustedPluginDeps,
} from "./trusted-plugin.js";
import { createTrustedFiles } from "./trusted-plugin-files.js";
import { AgentHost } from "@pi-desktop/agent-host";
import { createBotNodePort } from "./bot-node.js";
async function fixture(approvalLifetimeMs = 120_000) {
  const root = await mkdtemp(join(tmpdir(), "pi-trusted-"));
  const calls: { method: string; params: any }[] = [];
  let listener: ((m: string, p: unknown) => void) | undefined;
  const h = {
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "scheduled.pluginSessionOwnership")
        return { state: params.sessionId === "other-session" ? "other" : "own" };
      if (method === "session.configure")
        return {
          session: { id: params.id, permissionMode: params.permissionMode },
        };
      return {};
    },
    onNotification: (l: any) => {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
  };
  const abort = vi.fn(async () => {});
  const native = new AgentHost({
    runtime: { prompt: async () => ({ turnId: "turn-1" }), stop: async () => ({ requested: true }), abort, respondInput: async () => {} },
    sessions: { get: async (id) => ({ id, title: id, mode: "agent", permissionMode: "ask", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), history: async () => ({ items: [], hasMore: false }) },
    approvals: { resolveTool: async () => {}, resolveContract: async () => {}, listPendingTools: async () => [] },
    localApprovalLifetimeMs: approvalLifetimeMs,
  });
  const deps = {
    getHost: () => h,
    getSidecar: () => null,
    runtime: {
      onTurnEnded: () => () => {},
      activeTurnId: () => "turn-1",
      abort,
    },
    agentHost: native,
    log: () => {},
  } as unknown as TrustedPluginDeps;
  const plugin = createTrustedPlugin(
    {
      manifest: {
        id: "local.pi-bot",
        permissions: ["desktop.control", "agent.tool.register"],
      },
      dataDir: join(root, "state"),
      workspaceRoots: [root],
    },
    deps,
  );
  return {
    root,
    calls,
    host: h,
    plugin,
    abort,
    native,
    notify: (m: string, p: unknown) => listener?.(m, p),
    close: async () => {
      plugin.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
describe("headless first-party broker", () => {
  it.each(["tool", "plan", "goal"] as const)("bridges actual AgentHost %s approvals and external settlement without leaking native payloads", async (kind) => {
    const f = await fixture();
    try {
      const events: unknown[] = [];
      f.plugin.api.events.on("host.changed", (payload) => events.push(payload));
      const ingest = (sessionId: string, id: string) => {
        f.native.ingest({ sessionId, turnId: "native-turn-" + sessionId, ts: Date.now(), event: { type: "agent_start" } });
        f.native.ingest({ sessionId, turnId: "native-turn-" + sessionId, ts: Date.now(), event: kind === "tool" ? { type: "tool_permission_request", request: { requestId: id, sessionId, toolName: "Bash", toolCallId: "tool-1", argsPreview: { command: "private-command" }, risk: "high", reason: "private-reason" } } : { type: "planning_state", state: "awaiting_approval", kind, proposalId: id, title: "private-title", question: "private-question", version: 1 } });
      };
      ingest("other-session", "other-approval");
      ingest("s1", "own-approval");
      await vi.waitFor(() => expect(events).toEqual([{ sessionId: "s1", reason: "approvals" }]));
      expect(f.native.pendingApprovals("s1")).toHaveLength(1);
      expect(await f.plugin.approvals("s1")).toMatchObject([{ id: "own-approval", kind, sessionId: "s1" }]);
      await expect(f.plugin.approvals("other-session")).rejects.toThrow("not owned");
      expect(f.native.pendingApprovals("s1")[0]?.expiresAt).not.toBeUndefined();
      f.native.settleApprovalExternally("own-approval", { status: "resolved", decision: kind === "tool" ? "deny" : "reject" });
      await vi.waitFor(() => expect(events).toHaveLength(2));
      expect(f.native.pendingApprovals("s1")).toEqual([]);
      expect(await f.plugin.approvals("s1")).toEqual([]);
      expect(JSON.stringify(events)).not.toContain("private");
      f.plugin.stop();
      ingest("s1", "after-stop");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(events).toHaveLength(2);
    } finally { await f.close(); }
  });
  it("forwards real native approval creation and cancellation to only the attached node peer and detaches on release", async () => {
    const f = await fixture();
    const delivered: any[] = [];
    const peer = { connectionId: "central-1", principal: { subject: "central-owner", roles: ["owner" as const] }, isClosed: () => false, request: async (method: string, payload: unknown) => { delivered.push({ method, payload }); return {}; } };
    const port = createBotNodePort(f.plugin, () => {});
    try {
      await port.invoke("botNode/attach", { description: "test", schema: { type: "object" } }, peer);
      f.native.ingest({ sessionId: "s1", turnId: "rt1", ts: Date.now(), event: { type: "agent_start" } });
      f.native.ingest({ sessionId: "s1", turnId: "rt1", ts: Date.now(), event: { type: "planning_state", state: "awaiting_approval", kind: "goal", proposalId: "p1", title: "private", question: "private" } });
      await vi.waitFor(() => expect(delivered).toEqual([{ method: "botNode/event", payload: { event: "host.changed", payload: { sessionId: "s1", reason: "approvals" } } }]));
      f.native.ingest({ sessionId: "s1", turnId: "rt1", ts: Date.now(), event: { type: "agent_end", messageIds: [] } });
      await vi.waitFor(() => expect(delivered).toHaveLength(2));
      expect(f.native.pendingApprovals("s1")).toEqual([]);
      port.release(peer.connectionId);
      f.native.ingest({ sessionId: "s1", turnId: "rt2", ts: Date.now(), event: { type: "planning_state", state: "awaiting_approval", kind: "plan", proposalId: "p2", title: "private", question: "private" } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(delivered).toHaveLength(2);
    } finally { port.release(peer.connectionId); await f.close(); }
  });
  it("refreshes at actual native approval expiry without changing local approval lifetime", async () => {
    const f = await fixture(150);
    try {
      const events: unknown[] = [];
      f.plugin.api.events.on("host.changed", (payload) => events.push(payload));
      const before = Date.now();
      f.native.ingest({ sessionId: "s1", turnId: "rt1", ts: before, event: { type: "planning_state", state: "awaiting_approval", kind: "goal", proposalId: "expiry", title: "title", question: "?" } });
      expect(Date.parse(f.native.pendingApprovals("s1")[0]!.expiresAt) - before).toBeLessThan(200);
      await vi.waitFor(() => expect(events).toHaveLength(2));
      expect(f.native.pendingApprovals("s1")).toEqual([]);
    } finally { await f.close(); }
  });
  it("cancels expiry timers and detaches the native observer on stop", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    try {
      f.native.ingest({ sessionId: "s1", ts: Date.now(), event: { type: "planning_state", state: "awaiting_approval", kind: "goal", proposalId: "p1", title: "title", question: "?" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      const callCount = f.calls.length;
      f.plugin.stop();
      expect(vi.getTimerCount()).toBe(0);
      f.native.ingest({ sessionId: "s1", ts: Date.now(), event: { type: "planning_state", state: "awaiting_approval", kind: "goal", proposalId: "p2", title: "title", question: "?" } });
      await vi.advanceTimersByTimeAsync(200_000);
      expect(f.calls).toHaveLength(callCount);
    } finally { vi.useRealTimers(); await f.close(); }
  });
  it("fails closed when an ownership check finishes after stop", async () => {
    const f = await fixture();
    try {
      let finish!: (value: { state: string }) => void;
      const ownership = new Promise<{ state: string }>((resolve) => { finish = resolve; });
      const check = vi.spyOn(f.host, "call").mockImplementation(async () => ownership);
      const listener = vi.fn();
      f.plugin.api.events.on("host.changed", listener);
      f.native.ingest({ sessionId: "s1", ts: Date.now(), event: { type: "planning_state", state: "awaiting_approval", kind: "plan", proposalId: "p1", title: "private", question: "private" } });
      await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
      f.plugin.stop();
      finish({ state: "own" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(listener).not.toHaveBeenCalled();
      expect(check).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });
  it("confirms abort only for the exact live native turn", async () => {
    const f = await fixture();
    try {
      const invoke = (turnId: string) =>
        f.plugin.runAsWebUser({ userId: "owner", deviceId: "phone" }, () =>
          f.plugin.api.desktop.invoke({
            operation: "agent/abort",
            args: [{ sessionId: "s1", turnId }],
          }),
        );
      expect(await invoke("expired-turn")).toEqual({
        ok: false,
        aborted: false,
      });
      expect(f.abort).not.toHaveBeenCalled();
      expect(await invoke("turn-1")).toEqual({ ok: true, aborted: true });
      expect(f.abort).toHaveBeenCalledExactlyOnceWith("s1", "turn-1");
    } finally {
      await f.close();
    }
  });
  it("does not accept payload authority for a mutation", async () => {
    const f = await fixture();
    try {
      await expect(
        f.plugin.api.desktop.invoke({
          operation: "agent/abort",
          args: [{ sessionId: "s1", turnId: "turn-1", panelAuthorized: true }],
        }),
      ).rejects.toThrow("principal");
      expect(f.calls).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("requires exact one-time user consent before configure reaches Host", async () => {
    const f = await fixture();
    try {
      const principal = { userId: "owner" as const, deviceId: "phone" };
      const configured = f.plugin.runAsWebUser(principal, () =>
        f.plugin.api.desktop.invoke({
          operation: "session/configure",
          confirm: true,
          args: ["s1", { mode: "agent", permissionMode: "ask" }],
        }),
      );
      await vi.waitFor(() =>
        expect(f.plugin.pendingConsents()).toHaveLength(1),
      );
      const approval = f.plugin.pendingConsents()[0]!;
      expect(() =>
        f.plugin.respondConsent(principal, approval.id, "wrong", "approve"),
      ).toThrow("changed");
      expect(f.calls.some((c) => c.method === "session.configure")).toBe(false);
      f.plugin.respondConsent(principal, approval.id, approval.hash, "approve");
      await configured;
      expect(
        f.calls.find((c) => c.method === "session.configure")?.params
          .permissionMode,
      ).toBe("ask");
      expect(() =>
        f.plugin.respondConsent(
          principal,
          approval.id,
          approval.hash,
          "approve",
        ),
      ).toThrow("unavailable");
    } finally {
      await f.close();
    }
  });
  it("registers a real runtime tool catalog and denies mismatched turn dispatch", async () => {
    const f = await fixture();
    try {
      const execute = vi.fn(async () => "result");
      await f.plugin.api.agent.registerTool({
        name: "bot_workbench",
        description: "Workbench",
        schema: { type: "object" },
        execute,
      });
      expect(f.plugin.toolCatalog()[0]).toMatchObject({
        name: "plugin_local_pi_bot_bot_workbench",
        parameters: { type: "object" },
      });
      f.notify("plugins.execute", {
        executionId: "e1",
        toolName: "plugin_local_pi_bot_bot_workbench",
        sessionId: "s1",
        turnId: "old",
        args: {},
        mode: "agent",
      });
      await vi.waitFor(() =>
        expect(
          f.calls.some((c) => c.method === "plugins.resolveExecution"),
        ).toBe(true),
      );
      expect(execute).not.toHaveBeenCalled();
      expect(
        f.calls.find((c) => c.method === "plugins.resolveExecution")?.params.ok,
      ).toBe(false);
    } finally {
      await f.close();
    }
  });
  it("executes only Host-attributed live tool calls and returns the actual result", async () => {
    const f = await fixture();
    try {
      await f.plugin.api.agent.registerTool({
        name: "bot_workbench",
        description: "Workbench",
        schema: {},
        execute: async () => "real callback",
      });
      f.notify("plugins.execute", {
        executionId: "e2",
        toolName: "plugin_local_pi_bot_bot_workbench",
        sessionId: "s1",
        turnId: "turn-1",
        args: {},
        mode: "agent",
      });
      await vi.waitFor(() =>
        expect(
          f.calls.find((c) => c.method === "plugins.resolveExecution")?.params,
        ).toMatchObject({ ok: true, content: "real callback" }),
      );
    } finally {
      await f.close();
    }
  });
});
describe("registered plugin file boundary", () => {
  it("refuses traversal, absolute paths and symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-files-"));
    try {
      await mkdir(join(root, "project"));
      await writeFile(join(root, "secret"), "private");
      const files = createTrustedFiles([join(root, "project")], async () =>
        join(root, "project"),
      );
      await expect(files.api.readText("../secret")).rejects.toThrow();
      await expect(files.api.readText(join(root, "secret"))).rejects.toThrow();
      await mkdir(join(root, "outside"));
      await writeFile(join(root, "outside", "secret"), "private");
      await symlink(
        join(root, "outside"),
        join(root, "project", "link"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(files.api.readText("link/secret")).rejects.toThrow(
        "Symlink",
      );
      await files.api.writeText("report.md", "verified");
      expect(await files.api.readText("report.md")).toBe("verified");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
