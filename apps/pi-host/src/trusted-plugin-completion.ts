import { completeOneShot } from "@pi-desktop/agent-runtime";
import type { HostProcess } from "@pi-desktop/host-runtime";
import { fail, type TrustedPluginDeps } from "./trusted-plugin-contracts.js";
export function createIndependentCompletion(
  deps: TrustedPluginDeps,
  grants: Set<string>,
  requireAuthority: () => unknown,
  host: () => HostProcess,
  listModels: () => Promise<
    { key: string; providerId: string; modelId: string }[]
  >,
) {
  let completions = 0;
  return async (input: {
    modelKey: string;
    system?: string;
    messages?: { role: "user" | "assistant"; content: string }[];
    includeSessionContext?: boolean;
  }) => {
    requireAuthority();
    if (!grants.has("agent.complete") || !deps.launch)
      fail("Completion is not enabled", "UNSUPPORTED");
    if (
      !input ||
      input.includeSessionContext !== false ||
      typeof input.modelKey !== "string" ||
      !Array.isArray(input.messages) ||
      input.messages.some(
        (m) =>
          !["user", "assistant"].includes(m.role) ||
          typeof m.content !== "string",
      ) ||
      Buffer.byteLength(JSON.stringify(input)) > 24576
    )
      fail("Invalid bounded independent completion", "INVALID_ARGUMENT");
    const listed = await listModels();
    const model = listed.find((m) => m.key === input.modelKey);
    if (!model) fail("Completion model is not ready", "MODEL_NOT_CONFIGURED");
    if (completions >= 2)
      fail("Completion concurrency limit reached", "AGENT_BUSY");
    completions++;
    try {
      const settings = await host().call<Record<string, unknown>>(
        "settings.get",
        {},
      );
      const resolved = await deps.launch!.resolve(
        "plugin-complete",
        {
          providerId: model!.providerId,
          modelId: model!.modelId,
          mode: "agent",
          thinkingLevel: "off",
        },
        settings,
      );
      const result = await completeOneShot(
        resolved.sidecarParams.provider,
        {
          systemPrompt: input.system,
          messages: input.messages!.map((m) => ({
            role: "user" as const,
            content:
              m.role === "assistant"
                ? "### Assistant\n" + m.content
                : m.content,
            timestamp: Date.now(),
          })),
        },
        "off",
        { signal: AbortSignal.timeout(90000) },
      );
      if (Buffer.byteLength(result.text) > 24576)
        fail("Completion output exceeds the bound", "INVALID_ARGUMENT");
      return { ...result, modelKey: input.modelKey };
    } finally {
      completions--;
    }
  };
}
