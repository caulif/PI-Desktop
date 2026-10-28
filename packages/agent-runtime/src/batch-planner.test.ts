import { describe, expect, it } from "vitest";
import { BatchPlanner, claimsConflict } from "./batch-planner.js";
import {
  type ResourceClaim,
  TOOL_EXECUTION_SPECS,
  resourcePathKey,
} from "./tool-execution-policy.js";

const BASE = "/root";

function claimsFor(name: string, params: unknown): ResourceClaim[] {
  return TOOL_EXECUTION_SPECS[name]?.claims?.(params, BASE) ?? [];
}

function pathClaim(key: string, access: "shared" | "exclusive"): ResourceClaim {
  return { kind: "path", key, access };
}

const TREE_SHARED: ResourceClaim = { kind: "tree", access: "shared" };
const TREE_EXCLUSIVE: ResourceClaim = { kind: "tree", access: "exclusive" };

/** True when `promise` is still pending after one microtask turn. */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => false), Promise.resolve(true)]);
}

describe("claimsConflict", () => {
  it("lets shared reads of one file overlap", () => {
    expect(claimsConflict(pathClaim("a.ts", "shared"), pathClaim("a.ts", "shared"))).toBe(false);
  });

  it("serializes a read against a write of the same file", () => {
    expect(claimsConflict(pathClaim("a.ts", "shared"), pathClaim("a.ts", "exclusive"))).toBe(true);
    expect(claimsConflict(pathClaim("a.ts", "exclusive"), pathClaim("a.ts", "shared"))).toBe(true);
  });

  it("keeps writes to different files independent", () => {
    expect(claimsConflict(pathClaim("a.ts", "exclusive"), pathClaim("b.ts", "exclusive"))).toBe(false);
  });

  it("lets two tree claims of the same access overlap", () => {
    expect(claimsConflict(TREE_SHARED, TREE_SHARED)).toBe(false);
  });

  it("orders a search against a write of any file", () => {
    expect(claimsConflict(TREE_SHARED, pathClaim("a.ts", "exclusive"))).toBe(true);
    expect(claimsConflict(pathClaim("a.ts", "exclusive"), TREE_SHARED)).toBe(true);
  });

  it("lets a search overlap a read of any file", () => {
    expect(claimsConflict(TREE_SHARED, pathClaim("a.ts", "shared"))).toBe(false);
  });

  it("serializes an exclusive tree claim against everything", () => {
    expect(claimsConflict(TREE_EXCLUSIVE, TREE_SHARED)).toBe(true);
    expect(claimsConflict(TREE_EXCLUSIVE, pathClaim("a.ts", "shared"))).toBe(true);
    expect(claimsConflict(pathClaim("a.ts", "exclusive"), TREE_EXCLUSIVE)).toBe(true);
    expect(claimsConflict(TREE_EXCLUSIVE, TREE_EXCLUSIVE)).toBe(true);
  });

  it("treats two spellings of one file as the same file", () => {
    expect(
      claimsConflict(
        pathClaim(resourcePathKey("./a.ts", BASE), "shared"),
        pathClaim(resourcePathKey("a.ts", BASE), "exclusive"),
      ),
    ).toBe(true);
    expect(
      claimsConflict(
        pathClaim(resourcePathKey("src\\a.ts", BASE), "exclusive"),
        pathClaim(resourcePathKey("src/a.ts", BASE), "shared"),
      ),
    ).toBe(true);
    expect(
      claimsConflict(
        pathClaim(resourcePathKey("/root/a.ts", BASE), "shared"),
        pathClaim(resourcePathKey("a.ts", BASE), "exclusive"),
      ),
    ).toBe(true);
    expect(
      claimsConflict(
        pathClaim(resourcePathKey("A.ts", BASE), "shared"),
        pathClaim(resourcePathKey("a.ts", BASE), "exclusive"),
      ),
    ).toBe(true);
    expect(
      claimsConflict(
        pathClaim(resourcePathKey("src/../a.ts", BASE), "shared"),
        pathClaim(resourcePathKey("a.ts", BASE), "exclusive"),
      ),
    ).toBe(true);
  });

  it("falls back to the file name so an alias the key cannot see still waits", () => {
    expect(claimsConflict(pathClaim("x/a.ts", "shared"), pathClaim("y/a.ts", "exclusive"))).toBe(true);
  });
});

