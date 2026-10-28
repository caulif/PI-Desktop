/**
 * Batch policy only: this does not grant permissions or coordinate other agents.
 *
 * The claims below order the calls of one parallel batch against each other.
 * They are not locks: `PathMutex` still protects the same path across a parent
 * and its delegates.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { isRecord } from "./agent-messages.js";
import { normalizeLockPath } from "./path-lock.js";

export type ResourceAccess = "shared" | "exclusive";

export type ResourceClaim =
  /** One file; `key` is already normalized by {@link resourcePathKey}. */
  | { kind: "path"; key: string; access: ResourceAccess }
  /** The whole workspace. */
  | { kind: "tree"; access: ResourceAccess };

export type ToolExecutionSpec = {
  /** pi's batch mode. A tool without an entry is sequential. */
  mode: "parallel" | "sequential";
  /** Only parallel tools need this: what one call of this tool touches. */
  claims?: (params: unknown, base: string) => ResourceClaim[];
};

/**
 * Compare-equal key for one file.
 *
 * A relative path is joined to `base`; an absolute one is kept as written. `.`
 * and `..` collapse by string alone: preparation runs before the call reaches
 * the host, so it cannot look at a remote workspace's files, and `realpath`
 * would key a symlinked directory differently from the spelling the model
 * wrote. Lowercased like `normalizeLockPath`, because over-reporting a conflict
 * costs only parallelism.
 */
export function resourcePathKey(raw: string, base: string): string {
  const path = raw.trim().replaceAll("\\", "/");
  if (!path) return "";
  const absolute = /^([A-Za-z]:)?\//.test(path);
  const root = base.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return normalizeLockPath(absolute || !root ? path : `${root}/${path}`);
}

function claimedPath(params: unknown): string {
  if (!isRecord(params)) return "";
  const path = params.path;
  return typeof path === "string" && path.trim() ? path : "";
}

/** A call that names no file claims the tree: the host may still touch any path. */
function pathClaim(
  params: unknown,
  base: string,
  access: ResourceAccess,
): ResourceClaim[] {
  const path = claimedPath(params);
  return path
    ? [{ kind: "path", key: resourcePathKey(path, base), access }]
    : [{ kind: "tree", access }];
}

/** `MV` and `REM` reach a second path or the directory listing, not just the file. */
const TREE_WIDE_EDIT_OPS = /^\s*(MV|REM)\b/m;

function editClaims(params: unknown, base: string): ResourceClaim[] {
  const ops = isRecord(params) && typeof params.ops === "string" ? params.ops : "";
  if (!claimedPath(params) || TREE_WIDE_EDIT_OPS.test(ops)) {
    return [{ kind: "tree", access: "exclusive" }];
  }
  return pathClaim(params, base, "exclusive");
}

export const TOOL_EXECUTION_SPECS: Readonly<Record<string, ToolExecutionSpec>> = {
  Read: {
    mode: "parallel",
    claims: (params, base) => pathClaim(params, base, "shared"),
  },
  // A search covers every file it walks, so it cannot be ordered against a
  // write of any file inside the tree.
  Glob: { mode: "parallel", claims: () => [{ kind: "tree", access: "shared" }] },
  Grep: { mode: "parallel", claims: () => [{ kind: "tree", access: "shared" }] },
  Write: {
    mode: "parallel",
    claims: (params, base) => pathClaim(params, base, "exclusive"),
  },
  Edit: { mode: "parallel", claims: editClaims },
  // Task claims no file: a batch that mixes it with a file tool is whole-batch
  // sequential, see `resolveBatchExecutionMode`.
  Task: { mode: "parallel" },
};

export function toolExecutionMode(name: string): "parallel" | "sequential" {
  return TOOL_EXECUTION_SPECS[name]?.mode ?? "sequential";
}

/**
 * Keep Task fan-out and file batches parallel, but preserve the old safety
 * boundary for a batch that mixes a background delegate with a file tool: a
 * delegate may write the workspace the batch reads or writes, and its
 * completion is the only ordering point the runtime has. Delegate
 * write/resource coordination belongs to a later Host-owned phase.
 */
export function resolveBatchExecutionMode(
  assistantMessage: AssistantMessage,
): "parallel" | "sequential" | undefined {
  const names = assistantMessage.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "toolCall" }> => block.type === "toolCall")
    .map((block) => block.name);
  const hasTask = names.includes("Task");
  const hasFileTool = names.some(
    (name) =>
      name === "Read" ||
      name === "Glob" ||
      name === "Grep" ||
      name === "Write" ||
      name === "Edit",
  );
  return hasTask && hasFileTool ? "sequential" : undefined;
}

export function resolveTaskExecutionMode(
  lastMessage: unknown,
): "parallel" | "sequential" {
  if (
    typeof lastMessage === "object" &&
    lastMessage !== null &&
    (lastMessage as { role?: unknown }).role === "assistant" &&
    Array.isArray((lastMessage as { content?: unknown }).content) &&
    resolveBatchExecutionMode(lastMessage as AssistantMessage) === "sequential"
  ) {
    return "sequential";
  }
  return "parallel";
}

export function withDynamicTaskExecutionMode<
  T extends { name: string; executionMode?: "parallel" | "sequential" },
>(tool: T, getLastMessage: () => unknown): T {
  if (tool.name !== "Task" || tool.executionMode !== "parallel") {
    return tool;
  }
  return Object.defineProperty(tool, "executionMode", {
    enumerable: true,
    configurable: true,
    get: () => resolveTaskExecutionMode(getLastMessage()),
  });
}
