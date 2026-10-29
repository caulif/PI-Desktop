/**
 * Batch policy only: this does not grant permissions or coordinate other agents.
 * Resource claims only order calls inside one assistant message; they are not a
 * cross-agent lock (`PathMutex` and host-core keep that role).
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { normalizeLockPath } from "./path-lock.js";

export type ResourceAccess = "shared" | "exclusive";
export type ResourceClaim =
  /** `key` is a {@link resourcePathKey}. */
  | { kind: "path"; key: string; access: ResourceAccess }
  /** The whole workspace. */
  | { kind: "tree"; access: ResourceAccess };

export type ToolExecutionSpec = {
  /** pi batch mode; a tool missing from the table is sequential. */
  mode: "parallel" | "sequential";
  /** What one call touches, from its normalized params; parallel tools only. */
  claims?: (params: unknown, base: string) => ResourceClaim[];
};

export const TOOL_EXECUTION_SPECS: Readonly<Record<string, ToolExecutionSpec>> = {
  Read: { mode: "parallel", claims: (params, base) => pathClaim(params, base, "shared") },
  Glob: { mode: "parallel", claims: () => [{ kind: "tree", access: "shared" }] },
  Grep: { mode: "parallel", claims: () => [{ kind: "tree", access: "shared" }] },
  Write: { mode: "parallel", claims: (params, base) => pathClaim(params, base, "exclusive") },
  Edit: { mode: "parallel", claims: (params, base) => editClaims(params, base) },
  // No file claims; a Task mixed with file tools runs the whole batch
  // sequentially (`resolveBatchExecutionMode`).
  Task: { mode: "parallel" },
};

export function toolExecutionMode(name: string): "parallel" | "sequential" {
  return TOOL_EXECUTION_SPECS[name]?.mode ?? "sequential";
}

/**
 * Lexical, case-insensitive key for one path argument: relative paths join
 * `base`, absolute ones (`/x`, `C:/x`, `//server/x`) stay as they are, and
 * `.`/`..` collapse as in {@link normalizeLockPath}. No filesystem access: a
 * remote workspace has no local filesystem and preparation must not do I/O.
 * With an empty `base` a relative path stays unjoined (unlike
 * `mutationFailureKey`, which falls back to the scratch directory), so
 * relative/absolute aliases then rely on the basename fallback in `sameFile`.
 */
export function resourcePathKey(raw: string, base: string): string {
  const path = raw.replaceAll("\\", "/");
  const absolute = path.startsWith("/") || /^[A-Za-z]:/.test(path);
  return normalizeLockPath(absolute || !base ? path : `${base}/${path}`);
}

function pathClaim(params: unknown, base: string, access: ResourceAccess): ResourceClaim[] {
  const path = typeof params === "object" && params !== null
    ? (params as { path?: unknown }).path
    : undefined;
  return typeof path === "string" && path.trim()
    ? [{ kind: "path", key: resourcePathKey(path.trim(), base), access }]
    : [{ kind: "tree", access }];
}

/**
 * Whole tree for `MV` and `REM`, which touch a second path or the directory
 * listing, and for a `CUT`/`PUT` header naming an `@register`: host-core keeps
 * named registers per session, so another file's Edit may read or overwrite it.
 * U+0085 joins `\s` because host-core splits headers with Rust whitespace.
 */
function editClaims(params: unknown, base: string): ResourceClaim[] {
  const ops = typeof params === "object" && params !== null
    ? (params as { ops?: unknown }).ops
    : undefined;
  if (typeof ops === "string" && /^[\s\u0085]*(?:MV|REM)\b|^[\s\u0085]*(?:CUT|PUT)\b[^\n]*[\s\u0085]@/m.test(ops)) {
    return [{ kind: "tree", access: "exclusive" }];
  }
  return pathClaim(params, base, "exclusive");
}

const FILE_TOOL_NAMES = new Set(["Read", "Glob", "Grep", "Write", "Edit"]);

/**
 * Keep Task fan-out and file batches parallel, but preserve the old safety
 * boundary for a batch that mixes a background delegate with file tools: the
 * whole batch runs sequentially. Delegate write/resource coordination belongs
 * to a later Host-owned phase.
 */
export function resolveBatchExecutionMode(
  assistantMessage: AssistantMessage,
): "parallel" | "sequential" | undefined {
  const names = assistantMessage.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "toolCall" }> => block.type === "toolCall")
    .map((block) => block.name);
  const hasTask = names.includes("Task");
  const hasFileTool = names.some((name) => FILE_TOOL_NAMES.has(name));
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
