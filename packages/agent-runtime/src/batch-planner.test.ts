import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { BatchPlanner, claimsConflict, sameFile, withBatchTurn } from "./batch-planner.js";
import { resourcePathKey, TOOL_EXECUTION_SPECS, type ResourceClaim } from "./tool-execution-policy.js";

const path = (key: string, access: "shared" | "exclusive"): ResourceClaim => ({ kind: "path", key, access });
const tree = (access: "shared" | "exclusive"): ResourceClaim => ({ kind: "tree", access });
const claims = (name: string, params: unknown, base = "/root") => TOOL_EXECUTION_SPECS[name]!.claims!(params, base);

/** Resolves on the next macrotask, after every pending microtask has run. */
const settledTurn = () => new Promise((resolve) => setTimeout(resolve, 0));

function track(promise: Promise<unknown>) {
  const state = { done: false };
  void promise.then(() => { state.done = true; }, () => { state.done = true; });
  return state;
}

describe("claim conflicts", () => {
  it.each([
    ["path S / path S", path("a", "shared"), path("a", "shared"), false],
    ["path X / path X, same file", path("/r/a", "exclusive"), path("/r/a", "exclusive"), true],
    ["path S / path X, same file", path("/r/a", "shared"), path("/r/a", "exclusive"), true],
    ["path X / path S, other file", path("/r/a", "exclusive"), path("/r/b", "shared"), false],
    ["tree S / tree S", tree("shared"), tree("shared"), false],
    ["tree S / path X", tree("shared"), path("/r/a", "exclusive"), true],
    ["path X / tree S", path("/r/a", "exclusive"), tree("shared"), true],
    ["tree S / path S", tree("shared"), path("/r/a", "shared"), false],
    ["tree X / path S", tree("exclusive"), path("/r/a", "shared"), true],
    ["tree X / tree S", tree("exclusive"), tree("shared"), true],
    ["path S / tree X", path("/r/a", "shared"), tree("exclusive"), true],
  ] as const)("%s → %s", (_label, a, b, expected) => {
    expect(claimsConflict([a], [b])).toBe(expected);
  });

  it("never orders a call that declares no claims", () => {
    expect(claimsConflict([], [tree("exclusive")])).toBe(false);
    expect(claimsConflict([tree("exclusive")], [])).toBe(false);
  });
});

describe("resource path keys", () => {
  const key = (raw: string) => resourcePathKey(raw, "/root");

  it.each([
    ["a.ts", "./a.ts"],
    ["src\\a.ts", "src/a.ts"],
    ["/root/a.ts", "a.ts"],
    ["A.ts", "a.ts"],
    ["src/../a.ts", "a.ts"],
    ["src/", "src"],
  ])("%s and %s name the same file", (left, right) => {
    expect(key(left)).toBe(key(right));
    expect(sameFile(key(left), key(right))).toBe(true);
  });

  it("keeps absolute Windows, POSIX and UNC paths off the base", () => {
    expect(resourcePathKey("C:\\Work\\A.ts", "/root")).toBe("c:/work/a.ts");
    expect(resourcePathKey("/etc/hosts", "C:/root")).toBe("/etc/hosts");
    expect(resourcePathKey("//server/share/a.ts", "/root")).toBe("/server/share/a.ts");
    expect(resourcePathKey("a.ts", "C:\\Root")).toBe("c:/root/a.ts");
  });

  it("treats a shared basename as the same file even in different directories", () => {
    expect(sameFile(key("x/a.ts"), key("y/a.ts"))).toBe(true);
  });

  it("keeps different files apart", () => {
    expect(sameFile(key("a.ts"), key("b.ts"))).toBe(false);
  });
});

