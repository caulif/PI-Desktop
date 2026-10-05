import { describe, expect, it } from "vitest";
import { normalizeRuntimeToolPolicy } from "./session-tool-policy.js";

describe("session tool policy parsing", () => {
  it("retains the legacy default and recognized policies", () => {
    expect(normalizeRuntimeToolPolicy(undefined)).toBe("unrestricted");
    expect(normalizeRuntimeToolPolicy("unrestricted")).toBe("unrestricted");
    expect(normalizeRuntimeToolPolicy("plugin-bot-scoped")).toBe("plugin-bot-scoped");
  });
  it.each([null, "unknown", "", false, {}])("rejects invalid explicit policy %j", (policy) => {
    expect(() => normalizeRuntimeToolPolicy(policy)).toThrow("Invalid session tool policy");
  });
});