describe("resourcePathKey", () => {
  it("joins a relative path to the base and keeps an absolute one", () => {
    expect(resourcePathKey("a.ts", "/root")).toBe("/root/a.ts");
    expect(resourcePathKey("/root/a.ts", "/root")).toBe("/root/a.ts");
    expect(resourcePathKey("/elsewhere/a.ts", "/root")).toBe("/elsewhere/a.ts");
    expect(resourcePathKey("C:\\work\\a.ts", "/root")).toBe("c:/work/a.ts");
  });

  it("normalizes separators, dot segments, a trailing slash, and case", () => {
    expect(resourcePathKey("src\\a.ts", "/root")).toBe("/root/src/a.ts");
    expect(resourcePathKey("./src/./a.ts/", "/root")).toBe("/root/src/a.ts");
    expect(resourcePathKey("src/other/../a.ts", "/root")).toBe("/root/src/a.ts");
    expect(resourcePathKey("A.TS", "/root")).toBe("/root/a.ts");
  });

  it("stays lexical when there is no base", () => {
    expect(resourcePathKey("src/a.ts", "")).toBe("src/a.ts");
    expect(resourcePathKey("", "/root")).toBe("");
  });
});

describe("TOOL_EXECUTION_SPECS claims", () => {
  it("claims the path a read names and the tree when it names none", () => {
    expect(claimsFor("Read", { path: "a.ts" })).toEqual([pathClaim("/root/a.ts", "shared")]);
    expect(claimsFor("Read", {})).toEqual([TREE_SHARED]);
  });

  it("claims the path a write names exclusively, and the tree when it names none", () => {
    expect(claimsFor("Write", { path: "a.ts" })).toEqual([pathClaim("/root/a.ts", "exclusive")]);
    expect(claimsFor("Write", {})).toEqual([TREE_EXCLUSIVE]);
  });

  it("claims the tree for a search", () => {
    expect(claimsFor("Glob", { pattern: "**/*.ts" })).toEqual([TREE_SHARED]);
    expect(claimsFor("Grep", { pattern: "foo" })).toEqual([TREE_SHARED]);
  });

  it("claims one path for an ordinary edit", () => {
    expect(claimsFor("Edit", { path: "a.ts", ops: "PUT 1.=1:\n+one" })).toEqual([
      pathClaim("/root/a.ts", "exclusive"),
    ]);
    expect(claimsFor("Edit", { path: "a.ts", old_string: "one", new_string: "two" })).toEqual([
      pathClaim("/root/a.ts", "exclusive"),
    ]);
  });

  it("claims the tree for an edit that renames or removes", () => {
    expect(claimsFor("Edit", { path: "a.ts", ops: "MV b.ts" })).toEqual([TREE_EXCLUSIVE]);
    expect(claimsFor("Edit", { path: "a.ts", ops: "REM" })).toEqual([TREE_EXCLUSIVE]);
    expect(claimsFor("Edit", { path: "a.ts", ops: "PUT 1.=1:\n+one\nMV b.ts" })).toEqual([
      TREE_EXCLUSIVE,
    ]);
  });

  it("claims the tree for an edit that names no path", () => {
    expect(claimsFor("Edit", { ops: "PUT 1.=1:\n+one" })).toEqual([TREE_EXCLUSIVE]);
    expect(claimsFor("Edit", { path: "  " })).toEqual([TREE_EXCLUSIVE]);
  });
});

