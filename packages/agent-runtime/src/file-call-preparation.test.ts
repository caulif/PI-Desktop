import { describe, expect, it, vi } from "vitest";
import { FileCallPreparation } from "./file-call-preparation.js";
import type { RuntimeHost } from "./host-client.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("ordered file call preparation", () => {
  it("retries failed cleanup identities on a later drain and recovers", async () => {
    let unavailable = true;
    const errors = vi.fn();
    const call = vi.fn(async (method: string, args: any) => {
      if (method === "tools.prepareFileCall") return { ticket: `ticket-${args.toolCallId}` };
      if (unavailable) throw new Error("HOST_OVERLOADED");
      return {};
    });
    const preparations = new FileCallPreparation({ call } as RuntimeHost, "s", errors);
    await preparations.prepare("one", "Read", { path: "a" }, "parent", undefined, () => false);
    preparations.cancelOwner();
    await expect(preparations.drainCleanup()).rejects.toThrow("cleanup failed");
    expect(preparations.hasCleanup).toBe(true);
    await expect(preparations.prepare("one", "Read", { path: "a" }, "parent", undefined, () => false))
      .rejects.toThrow("awaiting cleanup");
    unavailable = false;
    await preparations.drainCleanup();
    expect(call).toHaveBeenLastCalledWith("tools.cancelPreparedFileCalls", { sessionId: "s", toolCallIds: ["one"] }, 10_000);
    expect(preparations.hasCleanup).toBe(false);
    await preparations.drainCleanup();
    expect(call.mock.calls.filter(([method]) => method === "tools.cancelPreparedFileCalls")).toHaveLength(2);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it("bounds retries while the Host remains unavailable", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "tools.prepareFileCall") return { ticket: "ticket" };
      throw new Error("timeout");
    });
    const preparations = new FileCallPreparation({ call } as RuntimeHost, "s", vi.fn());
    await preparations.prepare("one", "Read", {}, "parent", undefined, () => false);
    preparations.cancelOwner();
    await expect(preparations.drainCleanup()).rejects.toThrow("cleanup failed");
    await expect(preparations.drainCleanup()).rejects.toThrow("cleanup failed");
    expect(call.mock.calls.filter(([method]) => method === "tools.cancelPreparedFileCalls")).toHaveLength(2);
  });

  it("retains a failed batch without losing later batches or retrying successful ones", async () => {
    let attempts = 0;
    const call = vi.fn(async (method: string, args: any) => {
      if (method === "tools.prepareFileCall") return { ticket: `ticket-${args.toolCallId}` };
      if (++attempts === 1) throw new Error("timeout");
      return {};
    });
    const preparations = new FileCallPreparation({ call } as RuntimeHost, "s", vi.fn());
    for (let i = 0; i < 130; i++) {
      await preparations.prepare(`call-${i}`, "Read", {}, "parent", undefined, () => false);
    }
    preparations.cancelOwner();
    await expect(preparations.drainCleanup()).rejects.toThrow("cleanup failed");
    const batches = () => call.mock.calls.filter(([method]) => method === "tools.cancelPreparedFileCalls")
      .map(([, args]) => args.toolCallIds);
    expect(batches().map(ids => ids.length)).toEqual([64, 64, 2]);
    await preparations.drainCleanup();
    expect(batches()[3]).toEqual(batches()[0]);
    expect(preparations.hasCleanup).toBe(false);
  });

  it("drains cleanup added while an earlier cleanup RPC is settling", async () => {
    const gates = [deferred(), deferred()];
    const entered = [deferred(), deferred()];
    let cleanupIndex = 0;
    const call = vi.fn(async (method: string, args: any) => {
      if (method === "tools.prepareFileCall") return { ticket: `ticket-${args.toolCallId}` };
      const index = cleanupIndex++;
      entered[index].resolve();
      await gates[index].promise;
      return {};
    });
    const preparations = new FileCallPreparation({ call } as RuntimeHost, "s", vi.fn());
    await preparations.prepare("first", "Read", { path: "a" }, "first-owner", undefined, () => false);
    await preparations.prepare("second", "Read", { path: "b" }, "second-owner", undefined, () => false);
    preparations.cancelOwner("first-owner");
    await entered[0].promise;
    let settled = false;
    const draining = preparations.drainCleanup().then(() => { settled = true; });
    preparations.cancelOwner("second-owner");
    gates[0].resolve();
    await entered[1].promise;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    try {
      expect(settled).toBe(false);
      expect(preparations.hasCleanup).toBe(true);
    } finally {
      gates[1].resolve();
      await draining;
    }
    expect(preparations.hasCleanup).toBe(false);
    expect(cleanupIndex).toBe(2);
  });

  it("registers in prepare order without waiting for execution or permission", async () => {
    const call = vi.fn(async (method: string, args: any) => method === "tools.prepareFileCall"
      ? { ticket: `ticket-${args.toolCallId}` } : {});
    const preparations = new FileCallPreparation({ call } as RuntimeHost, "s", vi.fn());
    await preparations.prepare("one", "Write", { path: "a", content: "value" }, "parent", undefined, () => false);
    await preparations.prepare("two", "Read", { path: "a" }, "parent", undefined, () => false);
    expect(call.mock.calls.map(([, args]) => args.toolCallId)).toEqual(["one", "two"]);
    expect(preparations.take("two")).toBe("ticket-two");
    expect(preparations.take("one")).toBe("ticket-one");
    expect(preparations.take("one")).toBeUndefined();
  });

  it("cancels skipped prepared calls by owner without cancelling another delegate", async () => {
    const call = vi.fn(async (method: string, args: any) => method === "tools.prepareFileCall"
      ? { ticket: `ticket-${args.toolCallId}` } : {});
    const preparations = new FileCallPreparation({ call } as RuntimeHost, "s", vi.fn());
    await preparations.prepare("parent", "Read", { path: "a" }, "parent", undefined, () => false);
    await preparations.prepare("child", "Read", { path: "a" }, "delegate", "ask", () => false);
    preparations.cancelOwner("parent");
    await preparations.drainCleanup();
    expect(call).toHaveBeenLastCalledWith("tools.cancelPreparedFileCalls", { sessionId: "s", toolCallIds: ["parent"] }, 10_000);
    expect(preparations.take("child")).toBe("ticket-child");
  });

  it("revokes a ticket when cancellation races its preparation response", async () => {
    let respond!: (value: unknown) => void;
    const call = vi.fn((method: string) => method === "tools.prepareFileCall"
      ? new Promise(resolve => { respond = resolve; }) : Promise.resolve({}));
    const preparations = new FileCallPreparation({ call } as RuntimeHost, "s", vi.fn());
    const preparing = preparations.prepare("one", "Read", { path: "a" }, "parent", undefined, () => false);
    preparations.cancelOwner("parent");
    respond({ ticket: "ticket-one" });
    await expect(preparing).rejects.toThrow("aborted");
    await preparations.drainCleanup();
    expect(call).toHaveBeenLastCalledWith("tools.cancelPreparedFileCalls", { sessionId: "s", toolCallIds: ["one"] }, 10_000);
    expect(preparations.take("one")).toBeUndefined();
  });

  it("fails closed for an older host rather than bypassing ordering", async () => {
    const call = vi.fn(async () => { throw new Error("METHOD_NOT_FOUND"); });
    const preparations = new FileCallPreparation({ call } as RuntimeHost, "s", vi.fn());
    await expect(preparations.prepare("one", "Write", {}, "parent", undefined, () => false)).rejects.toThrow("METHOD_NOT_FOUND");
    expect(preparations.take("one")).toBeUndefined();
  });
});
