import { describe, expect, it, vi } from "vitest";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { buildProviderModel, createProviderModels, type RuntimeProviderConfig } from "./provider-binding.js";
import { withoutDerivedOutputLimit } from "./provider-retry.js";
import { completeOneShot } from "./one-shot-complete.js";
import { clampProviderThinkingLevel, withThinkingRequestTransport } from "./relay-thinking-transport.js";

const provider: RuntimeProviderConfig = {
  id: "relay-row",
  name: "Relay fixture",
  baseUrl: "https://relay.invalid/v1",
  modelId: "deepseek-fixture",
  apiKey: "fixture-only",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
  thinkingRequestProtocol: "deepseek",
};
const model = buildProviderModel(provider);

describe("explicit relay thinking transport", () => {
  it("preserves explicit omit for opted-in false-capability relays only", () => {
    expect(clampProviderThinkingLevel(provider, "omit")).toBe("omit");
    expect(clampProviderThinkingLevel({ ...provider, thinkingRequestProtocol: undefined }, "omit")).toBe("off");
    expect(clampProviderThinkingLevel(provider, "off")).toBe("off");
    expect(clampProviderThinkingLevel(provider, "high")).toBe("off");
  });

  it("rejects an explicitly configured relay when the physical model uses another API", () => {
    expect(() => buildProviderModel({ ...provider, apiStyle: "responses" })).toThrow("requires");
    expect(() => buildProviderModel({ ...provider, modelConfig: {
      ...model, source: "generic", api: "openai-responses",
    } as RuntimeProviderConfig["modelConfig"] })).toThrow("requires");
  });
  it("serializes explicit off even when capability is false, without mutating metadata", async () => {
    const original = { model: "fixture", messages: [], thinking: { type: "enabled" }, reasoning_effort: "high" };
    const options = withThinkingRequestTransport(provider, model, "off", {} as SimpleStreamOptions);
    expect(await options.onPayload?.(original, model)).toEqual({
      model: "fixture", messages: [], thinking: { type: "disabled" },
    });
    expect(original.thinking.type).toBe("enabled");
    expect(original.reasoning_effort).toBe("high");
    expect(model.reasoning).toBe(false);
    expect(provider.supportsReasoning).toBe(false);
  });

  it("removes both request override fields for omit", async () => {
    const options = withThinkingRequestTransport(provider, model, "omit", {} as SimpleStreamOptions);
    expect(await options.onPayload?.({ model: "fixture", thinking: { type: "disabled" }, reasoning_effort: "none" }, model))
      .toEqual({ model: "fixture" });
  });

  it("leaves unconfigured endpoints, other APIs, and enabled levels unchanged", () => {
    const options: SimpleStreamOptions = { onPayload: vi.fn() };
    expect(withThinkingRequestTransport({}, model, "off", options)).toBe(options);
    expect(withThinkingRequestTransport(provider, { api: "openai-responses" }, "off", options)).toBe(options);
    expect(withThinkingRequestTransport(provider, model, "high", options)).toBe(options);
  });

  it("composes an async caller hook and the retry output-limit repair", async () => {
    const caller = vi.fn(async () => ({ model: "rewritten", max_tokens: 32, thinking: { type: "enabled" }, reasoning_effort: "high" }));
    const options = withoutDerivedOutputLimit(withThinkingRequestTransport(provider, model, "off", { onPayload: caller }));
    expect(await options.onPayload?.({ model: "original" }, model)).toEqual({
      model: "rewritten", thinking: { type: "disabled" },
    });
    expect(caller).toHaveBeenCalledTimes(1);
  });

  it("honors a caller hook returning undefined and rejects malformed replacement payloads", async () => {
    const unchanged = withThinkingRequestTransport(provider, model, "off", { onPayload: () => undefined });
    expect(await unchanged.onPayload?.({ model: "fixture" }, model)).toEqual({ model: "fixture", thinking: { type: "disabled" } });
    for (const replacement of [null, [], "invalid"]) {
      const options = withThinkingRequestTransport(provider, model, "off", { onPayload: () => replacement });
      await expect(options.onPayload?.({}, model)).rejects.toThrow("requires an object payload");
    }
  });

  it("propagates caller hook failures instead of sending a partially rewritten request", async () => {
    const options = withThinkingRequestTransport(provider, model, "off", {
      onPayload: () => { throw new Error("fixture failure"); },
    });
    await expect(options.onPayload?.({}, model)).rejects.toThrow("fixture failure");
  });

  it.each(["off", "omit"] as const)("checks %s at the actual adapter fetch boundary without a provider request", async (requested) => {
    let shape: { thinking?: unknown; hasEffort: boolean } | undefined;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      // Keep only structural facts: no headers, credentials, messages, or text.
      shape = {
        ...(Object.hasOwn(payload, "thinking") ? { thinking: payload.thinking } : {}),
        hasEffort: Object.hasOwn(payload, "reasoning_effort"),
      };
      return new Response("fixture rejection", { status: 400 });
    });
    const options = withThinkingRequestTransport(provider, model, requested, { fetch, maxRetries: 0 });
    await createProviderModels(provider, model).streamSimple(model, {
      messages: [{ role: "user", content: "synthetic fixture", timestamp: 1 }],
    }, options).result();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(shape).toEqual(requested === "off"
      ? { thinking: { type: "disabled" }, hasEffort: false }
      : { hasEffort: false });
  });

  it("keeps the existing false-capability wire default when relay opt-in is absent", async () => {
    const unconfigured = { ...provider, thinkingRequestProtocol: undefined };
    const physicalModel = buildProviderModel(unconfigured);
    let overrideKeys: string[] | undefined;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      overrideKeys = ["thinking", "reasoning_effort"].filter((key) => Object.hasOwn(payload, key));
      return new Response("fixture rejection", { status: 400 });
    });
    const options = withThinkingRequestTransport(unconfigured, physicalModel, "off", { fetch, maxRetries: 0 });
    await createProviderModels(unconfigured, physicalModel).streamSimple(physicalModel, {
      messages: [{ role: "user", content: "synthetic fixture", timestamp: 1 }],
    }, options).result();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(overrideKeys).toEqual([]);
  });

  it.each(["off", "omit"] as const)("keeps %s through the one-shot completion caller", async (requested) => {
    let shape: { thinking?: unknown; hasEffort: boolean } | undefined;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      shape = {
        ...(Object.hasOwn(payload, "thinking") ? { thinking: payload.thinking } : {}),
        hasEffort: Object.hasOwn(payload, "reasoning_effort"),
      };
      return new Response("fixture rejection", { status: 400 });
    });
    await expect(completeOneShot(provider, {
      messages: [{ role: "user", content: "synthetic fixture", timestamp: 1 }],
    }, requested, {
      stream: (requestModel, context, options) => createProviderModels(provider, requestModel)
        .streamSimple(requestModel, context, { ...options, fetch }),
    })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(shape).toEqual(requested === "off"
      ? { thinking: { type: "disabled" }, hasEffort: false }
      : { hasEffort: false });
  });
});