describe("tool claims", () => {
  it("declares Read as a shared path and Glob/Grep as a shared tree", () => {
    expect(claims("Read", { path: "a.ts" })).toEqual([path("/root/a.ts", "shared")]);
    expect(claims("Read", {})).toEqual([tree("shared")]);
    expect(claims("Glob", { pattern: "*.ts" })).toEqual([tree("shared")]);
    expect(claims("Grep", { pattern: "x", path: "src" })).toEqual([tree("shared")]);
  });

  it("declares Write as an exclusive path, or the whole tree without a path", () => {
    expect(claims("Write", { path: "a.ts", content: "" })).toEqual([path("/root/a.ts", "exclusive")]);
    expect(claims("Write", { content: "" })).toEqual([tree("exclusive")]);
  });

  it.each([
    ["plain ops", { path: "a.ts", tag: "ABCD", ops: "PUT 1.=1:\n+x" }, [path("/root/a.ts", "exclusive")]],
    ["MV", { path: "a.ts", tag: "ABCD", ops: "MV b.ts" }, [tree("exclusive")]],
    ["indented REM after another op", { path: "a.ts", tag: "ABCD", ops: "PUT 1.=1:\n+x\n  REM" }, [tree("exclusive")]],
    ["MV text inside a body row", { path: "a.ts", tag: "ABCD", ops: "PUT 1.=1:\n+MV b.ts" }, [path("/root/a.ts", "exclusive")]],
    ["CUT into a named register", { path: "a.ts", tag: "ABCD", ops: "CUT 3.=5 @moved" }, [tree("exclusive")]],
    ["PUT from a named register", { path: "b.ts", tag: "ABCD", ops: "PUT 1.=1:\n+x\nPUT <1 @moved" }, [tree("exclusive")]],
    ["a register after U+0085, which host-core treats as whitespace", { path: "b.ts", tag: "ABCD", ops: "PUT\u0085<1\u0085@moved" }, [tree("exclusive")]],
    ["anonymous CUT and PUT in one call", { path: "a.ts", tag: "ABCD", ops: "CUT 3.=5\nPUT <1" }, [path("/root/a.ts", "exclusive")]],
    ["@ text inside a body row", { path: "a.ts", tag: "ABCD", ops: "PUT 1.=1:\n+mail @someone" }, [path("/root/a.ts", "exclusive")]],
    ["legacy old_string/new_string", { path: "a.ts", old_string: "a", new_string: "b" }, [path("/root/a.ts", "exclusive")]],
    ["missing path", { tag: "ABCD", ops: "PUT 1.=1:\n+x" }, [tree("exclusive")]],
    ["empty path", { path: " ", ops: "PUT 1.=1:\n+x" }, [tree("exclusive")]],
  ] as const)("declares Edit with %s", (_label, params, expected) => {
    expect(claims("Edit", params)).toEqual(expected);
  });

  it("gives Task no claims and leaves unlisted tools sequential without claims", () => {
    expect(TOOL_EXECUTION_SPECS.Task).toEqual({ mode: "parallel" });
    expect(TOOL_EXECUTION_SPECS.Bash).toBeUndefined();
  });
});

describe("BatchPlanner", () => {
  /** Registers calls in source order under one batch and returns their keys. */
  function plan(planner: BatchPlanner, batch: object, calls: Array<[string, unknown]>) {
    return calls.map(([name, params]) => {
      const key = { name, params };
      planner.register(batch, key, claims(name, params));
      return key;
    });
  }

  it("keeps a named-register CUT and PUT on different files in source order", async () => {
    const planner = new BatchPlanner();
    // Host keeps named registers per session, so the PUT must see this CUT.
    const [cut, put] = plan(planner, {}, [
      ["Edit", { path: "a.ts", tag: "ABCD", ops: "CUT 3.=5 @moved" }],
      ["Edit", { path: "b.ts", tag: "ABCD", ops: "PUT <1 @moved" }],
    ]);
    const waiting = track(planner.waitForTurn(put));
    await settledTurn();
    expect(waiting.done).toBe(false);
    planner.settle(cut);
    await settledTurn();
    expect(waiting.done).toBe(true);
  });

  it("orders only the conflicting call in [Read a, Edit a, Read b, Write c]", async () => {
    const planner = new BatchPlanner();
    const [readA, editA, readB, writeC] = plan(planner, {}, [
      ["Read", { path: "a.ts" }],
      ["Edit", { path: "a.ts", tag: "ABCD", ops: "PUT 1.=1:\n+x" }],
      ["Read", { path: "b.ts" }],
      ["Write", { path: "c.ts", content: "" }],
    ]);
    const edit = track(planner.waitForTurn(editA));
    const others = [readA, readB, writeC].map((key) => track(planner.waitForTurn(key)));
    await settledTurn();
    expect(others.map((state) => state.done)).toEqual([true, true, true]);
    expect(edit.done).toBe(false);
    planner.settle(readA);
    await settledTurn();
    expect(edit.done).toBe(true);
  });

  it("waits for every conflicting predecessor", async () => {
    const planner = new BatchPlanner();
    const [first, second, third] = plan(planner, {}, [
      ["Read", { path: "a.ts" }],
      ["Read", { path: "./a.ts" }],
      ["Write", { path: "a.ts", content: "" }],
    ]);
    const write = track(planner.waitForTurn(third));
    planner.settle(first);
    await settledTurn();
    expect(write.done).toBe(false);
    planner.settle(second);
    await settledTurn();
    expect(write.done).toBe(true);
  });

  it("keeps batches apart", async () => {
    const planner = new BatchPlanner();
    const [parentRead] = plan(planner, {}, [["Read", { path: "a.ts" }]]);
    const [childWrite] = plan(planner, {}, [["Write", { path: "a.ts", content: "" }]]);
    await expect(planner.waitForTurn(childWrite)).resolves.toBeUndefined();
    planner.settle(parentRead);
  });

  it("returns at once for an unregistered call", async () => {
    await expect(new BatchPlanner().waitForTurn({})).resolves.toBeUndefined();
  });

  it("returns on abort while a predecessor is still running", async () => {
    const planner = new BatchPlanner();
    const [, edit] = plan(planner, {}, [
      ["Read", { path: "a.ts" }],
      ["Edit", { path: "a.ts", ops: "PUT 1.=1:\n+x" }],
    ]);
    const controller = new AbortController();
    const waiting = track(planner.waitForTurn(edit, controller.signal));
    await settledTurn();
    expect(waiting.done).toBe(false);
    controller.abort();
    await settledTurn();
    expect(waiting.done).toBe(true);
  });

  it("unblocks a successor when a registered predecessor never executes and the batch aborts", async () => {
    const planner = new BatchPlanner();
    const batch = {};
    // The predecessor is registered but never reaches waitForTurn/settle.
    const [, write] = plan(planner, batch, [
      ["Read", { path: "a.ts" }],
      ["Write", { path: "a.ts", content: "" }],
    ]);
    const controller = new AbortController();
    const waiting = track(planner.waitForTurn(write, controller.signal));
    await settledTurn();
    expect(waiting.done).toBe(false);
    controller.abort();
    await settledTurn();
    expect(waiting.done).toBe(true);
    // An already-aborted signal returns at once as well.
    await expect(planner.waitForTurn(write, controller.signal)).resolves.toBeUndefined();
  });

  it("settles every registration left in a batch at batch end", async () => {
    const planner = new BatchPlanner();
    const batch = {};
    const [, write] = plan(planner, batch, [
      ["Read", { path: "a.ts" }],
      ["Write", { path: "a.ts", content: "" }],
    ]);
    const waiting = track(planner.waitForTurn(write));
    planner.settleBatch(batch);
    await settledTurn();
    expect(waiting.done).toBe(true);
  });

  it("treats settle as idempotent and safe for unknown keys", async () => {
    const planner = new BatchPlanner();
    const [read, write] = plan(planner, {}, [
      ["Read", { path: "a.ts" }],
      ["Write", { path: "a.ts", content: "" }],
    ]);
    planner.settle(read);
    planner.settle(read);
    planner.settle({});
    await expect(planner.waitForTurn(write)).resolves.toBeUndefined();
  });
});

