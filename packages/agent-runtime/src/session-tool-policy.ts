import type { SessionToolPolicy } from "@pi-desktop/shared";

export type RuntimeToolPolicy = SessionToolPolicy;

/** Absent is the legacy policy; an invalid explicit value must fail closed. */
export function normalizeRuntimeToolPolicy(value: unknown): RuntimeToolPolicy {
  if (value === undefined || value === "unrestricted") return "unrestricted";
  if (value === "plugin-bot-scoped") return value;
  throw Object.assign(new Error("Invalid session tool policy"), { errorCode: "INVALID_ARGUMENT" });
}
