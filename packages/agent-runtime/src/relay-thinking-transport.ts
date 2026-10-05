import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ProviderThinkingRequestProtocol, SessionThinkingLevel } from "@pi-desktop/shared";
import { clampThinkingLevel, type ThinkingCapabilitySet } from "./thinking-level.js";

/** Preserve explicit omission only for opted-in relays; all default clamping stays unchanged. */
export function clampProviderThinkingLevel(
  provider: ThinkingCapabilitySet & { thinkingRequestProtocol?: ProviderThinkingRequestProtocol },
  requested: SessionThinkingLevel,
): SessionThinkingLevel {
  return provider.thinkingRequestProtocol === "deepseek" && requested === "omit"
    ? "omit"
    : clampThinkingLevel(provider, requested);
}

/**
 * Translate only an explicitly selected relay's off/omit preference after the
 * adapter builds its payload. Reasoning capability and persisted preferences
 * remain unchanged. The caller applies this once before retry option wrappers.
 */
export function withThinkingRequestTransport(
  provider: { thinkingRequestProtocol?: ProviderThinkingRequestProtocol },
  model: Pick<Model<Api>, "api">,
  requested: SessionThinkingLevel,
  options: SimpleStreamOptions,
): SimpleStreamOptions {
  if (
    provider.thinkingRequestProtocol !== "deepseek" ||
    model.api !== "openai-completions" ||
    (requested !== "off" && requested !== "omit")
  ) {
    return options;
  }
  return {
    ...options,
    onPayload: async (payload, requestModel) => {
      const previous = await options.onPayload?.(payload, requestModel);
      const effective = previous === undefined ? payload : previous;
      if (typeof effective !== "object" || effective === null || Array.isArray(effective)) {
        // Never silently send a malformed rewrite without the requested override.
        throw new TypeError("Relay thinking transport requires an object payload");
      }
      const result = { ...(effective as Record<string, unknown>) };
      delete result.reasoning_effort;
      if (requested === "omit") {
        delete result.thinking;
      } else {
        result.thinking = { type: "disabled" };
      }
      return result;
    },
  };
}