describe("withBatchTurn releases every registered call", () => {
  function tool(execute: AgentTool["execute"]): AgentTool {
    return { name: "Read", label: "Read", description: "Read", parameters: Type.Object({}), execute };
  }

  /** [predecessor, successor] on one file; the successor waits for the predecessor. */
  function batch(planner: BatchPlanner) {
    const first = { path: "a.ts" };
    const second = { path: "a.ts", content: "" };
    const key = {};
    planner.register(key, first, claims("Read", first));
    planner.register(key, second, claims("Write", second));
    return { key, first, second };
  }

  it.each([
    ["throws synchronously", () => { throw new Error("invalid arguments"); }],
    ["rejects", async () => { throw new Error("mode denied"); }],
  ] as const)("when the inner execute %s", async (_label, execute) => {
    const planner = new BatchPlanner();
    const { first, second } = batch(planner);
    const failing = withBatchTurn(tool(execute as AgentTool["execute"]), planner);
    const next = withBatchTurn(tool(async () => ({ content: [], details: {} })), planner);
    const successor = next.execute("second", second as never);
    await expect(failing.execute("first", first as never)).rejects.toThrow();
    await expect(successor).resolves.toEqual({ content: [], details: {} });
  });

  it("releases only after the inner execute settles", async () => {
    const planner = new BatchPlanner();
    const { first, second } = batch(planner);
    let finish!: () => void;
    const slow = withBatchTurn(tool(() => new Promise((resolve) => {
      finish = () => resolve({ content: [], details: {} });
    })), planner);
    const next = withBatchTurn(tool(async () => ({ content: [], details: {} })), planner);
    const running = slow.execute("first", first as never);
    const waiting = track(next.execute("second", second as never));
    await settledTurn();
    expect(waiting.done).toBe(false);
    finish();
    await running;
    await settledTurn();
    expect(waiting.done).toBe(true);
  });

  it("releases a call that was aborted while waiting for its turn", async () => {
    const planner = new BatchPlanner();
    const { key, first, second } = batch(planner);
    // A later same-file Read in the same batch waits only for the Write; the
    // first Read keeps running and never settles in this test.
    const third = { path: "a.ts" };
    planner.register(key, third, claims("Read", third));
    const controller = new AbortController();
    const inner = async (_id: string, _args: unknown, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error("tool execution aborted before it started");
      return { content: [], details: {} };
    };
    const write = withBatchTurn(tool(inner as AgentTool["execute"]), planner);
    const read = withBatchTurn(tool(inner as AgentTool["execute"]), planner);
    const writing = write.execute("second", second as never, controller.signal);
    const reading = read.execute("third", third as never);
    controller.abort();
    await expect(writing).rejects.toThrow("aborted before it started");
    // The Write never ran but still released the Read ordered behind it.
    await expect(reading).resolves.toEqual({ content: [], details: {} });
    planner.settle(first);
  });

  it("is a no-op for a direct call that was never registered", async () => {
    const planner = new BatchPlanner();
    const wrapped = withBatchTurn(tool(async () => ({ content: [], details: {} })), planner);
    await expect(wrapped.execute("direct", { path: "a.ts" } as never)).resolves.toEqual({ content: [], details: {} });
  });
});