describe("BatchPlanner", () => {
  it("orders only the calls that conflict", async () => {
    const planner = new BatchPlanner();
    const batch = {};
    const readA = { path: "a.ts" };
    const editA = { path: "a.ts" };
    const readB = { path: "b.ts" };
    const writeC = { path: "c.ts" };
    planner.register(batch, readA, claimsFor("Read", readA));
    planner.register(batch, editA, claimsFor("Edit", editA));
    planner.register(batch, readB, claimsFor("Read", readB));
    planner.register(batch, writeC, claimsFor("Write", writeC));

    const turns: string[] = [];
    const editTurn = planner.waitForTurn(editA).then(() => turns.push("edit"));

    await planner.waitForTurn(readB);
    await planner.waitForTurn(writeC);
    expect(turns).toEqual([]);
    expect(await isPending(editTurn)).toBe(true);

    planner.settle(readA);
    await editTurn;
    expect(turns).toEqual(["edit"]);
  });

  it("waits for the last conflicting predecessor, not just the first", async () => {
    const planner = new BatchPlanner();
    const batch = {};
    const readA = { path: "a.ts" };
    const writeA = { path: "./a.ts" };
    const editA = { path: "a.ts" };
    planner.register(batch, readA, claimsFor("Read", readA));
    planner.register(batch, writeA, claimsFor("Write", writeA));
    planner.register(batch, editA, claimsFor("Edit", editA));

    const editTurn = planner.waitForTurn(editA);
    planner.settle(readA);
    expect(await isPending(editTurn)).toBe(true);
    planner.settle(writeA);
    await expect(editTurn).resolves.toBeUndefined();
  });

  it("keeps separate messages independent", async () => {
    const planner = new BatchPlanner();
    const first = { path: "a.ts" };
    const second = { path: "a.ts" };
    planner.register({}, first, claimsFor("Read", first));
    planner.register({}, second, claimsFor("Edit", second));

    await expect(planner.waitForTurn(second)).resolves.toBeUndefined();
  });

  it("returns immediately for a call that was never registered", async () => {
    const planner = new BatchPlanner();
    await expect(planner.waitForTurn({})).resolves.toBeUndefined();
    await expect(planner.waitForTurn({}, new AbortController().signal)).resolves.toBeUndefined();
  });

  it("returns immediately when nothing conflicts", async () => {
    const planner = new BatchPlanner();
    const batch = {};
    const readA = { path: "a.ts" };
    const readB = { path: "b.ts" };
    planner.register(batch, readA, claimsFor("Read", readA));
    planner.register(batch, readB, claimsFor("Read", readB));

    await expect(planner.waitForTurn(readB)).resolves.toBeUndefined();
  });

  it("releases the wait when a predecessor never executes and the signal aborts", async () => {
    const planner = new BatchPlanner();
    const batch = {};
    const readA = { path: "a.ts" };
    const writeA = { path: "a.ts" };
    planner.register(batch, readA, claimsFor("Read", readA));
    planner.register(batch, writeA, claimsFor("Write", writeA));

    const controller = new AbortController();
    const turn = planner.waitForTurn(writeA, controller.signal);
    expect(await isPending(turn)).toBe(true);
    controller.abort();
    await expect(turn).resolves.toBeUndefined();
  });

  it("returns immediately when the signal is already aborted", async () => {
    const planner = new BatchPlanner();
    const batch = {};
    const readA = { path: "a.ts" };
    const writeA = { path: "a.ts" };
    planner.register(batch, readA, claimsFor("Read", readA));
    planner.register(batch, writeA, claimsFor("Write", writeA));

    const controller = new AbortController();
    controller.abort();
    await expect(planner.waitForTurn(writeA, controller.signal)).resolves.toBeUndefined();
  });

  it("settles idempotently and without a registration", async () => {
    const planner = new BatchPlanner();
    const batch = {};
    const readA = { path: "a.ts" };
    const editA = { path: "a.ts" };
    planner.register(batch, readA, claimsFor("Read", readA));
    planner.register(batch, editA, claimsFor("Edit", editA));

    const turn = planner.waitForTurn(editA);
    planner.settle(readA);
    planner.settle(readA);
    planner.settle({});
    await expect(turn).resolves.toBeUndefined();
    await expect(planner.waitForTurn(editA)).resolves.toBeUndefined();
  });
});
